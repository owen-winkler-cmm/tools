# Change Submission Email Template

Use this for every in-scope change. The fields match the steps in
`change-process-interim-instructions.md`; filling this out is how you complete steps 2
through 4, not extra work on top of them.

Send to the Service Level Management team. Copy your manager, and your director as well
for Medium tier and above.

Address to confirm: the memo names Sharon Fordham as the lead but gives no address or
distribution list. Get the correct address from SLM before the first submission.

## Subject line

Use exactly this format:

```
Change Submission: STCM#### - short description
```

Example:

```
Change Submission: STCM-4821 - Update prior auth routing rules in EDI gateway
```

Not every change requires an STCM. When none applies, the Jira team card itself is the
change record -- use its key in the same slot, with no annotation:

```
Change Submission: PLAT-2290 - Update prior auth routing rules in EDI gateway
```

## Body template

Copy from here. Delete the bracketed guidance as you fill it in. For Low tier changes,
one line per field is enough; the sections marked "scale by tier" are where higher tiers
need detail.

```
Change: STCM#### | Team card: KEY-### | [one-line description]
(if no STCM applies, the team card is the change record -- drop the STCM segment: Change: KEY-### | [one-line description])
Requested tier: [Low / Medium / High / Critical] because [one sentence]
Systems affected: [the business-facing systems, clients, or workflows exposed if this breaks -- name the technical service only as supporting detail behind that]
Production reach: [the business/customer effect if this affects production, stated first, technical cause as the reason -- e.g. "Would prevent CVS users from logging in, because the OIDC callback stops validating tokens." No production impact at all: say so plainly. Effect not supported by the ticket: don't invent one -- mark it for the human to fill in.]
Proposed window: [start: exact date, time, timezone] to [end: exact date, time, timezone] -- deployment and in-window validation only; never fold post-deployment monitoring time into this window, even when the tier requires 24-48h of it afterward
[maintenance window name, or why these are non-use hours]

APPROVALS SO FAR
Approvers: [name(s), approved date(s) -- list everyone who has approved so far, no need to label roles; confirm which approval(s) satisfy the manager and director requirement (one person may cover both)]

RISK AND READINESS
1. If this goes wrong, how would it hurt our business, revenue, or client relationships?
[Name the systems, clients, and workflows. "Nothing, because X" is a valid answer with the reason attached.]

2. What would tell us it is going wrong, how would we roll it back, and how long would recovery take?
[Name the actual back-out steps (the concrete actions, not "we will back it out") and the recovery duration; add tested evidence where it exists. If rollback is not possible, say so and describe the plan to fix forward. Missing steps or missing timing is a rejection, every time.]

3. What testing, validation, and automation has been performed to gain confidence that this change will not cause incidents?
[Lead with a capitalized confidence verdict tied to fact, then the evidence: e.g. "We are CONFIDENT OUR TESTING HAS MITIGATED THE RISK OF THIS CHANGE, from testing in lower environments and passing all automated checks designed to catch this class of change." A bare "yes" or "it was tested" is a non-answer.]

4. What validation will run inside the change window, and who has to be available for it?
[Name teams and individuals.]

5. Which product and operations counterparts know about this change, and how will they be reached during the window?

NAMED RESOURCES
Implementer: [name]
Validator: [name -- a different person from the implementer where possible]
Product counterpart: [name] -- reachable via [channel/number] during the window
Operations counterpart: [name] -- reachable via [channel/number] during the window

POST-DEPLOYMENT VERIFICATION PLAN (scale by tier)
Checks to run: [specific checks, and who runs each]
Pass criteria: [what a passing result looks like]
Rollback trigger: [the specific observation that means we roll back]
Rollback decision: [who decides, and how they are reached]

MONITORING AFTER BUSINESS HOURS RESUME (scale by tier)
Duration: [24h for Low and Medium / 48h for High and Critical]
Who is watching: [names and hours, including overnight and weekend coverage -- usually the team's PagerDuty on-call rotation]
Dashboards: [links -- pull from Datadog automatically]
Muted alerts: [check Datadog for currently muted monitors on this service; state plainly if none]

LINKS
STCM record: [link] (omit this line entirely if no STCM applies)
Team card: [link]
Change set: [PR or diff link]
```

## Filled example

Subject: `Change Submission: STCM-4821 - Update prior auth routing rules in EDI gateway`

