<!-- PARCH standup flow report: team derived from current and recent ticket assignments, no hard-coded names.
     Persistent defaults are read from .claude/standup-context.json: "defaultExclude" lists engineers always
     omitted from the report, and "pto" lists date-ranged absences ({ name, start, end, note } in YYYY-MM-DD).
     PTO/OOO entries default to full-day. Add "allDay": false plus "startTime"/"endTime" (e.g. "1:00 PM") for a
     partial-day absence -- the person is only shown as out during that window, not the whole day.
     "events" lists upcoming events: { date: "YYYY-MM-DD", name: "...", note: "..." }.
     "holidays" ({ year, dates }) is computed and cached by the script itself once per calendar year -- never edit manually.
     CLI: --exclude "Name1, Name2" or --ignore "Name1, Name2" adds to the default exclude list for this run.
          --project KEY overrides the default Jira project (default: PARCH).
          --board ID overrides the Jira board ID used for column WIP limits (default: 1967).
          --skip-github skips GitHub PR activity fetching for In Review cards (faster, less data). -->

If $ARGUMENTS contains a natural-language exclusion request (e.g. "omit Jeffrey and Thomas", "exclude Richard", "ignore Thomas and Jeffrey") or uses --ignore, extract the names and rewrite the command using --exclude:

```bash
node .claude/scripts/standup.js --exclude "Name1, Name2"
```

Otherwise run:

```bash
node .claude/scripts/standup.js $ARGUMENTS
```

This fetches everything and writes a data blob to a dated temp path, printed as `DATA_OUT:<path>`, plus a markdown summary to stdout. It does not open anything yet -- Recommendations and the national-day description still need to be generated (see below) before there's anything worth looking at.

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

- **Column WIP violations (lead with these)**: check the Column WIP Violations section first. A column with a hard zero limit (e.g. In Review) is reported as a plain count, not an alarm -- every card there is inherently "over" a zero limit, so that's not itself a signal, just how many cards are done and waiting on someone else's action (review sign-off, AI check, merge). Name every card in that column and state exactly what needs to happen to clear it, without framing the count as a violation. Any column marked ⚠ OVER LIMIT (a positive limit actually exceeded) is a real systemic flow blocker affecting the whole team; name the column, the count, and the limit, and ask what the team can do to pull work forward before starting anything new.
- **WIP violations**: anyone over 1 *actively in-progress* card (flag 2 as a concern, 3+ as critical). Cards sitting in a review-type status are done and waiting on someone else, not competing for the engineer's attention -- don't count them here. Count collaborator cards toward effective WIP, not just assigned cards
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

After generating recommendations, identify the data file from the `DATA_OUT:` line in stdout, then use the Edit tool on that file to replace the empty `"recommendations"` array with one entry per block:

- `{"type": "heading", "text": "..."}`
- `{"type": "paragraph", "text": "..."}`
- `{"type": "list", "items": ["...", "..."]}`

Write ticket keys (`PARCH-932`) and PR mentions (`PR #120`) as plain text inside `text`/`items` strings -- do not hand-write `<a>` tags or data-* attributes for them. The render step auto-linkifies any mention of a known key against the `issues`/`prs` pool in the same JSON file into a link with the same hover card used everywhere else. `**bold**` inside a block's text is rendered as emphasis, so a name or key can still be called out without needing raw HTML.

**National day tooltip:** The stdout's **Today is:** line includes the day's URL in parentheses. Fetch that page and, in one or two short, factual sentences, explain what the day is and why it's observed -- skip fluffy "this day celebrates" framing, get straight to the substance. Edit the JSON file's `nationalDay.description` field to that text (a plain JSON string -- no HTML escaping, no attribute syntax to get wrong). It's usually pre-filled with a shorter teaser scraped from the listing page; replace it with your fetched summary.

Once both edits are made, render the final report and stop -- do not read the JSON back to check it:

```bash
node .claude/scripts/standup.js --render <path from DATA_OUT>
```

This reads the completed data file and writes a dated `standup-YYYY-MM-DD.html` to the OS temp directory (printed as `REPORT_OUT:<path>`), not the working directory: one fully self-contained, static HTML file (data baked in, no separate JSON file, no fetch, no CDN, no live polling) that's safe to move, email, or open offline, and gets cleaned up automatically on reboot rather than littering the repo. The script opens it once itself -- do not open or re-open it yourself, and do not offer or set up live board monitoring: no extra `open` command, no browser tool, no AskUserQuestion about monitoring, no CronCreate job.

