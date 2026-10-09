#!/usr/bin/env node
// Standup: team derived from recent ticket assignments, no hard-coded names.
// Default project: PARCH. Override with --project KEY.

(function() {
  const fs = require('fs'), path = require('path');
  const f = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(f)) fs.readFileSync(f, 'utf8').split('\n').forEach(l => {
    const m = l.match(/^\s*([^#\s][^=]*?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  });
})();

// Context stash: persistent defaults loaded from .claude/standup-context.json
const ctx = (() => {
  const fs = require('fs'), path = require('path');
  const f = path.resolve(__dirname, '../standup-context.json');
  try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; } catch { return {}; }
})();

const rawArgs = process.argv.slice(2);

// ── Escaping + card-linking helpers ───────────────────────────────────────────────────────
// Used both by the aging-WIP chart/PR-preview HTML built during data collection below, and by
// the static-report renderer that `--render` invokes afterward.
function _esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
function _escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Auto-linkifies any mention of a known Jira key or "PR #N" in free text against the
// issues/prs pool from the data blob, so Recommendations prose gets the same linked,
// hover-card-enabled treatment as Team Status without Claude hand-writing <a> tags.
function cardLinks(rawText, issues, prs) {
  const bolded = _esc(String(rawText ?? '')).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const keys = Object.keys(issues);
  const issueRe = keys.length ? new RegExp('\\b(' + keys.map(_escRe).join('|') + ')\\b', 'g') : null;
  const prRe = /\bPR\s*#(\d+)\b/gi;
  const matches = [];
  if (issueRe) {
    let m;
    while ((m = issueRe.exec(bolded))) matches.push({ start: m.index, end: m.index + m[0].length, key: m[1], kind: 'issue' });
  }
  let pm;
  while ((pm = prRe.exec(bolded))) {
    if (prs[pm[1]]) matches.push({ start: pm.index, end: pm.index + pm[0].length, num: pm[1], text: pm[0], kind: 'pr' });
  }
  if (!matches.length) return bolded;
  matches.sort((a, b) => a.start - b.start);
  let out = '', cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue;
    out += bolded.slice(cursor, m.start);
    out += m.kind === 'issue' ? issueAnchor(m.key, issues) : prAnchor(m.num, m.text, prs);
    cursor = m.end;
  }
  out += bolded.slice(cursor);
  return out;
}
function issueAnchor(key, issues) {
  const d = issues[key];
  if (!d) return _esc(key);
  return '<a class="card-key tt" target="_blank" href="' + _esc(d.url) + '"' +
    ' data-key="' + _esc(key) + '" data-title="' + _esc(key + ' — ' + d.title) + '"' +
    ' data-summary="' + _esc(d.summary) + '" data-meta="' + _esc(d.meta) + '" data-url="' + _esc(d.url) + '">' +
    _esc(key) + '</a>';
}
function prAnchor(num, text, prs) {
  const d = prs[num];
  if (!d) return _esc(text);
  return '<a class="pr-info pr-link tt" target="_blank" href="' + _esc(d.url) + '"' +
    ' data-key="pr-' + num + '" data-title="' + _esc(d.title) + '"' +
    // d.summary is already-safe HTML (rendered from the PR body markdown) -- do not re-escape
    ' data-summary="' + d.summary + '" data-meta="' + _esc(d.meta) + '" data-url="' + _esc(d.url) + '" data-link-label="Open PR">' +
    _esc(text) + '</a>';
}

// ── Static report rendering ────────────────────────────────────────────────────────────────
// Turns the completed data blob into one self-contained HTML file: no fetch, no CDN, no
// polling -- safe to open via file://, email, or move anywhere.
function renderHeaderHtml(data) {
  let h = '<h1>' + _esc(data.projectName) + ' Standup — ' + _esc(data.dateLabel) + '</h1>';
  if (data.nationalDay) {
    h += '<p class="tagline">Today is: <a class="nd-label" href="' + _esc(data.nationalDay.url) +
      '" target="_blank" data-desc="' + _esc(data.nationalDay.description || '') + '">' +
      _esc(data.nationalDay.name) + '</a></p>';
  }
  if (data.sprint) {
    const s = data.sprint, m = data.sprintMetrics;
    const dayLabel = s.day != null
      ? 'Day ' + s.day + ' of ' + s.total + (s.endLabel ? ' · ends ' + _esc(s.endLabel) : '')
      : '';
    let prog = '';
    if (m) {
      const pct = m.committedPoints > 0 ? Math.round(m.donePoints / m.committedPoints * 100) : 0;
      prog = '<div class="sprint-progress"><div class="sprint-bar"><span style="width:' + pct + '%"></span></div>' +
        '<div class="sprint-prog-label">' + m.donePoints + '/' + m.committedPoints + ' pts · ' +
        m.doneCards + '/' + m.totalCards + ' cards done</div></div>';
    }
    h += '<div class="sprint-banner">' +
      '<div class="sprint-head"><span class="sprint-name">' + _esc(s.name) + '</span>' +
      (dayLabel ? '<span class="sprint-day">' + dayLabel + '</span>' : '') + '</div>' +
      (s.goal ? '<div class="sprint-goal"><strong>Goal:</strong> ' + _esc(s.goal) + '</div>' : '') +
      prog + '</div>';
  }
  return h;
}
function renderMetricsHtml(data) {
  let h = '';
  if (data.metrics) {
    const m = data.metrics;
    h += '<div class="metrics-row">' +
      '<span><strong>85th Percentile (SLE):</strong> ' + _esc(m.sleLabel) + '</span>' +
      '<span><strong>Median:</strong> ' + _esc(m.medianLabel) + '</span>' +
      '<span><strong>Sample:</strong> ' + m.sampleCount + ' completed cards (last ' + m.historyDays + ' days)</span>' +
      '<span><strong>Sprint backlog:</strong> ' + m.readyCardCount + ' unstarted card' + (m.readyCardCount === 1 ? '' : 's') +
      (m.runwayWeeks ? ' (~' + m.runwayWeeks + 'w)' : '') + '</span></div>';
  } else {
    h += '<p class="empty-note">No completed cards with changelog data -- SLE unavailable.</p>';
  }
  return h + '<div class="chart-wrap">' + (data.chartSvg || '') + '</div>';
}

// Sprint panel: committed/done points, velocity, and the burndown chart. Sits beside the Flow
// panel in the metrics row.
function renderSprintHtml(data) {
  const s = data.sprint, m = data.sprintMetrics;
  if (!s) return '<p class="empty-note">No active sprint on the board.</p>';
  if (!m) return '<p class="empty-note">Sprint metrics unavailable.</p>';
  const vel = m.velocity
    ? m.velocity.perSprint + ' pts/sprint (last ' + m.velocity.sprintsCounted + ' closed)'
    : 'first tracked sprint';
  let h = '<div class="metrics-row">' +
    '<span><strong>Committed:</strong> ' + m.committedPoints + ' pts</span>' +
    '<span><strong>Done:</strong> ' + m.donePoints + ' pts · ' + m.doneCards + '/' + m.totalCards + ' cards</span>' +
    '<span><strong>Velocity:</strong> ' + _esc(vel) + '</span></div>';
  if (m.unpointed) {
    h += '<p class="empty-note">' + m.unpointed + ' sprint card' + (m.unpointed === 1 ? '' : 's') +
      ' unpointed — burndown reflects pointed work only.</p>';
  }
  return h + '<div class="chart-wrap">' + (m.burndownSvg || '') + '</div>';
}

// Stragglers: in-flight cards not on the sprint. Returns the whole card so an empty list leaves
// no empty card behind in the template.
function renderStragglersHtml(data) {
  const issues = data.issues || {};
  const items = data.stragglers || [];
  if (!items.length) return '';
  let h = '<div class="card" id="stragglers-card"><h2>Stragglers <span class="card-sub">in flight, not in this sprint — consider pulling onto the board</span></h2><ul class="straggler-list">';
  for (const s of items) {
    h += '<li>' + issueAnchor(s.key, issues) +
      '<span class="card-title">' + _esc(s.title) + '</span>' +
      '<span class="card-status">' + _esc(s.status) + '</span>' +
      '<span class="card-age">' + s.days + 'd</span>' +
      '<span class="straggler-owner">' + _esc(s.owner || 'unassigned') + '</span></li>';
  }
  return h + '</ul></div>';
}
function renderTeamHtml(data) {
  const issues = data.issues || {}, prs = data.prs || {};
  let h = '';
  for (const eng of (data.engineers || [])) {
    h += '<div class="eng-block"><div class="eng-header">' +
      '<span class="eng-name">' + _esc(eng.name) + '</span>' +
      '<span class="eng-count">' + eng.count + ' card' + (eng.count === 1 ? '' : 's') + '</span>';
    if (eng.doneThisSprint) h += '<span class="done-chip">✓ ' + eng.doneThisSprint + ' done</span>';
    if (eng.badgeLevel) h += '<a href="#recommendations" class="wip-badge ' + eng.badgeLevel + '">⚠ WIP ' + _esc(eng.badgeLabel) + '</a>';
    if (eng.pto) h += '<span class="pto-tag' + (eng.pto.partial ? ' partial' : '') + '">' + _esc(eng.pto.label) + '</span>';
    h += '</div><ul class="card-list">';
    for (const c of (eng.cards || [])) {
      h += '<li>' + issueAnchor(c.key, issues) +
        '<span class="card-title">' + _esc(c.titleShort) + '</span>' +
        '<span class="card-status">' + _esc(c.status) + '</span>' +
        '<span class="card-age' + (c.over ? ' over-sle' : '') + '">' + c.days + 'd' + (c.over ? ' ⚠' : '') + '</span>';
      if (c.outOfSprint) h += '<span class="not-in-sprint">not in sprint</span>';
      if (c.pr) {
        if (c.pr.notNeeded) h += '<span class="pr-info pr-not-needed">no pr needed</span>';
        if (c.pr.missing) h += '<span class="pr-info pr-missing">no linked PR</span>';
        if (c.pr.active) {
          h += cardLinks(c.pr.mention, issues, prs) +
            '<span class="pr-info pr-decision pr-' + c.pr.decisionClass + '">' + _esc(c.pr.decision) + '</span>' +
            '<span class="pr-info">' + _esc(c.pr.lastAgo) + '</span>';
          if (c.pr.foundViaSearch) h += '<span class="pr-info pr-missing">not linked in Jira</span>';
        }
      }
      h += '</li>';
    }
    h += '</ul></div>';
  }
  for (const av of (data.available || [])) {
    h += '<div class="eng-block"><div class="eng-header"><span class="eng-name">' + _esc(av.name) + '</span>';
    if (av.pto) {
      h += '<span class="pto-tag' + (av.pto.kind === 'upcoming' ? ' upcoming' : '') + (av.pto.partial ? ' partial' : '') + '">' + _esc(av.pto.label) + '</span>';
    } else if (av.suggestion) {
      h += '<span class="avail-note">available → ' + issueAnchor(av.suggestion.key, issues) + ' ' + _esc(av.suggestion.summary) + ' <em>(' + _esc(av.suggestion.basis) + ')</em></span>';
    } else {
      h += '<span class="avail-note">available — <em>backlog exhausted</em></span>';
    }
    h += '</div></div>';
  }
  return h;
}
function renderRecommendationsHtml(data) {
  const issues = data.issues || {}, prs = data.prs || {};
  const recs = data.recommendations || [];
  if (!recs.length) return '<p class="recs-placeholder">No recommendations generated.</p>';
  let h = '';
  for (const block of recs) {
    if (block.type === 'heading') h += '<h3>' + cardLinks(block.text, issues, prs) + '</h3>';
    else if (block.type === 'paragraph') h += '<p>' + cardLinks(block.text, issues, prs) + '</p>';
    else if (block.type === 'list') h += '<ul>' + (block.items || []).map(i => '<li>' + cardLinks(i, issues, prs) + '</li>').join('') + '</ul>';
    else if (block.type === 'placeholder') h += '<p class="recs-placeholder">' + _esc(block.text) + '</p>';
  }
  return h;
}
function renderAvailabilityHtml(data) {
  const issues = data.issues || {}, prs = data.prs || {};
  const items = data.availability || [];
  if (!items.length) return '<p class="empty-note">No PTO or events in the next 30 days.</p>';
  let h = '<ul class="av-list">';
  for (const it of items) {
    h += '<li>';
    if (it.name) {
      h += '<strong>' + _esc(it.name) + '</strong> — ' + cardLinks(it.label, issues, prs) + (it.note ? ' (' + _esc(it.note) + ')' : '');
    } else {
      h += _esc(it.dateLabel) + ' — ' + cardLinks(it.label, issues, prs) + (it.note ? ' <span class="ev-note">' + _esc(it.note) + '</span>' : '');
    }
    h += '</li>';
  }
  return h + '</ul>';
}
function renderStaticHtml(data) {
  const fs = require('fs'), path = require('path');
  let html = fs.readFileSync(path.resolve(__dirname, '../assets/standup/report.html'), 'utf8');
  const tokens = {
    '<!--TITLE-->': _esc(data.projectName + ' Standup — ' + data.dateLabel),
    '<!--HEADER-->': renderHeaderHtml(data),
    '<!--METRICS-->': renderMetricsHtml(data),
    '<!--SPRINT-->': renderSprintHtml(data),
    '<!--STRAGGLERS-->': renderStragglersHtml(data),
    '<!--TEAM-->': renderTeamHtml(data),
    '<!--RECOMMENDATIONS-->': renderRecommendationsHtml(data),
    '<!--AVAILABILITY-->': renderAvailabilityHtml(data),
  };
  for (const [token, value] of Object.entries(tokens)) html = html.split(token).join(value);
  return html;
}

// `--render <data.json>` turns a completed data blob (fetched + Claude-annotated with
// recommendations and the national-day description) into the final static report and exits --
// no Jira credentials or network access needed, so this runs before the BASE/EMAIL/TOKEN check.
{
  const renderFlagIdx = rawArgs.indexOf('--render');
  if (renderFlagIdx !== -1) {
    const fs = require('fs'), path = require('path'), os = require('os');
    const dataPath = rawArgs[renderFlagIdx + 1];
    if (!dataPath) { console.error('--render requires a path to a data JSON file (see DATA_OUT: from a prior run)'); process.exit(1); }
    let data;
    try { data = JSON.parse(fs.readFileSync(dataPath, 'utf8')); }
    catch (e) { console.error('Could not read/parse ' + dataPath + ': ' + e.message); process.exit(1); }
    const outPath = path.join(os.tmpdir(), `standup-${new Date().toISOString().slice(0, 10)}.html`);
    fs.writeFileSync(outPath, renderStaticHtml(data), 'utf8');
    console.log('REPORT_OUT:' + outPath);
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try { require('child_process').execSync(opener + ' ' + JSON.stringify(outPath)); } catch { /* non-fatal */ }
    process.exit(0);
  }
}

// Returns true when an In Review ticket with no linked PR is non-code work.
// Description is checked first: any mention of a PR/pull request overrides classification.
// Then checks issue type, built-in summary patterns, and ctx.noPrKeywords.
// Ambiguous tickets that pass through here are handled by classifyNoPrTickets (AI fallback).
function looksLikeNoPr(row) {
  if (/pull\s+request|merge\s+request|\bDB\s+PR\b|open\s+a\s+(PR|pull)\b|submit\s+a\s+(DB\s+)?PR\b/i.test(row.descriptionText || '')) return false;
  const noPrTypeSet = new Set(
    ctx.noPrTypes !== undefined
      ? ctx.noPrTypes
      : ['Task', 'Sub-task', 'Question', 'Documentation', 'Knowledge Article', 'Request', 'Process', 'Service Request']
  );
  if (row.issueType && noPrTypeSet.has(row.issueType)) return true;
  const s = row.summary || '';
  const builtIn = [/\bKD:/i, /\bARB\b/i, /\baccess\s+to\s+/i];
  if (builtIn.some(re => re.test(s))) return true;
  if (ctx.noPrKeywords?.some(kw => s.toLowerCase().includes(kw.toLowerCase()))) return true;
  return false;
}

// Fetches OOO entries from the team M365 group calendar (GRP Dumpster Firefighters OOO).
// Returns entries shaped like ctx.pto: { name, start, end, note }.
// Fails silently if az CLI is unavailable or the session token is expired.
// The group calendar's Graph dateTime values come back with timeZone: 'UTC' -- convert to the
// team's local (Eastern) wall-clock time rather than reading the raw digits as if already local.
const CALENDAR_DISPLAY_TZ = 'America/New_York';
function utcGraphDateTimeToMs(dt) {
  if (!dt) return null;
  const ms = Date.parse(/Z$/.test(dt) ? dt : dt + 'Z');
  return Number.isNaN(ms) ? null : ms;
}
// Extracts "1:00 PM" style Eastern clock time from a UTC Graph dateTime string like "2026-07-31T19:00:00.0000000"
function fmtClockTime(dt) {
  const ms = utcGraphDateTimeToMs(dt);
  if (ms == null) return null;
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: CALENDAR_DISPLAY_TZ });
}

