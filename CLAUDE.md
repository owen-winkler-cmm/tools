# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project purpose

Personal EM toolbox: Claude Code slash commands for daily team operations and compliance workflows.

## Architecture

Each slash command is a `.md` file in `.claude/commands/`. Commands that need data from external APIs use a backing Node.js script in `.claude/scripts/`; commands that drive Claude directly via MCP tools or the `gh` CLI need no script.

```
.claude/
  commands/       # one .md file per slash command
  scripts/        # one .js file per script-backed command
  scripts/lib/    # shared modules: jira.js (REST client), flow.js (canonical SLE/throughput)
  assets/         # static assets a command depends on (e.g. the Marp theme)
  standup-context.json   # gitignored; managed by Claude, not edited manually
```

`lib/jira.js` and `lib/flow.js` are behavior-preserving extractions of code duplicated across `standup.js`/`metrics.js`/`dora.js`/`o3.js` -- one Jira REST client, one definition of SLE (85th percentile, 28d cycle time, Planned/Ready→Done) and throughput (8-week buckets). Any script needing Jira data or flow math should use these rather than reimplementing them.

## Jira integration

Scripts call the Jira REST API directly using Basic auth (email + API token). No MCP required.

**Required environment variables:**

| Variable | Example |
|---|---|
| `JIRA_BASE_URL` | `https://covermymeds.atlassian.net` |
| `JIRA_EMAIL` | `you@covermymeds.com` |
| `JIRA_API_TOKEN` | token from https://id.atlassian.com/manage/api-tokens |

Set these in a `.env` file at the repo root (gitignored) or in your shell profile.

## standup-context.json

Gitignored. Managed entirely by Claude -- never edit manually (except `holidays`, which the script itself computes and caches). Structure:

```json
{
  "defaultExclude": ["Name to always omit"],
  "nonEngineers": ["Name that is not pulling delivery work"],
  "pto": [
    { "name": "Full Name", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "note": "reason" },
    { "name": "Full Name", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "allDay": false, "startTime": "1:00 PM", "endTime": "5:00 PM" }
  ],
  "holidays": { "year": 2026, "dates": ["2026-01-01", "..."] }
}
```

Tell Claude in natural language to update it: "Rob is out next week", "remove Jeffrey from the ignore list", "Seyoung is back Thursday", "Dana's out this afternoon 1-5", "Owen isn't an engineer".

`nonEngineers` lists people (EMs, PMs) who aren't pulling delivery work. Unlike `defaultExclude`, they still appear in Team Status when they own a card; they are only kept out of the "available" list and never offered a backlog suggestion. `defaultExclude` omits a person from the report entirely.

Sprint "Day X of N" and the burndown glide path both count working days only -- weekends and CMM `holidays` carry no capacity, so a 2-week sprint reads as ~10 days and the ideal line holds flat across non-working days instead of declining through them.

PTO entries default to full-day. `allDay: false` + `startTime`/`endTime` marks a partial-day absence -- the engineer is only shown as out during that clock window, not flagged out (or excluded from backlog suggestions) for the whole day.

`holidays` caches CMM's standard observed US holidays (New Year's, MLK Day, Memorial Day, Juneteenth, July 4th, Labor Day, Thanksgiving + the Friday after, Christmas), computed once when the year in the cache no longer matches the current year. Used to compute "next work day" (skips weekends and holidays) for PTO return dates and recommendation phrasing.

## /emreview

Performs an EM review of a GitHub pull request for SOX/ITGC compliance. Fetches PR metadata, commit history, review decisions, and the linked Jira ticket, then evaluates the 7 compliance criteria and produces a copyable PR comment.

**Usage:** `/emreview <PR number>` (default repo: `covermymeds/drugs-api`)

**Requires:** `gh` CLI authenticated + Atlassian Rovo MCP connected. No script -- runs entirely via `gh` and MCP tool calls.

**Output:** A markdown table with ✅/❌/⚠️ per criterion, a plain-English change summary, and a APPROVED/NOT APPROVED/PENDING verdict. When APPROVED, a bare-URL "Apply approval" line (or two, in order, for the STCM double-approval sequence) gives the exact link(s) to act on -- plain text, not markdown link syntax, so they paste and autolink cleanly in a terminal.

**Deviation log:** `.claude/emreview/findings.jsonl` (gitignored) -- one compact JSON line appended per review that isn't a clean pass (any FAIL/NEEDS INFO, or an APPROVED with a CODEOWNERS gap). Schema: `date`, `repo`, `pr`, `pr_url`, `ticket`, `flow`, `verdict`, `deviations[]` (`criterion`, `name`, `result`, `note`), `codeowners_gap`. Query with `jq`, e.g. which criterion fails most often across repos.

