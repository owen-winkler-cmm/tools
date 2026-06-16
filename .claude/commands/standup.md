<!-- PARCH standup flow report: team derived from current and recent ticket assignments, no hard-coded names.
     Persistent defaults are read from .claude/standup-context.json: "defaultExclude" lists engineers always
     omitted from the report, and "pto" lists date-ranged absences ({ name, start, end, note } in YYYY-MM-DD).
     CLI: --exclude "Name1, Name2" or --ignore "Name1, Name2" adds to the default exclude list for this run.
          --project KEY overrides the default Jira project (default: PARCH).
     Output format: Microsoft Teams markdown -- use two trailing spaces (  ) at end of lines that require a
     line break within a block, rather than relying on blank lines alone. -->

If $ARGUMENTS contains a natural-language exclusion request (e.g. "omit Jeffrey and Thomas", "exclude Richard", "ignore Thomas and Jeffrey") or uses --ignore, extract the names and rewrite the command using --exclude:

```bash
node .claude/scripts/standup.js --exclude "Name1, Name2"
```

Otherwise run:

```bash
node .claude/scripts/standup.js $ARGUMENTS
```

Once you have the output:

1. Display the **Computed SLE** and **Team Status** sections verbatim, without any modification or commentary.
2. Then provide a prioritized list of actionable recommendations grounded in kanban flow principles, using the Multi-Ticket Owners and Collaborator Load sections as supporting data. Do not reprint those sections.

Recommendations must cover:

- **WIP violations**: anyone over 1 active card (flag 2 as a concern, 3+ as critical); count collaborator cards toward effective WIP, not just assigned cards
- **Collaboration concentration**: flag any engineer carrying heavy collaborator load alongside their own assigned work; call out cards where the collaborator count is high enough to suggest the work should be reassigned or split
- **Escalation candidates**: any card marked ⚠ in the cycle time report has exceeded its story-point-adjusted SLE. For each, identify the blocker type (external dependency, waiting on response, unclear scope, under-resourced, etc.) and recommend a concrete escalation action -- whether to reassign, park as blocked, pair someone on it, or escalate to a dependency owner. These take priority over generic aging flags.
- **Aging items**: flag anything beyond 1 week in any status not already covered by escalation; treat 2+ weeks as critical and name the blocker type
- **Status bottlenecks**: cards dwelling in In Review, Ready to Deploy, or any non-In Progress status -- these represent flow impediments, not active work; name who should be reviewing each one
- **Available engineers**: for each engineer listed as available in Team Status, confirm or adjust the suggested next card
- **Specific next actions**: name the engineer, the ticket, and the concrete step that unblocks it

Format as markdown. Use headers, bold text, and bullet lists -- no pipe tables. Every ticket reference must be a markdown link to its Jira card (https://covermymeds.atlassian.net/browse/ISSUE-nnn). Be direct and specific -- name engineers and tickets. Prioritize by flow impact, not by age alone.
