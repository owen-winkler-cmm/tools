<!-- EM review: SOX/ITGC compliance gate -- the final human sign-off before a change goes to production.
     This is NOT a code review. It checks process, traceability, segregation of duties, and testing evidence.
     Usage: /emreview <PR number or URL>
     Default repo: covermymeds/drugs-api. Override with full URL or "owner/repo#number".
     Version: 1.8 -->

## What an EM review is

An EM review is a SOX/ITGC compliance gate — the final human sign-off before a change goes to production. It is **not** a second code review. You are checking that the correct process was followed. Your output is a short, copyable report suitable for posting as a GitHub PR comment alongside the approval.

Two scope boundaries fall out of that "not a code review" line, and both matter enough to state directly:

- **Don't re-derive what the recorded process already tells you.** If a criterion's data is fully resolvable from what you fetched — a linked ticket's current status, a reviewer's own "confirmed"/"closes this," a later comment showing a prerequisite landed — conclude it. Don't hand an already-answered question back to the EM as something for them to go check; that's the work this skill exists to do once so the EM doesn't have to redo it.
- **Don't validate the code review by reading the code.** Whether a reviewer's concern was *correctly* fixed is not this skill's job — that judgment belongs to the reviewer who approved it. Take the recorded exchange (concern raised, response given, reviewer's own acknowledgment or approval) at face value. Fetching the diff or reading source files to check a reviewer's technical claim yourself is performing a second code review, which is exactly what this skill is not.

## Step 1: Identify the PR

Extract the PR number and repo from $ARGUMENTS. Default repo: `covermymeds/drugs-api`.

Accepted forms: a bare number (`114`), a `#number`, a full GitHub URL, or `owner/repo#number`.

## Step 2: Gather data in parallel

Fetch all of these at once:

```bash
# PR metadata, description, reviewer list, state
gh pr view <NUMBER> --repo <OWNER>/<REPO>

# General comment thread
gh api repos/<OWNER>/<REPO>/issues/<NUMBER>/comments

# Review decisions with timestamps
gh api repos/<OWNER>/<REPO>/pulls/<NUMBER>/reviews

# Commit history with timestamps
gh api repos/<OWNER>/<REPO>/pulls/<NUMBER>/commits

# CODEOWNERS (try .github/ first, then repo root)
gh api repos/<OWNER>/<REPO>/contents/.github/CODEOWNERS --jq '.content' | base64 -d \
  || gh api repos/<OWNER>/<REPO>/contents/CODEOWNERS --jq '.content' | base64 -d
```

Also scan the PR description for an **EM review checklist**: a block of markdown checkboxes (`- [ ]`/`- [x]`) under a heading or label that explicitly targets the EM (e.g. "EM Review", "EM Checklist", "For EM", "EM sign-off"). If found, extract each item and its checked/unchecked state. If no such block exists, note its absence — criterion 8 is simply omitted from the report.

Extract any Jira ticket key(s) from the PR description. Match any `[A-Z]+-[0-9]+` pattern or Jira URL. Fetch each with the Atlassian Rovo MCP:
- Tool: `getJiraIssue`, `cloudId`: `covermymeds.atlassian.net`
- `fields`: `["summary", "description", "status", "assignee", "comment"]`
- `responseContentFormat`: `"markdown"`

Also fetch issue links for each Jira ticket to check for open blockers or dependencies:
- Tool: `getJiraIssueRemoteIssueLinks` is not sufficient — use `getJiraIssue` with `fields: ["issuelinks"]` in a second call, or include `"issuelinks"` in the fields list above. Look for any link where the relationship type is "is blocked by", "depends on", or equivalent, and the linked issue is not in a Done/Resolved/Closed status. If found, surface it in criterion 7.

**Determine review flow** — two distinct paths, same 7 criteria, satisfied differently:

- **Standard flow**: No STCM ticket is present. The repo is itself a SOX-compliant system of record (application repos going through GitHub + DeployWizard). The PR plus a linked Jira work ticket (e.g. `PARCH-123`) together constitute the audit trail. This is the common case.

