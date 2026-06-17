<!-- Flow metrics report: 8-week rolling kanban health for a single Jira project.
     Ported from pce-forecast; this skill is the authoritative source going forward.
     Usage: /metrics [--project KEY]
     Default project: PARCH. -->

Run:

```bash
node .claude/scripts/metrics.js $ARGUMENTS
```

The script writes `metrics.html` to the working directory and prints a summary to stdout.

Once it completes, open `metrics.html` in a browser and report the key numbers from stdout to the user:

- Current SLE and 7-week average SLE
- Average throughput (cards/week), last week count, std dev
- SLE hit rate
- At-risk count (breached and warning)

If any cards are breached or at risk, summarize them briefly by name and how far over commitment they are.
