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

const BASE = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;

if (!BASE || !EMAIL || !TOKEN) {
  console.error('Missing env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN');
  process.exit(1);
}

const AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;

const rawArgs = process.argv.slice(2);
const normalizeN = s => s.toLowerCase().replace(/[^a-z ]/g, '').trim();

const projectFlagIdx = rawArgs.indexOf('--project');
const PROJECT = projectFlagIdx !== -1 && rawArgs[projectFlagIdx + 1]
  ? rawArgs[projectFlagIdx + 1].toUpperCase()
  : 'PARCH';

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

// Returns the active PTO entry for a name, or null
function getActivePto(name) {
  const nName = normalizeN(name);
  return (ctx.pto || []).find(e => {
    const nEntry = normalizeN(e.name);
    return (nName.includes(nEntry) || nEntry.includes(nName)) &&
           e.start <= todayStr && todayStr <= e.end;
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

// Static per-point SLE used for individual card ⚠ flags
const STORY_POINTS_FIELD = 'customfield_13078';
const SLE_BY_POINTS = { 1: 2, 2: 4, 3: 6, 5: 10, 8: 14, 13: 20, 20: 30, 21: 30 };
const DEFAULT_SLE_DAYS = 12;
const sleDays = pts => pts != null ? (SLE_BY_POINTS[pts] ?? DEFAULT_SLE_DAYS) : DEFAULT_SLE_DAYS;

async function jiraGet(p) {
  const r = await fetch(`${BASE}${p}`, { headers: { Authorization: AUTH, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET ${p} => ${r.status}: ${await r.text()}`);
  return r.json();
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

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// Fetch today's national/special days from daysoftheyear.com.
// Returns an array of day names, or null on any failure (always silent).
async function fetchNationalDays() {
  try {
    const r = await fetch('https://www.daysoftheyear.com/today/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; standup-report/1.0)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const names = [];
    const re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const name = m[1].replace(/<[^>]+>/g, '').trim();
      if (name.length >= 4 && name.length <= 80 && /day|week|month/i.test(name)) names.push(name);
      if (names.length >= 5) break;
    }
    return names.length ? names : null;
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

// Tee all console.log output to a buffer so we can write standup.md at the end
const _outputLines = [];
const _origLog = console.log.bind(console);
console.log = (...args) => { _origLog(...args); _outputLines.push(args.join(' ')); };

(async () => {
  // Fetch status category map and collaborators field in parallel with ticket queries
  const [statusTypes, allFields, inFlight, completed, backlog] = await Promise.all([
    jiraGet(`/rest/api/3/project/${PROJECT}/statuses`),
    jiraGet('/rest/api/3/field'),
    searchAll(
      `project = ${PROJECT} AND statusCategory = "In Progress" AND issuetype != Epic`,
      ['assignee', 'summary', 'status', 'statuscategorychangedate', STORY_POINTS_FIELD].join(','),
    ),
    // 28-day completed set for both SLE calculation and team membership (14d subset)
    searchAll(
      `project = ${PROJECT} AND issuetype != Epic AND statusCategory = Done AND updated >= "${SLE_CUTOFF}" AND assignee is not EMPTY`,
      'assignee,statuscategorychangedate,components',
      'changelog',
    ),
    // Backlog cards available to pull, oldest first
    searchAll(
      `project = ${PROJECT} AND issuetype != Epic AND status = "Selected For Development" AND assignee is EMPTY ORDER BY created ASC`,
      `summary,components,priority,${STORY_POINTS_FIELD}`,
    ),
  ]);

  const collabFieldId = allFields.find(f => f.name === 'Collaborators')?.id ?? null;

  // If collabs field exists, fetch it separately (can't mix with changelog expand cleanly)
  const inFlightWithCollabs = collabFieldId
    ? await searchAll(
        `project = ${PROJECT} AND statusCategory = "In Progress" AND issuetype != Epic`,
        `summary,${collabFieldId}`,
      )
    : [];

  const collabsByKey = new Map();
  for (const issue of inFlightWithCollabs) {
    const collabs = Array.isArray(issue.fields[collabFieldId])
      ? issue.fields[collabFieldId].map(u => u.displayName)
      : [];
    if (collabs.length) collabsByKey.set(issue.key, collabs);
  }

  // Build status category map for changelog parsing
  const categoryByStatus = new Map();
  for (const issueType of statusTypes) {
    for (const status of issueType.statuses) {
      categoryByStatus.set(status.name, status.statusCategory.key);
    }
  }

  // Compute actual cycle time from changelog (first In Progress → Done)
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

  // Computed SLE: 85th percentile of completed tickets in the last 28 days
  const cycleTimes = completed.map(getCycleTime).filter(ct => ct !== null).sort((a, b) => a - b);
  const computedSleMsRaw = percentile(cycleTimes, SLE_PERCENTILE);
  const computedSleMs = computedSleMsRaw ?? DEFAULT_SLE_DAYS * 86400000;

  // Build team: in-flight assignees + anyone who resolved a ticket in the last 14 days
  const team = new Map();
  const teamCutoffMs = NOW - TEAM_WINDOW_DAYS * 86400000;
  for (const issue of inFlight) {
    if (issue.fields.assignee) team.set(issue.fields.assignee.displayName, true);
  }
  for (const issue of completed) {
    if (issue.fields.assignee && new Date(issue.fields.statuscategorychangedate).getTime() >= teamCutoffMs) {
      team.set(issue.fields.assignee.displayName, true);
    }
  }

  // Build in-flight rows
  let rows = inFlight.map(issue => {
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
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      ms,
      ct,
      collabs: collabsByKey.get(issue.key) ?? [],
    };
  });

  rows.sort((a, b) => b.ms - a.ms);
  rows = rows.filter(r => !isExcluded(r.name));
  for (const name of [...team.keys()]) if (isExcluded(name)) team.delete(name);

  // ── National Days ───────────────────────────────────────────────────────────
  const nationalDays = await fetchNationalDays();
  const todayDate = new Date(NOW);
  const todayLabel = todayDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  console.log(`# ${PROJECT} Standup — ${todayLabel}\n`);
  if (nationalDays && nationalDays.length) {
    // Seed on YYYYMMDD so every run on the same day picks the same day
    const dateSeed = todayDate.getFullYear() * 10000 + (todayDate.getMonth() + 1) * 100 + todayDate.getDate();
    let h = dateSeed;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = (h ^ (h >>> 16)) >>> 0;
    const picked = nationalDays[h % nationalDays.length];
    console.log(`**Today is:** ${picked}\n`);
  }

  // ── Computed SLE ────────────────────────────────────────────────────────────
  console.log('## Computed SLE\n');
  if (cycleTimes.length > 0) {
    const median = percentile(cycleTimes, 0.50);
    console.log(`**85th percentile (SLE):** ${humanDuration(computedSleMs)}  `);
    console.log(`**Median:** ${humanDuration(median)}  `);
    console.log(`**Sample:** ${cycleTimes.length} completed cards (last ${SLE_HISTORY_DAYS} days)  `);
  } else {
    console.log(`_No completed cards with changelog data in the last ${SLE_HISTORY_DAYS} days -- SLE unavailable._`);
  }

  // Status rank drives right-to-left ordering: lower = closer to done
  function statusRank(statusName) {
    const s = statusName.toLowerCase();
    if (s.includes('deploy') || s.includes('release') || s.includes('staging')) return 0;
    if (s.includes('review')) return 1;
    return 2;
  }

  // Renders an ASCII aging WIP chart: columns = workflow stages, rows = age in days,
  // dots = individual cards, SLE threshold drawn as a dashed line.
  function renderAgingWip(inFlightRows, computedSleDays) {
    if (!inFlightRows.length) return null;

    // Group cards by status; order columns left (furthest from done) → right (closest to done)
    const byStatus = new Map();
    for (const r of inFlightRows) {
      if (!byStatus.has(r.status)) byStatus.set(r.status, []);
      byStatus.get(r.status).push({
        key: r.key,
        firstName: r.name.split(' ')[0],
        days: Math.floor(r.ms / 86400000),
      });
    }
    const cols = [...byStatus.entries()]
      .sort((a, b) => statusRank(b[0]) - statusRank(a[0]));

    const COL_W = 26;

    // Build per-column day→[label] maps
    const colByDay = cols.map(([, cards]) => {
      const m = new Map();
      for (const c of cards) {
        if (!m.has(c.days)) m.set(c.days, []);
        m.get(c.days).push(`● ${c.key} ${c.firstName}`);
      }
      return m;
    });

    // All significant day values (card ages + SLE threshold), sorted descending
    const allDays = new Set([computedSleDays]);
    for (const [, cards] of cols) for (const c of cards) allDays.add(c.days);
    const sortedDays = [...allDays].sort((a, b) => b - a);

    const lines = [];
    lines.push('     │' + cols.map(([status, cards]) =>
      ` ${status} (WIP:${cards.length})`.padEnd(COL_W)
    ).join('│'));
    lines.push('─────┼' + cols.map(() => '─'.repeat(COL_W)).join('┼'));

    let sleInserted = false;
    for (const day of sortedDays) {
      // Insert SLE threshold line when we reach or pass it
      if (!sleInserted && day <= computedSleDays) {
        sleInserted = true;
        lines.push(` ${String(computedSleDays).padStart(2)}d ┊` +
          cols.map(() => `── SLE (${computedSleDays}d) `.padEnd(COL_W, '─')).join('┊'));
      }
      const cells = colByDay.map(m => m.get(day) || []);
      const maxRows = Math.max(...cells.map(c => c.length));
      if (maxRows === 0) continue;
      for (let i = 0; i < maxRows; i++) {
        const label = i === 0 ? ` ${String(day).padStart(2)}d ` : '     ';
        lines.push(label + '│' + cells.map(cl => ` ${cl[i] || ''}`.padEnd(COL_W)).join('│'));
      }
    }
    // SLE below all cards
    if (!sleInserted) {
      lines.push(` ${String(computedSleDays).padStart(2)}d ┊` +
        cols.map(() => `── SLE (${computedSleDays}d) `.padEnd(COL_W, '─')).join('┊'));
    }
    lines.push('─────┴' + cols.map(() => '─'.repeat(COL_W)).join('┴'));

    return lines.join('\n');
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

  // ── Team Status ─────────────────────────────────────────────────────────────
  // Engineers with tickets: ordered right-to-left, longest-running first.
  // Available engineers appended at the bottom with a suggested next card.
  console.log('\n## Team Status\n');
  for (const [name, cards] of engineerEntries) {
    const pto = getActivePto(name);
    const upcomingPto = !pto ? getUpcomingPto(name) : [];
    const ptoTag = pto
      ? ` · PTO through ${fmtDate(pto.end)}`
      : upcomingPto.length
        ? ' · _' + upcomingPto.map(e => {
            const range = e.end > e.start ? `${fmtDate(e.start)}–${fmtDate(e.end)}` : fmtDate(e.start);
            return `PTO ${range}${e.note ? ` (${e.note})` : ''}`;
          }).join(', ') + '_'
        : '';
    console.log(`**${name}**${ptoTag} · ${cards.length} card${cards.length !== 1 ? 's' : ''}  `);
    for (const r of cards) {
      const link = `[${r.key}](${BASE}/browse/${r.key})`;
      console.log(`- ${link} ${trunc(r.summary, 60)} · **${r.status}** · ${r.ct}`);
    }
    console.log('');
  }
  for (const name of available) {
    const pto = getActivePto(name);
    if (pto) {
      const through = pto.end > todayStr ? ` through ${fmtDate(pto.end)}` : '';
      const noteStr = pto.note ? ` (${pto.note})` : '';
      console.log(`**${name}** · PTO${through}${noteStr}`);
      continue;
    }
    const upcoming = getUpcomingPto(name);
    const upcomingStr = upcoming.map(e => {
      const range = e.end > e.start ? `${fmtDate(e.start)}–${fmtDate(e.end)}` : fmtDate(e.start);
      return `PTO ${range}${e.note ? ` (${e.note})` : ''}`;
    }).join(', ');
    const upcomingSuffix = upcomingStr ? ` · _${upcomingStr}_` : '';

    const suggestion = suggestCard(name);
    if (suggestion) {
      const { card, basis } = suggestion;
      const pts = card.fields[STORY_POINTS_FIELD];
      const ptLabel = pts != null ? ` (${Math.round(pts)}pts)` : '';
      const basisLabel = basis ? `matched: ${basis}` : 'next in queue';
      console.log(`**${name}** · available → [${card.key}](${BASE}/browse/${card.key}) ${trunc(card.fields.summary, 45)}${ptLabel} _(${basisLabel})_${upcomingSuffix}`);
    } else {
      console.log(`**${name}** · available _(${backlog.length ? 'backlog exhausted' : 'no "Selected For Development" cards'})_${upcomingSuffix}`);
    }
  }

  // ── Aging WIP ───────────────────────────────────────────────────────────────
  const computedSleDays = Math.ceil(computedSleMs / 86400000);
  const agingChart = renderAgingWip(rows, computedSleDays);
  if (agingChart) {
    console.log('\n## Aging WIP\n');
    console.log('```');
    console.log(agingChart);
    console.log('```');
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

  // Write standup.md alongside the working directory (project root)
  const _fs2 = require('fs'), _path2 = require('path');
  const outPath = _path2.resolve(process.cwd(), 'standup.md');
  _fs2.writeFileSync(outPath, _outputLines.join('\n') + '\n', 'utf8');
})().catch(e => { console.error(e.message); process.exit(1); });
