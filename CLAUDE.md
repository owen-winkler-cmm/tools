# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project purpose

Personal EM toolbox: Claude Code slash commands for daily team operations and compliance workflows.

## Architecture

Each slash command is a `.md` file in `.claude/commands/`. Commands that need data from external APIs use a backing Node.js script in `.claude/scripts/`; commands that drive Claude directly via MCP tools or the `gh` CLI need no script.

```
.claude/
  commands/       # one .md file per slash command
  scripts/        # one .js file per script-backed commands
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

## /emreview

Performs an EM review of a GitHub pull request for SOX/ITGC compliance. Fetches PR metadata, commit history, review decisions, and the linked Jira ticket, then evaluates the 7 compliance criteria and produces a copyable PR comment.

**Usage:** `/emreview <PR number>` (default repo: `covermymeds/drugs-api`)

**Requires:** `gh` CLI authenticated + Atlassian Rovo MCP connected. No script -- runs entirely via `gh` and MCP tool calls.

**Output:** A markdown table with ✅/❌/⚠️ per criterion, a plain-English change summary, and a APPROVED/NOT APPROVED/PENDING verdict.

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

## /metadoc

Produces canonical meta-documents: reference documents that define what must be true or what must exist within a documentation hierarchy. Does **not** produce the project documents that fulfill those requirements -- those live in project folios and reference back to the meta-document.

**Usage:** `/metadoc [optional topic hint]`

**Requires:** Atlassian Rovo MCP connected (for optional Confluence publishing). No script -- runs entirely via interactive interview and MCP.

**What it produces:**
- **Meta-documents**: canonical references stating requirements by phase, with a "what must exist" table naming subordinate meta-docs and project templates. Short by design -- if requirements exceed ~15 items, the skill splits off a subordinate rather than expanding.
- **Subordinate meta-documents**: child documents that expand one complex requirement area from a parent meta-doc into its own structure. Published as Confluence children of their parent.
- **Project templates** (optional): project-facing starters teams clone into their folio. Pre-populated with required sections and guidance notes; back-reference the meta-doc as the compliance standard.

**Workflow:** Interactive interview → markdown draft for review → optional subordinate/template drafts → optional Confluence publish.