```
Change: STCM-4821 | Team card: PLAT-2290 | Update prior auth routing rules in the EDI gateway for two payer endpoints
Requested tier: Medium because it is customer-facing, affects two named payers only, and rollback has been tested in staging
Systems affected: Prior auth submissions for payers Acme Health and Northstar, routed through the EDI gateway
Production reach: This could misroute prior auth submissions for Acme Health and Northstar before they reach the payer, because the change updates the routing table the production gateway reads directly at request time.
Proposed window: Thursday 21 Aug, 22:00-00:00 ET
Standard Thursday maintenance window

APPROVALS SO FAR
Approvers: Dana Whitfield, approved 18 Aug; Marcus Lee, approved 19 Aug

RISK AND READINESS
1. FAILED PRIOR AUTH SUBMISSIONS for Acme Health and Northstar is the business risk, roughly 400 requests per business day combined, because the change updates the routing table the production gateway reads at request time. Providers would see submission errors. No other payers share these rules.

2. Gateway error rate on the two endpoints is the signal; it is currently near zero, so any sustained rise is unambiguous. Back-out steps: revert the routing config commit and restart the gateway, tested in staging at 6 minutes end to end. Recovery time: under 15 minutes including validation.

3. We are CONFIDENT OUR TESTING HAS MITIGATED THE RISK OF THIS CHANGE, from unit tests on the rule parser and a full submission replay of 500 recorded requests against staging with the new rules, all passed. No production traffic tested yet.

4. Inside the window: submit five synthetic requests per payer and confirm routing and response codes. Needs the EDI operations on-call to confirm gateway health, and Northstar's test endpoint to be up. Both confirmed available.

5. Priya Raman on product and Tom Alvarez on EDI operations are both aware and on the window invite; reachable in the #edi-changes Slack channel.

NAMED RESOURCES
Implementer: Jordan Blake
Validator: Sam Okafor
Product counterpart: Priya Raman -- #edi-changes during the window
Operations counterpart: Tom Alvarez -- #edi-changes and PagerDuty EDI rotation

POST-DEPLOYMENT VERIFICATION PLAN
Checks to run: Sam Okafor runs the synthetic submissions for both payers; Tom Alvarez confirms gateway error rate and latency on the dashboard
Pass criteria: All ten synthetic submissions return expected routing and a 200; error rate stays at baseline for 20 minutes after
Rollback trigger: Any synthetic submission misrouted, or error rate above baseline for 5 consecutive minutes
Rollback decision: Jordan Blake decides and executes; Tom Alvarez can call it if Jordan is unreachable

MONITORING AFTER BUSINESS HOURS RESUME
Duration: 24h
Who is watching: Jordan Blake, Friday 08:00-17:00 ET; EDI on-call overnight and through the weekend via PagerDuty
Dashboards: EDI Gateway Health, Prior Auth Submission Volume
Muted alerts: Checked before; two gateway latency monitors were suppressed and have been re-enabled. Will re-check after the window closes.

LINKS
STCM record: [link]
Team card: [link]
Change set: [PR link]
```

## What gets sent back for more detail

These are the answers most likely to draw a follow-up question:

- A tier justified by effort or scope of work rather than business impact -- whatever
  tier is being requested. "Small config change" is not, on its own, a reason for a
  lower tier; "it touches a lot of files" is not, on its own, a reason for a higher one.
- A back-out plan with no concrete steps ("we will back it out"), no recovery time, or no tested evidence. SLM asks for the actual steps and the timing in every bounce; both are required, every time.
- A rollback trigger written as a judgment call rather than an observation. "If it looks
  bad" is not a trigger; an error rate threshold is.
- Monitoring coverage that stops at the end of the implementer's workday with nothing
  named for overnight or the weekend.
- The same person named as implementer and validator with no explanation.
- A Proposed window written as a range, a multi-day span, "any time works," or
  anything other than one explicit start timestamp and one explicit end timestamp --
  SLM's intake asks for these as two separate fields and re-asks both even when a
  wider window technically covers them.
- A Proposed window whose length includes post-deployment monitoring time -- SLM will
  ask why the window is that long. Monitoring belongs only in "Monitoring after
  business hours resume," never folded into the deployment window itself.
- Rollback recovery time, counterpart real-time availability, or the post-deployment
  validator's name that appears only inside a longer paragraph, with no short, direct
  restatement -- SLM scans for these as standalone answers and re-asks even when the
  paragraph already covers it.
- A team name standing in for Validator or "who runs this check" -- SLM wants a
  specific individual, even when a team is legitimately the on-call owner.
- A true, fully-compliant answer that goes past the required direct callers (Systems
  affected) and traces a second-order chain nobody asked for -- who calls the callers,
  not just the callers themselves. The direct callers stay; the extra hop reads as
  more alarming, not more diligent, and invites a follow-up asking whether you're
  actually confident in the change.
- A Risk-and-readiness item 1 answer that doesn't land in this order: the direct
  answer, then what was tested or already proven, then the risk that evidence
  mitigates. Answering out of order, or stopping before reaching the evidence, is what
  draws the same question back a second time.
