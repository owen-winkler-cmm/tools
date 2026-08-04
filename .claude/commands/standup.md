<!-- PARCH standup flow report: team derived from current and recent ticket assignments, no hard-coded names.
     Persistent defaults are read from .claude/standup-context.json: "defaultExclude" lists engineers always
     omitted from the report, and "pto" lists date-ranged absences ({ name, start, end, note } in YYYY-MM-DD).
     PTO/OOO entries default to full-day. Add "allDay": false plus "startTime"/"endTime" (e.g. "1:00 PM") for a
     partial-day absence -- the person is only shown as out during that window, not the whole day.
     "events" lists upcoming events: { date: "YYYY-MM-DD", name: "...", note: "..." }.
     "holidays" ({ year, dates }) is computed and cached by the script itself once per calendar year -- never edit manually.
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

The script writes the HTML report to a dated temp file, opens it in the default browser, and prints the exact output path to stdout on a line starting with `HTML_OUT:`. It also outputs a markdown data summary to stdout.

**If stdout contains a line starting with `**OOO calendar unavailable:**`:** the az CLI session is logged into the wrong Azure tenant to read the OOO group calendar, so calendar-based PTO/OOO was silently skipped for this run. Use AskUserQuestion to ask whether to log into the correct tenant now (`az login --tenant da67ef1b-ca59-4db2-9a8c-aa8d94617a16`, which opens a browser auth flow) and re-run the standup, or continue without it. Don't run the login without asking first.

Once you have the stdout output:

1. Display the **Computed SLE** and **Team Status** sections verbatim, without any modification or commentary.
2. Then provide a prioritized list of actionable recommendations grounded in kanban flow principles, using the Multi-Ticket Owners and Collaborator Load sections as supporting data. Do not reprint those sections.

The team doesn't work weekends, and CMM observes standard holidays. Whenever a recommendation names a day to pick something up ("ready to start tomorrow", "can review it first thing"), use the exact date from the **Next work day** line in stdout rather than computing your own "tomorrow" -- it already skips weekends and holidays.

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

After generating recommendations, identify the output path from the `HTML_OUT:` line in stdout, then use the Edit tool on that file to replace `<!-- RECOMMENDATIONS_PLACEHOLDER -->` with the recommendations formatted as HTML. Use `<h3>` for section headers, `<p>` for paragraphs, `<ul>`/`<li>` for lists, `<strong>` for bold, and `<a href="...">` for ticket links. Do not include the outer `<h2>Recommendations</h2>` heading -- that is already in the file.

Every ticket link must carry the same hover-tooltip data attributes used elsewhere in the report, so hovering it shows the ticket summary: `<a href="https://covermymeds.atlassian.net/browse/TICKET-nnn" class="card-key tt" data-key="TICKET-nnn" data-title="TICKET-nnn" data-summary="SUMMARY" data-url="https://covermymeds.atlassian.net/browse/TICKET-nnn">TICKET-nnn</a>`, where `SUMMARY` is the ticket's summary text from the stdout data (HTML-escape it).

If a recommendation mentions a specific PR, its link needs the matching set too -- don't drop this: `<a href="PR_URL" class="pr-link tt" data-key="pr-NUM" data-title="PR #NUM · REPO" data-summary="SUMMARY" data-meta="META" data-url="PR_URL" data-link-label="Open PR">PR #NUM</a>`, where `SUMMARY` is a short description of the PR and `META` is status context (e.g. review decision, last activity) -- both from the stdout GitHub data.

**National day tooltip:** The stdout's **Today is:** line includes the day's URL in parentheses. Fetch that page and, in one or two short, factual sentences, explain what the day is and why it's observed -- skip fluffy "this day celebrates" framing, get straight to the substance. Use the Edit tool on the HTML_OUT file to set that text as the `data-desc` attribute on the `<a class="nd-label" ...>` tag (HTML-escape it), replacing whatever is currently there (often empty).

Finally, open the HTML file in the browser using the path from the `HTML_OUT:` line: `open <HTML_OUT path>`

---

## Live Board Monitoring (optional)

After injecting recommendations, use AskUserQuestion with:
- header: "Live updates"
- question: "Monitor the Jira board for changes and auto-update the standup page?"
- options:
  1. label: "Every 2 min for 30 min", description: "Recommended default — checks every 2 minutes and updates the page if anything changes."
  2. label: "Custom interval", description: "Specify your own check interval and duration."
  3. label: "No monitoring", description: "Skip live updates."

**If "No monitoring":** stop here.

**If "Every 2 min for 30 min" or "Custom interval":**

1. If custom, ask: "How often and for how long? (e.g. '5 min for 1 hour')" and parse INTERVAL_MINUTES and DURATION_MINUTES. Default: 2 min / 30 min.
2. Extract the **Team Status section** from the standup stdout: everything from `## Team Status` up to (but not including) `## Multi-Ticket Owners`.
3. Write `/tmp/standup-monitor-state.json`:
   ```json
   {
     "htmlPath": "<HTML_OUT path from stdout>",
     "snapshotTeamStatus": "<extracted Team Status markdown>",
     "cliArgs": "<the CLI args used, e.g. '--exclude \"Derik Pell\"', or empty string>",
     "expiresAt": <Math.floor(Date.now()/1000) + DURATION_MINUTES * 60>,
     "cronJobId": null
   }
   ```