async function fetchGroupOOO() {
  const GROUP_ID = '5731e1d4-4127-47f1-a547-4043adae8792';
  const from = new Date(NOW - 30 * 86400000).toISOString().slice(0, 10);
  try {
    const { execSync } = require('child_process');
    const url = `https://graph.microsoft.com/v1.0/groups/${GROUP_ID}/calendar/events` +
      `?$filter=end/dateTime ge '${from}T00:00:00Z'&$select=subject,start,end,isAllDay&$top=100&$orderby=start/dateTime`;
    const out = execSync(`az rest --method GET --url ${JSON.stringify(url)} 2>/dev/null`, { encoding: 'utf8', timeout: 12000 });
    const data = JSON.parse(out);
    const entries = [];
    for (const ev of (data.value || [])) {
      const m = (ev.subject || '').match(/^([A-Za-z]+(?:\s+[A-Za-z]+)?)\s+OOO(?:\s*[-–]\s*(.+))?/i);
      if (!m) continue;
      const name = m[1].trim();
      const note = m[2] ? m[2].trim() : null;
      let startDate, endDate;
      if (ev.isAllDay) {
        startDate = ev.start.dateTime.slice(0, 10);
        const endDt = new Date(ev.end.dateTime);
        endDt.setUTCDate(endDt.getUTCDate() - 1);
        endDate = endDt.toISOString().slice(0, 10);
        entries.push({ name, start: startDate, end: endDate, note, source: 'calendar', allDay: true });
      } else {
        // Time-scale OOO (e.g. a 1pm-5pm appointment): keep the clock window so getActivePto
        // can tell "out this afternoon" apart from "out all day".
        startDate = ev.start.dateTime.slice(0, 10);
        endDate = ev.end.dateTime.slice(0, 10);
        entries.push({
          name, start: startDate, end: endDate, note, source: 'calendar', allDay: false,
          startTime: fmtClockTime(ev.start.dateTime),
          endTime: fmtClockTime(ev.end.dateTime),
          startAt: utcGraphDateTimeToMs(ev.start.dateTime),
          endAt: utcGraphDateTimeToMs(ev.end.dateTime),
        });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// Converts a Jira ADF (Atlassian Document Format) description, as a JSON string, to plain text.
function adfToText(adfJson, maxLen = 500) {
  try {
    const walk = n => !n ? '' : n.text ? n.text : (n.content || []).map(walk).join(' ');
    return walk(JSON.parse(adfJson)).replace(/\s+/g, ' ').trim().slice(0, maxLen);
  } catch { return ''; }
}

// Calls Claude Haiku to classify In-Review tickets that slipped past looksLikeNoPr.
// Sets row.aiNoPr = true for those that don't need a code PR.
async function classifyNoPrTickets(rows) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const ambiguous = rows.filter(r => r.prSearched && !r.prActivity && !looksLikeNoPr(r));
  if (!ambiguous.length) return;

  const ticketList = ambiguous.map(r => {
    const desc = adfToText(r.descriptionText);
    return `${r.key} [${r.issueType}]: ${r.summary}\nDescription: ${desc}`;
  }).join('\n\n---\n\n');

  const prompt = `Classify each Jira ticket: does it require a GitHub code pull request ("needs_pr"), or is it non-code work ("no_pr_needed")?

Non-code: compliance assessments (OneTrust, AIA, GRC), ServiceNow/platform team requests, access requests, documentation, knowledge articles, API key provisioning where the team requests a key from another team, and similar administrative or process work.

Code (needs PR): implementing features, fixing bugs, changing codebase files (package.json, configs, CI, source code), removing/adding dependencies, updating docs that live in the repo itself, etc.

Tickets to classify:
${ticketList}

Reply with ONLY a JSON object. Example: {"PARCH-123":"no_pr_needed","PARCH-456":"needs_pr"}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return;
    const result = JSON.parse(m[0]);
    for (const row of ambiguous) {
      if (result[row.key] === 'no_pr_needed') row.aiNoPr = true;
    }
  } catch { /* silent fallback */ }
}

const BASE = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;

if (!BASE || !EMAIL || !TOKEN) {
  console.error('Missing env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN');
  process.exit(1);
}

const AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;

const normalizeN = s => s.toLowerCase().replace(/[^a-z ]/g, '').trim();

const projectFlagIdx = rawArgs.indexOf('--project');
const PROJECT = projectFlagIdx !== -1 && rawArgs[projectFlagIdx + 1]
  ? rawArgs[projectFlagIdx + 1].toUpperCase()
  : 'PARCH';

const boardFlagIdx = rawArgs.indexOf('--board');
const BOARD_ID = boardFlagIdx !== -1 && rawArgs[boardFlagIdx + 1]
  ? parseInt(rawArgs[boardFlagIdx + 1], 10)
  : 10731;

// Optional --sprint ID pins the report to a specific sprint; default is the board's
// current active sprint (Dumpster Firefighters Sprint Board is a Scrum board now).
const sprintFlagIdx = rawArgs.indexOf('--sprint');
const SPRINT_OVERRIDE = sprintFlagIdx !== -1 && rawArgs[sprintFlagIdx + 1]
  ? parseInt(rawArgs[sprintFlagIdx + 1], 10)
  : null;

const excludeFlagIdx = ['--exclude', '--ignore'].reduce((found, flag) => {
  const idx = rawArgs.indexOf(flag);
  return idx !== -1 ? idx : found;
}, -1);
// Merge context-file defaults with any --exclude/--ignore terms from CLI
const excludeTerms = [
  ...(ctx.defaultExclude || []).map(s => normalizeN(s)),
  ...(excludeFlagIdx !== -1 && rawArgs[excludeFlagIdx + 1]
    ? rawArgs[excludeFlagIdx + 1].split(',').map(s => normalizeN(s.trim())).filter(Boolean)
    : []),
];
const skipGithub = rawArgs.includes('--skip-github');
const isExcluded = name => excludeTerms.length > 0 && excludeTerms.some(t => normalizeN(name).includes(t));

// Team membership: engineers active within this window are included even if idle now
const TEAM_WINDOW_DAYS = 14;
// SLE history window and confidence level
const SLE_HISTORY_DAYS = 28;
const SLE_PERCENTILE = 0.85;

const NOW = Date.now();
const todayStr    = new Date(NOW).toISOString().slice(0, 10);
const TEAM_CUTOFF = new Date(NOW - TEAM_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
const SLE_CUTOFF  = new Date(NOW - SLE_HISTORY_DAYS * 86400000).toISOString().slice(0, 10);

// ── CMM observed holidays: computed once per year and cached in standup-context.json ─────────
function nthWeekdayOfMonth(year, month, weekday, n) {
  const d = new Date(Date.UTC(year, month, 1));
  let count = 0;
  while (true) {
    if (d.getUTCDay() === weekday) { count++; if (count === n) return d.toISOString().slice(0, 10); }
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
function lastWeekdayOfMonth(year, month, weekday) {
  const d = new Date(Date.UTC(year, month + 1, 0));
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
// Federal-style observance: a holiday landing on Saturday moves to Friday, on Sunday to Monday
function observedDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function addDaysIso(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function computeUsHolidays(year) {
  const thanksgiving = nthWeekdayOfMonth(year, 10, 4, 4); // 4th Thursday of November
  return [
    { name: "New Year's Day", date: observedDate(`${year}-01-01`) },
    { name: 'MLK Day', date: nthWeekdayOfMonth(year, 0, 1, 3) }, // 3rd Monday of January
    { name: 'Memorial Day', date: lastWeekdayOfMonth(year, 4, 1) }, // last Monday of May
    { name: 'Juneteenth', date: observedDate(`${year}-06-19`) },
    { name: 'Independence Day', date: observedDate(`${year}-07-04`) },
    { name: 'Labor Day', date: nthWeekdayOfMonth(year, 8, 1, 1) }, // 1st Monday of September
    { name: 'Thanksgiving', date: thanksgiving },
    { name: 'Day after Thanksgiving', date: addDaysIso(thanksgiving, 1) },
    { name: 'Christmas Day', date: observedDate(`${year}-12-25`) },
  ].sort((a, b) => a.date.localeCompare(b.date));
}

const CURRENT_YEAR = new Date(NOW).getFullYear();
let holidaySet;
if (ctx.holidays && ctx.holidays.year === CURRENT_YEAR && Array.isArray(ctx.holidays.dates)) {
  holidaySet = new Set(ctx.holidays.dates);
} else {
  const computed = computeUsHolidays(CURRENT_YEAR);
  holidaySet = new Set(computed.map(h => h.date));
  ctx.holidays = { year: CURRENT_YEAR, dates: [...holidaySet] };
  try {
    const fs = require('fs'), path = require('path');
    const ctxPath = path.resolve(__dirname, '../standup-context.json');
    const onDisk = fs.existsSync(ctxPath) ? JSON.parse(fs.readFileSync(ctxPath, 'utf8')) : {};
    onDisk.holidays = ctx.holidays;
    fs.writeFileSync(ctxPath, JSON.stringify(onDisk, null, 2) + '\n', 'utf8');
  } catch { /* non-fatal: recomputed next run */ }
}

function isWorkDay(dateStr) {
  const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return dow !== 0 && dow !== 6 && !holidaySet.has(dateStr);
}
// Advances to the next work day on/after dateStr, skipping weekends and CMM holidays
function nextWorkDay(dateStr) {
  let d = dateStr;
  while (!isWorkDay(d)) d = addDaysIso(d, 1);
  return d;
}
const NEXT_WORK_DAY = nextWorkDay(addDaysIso(todayStr, 1));

// Parses a "1:00 PM" style clock time onto a given YYYY-MM-DD date, returning epoch ms (local time)
function parseClockTime(dateStr, timeStr) {
  const m = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/.exec((timeStr || '').trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) hour += 12;
  const [y, mo, da] = dateStr.split('-').map(Number);
  return new Date(y, mo - 1, da, hour, parseInt(m[2], 10)).getTime();
}

// Returns the active PTO/OOO entry for a name, or null. For a partial-day (allDay: false)
// entry, "active" also requires the current time to fall within its start/end clock window --
// someone out 1-5pm shouldn't be marked out all day.
function getActivePto(name) {
  const nName = normalizeN(name);
  return (ctx.pto || []).find(e => {
    const nEntry = normalizeN(e.name);
    if (!(nName.includes(nEntry) || nEntry.includes(nName))) return false;
    if (!(e.start <= todayStr && todayStr <= e.end)) return false;
    if (e.allDay === false) {
      const startAt = e.startAt ?? (e.startTime ? parseClockTime(e.start, e.startTime) : null);
      const endAt = e.endAt ?? (e.endTime ? parseClockTime(e.end, e.endTime) : null);
      if (startAt != null && endAt != null) return NOW >= startAt && NOW <= endAt;
    }
    return true;
  }) ?? null;
}

// Returns PTO entries starting after today but within the next 7 calendar days
function getUpcomingPto(name) {
  const nName = normalizeN(name);
  const lookahead = new Date(NOW + 7 * 86400000).toISOString().slice(0, 10);
  return (ctx.pto || []).filter(e => {
    const nEntry = normalizeN(e.name);
    return (nName.includes(nEntry) || nEntry.includes(nName)) &&
           e.start > todayStr && e.start <= lookahead;
  });
}

function fmtDate(iso) {
  const [, m, d] = iso.split('-');
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m,10)-1]
    + ' ' + parseInt(d,10);
}

// Label for a PTO/OOO entry that's active right now. A partial-day (allDay: false) entry
// shows its clock window since the person is back at work later the same day; a full-day
// entry shows the date it runs through.
function ptoActiveLabel(entry) {
  if (entry.allDay === false && entry.startTime && entry.endTime) {
    return `Out ${entry.startTime}–${entry.endTime}`;
  }
  return `PTO through ${fmtDate(entry.end)}`;
}

// Label for a PTO/OOO entry that hasn't started yet
function ptoUpcomingLabel(entry) {
  const range = entry.end > entry.start ? `${fmtDate(entry.start)}–${fmtDate(entry.end)}` : fmtDate(entry.start);
  const timeSuffix = entry.allDay === false && entry.startTime && entry.endTime
    ? ` (${entry.startTime}–${entry.endTime})` : '';
  return `PTO ${range}${timeSuffix}${entry.note ? ` (${entry.note})` : ''}`;
}

// "Returns" label for an entry that's active today: a partial-day absence returns later
// today, a full-day one returns the next work day (skipping weekends and CMM holidays)
// after its last day.
function ptoReturnsLabel(entry) {
  if (entry.allDay === false && entry.startTime && entry.endTime) {
    return `Out today ${entry.startTime}–${entry.endTime}`;
  }
  return `On PTO, returns ${fmtDate(nextWorkDay(addDaysIso(entry.end, 1)))}`;
}

// Static per-point SLE used for individual card ⚠ flags
const STORY_POINTS_FIELD = 'customfield_13078';
const SLE_BY_POINTS = { 1: 2, 2: 4, 3: 6, 5: 10, 8: 14, 13: 20, 20: 30, 21: 30 };
const DEFAULT_SLE_DAYS = 12;
const sleDays = pts => pts != null ? (SLE_BY_POINTS[pts] ?? DEFAULT_SLE_DAYS) : DEFAULT_SLE_DAYS;

// "Working" statuses (In Progress + Reviewing columns on the board) are derived from the live
// board config at runtime -- see buildWorkingStatusNames below -- rather than hard-coded. On the
// Scrum board every working status is already in Jira's "In Progress" category (the "Planned"
// status included), so there's no longer a To-Do-category column to special-case.

async function jiraGet(p) {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: AUTH, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET ${p} => ${r.status}: ${await r.text()}`);
  return r.json();
}

async function jiraPost(p, body) {
  const r = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${p} => ${r.status}: ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function searchAll(jql, fields, expand = null) {
  const issues = [];
  let pageToken = null;
  while (true) {
    const q = new URLSearchParams({ jql, fields, maxResults: '100' });
    if (expand) q.set('expand', expand);
    if (pageToken) q.set('nextPageToken', pageToken);
    const d = await jiraGet(`/rest/api/3/search/jql?${q}`);
    issues.push(...d.issues);
    if (d.isLast || !d.issues.length) break;
    pageToken = d.nextPageToken;
  }
  return issues;
}

// GitHub hosts the team's PRs live on: github.com (covermymeds org) plus the
// internal GHE instance. Jira's dev-status/remotelink integration only knows about
// github.com, so anything on the other hosts needs the gh-search fallback below.
const GH_HOSTS = ['github.com', 'git.innova-partners.com'];
const prPattern = new RegExp(
  '(' + GH_HOSTS.map(h => h.replace(/\./g, '\\.')).join('|') + ')\\/[^/]+\\/[^/]+\\/pull\\/\\d+'
);

async function fetchRemoteLinks(issueKey, issueId) {
  const urls = new Set();
  try {
    const links = await jiraGet(`/rest/api/3/issue/${issueKey}/remotelink`);
    for (const l of (Array.isArray(links) ? links : [])) {
      const u = l.object?.url;
      if (u && prPattern.test(u)) urls.add(u);
    }
  } catch { /* ignore */ }
  // Also check Jira's development-panel integration (GitHub app / smart commits).
  // Must discover instance type keys via the summary first — the applicationType
  // value varies by integration (e.g. "oAuth-com.github.integration.production").
  if (issueId) {
    try {
      const summary = await jiraGet(`/rest/dev-status/1.0/issue/summary?issueId=${issueId}`);
      const instanceTypes = Object.keys(summary?.summary?.pullrequest?.byInstanceType ?? {});
      for (const appType of instanceTypes) {
        try {
          const devInfo = await jiraGet(
            `/rest/dev-status/1.0/issue/detail?issueId=${issueId}&applicationType=${encodeURIComponent(appType)}&dataType=pullrequest`
          );
          for (const detail of (devInfo?.detail ?? [])) {
            for (const pr of (detail.pullRequests ?? [])) {
              if (pr.url && prPattern.test(pr.url)) urls.add(pr.url);
            }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return [...urls];
}

// Fallback for tickets with zero Jira-side PR data (remote link + dev-status both empty).
// Jira's dev-status integration doesn't reach the internal GHE host, so a PR living there
// is otherwise invisible even though `gh` is authenticated to both hosts. Only trusts a
// search hit whose title explicitly names the issue key, to reject the loose keyword
// matches `gh search prs` otherwise turns up (e.g. unrelated PRs that happen to share digits).
async function searchGhForIssue(issueKey) {
  const { execFile } = require('child_process');
  const run = (host) => new Promise(resolve => {
    const env = host === 'github.com' ? process.env : { ...process.env, GH_HOST: host };
    execFile('gh', ['search', 'prs', issueKey, '--json', 'title,url', '--limit', '20'], { timeout: 15000, env }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try {
        const results = JSON.parse(stdout);
        const keyRe = new RegExp(`\\b${issueKey}\\b`, 'i');
        const hit = results.find(r => keyRe.test(r.title || ''));
        resolve(hit ? { url: hit.url, title: hit.title } : null);
      } catch { resolve(null); }
    });
  });
  for (const host of GH_HOSTS) {
    const hit = await run(host);
    if (hit) return hit;
  }
  return null;
}

// Auto-links a PR found only via GitHub search (not Jira remotelink/dev-status) back onto the
// issue, so the gap doesn't have to be rediscovered by hand every run. Only ever called when
// fetchRemoteLinks came back empty (no pre-existing associated PR), and the match itself is
// already exact-key-in-title (see searchGhForIssue) -- best-effort, non-fatal on any failure.
async function autoLinkPrToJira(issueKey, prUrl, prTitle) {
  try {
    await jiraPost(`/rest/api/3/issue/${issueKey}/remotelink`, {
      object: { url: prUrl, title: prTitle },
    });
    await jiraPost(`/rest/api/3/issue/${issueKey}/comment`, {
      body: {
        type: 'doc',
        version: 1,
        content: [{
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Auto-associated pull request ' },
            { type: 'text', text: prUrl, marks: [{ type: 'link', attrs: { href: prUrl } }] },
            { type: 'text', text: ` based on this issue key appearing in the PR title ("${prTitle}"). Added by the standup script -- verify it's the right PR.` },
          ],
        }],
      },
    });
    return true;
  } catch (e) {
    console.error(`  (auto-link failed for ${issueKey}: ${e.message})`);
    return false;
  }
}

async function fetchPrActivity(prUrl) {
  const match = prUrl.match(/(github\.com|git\.innova-partners\.com)\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  const [, host, repo, num] = match;
  const repoArg = host === 'github.com' ? repo : `${host}/${repo}`;
  return new Promise(resolve => {
    require('child_process').exec(
      `gh pr view ${num} --repo ${repoArg} --json updatedAt,latestReviews,reviewRequests,comments,state,reviewDecision,body`,
      { timeout: 15000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const d = JSON.parse(stdout);
          const dates = [];
          if (d.updatedAt) dates.push(new Date(d.updatedAt).getTime());
          for (const r of (d.latestReviews || [])) {
            if (r.submittedAt) dates.push(new Date(r.submittedAt).getTime());
          }
          for (const c of (d.comments || [])) {
            if (c.createdAt) dates.push(new Date(c.createdAt).getTime());
          }
          resolve({
            prUrl,
            repo: host === 'github.com' ? repo : `${repo} (${host})`,
            num: parseInt(num),
            state: d.state,
            reviewDecision: d.reviewDecision,
            // Preserve line breaks (needed for markdown headers/bullets) -- only collapse
            // horizontal whitespace and excess blank lines.
            body: (d.body || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
            reviewers: (d.latestReviews || []).map(r => ({
              author: r.author?.login, state: r.state, at: r.submittedAt,
            })),
            requestedReviewers: (d.reviewRequests || [])
              .map(r => r.requestedReviewer?.login || r.requestedReviewer?.name)
              .filter(Boolean),
            lastActivity: dates.length ? new Date(Math.max(...dates)) : null,
            commentCount: (d.comments || []).length,
          });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// Fetch today's national/special days from daysoftheyear.com.
// Returns an array of {name, description, dayUrl} objects, or null on any failure (always silent).
async function fetchNationalDays() {
  try {
    const r = await fetch('https://www.daysoftheyear.com/today/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; standup-report/1.0)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const days = [];
    const re = /<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]{0,600})/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const h3Inner = m[1];
      const afterH3 = m[2];
      const name = h3Inner.replace(/<[^>]+>/g, '').trim();
      if (name.length < 4 || name.length > 80 || !/day|week|month/i.test(name)) continue;

      const aMatch = h3Inner.match(/href="([^"]+)"/i);
      const dayUrl = aMatch
        ? (aMatch[1].startsWith('http') ? aMatch[1] : 'https://www.daysoftheyear.com' + aMatch[1])
        : 'https://www.google.com/search?q=' + encodeURIComponent(name) + '&btnI=1';

      const pMatch = afterH3.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      let description = null;
      if (pMatch) {
        const raw = pMatch[1].replace(/<[^>]+>/g, '').trim();
        if (raw.length >= 10) description = raw.length > 200 ? raw.slice(0, 197) + '…' : raw;
      }

      days.push({ name, description, dayUrl });
      if (days.length >= 5) break;
    }
    return days.length ? days : null;
  } catch {
    return null;
  }
}

function humanDuration(ms) {
  const d = Math.floor(ms / 86400000);
  if (d < 7)   return `${d} day${d !== 1 ? 's' : ''}`;
  if (d < 30)  return `${Math.floor(d / 7)} week${Math.floor(d / 7) !== 1 ? 's' : ''}`;
  if (d < 365) return `${Math.floor(d / 30)} month${Math.floor(d / 30) !== 1 ? 's' : ''}`;
  return `${Math.floor(d / 365)} year${Math.floor(d / 365) !== 1 ? 's' : ''}`;
}

const trunc = (s, n) => s.length <= n ? s : s.slice(0, n - 1) + '…';

const _origLog = console.log.bind(console);
console.log = (...args) => { _origLog(...args); };

(async () => {
  // ── Phase 1: board shape + sprint + the project-wide 28d completed set ──────────────────────
  // The sprint-scoped queries below need the board's column→status map first (to know which
  // statuses are "working"), so board config / status metadata / sprint lists are fetched up
  // front; the completed set for SLE is project-wide and independent, so it rides along here.
  const [statusTypes, allFields, boardConfig, activeSprintResp, closedSprintResp, completed] = await Promise.all([
    jiraGet(`/rest/api/3/project/${PROJECT}/statuses`),
    jiraGet('/rest/api/3/field'),
    jiraGet(`/rest/agile/1.0/board/${BOARD_ID}/configuration`).catch(() => null),
    jiraGet(`/rest/agile/1.0/board/${BOARD_ID}/sprint?state=active`).catch(() => null),
    jiraGet(`/rest/agile/1.0/board/${BOARD_ID}/sprint?state=closed`).catch(() => null),
    // 28-day completed set for both SLE calculation and team membership (14d subset)
    searchAll(
      `project = ${PROJECT} AND issuetype != Epic AND statusCategory = Done AND updated >= "${SLE_CUTOFF}" AND assignee is not EMPTY`,
      'assignee,statuscategorychangedate,components',
      'changelog',
    ),
  ]);

  const collabFieldId = allFields.find(f => f.name === 'Collaborators')?.id ?? null;

  // Build status category map for changelog parsing
  const categoryByStatus = new Map();
  for (const issueType of statusTypes) {
    for (const status of issueType.statuses) {
      categoryByStatus.set(status.name, status.statusCategory.key);
    }
  }

  const statusNameById = new Map();
  for (const issueType of statusTypes) {
    for (const s of issueType.statuses) statusNameById.set(String(s.id), s.name);
  }

  // statusToColumn: Jira status name → board column name
  // columnLimits: board column name → max WIP (0 = hard zero — any card here is a violation)
  // columnMins:   board column name → min WIP (under this = possible under-utilization)
  // statusColumnIndex: status name → board column position (0 = leftmost); drives right-to-left
  //   card ordering without keyword guessing (replaces the old statusRank heuristic).
  const statusToColumn = new Map();
  const columnLimits = new Map();
  const columnMins = new Map();
  const statusColumnIndex = new Map();
  const boardColumns = boardConfig?.columnConfig?.columns || [];
  boardColumns.forEach((col, idx) => {
    if (col.max != null) columnLimits.set(col.name, col.max);
    if (col.min != null) columnMins.set(col.name, col.min);
    for (const st of (col.statuses || [])) {
      const id = String(st.id ?? (st.self || '').match(/\/(\d+)$/)?.[1] ?? '');
      const name = statusNameById.get(id);
      if (name) { statusToColumn.set(name, col.name); statusColumnIndex.set(name, idx); }
    }
  });
  const colIdx = statusName => statusColumnIndex.get(statusName) ?? 1;

  // "Working" statuses = those sitting in the board's In Progress + Reviewing columns. Derived
  // from the live board so renamed/added columns don't need a code change. Fallback to Jira's
  // In Progress category if the board config is unavailable.
  const workingStatusNames = [];
  for (const col of boardColumns) {
    if (!/in\s*progress|review/i.test(col.name)) continue;
    for (const st of (col.statuses || [])) {
      const name = statusNameById.get(String(st.id ?? (st.self || '').match(/\/(\d+)$/)?.[1] ?? ''));
      if (name) workingStatusNames.push(name);
    }
  }
  const workingStatusJql = workingStatusNames.length
    ? `status in (${workingStatusNames.map(s => `"${s}"`).join(',')})`
    : `statusCategory = "In Progress"`;

  // Resolve the sprint to report on: an explicit --sprint ID, else the board's active sprint.
  let sprint = null;
  if (SPRINT_OVERRIDE) {
    sprint = await jiraGet(`/rest/agile/1.0/sprint/${SPRINT_OVERRIDE}`).catch(() => null);
  } else {
    sprint = activeSprintResp?.values?.[0] ?? null;
  }
  const closedSprints = (closedSprintResp?.values || [])
    .filter(s => s.completeDate || s.endDate)
    .sort((a, b) => new Date(b.completeDate || b.endDate) - new Date(a.completeDate || a.endDate));

  const issueFields = ['assignee', 'summary', 'status', 'statuscategorychangedate', STORY_POINTS_FIELD, 'issuetype', 'description'].join(',');
  const backlogFields = `summary,description,components,priority,${STORY_POINTS_FIELD}`;

  // ── Phase 2: the sprint-scoped populations ──────────────────────────────────────────────────
  // sprintIssues: the whole active sprint (every column, Done included).
  // stragglers:   working-status cards NOT in the sprint -- in-flight work off the board that
  //               should probably be pulled in. Surfaced, never silently added to the sprint.
  // backlog:      unstarted, unassigned sprint cards -- the "pull next" queue for an open person.
  // With no active sprint we degrade to the old project-wide working-status view.
  let sprintIssues = [], stragglers = [], backlog = [];
  if (sprint) {
    [sprintIssues, stragglers, backlog] = await Promise.all([
      searchAll(`project = ${PROJECT} AND sprint = ${sprint.id} AND issuetype != Epic`, issueFields, 'changelog'),
      searchAll(`project = ${PROJECT} AND issuetype != Epic AND ${workingStatusJql} AND (sprint IS EMPTY OR sprint != ${sprint.id})`, issueFields, 'changelog'),
      searchAll(`project = ${PROJECT} AND issuetype != Epic AND sprint = ${sprint.id} AND statusCategory = "To Do" AND assignee is EMPTY ORDER BY created ASC`, backlogFields),
    ]);
  } else {
    [sprintIssues, backlog] = await Promise.all([
      searchAll(`project = ${PROJECT} AND issuetype != Epic AND ${workingStatusJql}`, issueFields, 'changelog'),
      searchAll(`project = ${PROJECT} AND issuetype != Epic AND statusCategory = "To Do" AND assignee is EMPTY ORDER BY created ASC`, backlogFields),
    ]);
  }

  const isDoneCat = name => categoryByStatus.get(name) === 'done';
  const isWorkingCat = name => categoryByStatus.get(name) === 'indeterminate';

  // Raw in-flight set shown in Team Status + the aging-WIP chart: active (indeterminate) sprint
  // cards plus every straggler, each tagged with its sprint membership. Done sprint cards are
  // held back for the sprint-progress metric / per-engineer done chip, not the active WIP list.
  const sprintActive = sprintIssues.filter(i => isWorkingCat(i.fields.status?.name));
  const sprintDoneIssues = sprintIssues.filter(i => isDoneCat(i.fields.status?.name) && i.fields.status?.name !== 'Discard');
  for (const i of sprintActive) i._inSprint = true;
  for (const i of stragglers)   i._outOfSprint = true;
  const activeRaw = [...sprintActive, ...stragglers];

  // Collaborators ride on a separate query (can't mix the field with a changelog expand cleanly),
  // scoped to exactly the cards we're about to show.
  const collabsByKey = new Map();
  const activeKeys = activeRaw.map(i => i.key);
  if (collabFieldId && activeKeys.length) {
    const collabIssues = await searchAll(
      `project = ${PROJECT} AND key in (${activeKeys.join(',')})`,
      `summary,${collabFieldId}`,
    );
    for (const issue of collabIssues) {
      const collabs = Array.isArray(issue.fields[collabFieldId])
        ? issue.fields[collabFieldId].map(u => u.displayName)
        : [];
      if (collabs.length) collabsByKey.set(issue.key, collabs);
    }
  }

  // Compute actual cycle time from changelog (first In Progress → Done). Every working status
  // now lives in Jira's "In Progress" category, so entry into that category is the cycle start.
  function getCycleTime(issue) {
    const histories = (issue.changelog?.histories || [])
      .slice()
      .sort((a, b) => new Date(a.created) - new Date(b.created));
    let startTime = null;
    let endTime = null;
    for (const history of histories) {
      for (const item of history.items) {
        if (item.field !== 'status') continue;
        const cat = categoryByStatus.get(item.toString);
        if (!startTime && cat === 'indeterminate') startTime = new Date(history.created).getTime();
        if (cat === 'done') endTime = new Date(history.created).getTime();
      }
    }
    return startTime && endTime && endTime > startTime ? endTime - startTime : null;
  }

  // First transition into a Done-category status, in ms (for the sprint burndown). Null if the
  // card never reached Done.
  function firstDoneMs(issue) {
    const histories = (issue.changelog?.histories || [])
      .slice()
      .sort((a, b) => new Date(a.created) - new Date(b.created));
    for (const history of histories) {
      for (const item of history.items) {
        if (item.field === 'status' && categoryByStatus.get(item.toString) === 'done') {
          return new Date(history.created).getTime();
        }
      }
    }
    return null;
  }

  // Computed SLE and throughput: scoped to active (non-excluded) team members only
  const activeCompleted = completed.filter(i => !isExcluded(i.fields.assignee?.displayName ?? ''));
  const cycleTimes = activeCompleted.map(getCycleTime).filter(ct => ct !== null).sort((a, b) => a - b);
  const computedSleMsRaw = percentile(cycleTimes, SLE_PERCENTILE);
  const computedSleMs = computedSleMsRaw ?? DEFAULT_SLE_DAYS * 86400000;

  // Sprint backlog depth: unstarted, unassigned cards committed to the sprint, vs. throughput.
  const readyCardCount = backlog.length;
  const throughputPerWeek = activeCompleted.length / (SLE_HISTORY_DAYS / 7);
  const runwayWeeks = throughputPerWeek > 0 ? Math.round((readyCardCount / throughputPerWeek) * 10) / 10 : null;

  // Build team: active-card assignees (sprint + stragglers) + anyone who resolved a ticket in
  // the last 14 days.
  const team = new Map();
  const teamCutoffMs = NOW - TEAM_WINDOW_DAYS * 86400000;
  for (const issue of activeRaw) {
    if (issue.fields.assignee) team.set(issue.fields.assignee.displayName, true);
  }
  for (const issue of completed) {
    if (issue.fields.assignee && new Date(issue.fields.statuscategorychangedate).getTime() >= teamCutoffMs) {
      team.set(issue.fields.assignee.displayName, true);
    }
  }

  // Cards done inside the sprint, per engineer -- shown as a "done this sprint" chip rather than
  // as active WIP.
  const doneThisSprintByName = new Map();
  for (const issue of sprintDoneIssues) {
    const name = issue.fields.assignee?.displayName;
    if (!name || isExcluded(name)) continue;
    doneThisSprintByName.set(name, (doneThisSprintByName.get(name) ?? 0) + 1);
  }

  // Team Status in-flight = assigned active cards (sprint working cards + stragglers). Unassigned
  // active cards are dropped here but still counted toward their column's WIP below.
  const inFlightAssigned = activeRaw.filter(issue => issue.fields.assignee);

  // Build in-flight rows. `outOfSprint` marks a straggler -- in flight but not on the sprint.
  let rows = inFlightAssigned.map(issue => {
    const pts = issue.fields[STORY_POINTS_FIELD] ?? null;
    const ms = NOW - new Date(issue.fields.statuscategorychangedate).getTime();
    const sle = sleDays(pts);
    const overSle = ms > sle * 86400000;
    const ptsLabel = pts != null ? `${Math.round(pts)}pts` : 'unpointed';
    const ct = overSle
      ? `**${humanDuration(ms)} ⚠** _(SLE: ${sle}d, ${ptsLabel})_`
      : humanDuration(ms);
    return {
      name: issue.fields.assignee?.displayName ?? '(unassigned)',
      key: issue.key,
      id: issue.id,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      issueType: issue.fields.issuetype?.name ?? null,
      descriptionText: issue.fields.description ? JSON.stringify(issue.fields.description) : '',
      points: pts,
      outOfSprint: issue._outOfSprint === true,
      ms,
      ct,
      collabs: collabsByKey.get(issue.key) ?? [],
    };
  });

  rows.sort((a, b) => b.ms - a.ms);
  rows = rows.filter(r => !isExcluded(r.name));
  for (const name of [...team.keys()]) if (isExcluded(name)) team.delete(name);

  // WIP counts cover every card on the board view -- all sprint cards plus stragglers (off-board
  // work that should be pulled in), including unassigned ones, minus omitted engineers -- so the
  // In Progress limit reflects real effective load.
  const columnCardCounts = new Map();
  for (const issue of [...sprintIssues, ...stragglers]) {
    if (isExcluded(issue.fields.assignee?.displayName ?? '')) continue;
    const col = statusToColumn.get(issue.fields.status.name) ?? issue.fields.status.name;
    columnCardCounts.set(col, (columnCardCounts.get(col) ?? 0) + 1);
  }
  const violatedColumns = new Set(
    [...columnLimits.entries()]
      .filter(([name, limit]) => (columnCardCounts.get(name) ?? 0) > limit)
      .map(([name]) => name),
  );
  // Columns sitting under their configured minimum WIP (possible under-utilization / pull signal).
  const underMinColumns = new Set(
    [...columnMins.entries()]
      .filter(([name, min]) => min > 0 && (columnCardCounts.get(name) ?? 0) < min)
      .map(([name]) => name),
  );

  // ── Sprint metrics: progress, burndown series, velocity ─────────────────────────────────────
  // Story points drive the burndown; cards that carry no estimate are surfaced as a caveat
  // rather than silently dropped. Discarded cards are treated as removed from scope.
  const pointsOf = i => { const p = i.fields[STORY_POINTS_FIELD]; return typeof p === 'number' ? p : 0; };
  function computeSprintMetrics() {
    if (!sprint) return null;
    const inScope = sprintIssues.filter(i => i.fields.status?.name !== 'Discard');
    const committedPoints = inScope.reduce((s, i) => s + pointsOf(i), 0);
    const donePoints = sprintDoneIssues.reduce((s, i) => s + pointsOf(i), 0);
    const unpointed = inScope.filter(i => typeof i.fields[STORY_POINTS_FIELD] !== 'number').length;
    const startMs = sprint.startDate ? new Date(sprint.startDate).getTime() : null;
    const endMs = sprint.endDate ? new Date(sprint.endDate).getTime() : null;
    // Burn events: only cards that are *currently* Done (a card that reached Done and was later
    // reopened must not count), timed by their first Done transition. Pre-start / day-0
    // completions (carryover) are clamped to day 1 so the actual line still starts at the full
    // committed total on day 0.
    const DAY = 86400000;
    const doneEvents = sprintDoneIssues
      .map(i => ({ pts: pointsOf(i), at: firstDoneMs(i) }))
      .filter(e => e.at != null);
    const burnDay = at => Math.max(1, Math.round((at - startMs) / DAY));
    const series = [];
    if (startMs && endMs && endMs > startMs) {
      const totalDays = Math.max(1, Math.round((endMs - startMs) / DAY));
      // How many sprint days have actually elapsed -- the actual line is drawn through here
      // (inclusive) so "today" is always plotted, even in the first 24h.
      const elapsedDays = Math.min(totalDays, Math.max(0, Math.round((NOW - startMs) / DAY)));
      for (let d = 0; d <= totalDays; d++) {
        const burned = doneEvents.reduce((s, e) => burnDay(e.at) <= d ? s + e.pts : s, 0);
        series.push({
          day: d,
          ideal: Math.max(0, committedPoints * (1 - d / totalDays)),
          remaining: committedPoints - burned,
          future: d > elapsedDays,
        });
      }
    }
    return {
      committedPoints, donePoints,
      totalCards: inScope.length, doneCards: sprintDoneIssues.length,
      unpointed, startMs, endMs, series,
    };
  }
  const sprintMetrics = computeSprintMetrics();

  // Velocity: mean completed story points over the most recent closed sprints. None closed yet
  // on this board, so this stays null (reported as "first tracked sprint") until one completes.
  async function computeVelocity() {
    if (!closedSprints.length) return { perSprint: null, sprintsCounted: 0 };
    let total = 0, counted = 0;
    for (const cs of closedSprints.slice(0, 3)) {
      const issues = await searchAll(
        `project = ${PROJECT} AND sprint = ${cs.id} AND statusCategory = Done`,
        STORY_POINTS_FIELD,
      ).catch(() => []);
      total += issues.reduce((s, i) => s + pointsOf(i), 0);
      counted++;
    }
    return { perSprint: counted ? Math.round((total / counted) * 10) / 10 : null, sprintsCounted: counted };
  }
  const velocity = await computeVelocity();

  // Sprint day counter: "Day X of N". X is clamped into [1, N] so a just-started or overrunning
  // sprint still reads sensibly.
  function sprintDayInfo() {
    if (!sprint?.startDate || !sprint?.endDate) return null;
    const startMs = new Date(sprint.startDate).getTime();
    const endMs = new Date(sprint.endDate).getTime();
    const totalDays = Math.max(1, Math.round((endMs - startMs) / 86400000));
    const elapsed = Math.round((NOW - startMs) / 86400000) + 1;
    return { day: Math.min(Math.max(elapsed, 1), totalDays), total: totalDays, endMs };
  }
  const sprintDay = sprintDayInfo();

  // Enrich In Review cards with GitHub PR activity (linked via Jira remote links)
  if (!skipGithub) {
    const reviewRows = rows.filter(r => /review/i.test(r.status));
    if (reviewRows.length) {
      const linkResults = await Promise.all(
        reviewRows.map(r => fetchRemoteLinks(r.key, r.id).then(urls => ({ key: r.key, urls })))
      );
      await Promise.all(linkResults.map(async ({ key, urls }) => {
        const row = rows.find(r => r.key === key);
        if (!row) return;
        row.prSearched = true;
        let url = urls[0];
        let foundViaSearch = false;
        if (!url) {
          // Jira has no PR data at all for this ticket -- try a direct GitHub search across
          // both hosts before concluding there's genuinely no PR. Only reached when there's no
          // pre-existing associated PR, which is also what makes it safe to auto-link below.
          const hit = await searchGhForIssue(key);
          if (hit) {
            url = hit.url;
            foundViaSearch = true;
            await autoLinkPrToJira(key, hit.url, hit.title);
          }
        }
        if (!url) { row.prActivity = null; return; }
        row.prActivity = await fetchPrActivity(url);
        if (row.prActivity) {
          row.prUrl = url;
          row.prFoundViaSearch = foundViaSearch;
        }
      }));
    }
  }

  await classifyNoPrTickets(rows);

  // Merge live OOO entries from the team group calendar into ctx.pto
  const calendarOOO = await fetchGroupOOO();
  if (calendarOOO.length) ctx.pto = [...(ctx.pto || []), ...calendarOOO];

  // ── National Days ───────────────────────────────────────────────────────────
  const nationalDays = await fetchNationalDays();
  const todayDate = new Date(NOW);
  const todayLabel = todayDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  let pickedNationalDay = null;
  console.log(`# ${PROJECT} Standup — ${todayLabel}\n`);
  if (nationalDays && nationalDays.length) {
    // Seed on YYYYMMDD so every run on the same day picks the same day
    const dateSeed = todayDate.getFullYear() * 10000 + (todayDate.getMonth() + 1) * 100 + todayDate.getDate();
    let h = dateSeed;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = (h ^ (h >>> 16)) >>> 0;
    pickedNationalDay = nationalDays[h % nationalDays.length];
    console.log(`**Today is:** ${pickedNationalDay.name} (${pickedNationalDay.dayUrl})\n`);
  }

  // Weekends and CMM holidays don't count as work days -- use this date, not literal "tomorrow",
  // whenever recommendations suggest picking something up on the next day.
  const nextWorkDayWeekday = new Date(NEXT_WORK_DAY + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  console.log(`**Next work day:** ${nextWorkDayWeekday}, ${fmtDate(NEXT_WORK_DAY)}\n`);

  // ── Sprint ──────────────────────────────────────────────────────────────────
  console.log('## Sprint\n');
  if (sprint) {
    const endLabel = sprintDay ? new Date(sprintDay.endMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?';
    const dayLabel = sprintDay ? `Day ${sprintDay.day} of ${sprintDay.total} (ends ${endLabel})` : 'dates unavailable';
    console.log(`**${sprint.name}** — ${dayLabel}  `);
    if (sprint.goal) console.log(`**Goal:** ${sprint.goal}  `);
    if (sprintMetrics) {
      const m = sprintMetrics;
      console.log(`**Progress:** ${m.donePoints}/${m.committedPoints} pts · ${m.doneCards}/${m.totalCards} cards done  `);
      if (m.unpointed) console.log(`_${m.unpointed} sprint card${m.unpointed !== 1 ? 's' : ''} unpointed — burndown reflects pointed work only._  `);
    }
    console.log(velocity.perSprint != null
      ? `**Velocity:** ${velocity.perSprint} pts/sprint (last ${velocity.sprintsCounted} closed)  `
      : `**Velocity:** first tracked sprint — builds once a sprint closes  `);
    console.log('');
  } else {
    console.log(`_No active sprint on board ${BOARD_ID}. Showing project-wide in-flight work instead._\n`);
  }

  // ── Computed SLE ────────────────────────────────────────────────────────────
  console.log('## Computed SLE\n');
  if (cycleTimes.length > 0) {
    const median = percentile(cycleTimes, 0.50);
    console.log(`**85th percentile (SLE):** ${humanDuration(computedSleMs)}  `);
    console.log(`**Median:** ${humanDuration(median)}  `);
    console.log(`**Sample:** ${cycleTimes.length} completed cards (last ${SLE_HISTORY_DAYS} days)  `);
    console.log(`**Sprint backlog:** ${readyCardCount} unstarted unassigned card${readyCardCount !== 1 ? 's' : ''}${runwayWeeks !== null ? ` (~${runwayWeeks}w at current throughput)` : ''}  `);
  } else {
    console.log(`_No completed cards with changelog data in the last ${SLE_HISTORY_DAYS} days -- SLE unavailable._`);
  }

  // Right-to-left ordering by board column position: the closer a status is to Done (higher
  // column index), the smaller its rank, so it sorts first. Replaces the old keyword heuristic.
  const statusRank = statusName => -colIdx(statusName);

  // Minimal, safe markdown -> HTML for PR body previews in tooltips. Escapes first (so any
  // literal HTML in the PR description can't inject markup), then layers on headers, **bold**,
  // `code`, [text](url) links, and "- " bullets so a GitHub PR description reads like formatted
  // text in the tooltip instead of raw markdown syntax.
  function mdToHtml(md) {
    const esc = _esc(md)
      .replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // single-quoted attrs: this snippet gets embedded inside a double-quoted data-summary="..." attribute
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href='$2' target='_blank'>$1</a>")
      .replace(/^[-*]\s+(.+)$/gm, '• $1');
    return esc.split(/\n+/).map(l => l.trim()).filter(Boolean).join('<br>');
  }

  function generateAgingWipSvg(inFlightRows, sleDays, issueStore) {
    if (!inFlightRows.length) return '<p><em>No in-flight cards.</em></p>';
    // Fonts sized for ~half page width (shares a side-by-side row with the burndown chart).
    const W = 820, H = 400, P = {t:30, r:100, b:88, l:56};
    const pw = W - P.l - P.r, ph = H - P.t - P.b;
    const stageMap = new Map();
    for (const r of inFlightRows) {
      if (!stageMap.has(r.status)) stageMap.set(r.status, []);
      stageMap.get(r.status).push(r);
    }
    const stages = [...stageMap.entries()]
      .sort((a, b) => statusRank(b[0]) - statusRank(a[0]))
      .map(([name, cards]) => ({ name, cards: [...cards].sort((a, b) => b.ms - a.ms) }));
    const nc = stages.length, cw = pw / nc;
    const maxDays = Math.max(...inFlightRows.map(r => Math.floor(r.ms / 86400000)), sleDays);
    const yMax = Math.max(Math.ceil(maxDays * 1.3 / 5) * 5, 10);
    const sy = d => ph * (1 - d / yMax);
    const e = [];
    e.push('<rect width="' + W + '" height="' + H + '" fill="#fff" rx="8" stroke="#e2e8f0"/>');
    for (let i = 0; i < nc; i++) {
      const x = (P.l + i * cw).toFixed(1);
      e.push('<rect x="' + x + '" y="' + P.t + '" width="' + cw.toFixed(1) + '" height="' + ph + '" fill="' + (i % 2 ? '#fff' : '#f8fafc') + '"/>');
    }
    const tick = yMax <= 15 ? 2 : yMax <= 30 ? 5 : 10;
    for (let d = 0; d <= yMax; d += tick) {
      const y = (P.t + sy(d)).toFixed(1);
      e.push('<line x1="' + P.l + '" y1="' + y + '" x2="' + (P.l+pw).toFixed(1) + '" y2="' + y + '" stroke="#f1f5f9" stroke-width="1"/>');
      e.push('<text x="' + (P.l-8).toFixed(1) + '" y="' + y + '" text-anchor="end" dominant-baseline="middle" fill="#94a3b8" font-size="17" font-family="system-ui,sans-serif">' + d + '</text>');
    }
    for (let i = 1; i < nc; i++) {
      const x = (P.l + i * cw).toFixed(1);
      e.push('<line x1="' + x + '" y1="' + P.t + '" x2="' + x + '" y2="' + (P.t+ph) + '" stroke="#e2e8f0" stroke-width="1"/>');
    }
    const sleY = (P.t + sy(sleDays)).toFixed(1);
    e.push('<line x1="' + P.l + '" y1="' + sleY + '" x2="' + (P.l+pw).toFixed(1) + '" y2="' + sleY + '" stroke="#f59e0b" stroke-width="2" stroke-dasharray="6 4"/>');
    e.push('<text x="' + (P.l+pw+8).toFixed(1) + '" y="' + sleY + '" dominant-baseline="middle" fill="#d97706" font-size="16" font-weight="600" font-family="system-ui,sans-serif">SLE ' + sleDays + 'd</text>');
    for (let i = 0; i < nc; i++) {
      const cx = (P.l + i * cw + cw / 2).toFixed(1);
      e.push('<text x="' + cx + '" y="' + (P.t+ph+26).toFixed(1) + '" text-anchor="middle" fill="#374151" font-size="17" font-weight="500" font-family="system-ui,sans-serif">' + _esc(stages[i].name) + '</text>');
      const wipCol = statusToColumn.get(stages[i].name) ?? stages[i].name;
      const wipLimit = columnLimits.get(wipCol);
      // A hard-zero limit (e.g. In Review) is always "full" by design -- treat it like no
      // limit at all here so the chart reports a plain count instead of a false alarm.
      const hasLimit = wipLimit != null && wipLimit > 0;
      const wipOver = hasLimit && (columnCardCounts.get(wipCol) ?? 0) > wipLimit;
      const wipLabel = hasLimit ? 'WIP: ' + stages[i].cards.length + '/' + wipLimit : 'WIP: ' + stages[i].cards.length;
      e.push('<text x="' + cx + '" y="' + (P.t+ph+48).toFixed(1) + '" text-anchor="middle" fill="' + (wipOver ? '#ef4444' : '#94a3b8') + '" font-size="15" font-weight="' + (wipOver ? '700' : '400') + '" font-family="system-ui,sans-serif">' + wipLabel + '</text>');
    }
    e.push('<line x1="' + P.l + '" y1="' + P.t + '" x2="' + P.l + '" y2="' + (P.t+ph) + '" stroke="#cbd5e1" stroke-width="1"/>');
    e.push('<line x1="' + P.l + '" y1="' + (P.t+ph) + '" x2="' + (P.l+pw) + '" y2="' + (P.t+ph) + '" stroke="#cbd5e1" stroke-width="1"/>');
    const midY = (P.t + ph / 2).toFixed(1);
    e.push('<text x="18" y="' + midY + '" text-anchor="middle" fill="#94a3b8" font-size="16" font-family="system-ui,sans-serif" transform="rotate(-90 18 ' + midY + ')">Age (days)</text>');
    for (let si = 0; si < nc; si++) {
      const { cards } = stages[si];
      const colCx = P.l + si * cw + cw / 2;
      const spread = cards.length > 1 ? Math.min(cw * 0.5, (cards.length - 1) * 22) : 0;
      for (let ci = 0; ci < cards.length; ci++) {
        const r = cards[ci];
        const days = Math.floor(r.ms / 86400000);
        const lx = cards.length === 1 ? colCx : colCx + (ci / (cards.length - 1) - 0.5) * spread;
        const cx = lx.toFixed(1), cy = (P.t + sy(days)).toFixed(1);
        const pct = sleDays > 0 ? days / sleDays : 0;
        const col = pct > 1.0 ? {f:'#ef4444',s:'#b91c1c'} : pct > 0.75 ? {f:'#f97316',s:'#ea580c'} : pct > 0.5 ? {f:'#eab308',s:'#ca8a04'} : {f:'#22c55e',s:'#16a34a'};
        const num = r.key.replace(/[^-]+-/, '');
        const d = issueStore[r.key];
        const url = d ? d.url : BASE + '/browse/' + r.key;
        const cardTitle = d ? (r.key + ' — ' + d.title) : (r.key + ' — ' + trunc(r.summary, 60));
        const cardSummary = d ? d.summary : (adfToText(r.descriptionText, 300) || r.summary);
        e.push(
          '<a href="' + url + '" target="_blank" style="text-decoration:none">' +
          '<g class="wip-card" data-key="' + r.key + '" data-url="' + url + '" data-title="' + _esc(cardTitle) + '" data-summary="' + _esc(cardSummary) + '" data-name="' + _esc(r.name) + '" data-days="' + days + '" data-status="' + _esc(r.status) + '">' +
          '<circle cx="' + cx + '" cy="' + cy + '" r="15" fill="' + col.f + '" stroke="' + col.s + '" stroke-width="1.5"/>' +
          '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" dominant-baseline="central" fill="#fff" font-size="13" font-weight="600" font-family="system-ui,sans-serif" style="pointer-events:none">' + num + '</text>' +
          '</g></a>'
        );
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + W + 'px;height:auto;display:block">\n' + e.join('\n') + '\n</svg>';
  }

  // Sprint burndown: remaining story points per day (blue) against the ideal glide path (gray
  // dashed). The actual line stops at today; the ideal runs the full sprint. Same 820x400 canvas
  // as the aging-WIP chart so the two panels sit side by side cleanly.
  function generateBurndownSvg(metrics) {
    if (!metrics || !metrics.series.length) return '<p><em>Burndown unavailable (sprint dates or estimates missing).</em></p>';
    const series = metrics.series;
    // Fonts are sized for this chart rendered at ~half page width (it shares a side-by-side row
    // with the aging-WIP chart), so they stay legible after the SVG scales down.
    const W = 820, H = 400, P = { t: 40, r: 30, b: 62, l: 62 };
    const pw = W - P.l - P.r, ph = H - P.t - P.b;
    const nDays = series[series.length - 1].day;
    const yMax = Math.max(Math.ceil(metrics.committedPoints * 1.1 / 5) * 5, 5);
    const sx = d => P.l + (nDays ? d / nDays : 0) * pw;
    const sy = v => P.t + ph * (1 - Math.max(0, v) / yMax);
    const e = [];
    e.push('<rect width="' + W + '" height="' + H + '" fill="#fff" rx="8" stroke="#e2e8f0"/>');
    const yTick = yMax <= 20 ? 5 : yMax <= 50 ? 10 : 20;
    for (let v = 0; v <= yMax; v += yTick) {
      const y = sy(v).toFixed(1);
      e.push('<line x1="' + P.l + '" y1="' + y + '" x2="' + (P.l + pw).toFixed(1) + '" y2="' + y + '" stroke="#f1f5f9" stroke-width="1.5"/>');
      e.push('<text x="' + (P.l - 8) + '" y="' + y + '" text-anchor="end" dominant-baseline="middle" fill="#94a3b8" font-size="18" font-family="system-ui,sans-serif">' + v + '</text>');
    }
    const xStep = nDays <= 10 ? 1 : 2;
    for (let d = 0; d <= nDays; d += xStep) {
      e.push('<text x="' + sx(d).toFixed(1) + '" y="' + (P.t + ph + 26).toFixed(1) + '" text-anchor="middle" fill="#94a3b8" font-size="18" font-family="system-ui,sans-serif">' + d + '</text>');
    }
    e.push('<line x1="' + P.l + '" y1="' + P.t + '" x2="' + P.l + '" y2="' + (P.t + ph) + '" stroke="#cbd5e1" stroke-width="1.5"/>');
    e.push('<line x1="' + P.l + '" y1="' + (P.t + ph) + '" x2="' + (P.l + pw) + '" y2="' + (P.t + ph) + '" stroke="#cbd5e1" stroke-width="1.5"/>');
    const idealPts = series.map(s => sx(s.day).toFixed(1) + ',' + sy(s.ideal).toFixed(1)).join(' ');
    e.push('<polyline points="' + idealPts + '" fill="none" stroke="#cbd5e1" stroke-width="2.5" stroke-dasharray="7 5"/>');
    const actual = series.filter(s => !s.future);
    if (actual.length) {
      const actualPts = actual.map(s => sx(s.day).toFixed(1) + ',' + sy(s.remaining).toFixed(1)).join(' ');
      e.push('<polyline points="' + actualPts + '" fill="none" stroke="#3b82f6" stroke-width="3.5"/>');
      for (const s of actual) {
        e.push('<circle cx="' + sx(s.day).toFixed(1) + '" cy="' + sy(s.remaining).toFixed(1) + '" r="6" fill="#3b82f6"/>');
      }
    }
    const midY = (P.t + ph / 2).toFixed(1);
    e.push('<text x="18" y="' + midY + '" text-anchor="middle" fill="#94a3b8" font-size="17" font-family="system-ui,sans-serif" transform="rotate(-90 18 ' + midY + ')">Points remaining</text>');
    e.push('<text x="' + (P.l + pw / 2).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" fill="#94a3b8" font-size="17" font-family="system-ui,sans-serif">Sprint day</text>');
    e.push('<g font-family="system-ui,sans-serif" font-size="16">' +
      '<line x1="' + (P.l + 10) + '" y1="' + (P.t - 12) + '" x2="' + (P.l + 40) + '" y2="' + (P.t - 12) + '" stroke="#3b82f6" stroke-width="3.5"/>' +
      '<text x="' + (P.l + 46) + '" y="' + (P.t - 7) + '" fill="#475569">Actual</text>' +
      '<line x1="' + (P.l + 120) + '" y1="' + (P.t - 12) + '" x2="' + (P.l + 150) + '" y2="' + (P.t - 12) + '" stroke="#cbd5e1" stroke-width="2.5" stroke-dasharray="7 5"/>' +
      '<text x="' + (P.l + 156) + '" y="' + (P.t - 7) + '" fill="#475569">Ideal</text></g>');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + W + 'px;height:auto;display:block">\n' + e.join('\n') + '\n</svg>';
  }

  // Builds the plain, JSON-serializable data blob that `--render` turns into the final static
  // report. Claude fills in Recommendations / the national-day description by editing plain
  // JSON fields between the fetch step and the render step, rather than hand-splicing values
  // into HTML (the source of the unescaped-quote/dropped-`>` bug class).
  function buildReportData({ dateLabel, nationalDay, sleDays, sleLabel, medianLabel, sampleCount, readyCardCount, runwayWeeks, rows, engineerEntries, available, availSuggestions, sprint, sprintMetrics, velocity, sprintDay, stragglers, doneThisSprintByName }) {
    // Centralized issue/PR data pool: the single source of truth for every card and PR
    // mentioned anywhere in the report. Team Status, the WIP chart, and available-suggestion
    // links all read from it below, and it ships as-is in the JSON so the client-side
    // cardLinks Handlebars helper can turn any text mention of a known key -- e.g. in
    // Recommendations -- into the same linked, hover-card-enabled reference.
    const issues = {};
    for (const r of rows) {
      const days = Math.floor(r.ms / 86400000);
      issues[r.key] = {
        title: trunc(r.summary, 70),
        summary: adfToText(r.descriptionText, 300) || r.summary,
        url: BASE + '/browse/' + r.key,
        meta: r.status + ' · ' + days + 'd',
      };
    }
    for (const sug of availSuggestions.values()) {
      if (!sug || issues[sug.card.key]) continue;
      const c = sug.card;
      const status = c.fields.status?.name ?? '';
      issues[c.key] = {
        title: trunc(c.fields.summary, 70),
        summary: adfToText(c.fields.description ? JSON.stringify(c.fields.description) : '', 300) || c.fields.summary,
        url: BASE + '/browse/' + c.key,
        meta: status,
      };
    }
    // Stragglers: in-flight cards not on the sprint. Add them to the shared link pool (so their
    // keys resolve to hover cards anywhere) and build a shaped list for the dedicated section.
    const stragglerList = [];
    for (const i of (stragglers || [])) {
      if (isExcluded(i.fields.assignee?.displayName ?? '')) continue;
      const days = Math.floor((NOW - new Date(i.fields.statuscategorychangedate).getTime()) / 86400000);
      if (!issues[i.key]) {
        issues[i.key] = {
          title: trunc(i.fields.summary, 70),
          summary: adfToText(i.fields.description ? JSON.stringify(i.fields.description) : '', 300) || i.fields.summary,
          url: BASE + '/browse/' + i.key,
          meta: (i.fields.status?.name ?? '') + ' · ' + days + 'd · not in sprint',
        };
      }
      stragglerList.push({
        key: i.key,
        title: trunc(i.fields.summary, 70),
        status: i.fields.status?.name ?? '',
        days,
        owner: i.fields.assignee?.displayName ?? null,
      });
    }

    const prs = {};
    for (const r of rows) {
      if (!r.prActivity) continue;
      const a = r.prActivity;
      const lastAgo = a.lastActivity ? humanDuration(NOW - a.lastActivity.getTime()) + ' ago' : '?';
      const prReviewerStr = a.reviewers.length
        ? a.reviewers.map(rv => `${rv.author} (${rv.state})`).join(', ')
        : a.requestedReviewers.length
          ? a.requestedReviewers.map(n => `${n} (requested)`).join(', ')
          : 'none assigned';
      const prBodyTrunc = a.body ? (a.body.length > 300 ? a.body.slice(0, 300) + '…' : a.body) : '';
      const notLinkedNote = r.prFoundViaSearch ? ' · found via GitHub search, not linked in Jira' : '';
      prs[String(a.num)] = {
        title: 'PR #' + a.num + ' · ' + a.repo,
        summary: prBodyTrunc ? mdToHtml(prBodyTrunc) : 'No description provided.',
        meta: (a.reviewDecision || 'pending') + ' · ' + lastAgo + ' · reviewers: ' + prReviewerStr + notLinkedNote,
        url: a.prUrl,
      };
    }

    const chartSvg = generateAgingWipSvg(rows, sleDays, issues);

    const engineers = engineerEntries.map(([name, cards]) => {
      // Cards sitting in a review-named status are done and waiting on someone else -- they
      // don't compete for the engineer's attention the way active work does, so only
      // actively-worked cards count toward the WIP concern/critical badge.
      const activeCount = cards.filter(r => !/review/i.test(r.status)).length;
      const badgeLevel = activeCount >= 3 ? 'critical' : activeCount >= 2 ? 'concern' : null;
      const ptoEntry = getActivePto(name);
      const upcoming = !ptoEntry ? getUpcomingPto(name) : [];
      const pto = ptoEntry
        ? { label: ptoActiveLabel(ptoEntry), partial: ptoEntry.allDay === false }
        : upcoming.length ? { label: ptoUpcomingLabel(upcoming[0]), kind: 'upcoming' } : null;

      return {
        name,
        count: cards.length,
        badgeLevel,
        badgeLabel: badgeLevel === 'critical' ? 'Critical' : badgeLevel === 'concern' ? 'Concern' : null,
        doneThisSprint: (doneThisSprintByName && doneThisSprintByName.get(name)) || 0,
        pto,
        cards: cards.map(r => {
          const days = Math.floor(r.ms / 86400000);
          let pr = null;
          if (!r.prSearched && looksLikeNoPr(r)) {
            pr = { notNeeded: true };
          } else if (r.prSearched) {
            if (!r.prActivity) {
              pr = (looksLikeNoPr(r) || r.aiNoPr) ? { notNeeded: true } : { missing: true };
            } else {
              const a = r.prActivity;
              pr = {
                active: true,
                mention: 'PR #' + a.num,
                decision: a.reviewDecision || 'pending',
                decisionClass: (a.reviewDecision || 'pending').toLowerCase().replace(/[^a-z]/g, '-'),
                lastAgo: a.lastActivity ? humanDuration(NOW - a.lastActivity.getTime()) + ' ago' : '?',
                foundViaSearch: r.prFoundViaSearch || undefined,
              };
            }
          }
          return { key: r.key, titleShort: trunc(r.summary, 70), status: r.status, days, over: days > sleDays, outOfSprint: r.outOfSprint === true, pr };
        }),
      };
    });

    const availableList = available.map(name => {
      const ptoEntry = getActivePto(name);
      if (ptoEntry) return { name, pto: { label: ptoActiveLabel(ptoEntry), partial: ptoEntry.allDay === false }, suggestion: null };
      const sug = availSuggestions.get(name);
      return {
        name,
        pto: null,
        suggestion: sug ? { key: sug.card.key, summary: trunc(sug.card.fields.summary, 50), basis: sug.basis || 'next in queue' } : null,
      };
    });

    const lookahead = new Date(NOW + 30 * 86400000).toISOString().slice(0, 10);
    const availability = [];
    for (const entry of (ctx.pto || [])) {
      if (entry.end >= todayStr && entry.start <= lookahead) {
        const ongoing = entry.start <= todayStr;
        availability.push({
          sortKey: entry.start,
          name: entry.name,
          label: ongoing ? ptoReturnsLabel(entry) : ptoUpcomingLabel(entry),
          note: ongoing ? entry.note : null,
        });
      }
    }
    for (const ev of (ctx.events || [])) {
      if (ev.date >= todayStr && ev.date <= lookahead) {
        availability.push({ sortKey: ev.date, dateLabel: fmtDate(ev.date), label: ev.name, note: ev.note || null });
      }
    }
    availability.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    for (const item of availability) delete item.sortKey;

    return {
      projectName: PROJECT,
      dateLabel,
      nationalDay: nationalDay ? { name: nationalDay.name, url: nationalDay.dayUrl, description: nationalDay.description || '' } : null,
      metrics: sampleCount > 0 ? { sleLabel, medianLabel, sampleCount, historyDays: SLE_HISTORY_DAYS, readyCardCount, runwayWeeks } : null,
      sprint: sprint ? {
        name: sprint.name,
        goal: sprint.goal || '',
        day: sprintDay ? sprintDay.day : null,
        total: sprintDay ? sprintDay.total : null,
        endLabel: sprintDay ? new Date(sprintDay.endMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null,
      } : null,
      sprintMetrics: sprintMetrics ? {
        committedPoints: sprintMetrics.committedPoints,
        donePoints: sprintMetrics.donePoints,
        totalCards: sprintMetrics.totalCards,
        doneCards: sprintMetrics.doneCards,
        unpointed: sprintMetrics.unpointed,
        burndownSvg: generateBurndownSvg(sprintMetrics),
        velocity: velocity && velocity.perSprint != null
          ? { perSprint: velocity.perSprint, sprintsCounted: velocity.sprintsCounted }
          : null,
      } : null,
      chartSvg,
      engineers,
      available: availableList,
      availability,
      stragglers: stragglerList,
      issues,
      prs,
      recommendations: [],
    };
  }

  // Group in-flight rows by engineer; sort each engineer's cards right-to-left then longest first
  const byAssignee = new Map();
  for (const r of rows) {
    if (!byAssignee.has(r.name)) byAssignee.set(r.name, []);
    byAssignee.get(r.name).push(r);
  }
  for (const cards of byAssignee.values()) {
    cards.sort((a, b) => statusRank(a.status) - statusRank(b.status) || b.ms - a.ms);
  }

  // Sort engineers by their most urgent card (rightmost status, then longest running)
  const engineerEntries = [...byAssignee.entries()].sort((a, b) => {
    const aTop = a[1][0], bTop = b[1][0];
    return statusRank(aTop.status) - statusRank(bTop.status) || bTop.ms - aTop.ms;
  });

  // Compute available engineers and backlog suggestions before output
  const assignedNames = new Set(rows.map(r => r.name));
  const available = [...team.keys()].filter(name => !assignedNames.has(name)).sort();

  const engineerComponents = new Map();
  for (const issue of completed) {
    const name = issue.fields.assignee?.displayName;
    if (!name) continue;
    const comps = (issue.fields.components || []).map(c => c.name).filter(Boolean);
    if (!engineerComponents.has(name)) engineerComponents.set(name, new Map());
    const freq = engineerComponents.get(name);
    for (const comp of comps) freq.set(comp, (freq.get(comp) ?? 0) + 1);
  }

  const computedSleDays = Math.ceil(computedSleMs / 86400000);

  const claimedBacklogKeys = new Set();
  function suggestCard(name) {
    const freq = engineerComponents.get(name);
    const ranked = freq ? [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c) : [];
    for (const comp of ranked) {
      const match = backlog.find(
        b => !claimedBacklogKeys.has(b.key) && (b.fields.components || []).some(c => c.name === comp),
      );
      if (match) { claimedBacklogKeys.add(match.key); return { card: match, basis: comp }; }
    }
    const fallback = backlog.find(b => !claimedBacklogKeys.has(b.key));
    if (fallback) { claimedBacklogKeys.add(fallback.key); return { card: fallback, basis: null }; }
    return null;
  }

  // Pre-compute suggestions so they can be reused in the HTML output
  const availSuggestions = new Map();
  for (const name of available) {
    if (!getActivePto(name)) availSuggestions.set(name, suggestCard(name));
  }

  // ── Team Status ─────────────────────────────────────────────────────────────
  // Engineers with tickets: ordered right-to-left, longest-running first.
  // Available engineers appended at the bottom with a suggested next card.
  console.log('\n## Team Status\n');
  for (const [name, cards] of engineerEntries) {
    const pto = getActivePto(name);
    const upcomingPto = !pto ? getUpcomingPto(name) : [];
    const ptoTag = pto
      ? ` · ${ptoActiveLabel(pto)}`
      : upcomingPto.length
        ? ' · _' + upcomingPto.map(ptoUpcomingLabel).join(', ') + '_'
        : '';
    const doneChip = (doneThisSprintByName.get(name) || 0) > 0 ? ` · ✓ ${doneThisSprintByName.get(name)} done this sprint` : '';
    console.log(`**${name}**${ptoTag} · ${cards.length} card${cards.length !== 1 ? 's' : ''}${doneChip}  `);
    for (const r of cards) {
      const link = `[${r.key}](${BASE}/browse/${r.key})`;
      const sprintTag = r.outOfSprint ? ' · _not in sprint_' : '';
      console.log(`- ${link} ${trunc(r.summary, 60)} · **${r.status}** · ${r.ct}${sprintTag}`);
      if (!r.prSearched && looksLikeNoPr(r)) {
        console.log(`  - no PR needed`);
      } else if (r.prSearched) {
        if (!r.prActivity) {
          console.log((looksLikeNoPr(r) || r.aiNoPr) ? `  - no PR needed` : `  - GitHub: no linked PR found`);
        } else {
          const a = r.prActivity;
          const lastAgo = a.lastActivity ? humanDuration(NOW - a.lastActivity.getTime()) + ' ago' : 'unknown';
          const reviewerStr = a.reviewers.length
            ? a.reviewers.map(rv => `${rv.author} (${rv.state})`).join(', ')
            : a.requestedReviewers.length
              ? a.requestedReviewers.map(n => `${n} (requested)`).join(', ')
              : 'none assigned';
          const notLinkedNote = r.prFoundViaSearch ? ' _(found via GitHub search, not linked in Jira)_' : '';
          console.log(`  - GitHub: [PR #${a.num}](${a.prUrl}) in ${a.repo} · ${a.state} · review: ${a.reviewDecision || 'NONE'} · last activity: ${lastAgo} · reviewers: ${reviewerStr}${notLinkedNote}`);
        }
      }
    }
    console.log('');
  }
  for (const name of available) {
    const pto = getActivePto(name);
    if (pto) {
      const noteStr = pto.note ? ` (${pto.note})` : '';
      console.log(`**${name}** · ${ptoActiveLabel(pto)}${noteStr}`);
      continue;
    }
    const upcoming = getUpcomingPto(name);
    const upcomingStr = upcoming.map(ptoUpcomingLabel).join(', ');
    const upcomingSuffix = upcomingStr ? ` · _${upcomingStr}_` : '';

    const suggestion = availSuggestions.get(name);
    if (suggestion) {
      const { card, basis } = suggestion;
      const pts = card.fields[STORY_POINTS_FIELD];
      const ptLabel = pts != null ? ` (${Math.round(pts)}pts)` : '';
      const basisLabel = basis ? `matched: ${basis}` : 'next in queue';
      console.log(`**${name}** · available → [${card.key}](${BASE}/browse/${card.key}) ${trunc(card.fields.summary, 45)}${ptLabel} _(${basisLabel})_${upcomingSuffix}`);
    } else {
      console.log(`**${name}** · available _(${backlog.length ? 'backlog exhausted' : 'no unstarted unassigned sprint cards'})_${upcomingSuffix}`);
    }
  }

  // ── Stragglers ──────────────────────────────────────────────────────────────
  // In-flight work that isn't on the sprint. Surfaced so the team can pull it onto the board;
  // the script never adds anything to the sprint itself.
  const visibleStragglers = (stragglers || []).filter(i => !isExcluded(i.fields.assignee?.displayName ?? ''));
  console.log('\n## Stragglers (in flight, not in this sprint)\n');
  if (!sprint) {
    console.log('_No active sprint, so straggler detection is off._');
  } else if (!visibleStragglers.length) {
    console.log('None — all in-flight work is on the sprint.');
  } else {
    for (const i of visibleStragglers) {
      const days = Math.floor((NOW - new Date(i.fields.statuscategorychangedate).getTime()) / 86400000);
      const owner = i.fields.assignee?.displayName ?? 'unassigned';
      console.log(`- [${i.key}](${BASE}/browse/${i.key}) — ${trunc(i.fields.summary, 70)} *(${i.fields.status?.name})* · ${days}d · ${owner} — consider adding to the sprint`);
    }
  }

  // ── Multi-Ticket Owners ─────────────────────────────────────────────────────
  const multi = [...byAssignee.entries()].filter(([, cards]) => cards.length > 1).sort((a, b) => b[1].length - a[1].length);

  console.log('\n## Multi-Ticket Owners\n');
  if (!multi.length) {
    console.log('No engineers currently assigned to more than one card.');
  } else {
    for (const [name, cards] of multi) {
      console.log(`**${name}** (${cards.length} cards)`);
      for (const r of cards) {
        console.log(`- [${r.key}](${BASE}/browse/${r.key}) — ${trunc(r.summary, 70)} *(${r.status})*`);
      }
      console.log('');
    }
  }

  // ── Collaborator Load ───────────────────────────────────────────────────────
  const byCollab = new Map();
  for (const r of rows) {
    for (const c of r.collabs) {
      if (!byCollab.has(c)) byCollab.set(c, []);
      byCollab.get(c).push(r);
    }
  }

  console.log('\n## Collaborator Load\n');
  if (!byCollab.size) {
    console.log('No engineers listed as collaborators on any in-flight card.');
  } else {
    for (const [name, cards] of [...byCollab.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`**${name}** (${cards.length} card${cards.length !== 1 ? 's' : ''})`);
      for (const r of cards) {
        console.log(`- [${r.key}](${BASE}/browse/${r.key}) — ${trunc(r.summary, 70)} *(${r.status})*`);
      }
      console.log('');
    }
  }

  // ── Column WIP Violations ────────────────────────────────────────────────────
  console.log('\n## Column WIP Violations\n');
  if (!columnLimits.size) {
    console.log('_No column WIP limits configured on board ' + BOARD_ID + ' (or board config unavailable)._\n');
  } else {
    for (const [col, limit] of columnLimits) {
      const count = columnCardCounts.get(col) ?? 0;
      // A hard-zero limit means every card in the column is inherently "over" -- that's not
      // a signal, just the column's nature (e.g. In Review: done, waiting on someone else).
      // Report it as a plain count instead of an alarm; only a positive limit can be violated.
      if (limit === 0) {
        console.log('- **' + col + '**: ' + count + ' card' + (count !== 1 ? 's' : ''));
        continue;
      }
      const over = count > limit;
      console.log('- **' + col + '**: ' + count + '/' + limit + (over ? ' ⚠ OVER LIMIT' : ''));
    }
    for (const col of underMinColumns) {
      console.log('- **' + col + '**: ' + (columnCardCounts.get(col) ?? 0) + ' (min ' + columnMins.get(col) + ') _under minimum — room to pull_');
    }
  }

  // ── Write this run's data blob for Claude to annotate (recommendations, national-day
  // description), then render with `--render <path>` once those are filled in -- see
  // .claude/commands/standup.md for the two-step flow. ──────────────────────────────────────
  const _fs = require('fs'), _path = require('path'), _os = require('os');
  const medianMs = cycleTimes.length ? percentile(cycleTimes, 0.5) : null;
  const _sDate = new Date().toISOString().slice(0, 10);
  const _jOut = _path.join(_os.tmpdir(), `standup-${_sDate}.json`);
  const reportData = buildReportData({
    dateLabel: todayLabel,
    nationalDay: pickedNationalDay,
    sleDays: computedSleDays,
    sleLabel: cycleTimes.length ? humanDuration(computedSleMs) : null,
    medianLabel: medianMs !== null ? humanDuration(medianMs) : null,
    sampleCount: cycleTimes.length,
    readyCardCount,
    runwayWeeks,
    rows,
    engineerEntries,
    available,
    availSuggestions,
    sprint,
    sprintMetrics,
    velocity,
    sprintDay,
    stragglers,
    doneThisSprintByName,
  });
  _fs.writeFileSync(_jOut, JSON.stringify(reportData, null, 2) + '\n', 'utf8');
  console.log('DATA_OUT:' + _jOut);

})().catch(e => { console.error(e.message); process.exit(1); });