## Publish to Confluence

After `--render` prints `REPORT_OUT:`, publish the same recommendations to the team's standup page: cloudId `covermymeds.atlassian.net`, pageId `4048945159` (https://covermymeds.atlassian.net/wiki/spaces/PLATFORM/pages/4048945159/Standup).

0. Before anything else, verify the page is still reachable with a `getConfluencePage` call on the pageId above -- confirm it returns and the title is still "Standup" (or a page under the same space/URL). The pageId is hard-coded here and Confluence page IDs do not change on their own, but if this ever comes back not-found or clearly wrong, stop, report it, and ask for the current page before touching anything.
1. Fetch the current body (same call as step 0 covers this). Its shape is fixed: an `<h2>Standup Report</h2>` heading, a content slot, a `<hr>`, then a `<h2>To-Do List</h2>` section and whatever follows it.
2. Replace only the content slot between the `<h2>Standup Report</h2>` heading and the next `<hr>` -- leave the To-Do List section and everything else in the page byte-for-byte untouched. This overwrites whatever was there from the previous run; the page is a live snapshot of today's actions to consider, not an accumulating history.
3. The very first element of that content slot, every run, is the national day: `<p><a href="<national day URL>"><national day name></a> · <dateLabel></p>` -- the URL and name come from the stdout `Today is:` line, the date from `dateLabel` in the JSON data file. This is not conditional; every run has one.
4. Immediately after the national-day line, embed the aging WIP chart as an image (also not conditional -- every run):
   a. Extract `chartSvg` from the JSON data file and write it to a temp `.svg` file.
   b. Convert it to PNG with `rsvg-convert -w 820 -h 400 --background-color=white <svg path> -o <png path>` (requires `rsvg-convert`, e.g. `brew install librsvg` -- if it's not on PATH, skip the image, note it in the run summary, and continue with the rest of the Confluence publish rather than blocking on it).
   c. Upload the PNG as a page attachment via a raw REST call (the Atlassian Rovo MCP has no attachment-upload tool, so this goes around it): `curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -X POST -H "X-Atlassian-Token: nocheck" -F "file=@<png path>;type=image/png" -F "comment=Standup aging WIP chart" "https://covermymeds.atlassian.net/wiki/rest/api/content/4048945159/child/attachment"`. From the JSON response take `results[0].extensions.fileId` and `results[0].extensions.collectionName` -- these are real Media Services identifiers (not the legacy `att...` attachment ID), safe to use directly in a media node.
   d. Embed it: `<figure data-type="media-single" data-layout="center" data-width="80"><div data-type="media" data-media-type="file" data-id="<fileId>" data-collection="<collectionName>" data-alt="Aging WIP chart"></div></figure>`. Each run uploads a fresh attachment and points the figure at the new one -- don't try to reuse or overwrite a prior day's attachment.
5. After the chart, convert the same `recommendations` blocks you wrote to the JSON data file into Confluence HTML: `heading` → `<h3>`, `paragraph` → `<p>`, `list` → `<ul><li>`. Confluence has no hover-card mechanism, so resolve every ticket key and `PR #nnn` mention to a real working link instead: `<a href="https://covermymeds.atlassian.net/browse/PARCH-nnn">PARCH-nnn</a>` for tickets, the actual PR URL (from the same data file's `prs` pool) for PR mentions. Render `**bold**` markers as `<strong>`. **Every** Jira ticket key that appears anywhere in the content -- including inside a bolded or otherwise-marked-up mention, and on every repeat of the same key across sections -- must be wrapped in its Jira link; a plain-text ticket code slipping through unlinked is a bug, not a style choice. Before publishing, scan your own draft HTML for the `[A-Z]+-[0-9]+` pattern and confirm each match sits inside an `<a href>`.
6. Call `getContentFormatGuide` with `{ toolName: "updateConfluencePage" }` before authoring the HTML if you haven't already this session, and follow its nesting rules.
7. Call `updateConfluencePage` with the full merged body (unchanged heading + national-day line + chart figure + new recommendations HTML + `<hr>` + everything after, untouched) and a `versionMessage` like "Standup — YYYY-MM-DD".

If the Atlassian Rovo MCP isn't connected, the page ID no longer resolves, or the update fails, report that clearly and move on -- the local report has already rendered successfully and the run is otherwise complete; don't retry in a loop or block on this step.

The standup run is complete once this step succeeds or is reported as skipped.