- **STCM flow**: An `STCM-xxxx` ticket is present. The repo is NOT a self-managing SOX system of record (Puppet, Terraform, infrastructure, credential rotations, manual DB operations). The STCM ticket is the change record — it captures authorization, peer review, EM approval, risk, testing evidence, and change window. The PR alone is not sufficient evidence; the STCM is the evidence.

**A note on CI status checks:** some repos run their own automated compliance job (e.g. a check named `itgc-checks` or similar) that verifies required approvals are in place before the change can be applied. If that job's trigger list includes `pull_request_review` events, it is checking for the same EM sign-off this skill produces — it will read red on any PR still awaiting EM review, by design, and that redness is not a finding. Do not fetch CI/status-check state at all unless a criterion below explicitly calls for it (criterion 5's CI-backed-tests mode does; nothing else does). If you do encounter a failing check incidentally, do not report on it, speculate about its cause, or use it as evidence for any criterion, unless you have first read that check's actual workflow definition and confirmed it verifies something independent of this review's own outcome.

**A note on verifying reviewer claims:** Criterion 2 checks that a peer review happened and that open questions were answered — not that the review was technically correct. Do not fetch the PR diff, read changed source files, or independently re-derive whether a reviewer's concern was properly fixed in code; that's a second code review, which this skill explicitly is not. The recorded exchange is the evidence: a concern raised as a review comment, a reply addressing it, and the reviewer's own acknowledgment ("confirmed", "closes this", a re-review, an APPROVED state) is sufficient on its own. Take it at face value.

**A note on post-deployment verification:** some done-when/AC criteria or test plans specify verification that can only happen after the change ships (e.g. "verified in production," "confirm resolved in prod," "monitor after rollout for 24h"). That describes work that necessarily happens *after* merge and deployment. A PR under review has, by definition, not been deployed yet — it cannot already satisfy a criterion phrased that way, and no one can attest otherwise. Never ask the EM to "confirm" or "decide" that a not-yet-deployed change has been verified in production; that isn't a judgment call available to make yet, it's a fact that doesn't exist yet. When criterion 1 (done-when) or criterion 5 (testing evidence) runs into wording like this:

1. Look for a pre-merge equivalent named elsewhere in the ticket or PR (HOW steps that say "verify in production/master-testing" or name a staging/lower environment). If one exists, assess against that equivalent instead of the literal production wording — that's the bar the team can actually clear before merge.
2. If the equivalent was met, the criterion passes on that basis. Literal production confirmation is still outstanding, but that's a post-deployment follow-up to note in the output, not a pre-approval blocker — don't hold the verdict on it.
3. If no pre-merge equivalent exists, or the one that does exist wasn't exercised, that's a real gap — but phrase the ask correctly. What the EM can decide *now* is whether the pre-merge evidence that does exist (specs, a different environment's test, a sibling code path's verification) is sufficient to proceed — not whether the literal post-deployment criterion has been satisfied. Word any "To reach approval" item around that decision, and list the actual production verification separately as a post-merge action item, not as something blocking this approval.

This generalizes the merge-then-verify handling under criterion 5 (Lower-environment prerequisite PR) — the same "don't gate on something only the merge itself would produce" logic applies whenever a criterion's literal wording describes a post-merge event, not only for the repos listed there.

## Step 3: Build the report

The report has three parts. Keep each part tight — this should fit in a GitHub PR comment.

---

### Part A: Change summary (ELI5)

Write 2–3 sentences describing what this PR does and why, pitched at a technically literate reader who doesn't know this specific codebase. Name the files or components changed but explain what they do rather than assuming familiarity. Then add one sentence on the change record:

- **Standard flow**: state whether the Jira done-when criteria are satisfied ("The done-when criteria are met: …" or "The done-when criteria are **not** fully met because …").
- **STCM flow**: state whether the STCM description matches the change and whether it is approved or still pending ("The STCM accurately describes this change and is approved." or "The STCM [does not match / is still pending approval] because …").

---

### Part B: Compliance checklist

Assess each criterion. Use: ✅ PASS, ❌ FAIL, ⚠️ NEEDS INFO.

Use FAIL when the criterion is clearly not met. Use NEEDS INFO only when you genuinely cannot determine the answer from available data. An absent item (no ticket linked, no risk statement anywhere) is a FAIL, not NEEDS INFO.

