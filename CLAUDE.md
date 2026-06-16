# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project purpose

Personal EM toolbox: Claude Code slash commands backed by plain Node.js scripts. Currently contains one command (`/standup`) for running a daily kanban standup report against a Jira project.

## Architecture

Each slash command is a thin `.md` file that tells Claude to run a Node.js script. All logic lives in the script.

```
.claude/
  commands/       # one .md file per slash command
  scripts/        # one .js file per command
  standup-context.json   # gitignored; managed by Claude, not edited manually
```

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

Gitignored. Managed entirely by Claude -- never edit manually. Structure:

```json
{
  "defaultExclude": ["Name to always omit"],
  "pto": [
    { "name": "Full Name", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "note": "reason" }
  ]
}
```

Tell Claude in natural language to update it: "Rob is out next week", "remove Jeffrey from the ignore list", "Seyoung is back Thursday".

## /standup

Runs a PARCH kanban standup report (default project). Override with `--project KEY`.

**Output includes:**
- National day of the day (deterministic pick, same for everyone on a given date)
- Computed SLE (85th percentile of 28-day cycle time history)
- Team Status: every active engineer, cards ordered right-to-left by kanban stage then age descending; available engineers get a suggested next backlog card
- Aging WIP chart: ASCII visualization of card age vs. workflow stage with SLE threshold
- Multi-Ticket Owners and Collaborator Load sections (used by Claude for recommendations)
- Writes `standup.md` to the working directory on every run

**PTO handling:** active PTO suppresses backlog suggestions; upcoming PTO (within 7 days) is flagged on the engineer's line.