4. Use CronCreate:
   - cron: `*/<INTERVAL_MINUTES> * * * *`
   - recurring: true
   - prompt: `Standup monitoring check — follow the ## Monitoring Protocol in the owen-standup skill.`
5. Update the state file: replace `"cronJobId": null` with the returned job ID string.
6. Report: "Monitoring active — checking every N min until HH:MM."

---

## Monitoring Protocol

**This section runs when the CronCreate job fires.**

<!-- The script paths below use the same repo-relative form as the initial run
     instructions above (.claude/scripts/...), not an absolute path. They were
     previously hardcoded to one contributor's local machine and synced-command
     prefix (/Users/robert.little/.claude/scripts/owen-standup.js, and
     /Users/robert.little/.claude/skills/owen/.claude/scripts/update-live-standup.js
     pointing into that contributor's raw clone rather than the synced scripts
     dir at all), which only happened to work by coincidence for that one
     person and broke monitoring for every other teammate syncing this repo. -->


1. Run `cat /tmp/standup-monitor-state.json`. If missing or empty, stop silently.
2. Parse the state. If `Date.now()/1000 > expiresAt`:
   - Use CronDelete with the cronJobId.
   - In the HTML at htmlPath, replace `<!-- MONITORING_LOG_PLACEHOLDER -->` with `<div class="monitor-entry"><span class="monitor-time">HH:MM</span> — <span class="monitor-nochange">Monitoring ended.</span></div>` (preserving any existing log entries before it).
   - Delete the state file: `rm /tmp/standup-monitor-state.json`
   - Report: "Standup monitoring ended."
   - Stop.
3. Run the standup script with `--skip-github --no-html` plus the stored cliArgs to get a fast Jira snapshot (the `--no-html` flag prevents overwriting the existing standup page):
   ```
   node .claude/scripts/standup.js --skip-github --no-html <cliArgs>
   ```
4. Extract the Team Status section from stdout (same bounds as above).
4.5. **Merged PR scan for "In Review" cards:** Even when Team Status looks unchanged, Jira lags behind GitHub merges. For each ticket `PARCH-NNN` that appears as "In Review" in `snapshotTeamStatus`, run:
   ```bash
   gh pr list --repo covermymeds/drugs-api --state merged --search "PARCH-NNN" --json number,title,mergedAt,author --limit 3 2>/dev/null
   ```
   If any PR has a `mergedAt` timestamp within the last 2 hours **and the key `PARCH-NNN#NUMBER` is not already in `knownMergedPRs` in the state file**, collect it as an extra change: `"PARCH-NNN: PR #NNN merged by AUTHOR — card still In Review, needs transition to Done"`. After surfacing a merged PR, add its key (`PARCH-NNN#NUMBER`) to `knownMergedPRs` in the state file so it is not reported again. If any new merged PRs are found, treat the run as "different" and include these entries in the changes array for step 6a (even if the Jira Team Status text is identical).
5. **If identical to `snapshotTeamStatus` AND no merged PRs found in step 4.5:** update the last-checked timestamp only (no log entry):
   ```
   node .claude/scripts/update-live-standup.js \
     --live <htmlPath> --time <HH:MM> --no-changes
   ```
   Report "No changes at HH:MM." and stop.
6. **If different (Team Status changed OR merged PRs found in step 4.5):**
   a. Diff old (`snapshotTeamStatus`) vs. new Team Status line by line to build a plain-text change list. For each difference identify: status changes (`PARCH-NNN: Old → New`), cards added or removed, PR state changes. Merge in any merged-PR entries collected in step 4.5. Produce a JSON array of short strings, e.g. `["PARCH-786: In Review → Done","PARCH-999 added for Ivan","PARCH-786: PR #140 merged — card still In Review"]`.
   b. Run the full standup (with GitHub) in **draft mode** — writes a separate draft file without opening the browser:
      ```
      node .claude/scripts/standup.js --draft <cliArgs>
      ```
      Get DRAFT_PATH from the `HTML_OUT:` line in stdout.
   c. Run the update helper to merge the draft into the live file. Pass the current time (`HH:MM`) and the JSON change array:
      ```
      node .claude/scripts/update-live-standup.js \
        --live <htmlPath from state file> \
        --draft <DRAFT_PATH> \
        --time <HH:MM> \
        --changes '<JSON array from step a>'
      ```
      The helper: replaces the Kanban metrics and Team Status sections with fresh data; diffs the recommendations by `<h3>` block (added sections get a ✚ green marker, removed sections get a ✕ strikethrough); prepends the new change entry to the Live Updates log; writes the merged result to the live path.
   d. Extract the new Team Status section from the full standup stdout and update `snapshotTeamStatus` in the state file.
   e. Delete the draft file: `rm <DRAFT_PATH>`
   f. Report: "Board updated at HH:MM: [summary of changes from step a]"