If you find a signal that *looks* like it needs the EM's judgment (an open dependency, a stale-sounding claim, a prerequisite ticket) but you already have — or can fetch — the data that settles it, settle it. Fetch the current status of the referenced ticket, check for a later comment confirming it landed, whatever closes the loop. Mark the criterion based on what you found, and put both the original signal and the resolving evidence in the Notes column so the EM sees the full picture without re-doing the check. Only fall back to NEEDS INFO when the available data is genuinely silent or ambiguous even after you've looked.

---

**1. Authorized change record** — A valid change record is linked and covers the change.

Standard flow:
- Work story ticket key present in PR description?
- The ticket's done-when criteria are met. Related cleanup or incidental fixes are acceptable as long as AC is met and the extra changes are clearly related — only flag if additions are substantial and plainly outside the ticket's intent.
- If a done-when item is phrased as post-deployment observation (e.g. "verified in production"), see the note on post-deployment verification in Step 2 before marking this FAIL or NEEDS INFO — assess against any pre-merge equivalent instead, and don't ask the EM to confirm something that can't be true yet.
- Ticket status is active (not Backlog or Closed - Won't Do)?

STCM flow:
- STCM ticket key present in PR description?
- STCM description accurately reflects the change being made (not a generic placeholder)?
- STCM is in an active workflow state (not Draft, not Closed - Won't Do)?
- If STCM is pending only manager/EM approval ("Manager Review Still Needed" or equivalent): this is acceptable — the EM conducting this review approves the STCM first, then approves the PR. Note it in the output.
- If STCM is still pending peer review from a non-EM: that is a blocker (see criterion 2).

---

**2. Code review complete** — A non-author peer review occurred; no unresolved questions in the thread.
- At least one approval from someone other than the PR author?
- Open questions in the comment thread answered?
- Assess this from the recorded review/comment data only — see the note on verifying reviewer claims in Step 2. Don't fetch the diff or read source to check whether a raised concern was *correctly* addressed; a reply plus the reviewer's own acknowledgment or approval is the evidence this criterion asks for.

*(Same for both flows.)*

---

**3. Segregation of duties** — Author ≠ approver.
- PR author is not the same person as any reviewer who submitted an approval?

*(Same for both flows.)*

---

**4. Risk assessed** — Risk is evaluated per the [Platform Risk Analysis Procedure](https://covermymeds.atlassian.net/wiki/spaces/PLATFORM/pages/3417112810/Risk+Analysis+Procedure+-+Platform+Core+Engineering): an explicit overall level, backed by a **Consequence** and **Scope** rating specific to this change, not an asserted label.

- Is there a risk statement ("Low / Medium / High / RMT:")?
- Standard flow: look in the PR description or the linked work ticket.
- STCM flow: look in the STCM description (risk is a required field of the STCM record).
- No risk statement found anywhere = FAIL.

**Consequence and Scope** — the procedure deliberately uses these two dimensions instead of Likelihood (Scope is observable/measurable; Likelihood tends to become a way to rationalize risk away). Look for both, specific to this change:

- **Consequence** — how much damage a failure could cause. High: PHI exposure, service outages affecting end users/clients, SLA violations, compliance findings, anything requiring incident response. Moderate: degraded performance, delayed processing, broken internal workflows, visible-but-recoverable errors. Low: cosmetic issues, minor inconvenience, contained to non-prod with no user-facing impact.
- **Scope** — how broadly a failure could spread. High: affects most/all users, services, or traffic through the changed system. Moderate: affects a significant subset — a specific integration, workflow, or consumer group. Low: a small, well-defined slice — a single service, a feature-flagged population, or a low-traffic path.

Each must be specific to this change — "a malformed response could cause downstream parsers to reject valid PAs" is a real Consequence description; "PAs could stop working" is not. "This endpoint handles 60% of inbound traffic" is a real Scope description; "affects a lot of requests" is not.

Cross-check the stated overall level against the procedure's matrix:

|  | High Consequence | Moderate Consequence | Low Consequence |
|---|---|---|---|
| **High Scope** | High | High | Medium |
| **Moderate Scope** | High | Medium | Low |
| **Low Scope** | Medium | Low | Low |

- Consequence and Scope both stated with change-specific reasoning, overall level consistent with (or more conservative than) the matrix → ✅ PASS.
- A level is stated but Consequence and/or Scope are missing, generic, or not specific to this change (the assessment reads as asserted rather than evaluated) → ⚠️ NEEDS INFO, naming exactly what's missing or generic.
- Consequence and Scope are both specifically described but produce a matrix result materially higher than the stated overall level → ⚠️ NEEDS INFO, naming the mismatch and letting the EM decide — per the procedure's own guidance, a wrong rating with clear rationale is a conversation starter, not an automatic failure.
- Do not evaluate mitigation quality or the post-deployment plan here — that's testing evidence (criterion 5) and production intent (criterion 7). This criterion is scoped to whether Consequence and Scope were genuinely reasoned through.

---

**5. Testing evidence valid** — Evidence exists that the change was exercised and the acceptance criteria are met.

Three modes, assessed differently:

**CI-backed automated tests** (GitHub Actions or equivalent): No output in the PR is required — CI ran the suite and results are auditable there. The question is solely whether test coverage exists for the acceptance criteria. Coverage can be new tests added in this PR, or pre-existing tests that already cover the changed behavior (e.g., a library swap where existing unit tests exercise the same functionality). A bare pass count with no indication of AC coverage is thin — note it. A commit or diff showing new or existing tests that map to the AC is sufficient.

**Manual or exploratory verification**: When the change cannot be fully verified by automated tests (UI behavior, external integrations, deployment steps, DB operations), a screenshot or log excerpt must appear in the PR body or comments showing the changed behavior worked.

- Standard flow: look in the PR description and comments.
- STCM flow: look in the STCM ticket as well — evidence may live there instead.
- Do NOT compare screenshot or manual-test timestamps to commit timestamps. Test environments are deployed independently, and evidence is typically captured before the final commit push. Timestamps on screenshots are irrelevant — only content matters.

**Lower-environment prerequisite PR (merge-then-verify)**: Some repos use a workflow where a change must be deployed to a lower environment (e.g., unstable) before testing evidence can be captured — merging this PR IS the deployment step, so pre-merge evidence is structurally impossible. This applies when **both** of the following are true:

1. The testing evidence comment or PR description explicitly states this PR is a lower-environment or non-production-facing step (e.g., "unstable only", "not production facing", "to gather testing evidence for the stable PR", or equivalent language).
2. The production promotion that follows will go through its own separate EM review (with an STCM or its own PR review), at which point the testing evidence from this merged change will be required before that review can pass.

In this case, criterion 5 **passes** — the merge-then-verify pattern is the established process for this repo, and the explicit acknowledgment in the testing evidence comment is sufficient. Note in the output that post-merge verification (e.g., ArgoCD green) is expected before the stable or production PR can advance.

Currently known repos that use this pattern: `infrastructure/sharedtech-k8s`. Others may be added over time.

---

**6. Change history intact** — All code changes fall within the authorized window.

Standard flow:
- The last code-changing commit's timestamp must be ≤ the peer review approval timestamp.
- Post-approval commits that are purely documentation or configuration commentary do not require re-approval — note them as informational only.
- A post-approval commit that touches code or schema = FAIL.

STCM flow:
- The STCM must be fully approved before the PR is merged or the change is applied to production. An STCM in draft or pending non-EM approval at merge time = FAIL.
- Exception: if the STCM is pending only manager/EM approval, the EM approves the STCM first as part of this review — that satisfies the pre-merge requirement. Note this sequence in the output rather than failing.
- If a change window is visible in the STCM, all commits must fall within it. Commits outside the window = FAIL.
- The peer review (criterion 2) check still applies independently.

---

**7. Production intent confirmed** — No affirmative signals indicate this change should be held.

The default assumption is that the change is ready to deploy. This criterion only fails or needs info if something explicitly signals a hold. Scan the PR description, PR comments, and the linked Jira ticket for:

- A deployment timing constraint ("deploy after hours", "coordinate with X team", "maintenance window required")
- An unmet prerequisite ("blocked by PARCH-nnn", "waiting on config change in Y repo")
- A stakeholder sign-off still pending ("needs product approval before shipping")
- An open blocker or dependency link on the Jira ticket (a linked issue in Blocked By or Depends On status that is not yet resolved)

If any of these are present, check whether it's still actually open — fetch the current status of a referenced ticket, look for a later comment showing the prerequisite landed. If it's resolved as of this review, mark ✅ PASS and note both the original signal and the resolving evidence — don't ask the EM to re-verify something you already confirmed. If it's genuinely still open, or you can't determine its current state from available data, mark ⚠️ NEEDS INFO and say exactly what's unresolved.
If none are found: ✅ PASS — note "no hold indicators found."

Do not flag the absence of a deployment note as a problem. Absence of a hold signal is itself the signal.

*(Same for both flows.)*

---

**8. PR-specific requirements** *(only if an EM review checklist was found in the PR description)*

These are loose, PR-author-defined checks -- not SOX criteria -- but they were explicitly surfaced for the EM, so all must be satisfied before approval.
- A checklist item marked `[x]` is satisfied.
- A checklist item marked `[ ]` is not. List unchecked items verbatim in the Notes column.
- PASS if every item is checked.
- ⚠️ NEEDS INFO if some items are unchecked.
- If no EM review checklist was present in the PR, **omit this row entirely** from the table.

---

### Part C: CODEOWNERS gate

After assessing the 7 criteria, check whether all required CODEOWNERS approvals are in:

- Parse the CODEOWNERS file: each line is `<path-pattern> <owner> [<owner> ...]`. A pattern matches if the PR touches any file under that path. `*` matches everything.
- For each pattern that matches the PR's changed files, check whether at least one of the listed owners has submitted an APPROVED review.
- If an owner is a team (`@org/team-name`), an individual approver's username won't visibly match it — resolve membership with `gh api orgs/<ORG>/teams/<team-name>/members --jq '.[].login'` and check the approvers list against that, rather than assuming a mismatch. A reviewer who is personally a member of the required team satisfies the gate even though their handle differs from the `@org/team` string in CODEOWNERS.
- Don't take a reviewer's inline comment about approval status (e.g. "DBA review is still outstanding") as the current state — it's a timestamped snapshot of when they wrote it. Re-derive the gate from the actual reviews/requested-reviewers data as of now: a later review from a qualifying team member can close the gap after that comment was posted. Also check `gh api repos/<OWNER>/<REPO>/pulls/<NUMBER>/requested_reviewers` to confirm whether a request is genuinely still pending or has already been fulfilled.
- If any required owner group has not approved, list them explicitly — this does not change the 7-criteria verdict, but the PR is not actually mergeable and the EM comment should say so.

### Part D: Verdict

One of three:
- **APPROVED** — all applicable criteria pass (criteria 1–7 always; criterion 8 when present)
- **NOT APPROVED** — one or more FAIL
- **PENDING** — one or more NEEDS INFO, no FAILs

---

## Step 4: Output format

Produce this as a single markdown block, ready to paste as a GitHub PR comment:

```
## EM Review

**Change:** <one sentence ELI5 of what this does>
**Record:** <one sentence on change record status — done-when for standard flow, STCM authorization for STCM flow>

| # | Criterion | Result | Notes |
|---|-----------|--------|-------|
| 1 | Authorized change record | ✅/❌/⚠️ | |
| 2 | Code review complete | ✅/❌/⚠️ | |
| 3 | Segregation of duties | ✅/❌/⚠️ | |
| 4 | Risk assessed | ✅/❌/⚠️ | |
| 5 | Testing evidence valid | ✅/❌/⚠️ | |
| 6 | Change history intact | ✅/❌/⚠️ | |
| 7 | Production intent confirmed | ✅/❌/⚠️ | |
| 8 | PR-specific requirements | ✅/❌/⚠️ | |

**Verdict: APPROVED / NOT APPROVED / PENDING**
```

Row 8 is included only when an EM review checklist was present in the PR description; omit it entirely otherwise.

Fill in the Notes column for every row — one short clause stating what was found ("PARCH-824, In Review, done-when met", "ivan-tactukmercado-cmm approved", "last commit 18:35 UTC, approval 20:28 UTC"). For non-passing items, the note must name the specific gap. For passing items, the note is the evidence that earned the pass. Never leave Notes blank.

If NOT APPROVED or PENDING, add a brief "**To reach approval:**" bullet list naming exactly what must change.

If APPROVED with no pending CODEOWNERS, add one line: "Ready for EM sign-off — GitHub approval + checklist completion required before merge."

If APPROVED and the STCM is pending manager/EM approval, replace that line with: "Approve [STCM-XXXXX](link) first, then submit GitHub approval here."

If APPROVED but CODEOWNERS-required approvals are still pending, add instead:
"⚠️ SOX criteria met, but the following required CODEOWNERS approvals are still outstanding — PR is not mergeable until these are in: `<owner/team>` (for `<path pattern>`)"

### Part E: Apply approval

If the verdict is APPROVED, add an **Apply approval** section giving the EM the exact, bare URL(s) to act on — plain text, not markdown link syntax, so they paste and autolink cleanly in a terminal instead of showing as literal `[text](url)`:

- Standard flow (or STCM flow where the STCM is already fully approved): one line.
  ```
  **Apply approval:**
  <PR URL>
  ```
- STCM flow where the STCM is pending only manager/EM approval (the double-approval sequence from criterion 1/6): two lines, in required order — the STCM must be approved first to establish the change window before the PR approval means anything.
  ```
  **Apply approval:**
  1. Approve the STCM (establishes the change window): <STCM URL>
  2. Approve the PR: <PR URL>
  ```

Omit this section entirely for NOT APPROVED or PENDING verdicts — there is nothing to apply yet; the "To reach approval" list already covers what's outstanding.

After all verdict text, always append a **Links** section listing every relevant URL gathered during the review. Include all of the following that are present:

```
---
**Links**
- [PR #<number> — <title>](<PR URL>)
- [<TICKET-KEY> — <summary>](<Jira URL>)   ← work ticket (standard flow) or STCM (STCM flow); repeat for each ticket found
- [STCM-<number> — <summary>](<Jira URL>)  ← if STCM flow; omit if same as above
```

Rules:
- Always include the PR being reviewed.
- Include every Jira ticket key extracted from the PR description (work tickets, STCM tickets, any other `[A-Z]+-[0-9]+` references).
- Use the ticket summary as the link label (fetch it from Jira if not already retrieved).
- Omit any URL you could not resolve. Do not fabricate URLs.

## Step 5: Log deviations

If the verdict is **NOT APPROVED** or **PENDING**, or the verdict is APPROVED but a CODEOWNERS gap was noted, append one line to `.claude/emreview/findings.jsonl` (create the file and its parent directory if they don't exist — this path is gitignored, it's a local running log, not a repo artifact). Skip this step entirely for a clean APPROVED with no CODEOWNERS gap; there is nothing to record.

One compact JSON object per line, no pretty-printing:

```json
{"date":"YYYY-MM-DD","repo":"<owner>/<repo>","pr":<number>,"pr_url":"<PR URL>","ticket":"<primary work ticket or STCM key>","flow":"standard|stcm","verdict":"NOT APPROVED|PENDING|APPROVED","deviations":[{"criterion":<1-8>,"name":"<criterion name>","result":"FAIL|NEEDS INFO","note":"<the Notes-column text for that row>"}],"codeowners_gap":"<owner/team + path pattern still outstanding, or null>"}
```

- `date`: today's date, `YYYY-MM-DD`.
- `deviations`: every row that is not ✅ PASS, in criterion order. Empty array is valid (e.g. verdict APPROVED with only a `codeowners_gap`).
- `codeowners_gap`: `null` when CODEOWNERS is fully satisfied.
- Append with a single shell redirect (`>>`); never rewrite or reformat the existing file — other reviews may have appended to it since this session started.

This log is meant to be queried later with `jq` (e.g. "which criterion fails most often," "which repos carry the most PENDING verdicts") — keep the schema stable rather than adding ad hoc fields per review.
