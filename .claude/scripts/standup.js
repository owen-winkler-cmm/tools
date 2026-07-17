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

// Statuses misconfigured as "To Do" in Jira but treated as active work by this team
const EXTRA_ACTIVE_STATUSES = ['Planned Ready'];
const ACTIVE_STATUS_JQL = EXTRA_ACTIVE_STATUSES.length
  ? `(statusCategory = "In Progress" OR status in (${EXTRA_ACTIVE_STATUSES.map(s => `"${s}"`).join(',')}))`
  : `statusCategory = "In Progress"`;

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

async function fetchRemoteLinks(issueKey) {
  try {
    const links = await jiraGet(`/rest/api/3/issue/${issueKey}/remotelink`);
    return (Array.isArray(links) ? links : [])
      .map(l => l.object?.url)
      .filter(url => url && /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url));
  } catch {
    return [];
  }
}

async function fetchPrActivity(prUrl) {
  const match = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  const [, repo, num] = match;
  return new Promise(resolve => {
    require('child_process').exec(
      `gh pr view ${num} --repo ${repo} --json updatedAt,latestReviews,reviewRequests,comments,state,reviewDecision`,
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
            repo,
            num: parseInt(num),
            state: d.state,
            reviewDecision: d.reviewDecision,
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

const _origLog = console.log.bind(console);
console.log = (...args) => { _origLog(...args); };

(async () => {
  // Fetch status category map and collaborators field in parallel with ticket queries
  const [statusTypes, allFields, inFlight, completed, backlog] = await Promise.all([
    jiraGet(`/rest/api/3/project/${PROJECT}/statuses`),
    jiraGet('/rest/api/3/field'),
    searchAll(
      `project = ${PROJECT} AND ${ACTIVE_STATUS_JQL} AND issuetype != Epic`,
      ['assignee', 'summary', 'status', 'statuscategorychangedate', STORY_POINTS_FIELD].join(','),
      'changelog',
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
        `project = ${PROJECT} AND ${ACTIVE_STATUS_JQL} AND issuetype != Epic`,
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
        if (!startTime && (cat === 'indeterminate' || EXTRA_ACTIVE_STATUSES.includes(item.toString))) startTime = new Date(history.created).getTime();
        if (cat === 'done') endTime = new Date(history.created).getTime();
      }
    }
    return startTime && endTime && endTime > startTime ? endTime - startTime : null;
  }

  // For statuses whose category doesn't change on transition (EXTRA_ACTIVE_STATUSES),
  // statuscategorychangedate is stale. Walk the changelog to find the real entry time.
  function getStatusEntryTime(issue) {
    const current = issue.fields.status.name;
    const histories = (issue.changelog?.histories || [])
      .slice()
      .sort((a, b) => new Date(a.created) - new Date(b.created));
    let lastEntry = null;
    for (const history of histories) {
      for (const item of history.items) {
        if (item.field === 'status' && item.toString === current) {
          lastEntry = new Date(history.created).getTime();
        }
      }
    }
    return lastEntry ?? new Date(issue.fields.statuscategorychangedate).getTime();
  }

  // Computed SLE and throughput: scoped to active (non-excluded) team members only
  const activeCompleted = completed.filter(i => !isExcluded(i.fields.assignee?.displayName ?? ''));
  const cycleTimes = activeCompleted.map(getCycleTime).filter(ct => ct !== null).sort((a, b) => a - b);
  const computedSleMsRaw = percentile(cycleTimes, SLE_PERCENTILE);
  const computedSleMs = computedSleMsRaw ?? DEFAULT_SLE_DAYS * 86400000;

  // Backlog runway: ready cards at commitment point vs. throughput
  const plannedReadyCount = inFlight.filter(i => EXTRA_ACTIVE_STATUSES.includes(i.fields.status.name)).length;
  const throughputPerWeek = activeCompleted.length / (SLE_HISTORY_DAYS / 7);
  const runwayWeeks = throughputPerWeek > 0 ? Math.round((plannedReadyCount / throughputPerWeek) * 10) / 10 : null;

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
    const entryTime = EXTRA_ACTIVE_STATUSES.includes(issue.fields.status.name)
      ? getStatusEntryTime(issue)
      : new Date(issue.fields.statuscategorychangedate).getTime();
    const ms = NOW - entryTime;
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

  // Enrich In Review cards with GitHub PR activity (linked via Jira remote links)
  if (!skipGithub) {
    const reviewRows = rows.filter(r => /review/i.test(r.status));
    if (reviewRows.length) {
      const linkResults = await Promise.all(
        reviewRows.map(r => fetchRemoteLinks(r.key).then(urls => ({ key: r.key, urls })))
      );
      await Promise.all(linkResults.map(async ({ key, urls }) => {
        const row = rows.find(r => r.key === key);
        if (!row) return;
        row.prSearched = true;
        if (!urls.length) { row.prActivity = null; return; }
        row.prActivity = await fetchPrActivity(urls[0]);
        if (row.prActivity) row.prUrl = urls[0];
      }));
    }
  }

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
    console.log(`**Today is:** ${pickedNationalDay}\n`);
  }

  // ── Computed SLE ────────────────────────────────────────────────────────────
  console.log('## Computed SLE\n');
  if (cycleTimes.length > 0) {
    const median = percentile(cycleTimes, 0.50);
    console.log(`**85th percentile (SLE):** ${humanDuration(computedSleMs)}  `);
    console.log(`**Median:** ${humanDuration(median)}  `);
    console.log(`**Sample:** ${cycleTimes.length} completed cards (last ${SLE_HISTORY_DAYS} days)  `);
    console.log(`**Backlog Runway:** ${plannedReadyCount} ready card${plannedReadyCount !== 1 ? 's' : ''}${runwayWeeks !== null ? ` (~${runwayWeeks}w at current throughput)` : ''}  `);
  } else {
    console.log(`_No completed cards with changelog data in the last ${SLE_HISTORY_DAYS} days -- SLE unavailable._`);
  }

  // Status rank drives right-to-left ordering: lower = closer to done
  function statusRank(statusName) {
    const s = statusName.toLowerCase();
    if (s.includes('deploy') || s.includes('release') || s.includes('staging')) return 0;
    if (s.includes('review')) return 1;
    if (EXTRA_ACTIVE_STATUSES.some(es => es.toLowerCase() === s)) return 3;
    return 2;
  }

  const _esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);

  function generateAgingWipSvg(inFlightRows, sleDays) {
    if (!inFlightRows.length) return '<p><em>No in-flight cards.</em></p>';
    const W = 820, H = 400, P = {t:30, r:95, b:72, l:50};
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
      e.push('<text x="' + (P.l-6).toFixed(1) + '" y="' + y + '" text-anchor="end" dominant-baseline="middle" fill="#94a3b8" font-size="11" font-family="system-ui,sans-serif">' + d + '</text>');
    }
    for (let i = 1; i < nc; i++) {
      const x = (P.l + i * cw).toFixed(1);
      e.push('<line x1="' + x + '" y1="' + P.t + '" x2="' + x + '" y2="' + (P.t+ph) + '" stroke="#e2e8f0" stroke-width="1"/>');
    }
    const sleY = (P.t + sy(sleDays)).toFixed(1);
    e.push('<line x1="' + P.l + '" y1="' + sleY + '" x2="' + (P.l+pw).toFixed(1) + '" y2="' + sleY + '" stroke="#f59e0b" stroke-width="2" stroke-dasharray="6 4"/>');
    e.push('<text x="' + (P.l+pw+8).toFixed(1) + '" y="' + sleY + '" dominant-baseline="middle" fill="#d97706" font-size="11" font-weight="600" font-family="system-ui,sans-serif">SLE ' + sleDays + 'd</text>');
    for (let i = 0; i < nc; i++) {
      const cx = (P.l + i * cw + cw / 2).toFixed(1);
      e.push('<text x="' + cx + '" y="' + (P.t+ph+20).toFixed(1) + '" text-anchor="middle" fill="#374151" font-size="12" font-weight="500" font-family="system-ui,sans-serif">' + _esc(stages[i].name) + '</text>');
      e.push('<text x="' + cx + '" y="' + (P.t+ph+36).toFixed(1) + '" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="system-ui,sans-serif">WIP: ' + stages[i].cards.length + '</text>');
    }
    e.push('<line x1="' + P.l + '" y1="' + P.t + '" x2="' + P.l + '" y2="' + (P.t+ph) + '" stroke="#cbd5e1" stroke-width="1"/>');
    e.push('<line x1="' + P.l + '" y1="' + (P.t+ph) + '" x2="' + (P.l+pw) + '" y2="' + (P.t+ph) + '" stroke="#cbd5e1" stroke-width="1"/>');
    const midY = (P.t + ph / 2).toFixed(1);
    e.push('<text x="14" y="' + midY + '" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="system-ui,sans-serif" transform="rotate(-90 14 ' + midY + ')">Age (days)</text>');
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
        const url = BASE + '/browse/' + r.key;
        e.push(
          '<a href="' + url + '" target="_blank" style="text-decoration:none">' +
          '<g class="wip-card" data-key="' + r.key + '" data-url="' + url + '" data-summary="' + _esc(r.summary) + '" data-name="' + _esc(r.name) + '" data-days="' + days + '" data-status="' + _esc(r.status) + '">' +
          '<circle cx="' + cx + '" cy="' + cy + '" r="13" fill="' + col.f + '" stroke="' + col.s + '" stroke-width="1.5"/>' +
          '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" dominant-baseline="central" fill="#fff" font-size="9" font-weight="600" font-family="system-ui,sans-serif" style="pointer-events:none">' + num + '</text>' +
          '</g></a>'
        );
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + W + 'px;height:auto;display:block">\n' + e.join('\n') + '\n</svg>';
  }

  function generateStandupHtml({ dateLabel, nationalDay, sleDays, medianDays, sampleCount, plannedReadyCount, runwayWeeks, rows, engineerEntries, available, availSuggestions }) {
    const ndUrl = nationalDay ? 'https://www.google.com/search?q=' + encodeURIComponent(nationalDay) + '&btnI=1' : null;
    const svg = generateAgingWipSvg(rows, sleDays);

    let teamHtml = '';
    for (const [name, cards] of engineerEntries) {
      const count = cards.length;
      const badge = count >= 3
        ? '<a href="#recommendations" class="wip-badge critical">⚠ WIP Critical</a>'
        : count >= 2 ? '<a href="#recommendations" class="wip-badge concern">⚠ WIP Concern</a>' : '';
      const ptoEntry = getActivePto(name);
      const upcoming = !ptoEntry ? getUpcomingPto(name) : [];
      const ptoTag = ptoEntry
        ? '<span class="pto-tag">PTO through ' + fmtDate(ptoEntry.end) + '</span>'
        : upcoming.length
          ? '<span class="pto-tag upcoming">PTO ' + fmtDate(upcoming[0].start) + (upcoming[0].end > upcoming[0].start ? '–' + fmtDate(upcoming[0].end) : '') + '</span>'
          : '';
      let cl = '<ul class="card-list">';
      for (const r of cards) {
        const days = Math.floor(r.ms / 86400000);
        const over = days > sleDays;
        let prHtml = '';
        if (r.prSearched) {
          if (!r.prActivity) {
            prHtml = '<span class="pr-info pr-missing">no linked PR</span>';
          } else {
            const a = r.prActivity;
            const lastAgo = a.lastActivity ? humanDuration(NOW - a.lastActivity.getTime()) + ' ago' : '?';
            const dec = (a.reviewDecision || 'pending').toLowerCase().replace(/[^a-z]/g, '-');
            prHtml = '<a href="' + _esc(a.prUrl) + '" class="pr-info pr-link" target="_blank">PR #' + a.num + '</a>' +
              '<span class="pr-info pr-decision pr-' + dec + '">' + _esc(a.reviewDecision || 'pending') + '</span>' +
              '<span class="pr-info">' + _esc(lastAgo) + '</span>';
          }
        }
        cl += '<li>' +
          '<a href="' + BASE + '/browse/' + r.key + '" class="card-key" target="_blank">' + r.key + '</a>' +
          '<span class="card-title">' + _esc(trunc(r.summary, 70)) + '</span>' +
          '<span class="card-status">' + _esc(r.status) + '</span>' +
          '<span class="card-age' + (over ? ' over-sle' : '') + '">' + days + 'd' + (over ? ' ⚠' : '') + '</span>' +
          prHtml +
          '</li>';
      }
      cl += '</ul>';
      teamHtml += '<div class="eng-block"><div class="eng-header">' +
        '<span class="eng-name">' + _esc(name) + '</span>' +
        '<span class="eng-count">' + count + ' card' + (count !== 1 ? 's' : '') + '</span>' +
        badge + ptoTag +
        '</div>' + cl + '</div>';
    }
    for (const name of available) {
      const ptoEntry = getActivePto(name);
      if (ptoEntry) {
        teamHtml += '<div class="eng-block"><div class="eng-header">' +
          '<span class="eng-name">' + _esc(name) + '</span>' +
          '<span class="pto-tag">PTO through ' + fmtDate(ptoEntry.end) + '</span>' +
          '</div></div>';
      } else {
        const sug = availSuggestions.get(name);
        const sugHtml = sug
          ? ' → <a href="' + BASE + '/browse/' + sug.card.key + '" class="card-key" target="_blank">' + sug.card.key + '</a> ' + _esc(trunc(sug.card.fields.summary, 50)) + ' <em>(' + (sug.basis || 'next in queue') + ')</em>'
          : ' — <em>backlog exhausted</em>';
        teamHtml += '<div class="eng-block"><div class="eng-header">' +
          '<span class="eng-name">' + _esc(name) + '</span>' +
          '<span class="avail-note">available' + sugHtml + '</span>' +
          '</div></div>';
      }
    }

    const lookahead = new Date(NOW + 30 * 86400000).toISOString().slice(0, 10);
    const avItems = [];
    for (const entry of (ctx.pto || [])) {
      if (entry.end >= todayStr && entry.start <= lookahead) {
        const ongoing = entry.start <= todayStr;
        const range = entry.end > entry.start ? fmtDate(entry.start) + '–' + fmtDate(entry.end) : fmtDate(entry.start);
        avItems.push({ date: entry.start, html: '<strong>' + _esc(entry.name) + '</strong> — ' + (ongoing ? 'On PTO, returns ' + fmtDate(entry.end) : 'PTO ' + range) + (entry.note ? ' (' + _esc(entry.note) + ')' : '') });
      }
    }
    for (const ev of (ctx.events || [])) {
      if (ev.date >= todayStr && ev.date <= lookahead) {
        avItems.push({ date: ev.date, html: fmtDate(ev.date) + ' — ' + _esc(ev.name) + (ev.note ? ' <span class="ev-note">' + _esc(ev.note) + '</span>' : '') });
      }
    }
    avItems.sort((a, b) => a.date.localeCompare(b.date));
    const avHtml = avItems.length
      ? '<ul class="av-list">' + avItems.map(i => '<li>' + i.html + '</li>').join('') + '</ul>'
      : '<p class="empty-note">No PTO or events in the next 30 days.</p>';

    const css = '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f1f5f9;color:#1e293b;line-height:1.6}.wrap{max-width:960px;margin:0 auto;padding:32px 20px}header{margin-bottom:28px}h1{font-size:1.7rem;font-weight:700;color:#0f172a;letter-spacing:-.02em}.tagline{margin-top:6px;color:#64748b;font-size:.93rem}.tagline a{color:#3b82f6;text-decoration:none}.tagline a:hover{text-decoration:underline}.card{background:#fff;border-radius:12px;padding:24px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.07)}h2{font-size:1.05rem;font-weight:600;color:#0f172a;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #f1f5f9}.metrics-row{display:flex;gap:32px;flex-wrap:wrap;font-size:.9rem;color:#475569}.metrics-row strong{color:#0f172a}.chart-wrap{margin-top:20px}.eng-block{padding:14px 0;border-bottom:1px solid #f1f5f9}.eng-block:last-child{border-bottom:none;padding-bottom:0}.eng-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}.eng-name{font-weight:600;color:#0f172a;font-size:.97rem}.eng-count{color:#64748b;font-size:.85rem}.wip-badge{padding:2px 9px;border-radius:99px;font-size:.75rem;font-weight:600;text-decoration:none}.wip-badge.critical{background:#fee2e2;color:#991b1b}.wip-badge.concern{background:#fef3c7;color:#92400e}.pto-tag{background:#ede9fe;color:#5b21b6;padding:2px 8px;border-radius:99px;font-size:.75rem;font-weight:600}.pto-tag.upcoming{background:#e0f2fe;color:#0369a1}.avail-note{color:#64748b;font-size:.88rem}a.card-key{font-weight:600;color:#3b82f6;text-decoration:none;white-space:nowrap;font-size:.85rem}a.card-key:hover{text-decoration:underline}.card-list{list-style:none;padding-left:4px}.card-list li{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;padding:4px 0;font-size:.88rem}.card-title{color:#374151}.card-status{font-weight:600;color:#0f172a;white-space:nowrap}.card-age{color:#64748b;white-space:nowrap}.card-age.over-sle{color:#ef4444;font-weight:700}.av-list{list-style:none}.av-list li{padding:7px 0;border-bottom:1px solid #f1f5f9;color:#374151;font-size:.9rem}.av-list li:last-child{border-bottom:none}.ev-note{color:#64748b;font-size:.85rem}.empty-note,.recs-placeholder{color:#94a3b8;font-style:italic;font-size:.9rem}#wip-tip{position:fixed;display:none;background:#1e293b;color:#f8fafc;padding:10px 14px;border-radius:8px;font-size:12.5px;max-width:300px;pointer-events:none;z-index:9999;line-height:1.55;box-shadow:0 4px 20px rgba(0,0,0,.35)}#wip-tip .tk{font-weight:700;font-size:13px}#wip-tip .td{margin-top:2px;color:#94a3b8;font-size:11px}#wip-tip .tl{margin-top:8px;pointer-events:auto}#wip-tip .tl a{color:#60a5fa;text-decoration:none;font-weight:600}#wip-tip .tl a:hover{text-decoration:underline}#recs-content h3{font-size:.97rem;font-weight:600;color:#0f172a;margin:20px 0 8px}#recs-content h3:first-child{margin-top:0}#recs-content p{margin-bottom:10px;color:#374151;font-size:.9rem}#recs-content ul,#recs-content ol{padding-left:20px;margin:0 0 14px;font-size:.9rem;color:#374151}#recs-content li{margin-bottom:6px;line-height:1.5}#recs-content a{color:#3b82f6;text-decoration:none}#recs-content a:hover{text-decoration:underline}.pr-info{color:#94a3b8;font-size:.8rem}.pr-missing{color:#f97316}.pr-link{color:#60a5fa;text-decoration:none}.pr-link:hover{text-decoration:underline}.pr-approved{color:#22c55e;font-weight:600}.pr-changes-requested{color:#ef4444;font-weight:600}.pr-review-required{color:#f59e0b;font-weight:600}';
    const js = `const tip=document.getElementById("wip-tip");let pinned=false,pk=null;function showTip(el){const d=el.dataset;tip.innerHTML='<div class="tk">'+d.key+'</div><div class="td">'+d.summary+'</div><div class="td">'+d.name+' · '+d.days+'d · '+d.status+'</div><div class="tl"><a href="'+d.url+'" target="_blank">Open in Jira →</a></div>';tip.style.display='block';}tip.addEventListener('click',e=>e.stopPropagation());document.querySelectorAll('.wip-card').forEach(g=>{g.style.cursor='pointer';g.addEventListener('mouseenter',e=>{if(!pinned)showTip(e.currentTarget);});g.addEventListener('mousemove',e=>{if(!pinned){tip.style.left=(e.clientX+14)+'px';tip.style.top=(e.clientY-40)+'px';}});g.addEventListener('mouseleave',()=>{if(!pinned)tip.style.display='none';});g.addEventListener('click',e=>{e.stopPropagation();const k=e.currentTarget.dataset.key;if(pinned&&pk===k){pinned=false;pk=null;tip.style.display='none';tip.style.pointerEvents='';}else{pinned=true;pk=k;showTip(e.currentTarget);tip.style.left=(e.clientX+14)+'px';tip.style.top=(e.clientY-40)+'px';tip.style.pointerEvents='auto';}});});document.addEventListener('click',()=>{if(pinned){pinned=false;pk=null;tip.style.display='none';tip.style.pointerEvents='';}});document.addEventListener('keydown',e=>{if(e.key==='Escape'){pinned=false;pk=null;tip.style.display='none';tip.style.pointerEvents='';}});(function(){var el=document.getElementById('recs-content');if(el&&el.innerHTML.indexOf('RECOMMENDATIONS_PLACEHOLDER')!==-1){el.innerHTML='<p class="recs-placeholder">Recommendations loading…</p>';var iv=setInterval(function(){location.reload();},2000);setTimeout(function(){clearInterval(iv);},60000);}})();`;

    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>' + _esc(PROJECT) + ' Standup — ' + _esc(dateLabel) + '</title>\n<style>' + css + '</style>\n</head>\n<body>\n<div class="wrap">\n' +
      '<header><h1>' + _esc(PROJECT) + ' Standup — ' + _esc(dateLabel) + '</h1>' +
      (nationalDay ? '<p class="tagline">Today is: <a href="' + ndUrl + '" target="_blank">' + _esc(nationalDay) + '</a></p>' : '') +
      '</header>\n' +
      '<div class="card"><h2>Kanban Metrics</h2>' +
      '<div class="metrics-row"><span><strong>85th Percentile (SLE):</strong> ' + sleDays + ' days</span><span><strong>Median:</strong> ' + medianDays + ' days</span><span><strong>Sample:</strong> ' + sampleCount + ' completed cards (last 28 days)</span><span><strong>Runway:</strong> ' + plannedReadyCount + ' ready card' + (plannedReadyCount !== 1 ? 's' : '') + (runwayWeeks !== null ? ' (~' + runwayWeeks + 'w)' : '') + '</span></div>' +
      '<div class="chart-wrap">' + svg + '</div></div>\n' +
      '<div class="card"><h2>Team Status</h2>' + teamHtml + '</div>\n' +
      '<div class="card" id="recommendations"><h2>Recommendations</h2><div id="recs-content"><!-- RECOMMENDATIONS_PLACEHOLDER --></div></div>\n' +
      '<div class="card"><h2>Availability and Upcoming Events</h2>' + avHtml + '</div>\n' +
      '</div>\n<div id="wip-tip"></div>\n<script>' + js + '<\/script>\n</body>\n</html>';
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
      if (r.prSearched) {
        if (!r.prActivity) {
          console.log(`  - GitHub: no linked PR found`);
        } else {
          const a = r.prActivity;
          const lastAgo = a.lastActivity ? humanDuration(NOW - a.lastActivity.getTime()) + ' ago' : 'unknown';
          const reviewerStr = a.reviewers.length
            ? a.reviewers.map(rv => `${rv.author} (${rv.state})`).join(', ')
            : a.requestedReviewers.length
              ? a.requestedReviewers.map(n => `${n} (requested)`).join(', ')
              : 'none assigned';
          console.log(`  - GitHub: [PR #${a.num}](${a.prUrl}) in ${a.repo} · ${a.state} · review: ${a.reviewDecision || 'NONE'} · last activity: ${lastAgo} · reviewers: ${reviewerStr}`);
        }
      }
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

    const suggestion = availSuggestions.get(name);
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

  // ── Write standup HTML to a dated temp file ──────────────────────────────────
  const _fs = require('fs'), _path = require('path'), _os = require('os');
  const medianDays = cycleTimes.length ? Math.round(percentile(cycleTimes, 0.5) / 86400000) : 0;
  const _sDate = new Date().toISOString().slice(0, 10);
  const _sOut = _path.join(_os.tmpdir(), `standup-${_sDate}.html`);
  _fs.writeFileSync(
    _sOut,
    generateStandupHtml({
      dateLabel: todayLabel,
      nationalDay: pickedNationalDay,
      sleDays: computedSleDays,
      medianDays,
      sampleCount: cycleTimes.length,
      plannedReadyCount,
      runwayWeeks,
      rows,
      engineerEntries,
      available,
      availSuggestions,
    }),
    'utf8',
  );
  console.log('HTML_OUT:' + _sOut);
  const { execSync: _execSync } = require('child_process');
  try {
    const _opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    _execSync(`${_opener} "${_sOut}"`);
  } catch {}

})().catch(e => { console.error(e.message); process.exit(1); });
