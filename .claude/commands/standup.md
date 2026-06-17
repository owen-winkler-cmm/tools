<!-- PARCH standup flow report: team derived from current and recent ticket assignments, no hard-coded names.
     Persistent defaults are read from .claude/standup-context.json: "defaultExclude" lists engineers always
     omitted from the report, and "pto" lists date-ranged absences ({ name, start, end, note } in YYYY-MM-DD).
     "events" lists upcoming events: { date: "YYYY-MM-DD", name: "...", note: "..." }.
     CLI: --exclude "Name1, Name2" or --ignore "Name1, Name2" adds to the default exclude list for this run.
          --project KEY overrides the default Jira project (default: PARCH).
          --skip-github skips GitHub PR activity fetching for In Review cards (faster, less data). -->

If $ARGUMENTS contains a natural-language exclusion request (e.g. "omit Jeffrey and Thomas", "exclude Richard", "ignore Thomas and Jeffrey") or uses --ignore, extract the names and rewrite the command using --exclude:

```bash
node .claude/scripts/standup.js --exclude "Name1, Name2"
```

Otherwise run:

```bash
node .claude/scripts/standup.js $ARGUMENTS
```

The script writes `standup.html` to the working directory and outputs a markdown data summary to stdout.

Once you have the stdout output:

1. Display the **Computed SLE** and **Team Status** sections verbatim, without any modification or commentary.
2. Then provide a prioritized list of actionable recommendations grounded in kanban flow principles, using the Multi-Ticket Owners and Collaborator Load sections as supporting data. Do not reprint those sections.

Write recommendations as a team facilitator, not a manager. These appear in standup where the whole team is present -- they are prompts for conversation, not instructions. Keep this in mind throughout:
- Frame action items as questions: "Can X review Y today?" not "X needs to review Y"
- Acknowledge data gaps openly before drawing conclusions: if the standup data is incomplete, say so
- The team is collectively responsible for flow; avoid language that singles out one person as failing or at fault
- When uncertainty exists -- no linked PR found, GitHub not checked, Jira not recently updated -- say so explicitly, then ask the team to weigh in rather than asserting what's happening

Recommendations must cover:

- **WIP violations**: anyone over 1 active card (flag 2 as a concern, 3+ as critical); count collaborator cards toward effective WIP, not just assigned cards
- **Collaboration concentration**: flag any engineer carrying heavy collaborator load alongside their own assigned work; call out cards where the collaborator count is high enough to suggest the work should be reassigned or split
- **Escalation candidates**: any card marked ⚠ in the cycle time report has exceeded its story-point-adjusted SLE. For each, identify the blocker type (external dependency, waiting on response, unclear scope, under-resourced, etc.) and recommend a concrete escalation action -- whether to reassign, park as blocked, pair someone on it, or escalate to a dependency owner. These take priority over generic aging flags.
- **Aging items**: flag anything beyond 1 week in any status not already covered by escalation; treat 2+ weeks as critical and name the blocker type
- **Status bottlenecks**: for cards in In Review, Ready to Deploy, or any non-In Progress status, report what the data shows and surface questions for the team:
  - If GitHub PR activity is present for an In Review card: summarize the state (who's reviewing, last activity timestamp, review decision). If the review looks healthy and recent, say so briefly -- do not flag it as a bottleneck. Only raise a concern if the data shows genuine stagnation: multiple days with no activity, open change requests with no follow-up, or no reviewer assigned at all.
  - If no linked PR was found for an In Review card: say so explicitly ("the standup skill didn't find a linked PR for TICKET-nnn") and ask the team whether a review is in progress, and if not, who can take it.
  - If `--skip-github` was used or a PR fetch failed: note the data gap and ask the team to confirm whether review activity is under way before treating the card as blocked.
- **Available engineers**: for each engineer listed as available in Team Status, confirm or adjust the suggested next card
- **Specific next actions**: name the engineer, the ticket, and the concrete step that unblocks it

Format recommendations as markdown. Use headers, bold text, and bullet lists -- no pipe tables. Every ticket reference must be a markdown link to its Jira card (https://covermymeds.atlassian.net/browse/ISSUE-nnn). Name engineers and tickets specifically, but frame actions as questions and suggestions, not orders. Prioritize by flow impact, not by age alone.

After generating recommendations, inject them into `standup.html` by using the Edit tool to replace `<!-- RECOMMENDATIONS_PLACEHOLDER -->` with the recommendations formatted as HTML. Use `<h3>` for section headers, `<p>` for paragraphs, `<ul>`/`<li>` for lists, `<strong>` for bold, and `<a href="...">` for ticket links. Do not include the outer `<h2>Recommendations</h2>` heading -- that is already in the file.