## /standup

Runs a PARCH sprint standup report (default project). Override with `--project KEY`; `--board ID` (default 10731, the Dumpster Firefighters Scrum board) and `--sprint ID` override the board / active sprint.

The team moved from a kanban board to a Scrum sprint board (2-week PI-cadence sprints) but still works pull-based; the report is scoped to the active sprint **plus stragglers** (in-flight work not on the sprint, surfaced so it can be pulled in -- never auto-added to Jira) and keeps flow metrics alongside sprint metrics. See memory `project_team_kanban_operating_model` for the mixed/settling model.

**Output includes:**
- National day of the day (deterministic pick, same for everyone on a given date)
- Sprint banner: name, goal, day X of N, and progress (points/cards done vs committed)
- Computed SLE (85th percentile of 28-day cycle time history) -- flow metrics stay project-wide; only sprint metrics are sprint-scoped. `flow.js` is untouched, so `/metrics`, `/dora`, `/o3` are unaffected
- Team Status: every active engineer, cards ordered right-to-left by board-column position then age descending; every card (in-flight, straggler, suggested) shows its story points or `unpointed`; stragglers flagged `not in sprint`; a per-engineer "✓ N done this sprint" chip; available engineers get a suggested next card from the sprint backlog
- Stragglers section: in-flight cards not on the sprint, listed for a "pull onto the board?" prompt
- Two metric panels stacked full-width: Flow on top (the aging-WIP "board" chart, `chartSvg`) and Sprint below (burndown chart + velocity, `sprintMetrics.burndownSvg`). The aging-WIP chart is a board view: the sprint board's own columns (grouped via `statusToColumn`, not per-status), each card drawn as a titled chip placed by how long it has sat against the cycle time its story points imply (1≈hrs, 2≈1d, 3≈2.5d, 5≈1wk, 8≈sprint), with point-intent reference lines (1/2/5/8pt) replacing the old single SLE line on a non-uniform duration scale. Severity, review state, and over/approaching-intent notes ride on each card; `.wip-card` hover + `<a>` click-to-Jira are preserved. Burndown is points-based with an unpointed-cards caveat; velocity reads "first tracked sprint" until a sprint closes
- Multi-Ticket Owners and Collaborator Load sections (used by Claude for recommendations)
- Writes a dated `standup-YYYY-MM-DD.html` to the OS temp directory on every run (not the working directory, so it's not something to gitignore): one static, self-contained file (no separate data file, no fetch, no live polling) safe to move, email, or open offline, cleaned up automatically on reboot
- Publishes the same recommendations to Confluence (page 4048945159, PLATFORM space), replacing only the content between the "Standup Report" heading and the following horizontal rule -- the rest of that page (To-Do List, etc.) is left untouched. Connectivity to the page is checked first every run. The national day is linked at the top of that section, then a sprint line (name, day X of N, progress, goal), then the aging WIP chart and sprint burndown rendered as images (SVG → PNG via `rsvg-convert`, uploaded as fresh page attachments via a raw REST call to the Confluence attachment API since no MCP tool covers attachment upload -- skipped with a note if `rsvg-convert` isn't installed), then the recommendations. Every Jira ticket key anywhere in the content is a working link -- no plain-text ticket codes. Requires Atlassian Rovo MCP; skipped with a clear note if unavailable, doesn't block the local report.

**PTO handling:** active full-day PTO suppresses backlog suggestions; a partial-day absence (`allDay: false`) only suppresses them while the current time is inside its window. Upcoming PTO (within 7 days) is flagged on the engineer's line. "Returns" and "next work day" dates skip weekends and CMM holidays (see `holidays` in standup-context.json).

## /dora

Produces a DORA + backlog health snapshot -- deployment, flow, and kanban metrics in one dated markdown document, intended for AI context stores and 1:1 briefings.

**Usage:** `/dora [--project KEY] [--repo owner/repo] [--window N]`

**Defaults:** project=PARCH; repos from `DORA_REPOS` env var (comma-separated `owner/r1,owner/r2`), fallback `covermymeds/drugs-api`; window=30d. Deploy-workflow detection matches `DORA_DEPLOY_WORKFLOW` (regex, default `deploy|release|publish`).

**Script:** `.claude/scripts/dora.js`, writes `dora.md` to the working directory and prints the same content to stdout. Lead Time and MTTR are still placeholders -- Lead Time needs future script support, MTTR is filled manually from the incident tool.

## /metrics

Flow metrics report: 8-week rolling kanban health for a single Jira project. Ported from `pce-forecast`; this is the authoritative source going forward.

**Usage:** `/metrics [--project KEY]` (default project: PARCH)

**Script:** `.claude/scripts/metrics.js`, writes `metrics.html` to the working directory and prints a summary (current + 7-week average SLE, average throughput, SLE hit rate, at-risk/breached counts) to stdout.

## /goalsetting

Guides any McKesson Platform employee through the annual Workday goal-setting process. Produces SMART goals aligned to the three Platform evaluation criteria.

**Usage:** `/goalsetting` (no arguments; starts an interactive interview)

**Requires:** No external tools. Pure Claude skill.

**What it produces:**
- 3–4 performance goals (What You Deliver) and 1–2 development goals (How You Grow), reviewed individually with SMART scoring before finalization
- A single markdown artifact per goal with GOAL, DESCRIPTION, and MILESTONES sections
- Optional post-delivery advice on executing each goal for elevated or exceptional performance

**Flow:** Interview (job context or prewritten goals) → per-goal SMART review → artifact → optional performance execution review.

## /metadoc

Produces canonical meta-documents: reference documents that define what must be true or what must exist within a documentation hierarchy. Does **not** produce the project documents that fulfill those requirements -- those live in project folios and reference back to the meta-document.

**Usage:** `/metadoc [optional topic hint]`

**Requires:** Atlassian Rovo MCP connected (for optional Confluence publishing). No script -- runs entirely via interactive interview and MCP.

**What it produces:**
- **Meta-documents**: canonical references stating requirements by phase, with a "what must exist" table naming subordinate meta-docs and project templates. Short by design -- if requirements exceed ~15 items, the skill splits off a subordinate rather than expanding.
- **Subordinate meta-documents**: child documents that expand one complex requirement area from a parent meta-doc into its own structure. Published as Confluence children of their parent.
- **Project templates** (optional): project-facing starters teams clone into their folio. Pre-populated with required sections and guidance notes; back-reference the meta-doc as the compliance standard.

**Workflow:** Interactive interview → markdown draft for review → optional subordinate/template drafts → optional Confluence publish.

## /qpor

Produces a Quarterly Portfolio OKR Review: top-5 work items from the last quarter mapped to the Shared Capabilities FY27 team charter, formatted for a QBR meeting presentation.

**Usage:** `/qpor [--project KEY] [--quarter Q1|Q2|Q3] [--fy FY27]`

**Defaults:** project=PARCH, last completed quarter inferred from today's date.

**Requires:** Atlassian Rovo MCP connected. No script -- runs entirely via MCP tool calls.

**What it produces:**
- Two ranked sections — **Needs Attention** (blocked, carry over, not started, at-risk items) and **Successes** (completed and on-track items) — up to 5 items each, no repeats
- Each item formatted with: Goal/Initiative title, Segment Objective, QBR Status, What needs discussed or decided, and Speaker
- A brief quarter summary paragraph after the two sections
- Writes `qpor-{quarter}-{fy}.md` to the working directory

**Defaults:** Persisted in `.claude/qpor-defaults.json` (gitignored). If project/quarter/fy are not supplied via flags, the skill prompts once and saves the answers for next time.

**OKR mapping:** Items are mapped to three KR pillars from the team charter: Standards (API contract, ARB, Kafka, API Gateway), Priority APIs (Drugs, Diagnosis, Pharmacy), and Team Health (DORA, satisfaction survey, AI goals, migration tooling).

## /project

Turns a compound goal into a tracked, markdown-backed local project: **issues** that are planned, then completed one at a time by producing an **artifact**.

**Usage:** `/project <verb> [name] [args]`
- `new [name]` — start a project (interview, or ingest an existing checklist/doc into issues)
- `plan [name]` — order issues, resolve dependencies, list outstanding inputs, recommend next steps
- `work <id> [name]` — complete one issue: gather inputs, then draft the artifact or prep a request/template
- `status [name]` — re-render the tracker; summarize done / blocked / outstanding
- `refresh [name]` — pull current status of any linked Jira tickets into the file
- `list` — list all `project-*.md` trackers

**Requires:** Nothing for local work; Atlassian Rovo MCP only for `refresh`. No script.

**State:** One `project-<name>.md` per project is the sole source of truth (gitignored via `/project-*.md`). No JSON, no external tracker -- Claude reads the file, acts, and rewrites it.

**Issue types:**
- **draft** -- Claude produces the artifact from inputs (a document, plan, register, config spec).
- **evidence** -- completion needs an external artifact/action Claude cannot fabricate (a test run, pen-test, sign-off, third-party record). `work` produces the request/template and tracks the link; the issue only goes ✅ when real evidence is attached.

**Jira:** Never a tracker. If completing an issue spawns or needs a Jira ticket, its key + URL + status is recorded on that issue and refreshed from Jira on demand; the local file stays authoritative.

**Statuses:** ⬜ todo · 🟡 in progress · 🔵 needs input · ✅ done · ⏭️ deferred (future scope).

## /mdslides

Authors or validates a CoverMyMeds-branded slide deck as plain, diff-friendly markdown. The `.md` stays minimal (front-matter + headings + content + the occasional per-slide class); all brand styling lives in the theme CSS, so the source parses cleanly for AI and diffs like any code file.

**Usage:** `/mdslides <new|validate|preview|export> [file|name] [args]`

**Requires:** `node` + `npx` (marp-cli is fetched on first run, no global install). A Chrome/Chromium/Edge browser for the live `--preview` window and PPTX/PNG export; HTML export needs no browser.

**Verbs:**
- `new [name]` — interview or ingest content, then write a branded `<name>.md` that follows the markdown contract; validates before handing back
- `validate <file>` — lint for valid + minimal Marp and brand-theme compliance; reports a ✅/⚠️/❌ table + verdict, does not silently rewrite
- `preview <file>` — open the live-reloading preview window (`--preview --watch`); falls back to HTML export if no browser
- `export <file> [pptx|html]` — write a shareable file next to the source and open it

**Config:** `.claude/assets/marp/marp.config.js` -- passed to marp-cli with `-c`. Registers the brand theme, enables the column engine, and sets `html`/`allowLocalFiles`, so a deck reproduces identically outside the skill (`npx @marp-team/marp-cli deck.md -c .claude/assets/marp/marp.config.js --no-stdin -o deck.html`) with no repo dependencies to install. Always pass `--no-stdin` (marp-cli v4 hangs on a piped stdin otherwise).

**Theme:** `.claude/assets/marp/covermymeds.css` -- self-contained, built from the authoritative `CoverMyMeds_PowerPointTemplate_2026.potx` ("CMM Master"): Georgia headings / Arial body, the CMM palette, corner wordmark and ring frame embedded as data URIs. Regenerate with `.claude/assets/marp/gen_theme.py` if the brand marks change.

**Devices:** per-slide classes `title` / `section` / `lead` / `invert`; native `header:`/`footer:` directives for the eyebrow and confidentiality line; and columns via markdown-neutral HTML-comment markers (`<!-- columns -->`, `<!-- col orange|magenta|blue|navy -->`, `<!-- /columns -->`) that the config engine expands into the theme's colored card panels at render time -- no `<div>` or `html: true` in the source, so decks stay formatter-safe. `.claude/assets/marp/example.md` exercises every device.

**Render-instructions header:** every deck carries a one-line HTML comment right after the front-matter -- `<!-- Render this like PowerPoint slides!  ->  https://covermymeds.atlassian.net/wiki/x/DQAT9g -->` -- pointing to the Confluence how-to page ("Rendering CoverMyMeds Marp Slide Decks") that carries the full render + authoring instructions. It renders to nothing on the slides. Update the page, not each deck.

## /o3

Drafts the next recurring 1:1 (O3) note for a named report, mirroring that person's own prior note format. Fills only what primary sources prove -- live flow metrics, active-epic status, recent completions, and carried-forward open threads -- and leaves the narrative (wins framing, people, leadership translation) to the user. Every seeded line carries a strippable glyph so its origin is visible before the note goes upward.

**Usage:** `/o3 <Name> [--project KEY]` · `/o3 finalize <file>`

**Requires:** `node` + Jira `.env` credentials (see Jira integration). No MCP or `gh`. The Microsoft 365 connector gates the run: preflight checks it first, and if it's not authenticated the skill stops and alerts rather than proceeding quietly -- it only continues without MS365 if the user explicitly says so.

**Scripts:** `.claude/scripts/o3.js` (JSON aggregator: WIP with in-progress age, active epics + child rollups + not-Done children, completions in the last N days) plus `.claude/scripts/dora.js` (flow metrics). They run back-to-back so the breach list reconciles to one timestamp; `o3.js` emits WIP ages and the skill flags breached = age > dora's SLE, keeping one source of truth for the flow math.

**Notes location:** `/Users/owinkler/Documents/Prime/Areas/Work/Meetings/O3s/<Name>/<Name> O3 - YYYY-MM-DD.md`. The most recent note in that folder is the format template.

**Glyphs (strippable working marks):** 🆕 new from a primary source · ♻️ carried forward, still open · ✍️ human-fill (your words only) · 🚧 likely question/alarm + a drafted answer to massage. `finalize <file>` strips them.

**What it produces:**
- A dated note mirroring the person's prior structure, section for section
- A metrics block with DORA reported as "not yet configured" (no deploy/CFR/lead-time/MTTR proxy), the real kanban flow metrics, breached-SLE cards listed by key + title, and week-over-week deltas framed honestly (delivery reads as delivery, not decline; benign readings cite a verifiable fact)
- Every "N-1 of N done" bullet naming the specific remaining item and why (from epic children), so the reader's obvious next question is answered in place
- Candidate wins seeded from recent completions; carried-forward open threads under their sections; ✍️ blanks where only the user's words belong

## /cmemail

A **readiness gate before it is a drafter**: it produces an SLM Change Submission email from a single Jira ticket (a team card, an existing STCM record, or either linked to the other) only when every field an SLM reviewer scans is present and backed by a fact that would earn a plain "approved." It gathers what the ticket, PR, and the conversation prove -- description, components, linked STCM/team-card, linked PR, assignee, approvals (from the PR reviews), back-out plan, testing evidence, window -- then checks each SLM-answer field. If anything is missing it does not just bounce: it shows the full list of gaps, then **interviews the user through the collectable ones over several turns**, each with an example of a good answer, merging each reply in before composing. The one gap it can't collect is a required approval: that must actually be on the PR (typing "it's approved" doesn't count), so the interview preps everything else and the email still waits on the real approval. Never infers change tier from Jira `priority`; never invents a fact to clear the gate. Supplied facts are merged silently as a source. Rationale: a produced email gets sent as-is by someone who may not edit it or know `finalize` exists, and a stale or bounce-prone draft does real harm, so the skill never hands over an artifact that isn't actually ready -- and walks the user to ready rather than leaving them to guess why it bounced.

**Usage:** `/cmemail <TICKET-KEY> [facts missing from the ticket/PR]` · `/cmemail finalize <file>`

**Requires:** Atlassian Rovo MCP, `gh` CLI (github.com + git.innova-partners.com, for PR approvals), and Datadog MCP all connected. Preflight checks all three and stops if any is down. No backing script.

**Template:** `.claude/assets/cmemail/change-submission-email-template.md` -- the field-by-field contract, filled example, and the "what gets sent back for more detail" list that is now the gate's rejection rubric.

**Approver registry:** `.claude/cmemail/approvers.json` (version-controlled, not gitignored -- change-process policy, same for everyone). Maps people to roles and sets which roles each tier requires an APPROVED PR review from. The gate matches PR review authors by GitHub login against this file. Verifies `peer` + `em`, where EM = Owen Winkler (`owinkler` / `owen-winkler-cmm`), who also holds Director, so one approval from him is the combined EM/Director sign-off. VP (Todd) approves by replying to the generated email, so his approval never appears in the PR/Jira and is deliberately never gated -- he's an email recipient for High/Critical, not a source approval.

**Service-directory cache:** `.claude/cmemail/service-directory.json` (gitignored). Maps a service name to its product/operations counterparts and a dated Datadog dependency snapshot, plus the canonical team name and its aliases (Compass isn't active on this Atlassian instance, so there's no structured ownership registry -- this is the substitute, hand-maintained where Confluence is stale or contradictory). Dependency edges refresh cheaply via the Datadog MCP; contacts are human-confirmed only, never re-scraped. Tell Claude in natural language to update it, same as `standup-context.json`.

**Answer framing:** each SLM question is answered in a first sentence that matches the question's grammatical form (a "how" question leads with the named harm or "NO HARM, because..."; a yes/no question with YES/NO), with the exact phrase SLM scans for in ALL CAPS (caps, not bold, so it survives a plain-text paste), and always carrying a fact rather than a bare affirmation.

**Glyphs:** the gate retires ✍️/🚧 from content fields -- a field that lacks a fact is a gate block, not a shipped warning. The only ✍️ spans in a produced email are the To/Cc delivery lines. `finalize <file>` strips them.

**What it produces (when the gate passes):**
- Subject line: `Change Submission: STCM#### - {description}`, or `Change Submission: {TEAM-KEY} - {description}` when no STCM applies (no "STCM pending" annotation)
- A ✍️ `To:` line flagging the SLM distribution address as unconfirmed, and a conditional ✍️ `Cc:` line for the director (Medium tier and above)
- The template's full body -- Change/tier/systems/window, approvals, five-item risk-and-readiness, named resources, post-deployment verification, after-hours monitoring, links -- every content field filled with a sourced fact
- Written to `cmemail-<ticket-key>.md` in the working directory
