#!/usr/bin/env node
// Flow metrics: 8-week rolling kanban health report for a single Jira project.
// Ported from pce-forecast/src/js/compute/flow-dashboard.js; no dependency on that project.
// Usage: node .claude/scripts/metrics.js [--project KEY]

(function () {
  const fs = require('fs'), path = require('path');
  const f = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(f)) fs.readFileSync(f, 'utf8').split('\n').forEach(l => {
    const m = l.match(/^\s*([^#\s][^=]*?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  });
})();

const BASE  = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;

if (!BASE || !EMAIL || !TOKEN) {
  console.error('Missing env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN');
  process.exit(1);
}

const AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;

const rawArgs = process.argv.slice(2);
const pfIdx = rawArgs.indexOf('--project');
const PROJECT = pfIdx !== -1 && rawArgs[pfIdx + 1] ? rawArgs[pfIdx + 1].toUpperCase() : 'PARCH';

const LOOKBACK_WEEKS = 12;
const DISCARD_STATUSES = new Set(['Discard', 'Discarded', 'Cancelled', "Won't Do"]);

// ── Jira API ──────────────────────────────────────────────────────────────────

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

// ── Utilities ─────────────────────────────────────────────────────────────────

function getMondayStart(d) {
  const dt = new Date(d instanceof Date ? d.getTime() : new Date(d).getTime());
  const day = dt.getDay();
  dt.setDate(dt.getDate() + (day === 0 ? -6 : 1 - day));
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function addDays(d, n) {
  const dt = new Date(d.getTime());
  dt.setDate(dt.getDate() + n);
  return dt;
}

function arrMedian(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function arrMean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function arrStdDev(arr) {
  if (arr.length < 2) return 0;
  const m = arrMean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) * (v - m), 0) / (arr.length - 1));
}

// p in [0, 1]; arr must be sorted ascending
function p85(arr) {
  if (!arr.length) return null;
  const idx = Math.ceil(0.85 * arr.length) - 1;
  return arr[Math.max(0, Math.min(idx, arr.length - 1))];
}

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function fmtShort(d) { return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`; }
function fmtFull(d)  { return `${MONTHS_LONG[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; }

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ── Card parsing ──────────────────────────────────────────────────────────────

function buildCategoryMap(statusTypes) {
  const map = new Map();
  for (const it of statusTypes)
    for (const st of it.statuses)
      map.set(st.name, st.statusCategory.key);
  return map;
}

function parseCard(issue, catMap) {
  const histories = (issue.changelog?.histories || [])
    .slice()
    .sort((a, b) => new Date(a.created) - new Date(b.created));

  let flowStartMs = null, flowEndMs = null;
  for (const h of histories) {
    for (const item of h.items) {
      if (item.field !== 'status') continue;
      const cat = catMap.get(item.toString) || '';
      const ts = new Date(h.created).getTime();
      if (!flowStartMs && cat === 'indeterminate') flowStartMs = ts;
      if (!flowEndMs && cat === 'done') flowEndMs = ts;
    }
  }

  const statusName = issue.fields.status?.name || '';
  const statusCat  = catMap.get(statusName) || '';
  const tier = statusCat === 'indeterminate' ? 'in_progress' : statusCat === 'done' ? 'done' : 'backlog';

  const ctMs = (flowStartMs && flowEndMs && flowEndMs > flowStartMs) ? flowEndMs - flowStartMs : null;
  const cycleTime = ctMs !== null ? Math.round(ctMs / 86400000 * 10) / 10 : null;

  return {
    key: issue.key,
    summary: issue.fields.summary || '',
    status: statusName,
    tier,
    cycleTime,
    flowStart: flowStartMs ? new Date(flowStartMs) : null,
    flowEnd:   flowEndMs   ? new Date(flowEndMs)   : null,
    created:   issue.fields.created ? new Date(issue.fields.created) : null,
  };
}

// ── SLE reconstruction ────────────────────────────────────────────────────────

function reconstructSle(cards, asOf, lookbackWeeks = LOOKBACK_WEEKS) {
  const resolvedCutoff = addDays(asOf, -lookbackWeeks * 7);
  const createdCutoff  = addDays(asOf, -lookbackWeeks * 7 * 2);

  const cycleTimes = cards
    .filter(c =>
      c.tier === 'done' &&
      !DISCARD_STATUSES.has(c.status) &&
      c.cycleTime != null && c.cycleTime > 0.1 &&
      c.flowEnd != null && c.flowEnd < asOf && c.flowEnd >= resolvedCutoff &&
      c.created != null && c.created >= createdCutoff
    )
    .map(c => c.cycleTime)
    .sort((a, b) => a - b);

  return cycleTimes.length ? Math.round(p85(cycleTimes) * 10) / 10 : null;
}

// ── Flow metrics computation ──────────────────────────────────────────────────

function buildMetrics(cards, today) {
  const todayMs = today.getTime();
  const curMon = getMondayStart(today);

  // 8 Monday-aligned week starts, oldest first (index 0) → current (index 7)
  const weekStarts = Array.from({ length: 8 }, (_, i) => {
    const ws = new Date(curMon.getTime());
    ws.setDate(ws.getDate() - (7 - i) * 7);
    return ws;
  });

  const weeks = weekStarts.map((weekStart, idx) => {
    const weekEnd   = new Date(weekStart.getTime() + 7 * 86400000);
    const wsMs      = weekStart.getTime();
    const weMs      = weekEnd.getTime();
    const isCurrent = idx === 7;

    const throughputCards = cards.filter(c =>
      c.tier === 'done' && c.flowEnd != null &&
      c.flowEnd.getTime() >= wsMs && c.flowEnd.getTime() < weMs
    );

    const wipCards = cards.filter(c => {
      const fsMs = c.flowStart ? c.flowStart.getTime() : null;
      if (fsMs === null || fsMs >= weMs) return false;
      if (c.tier === 'in_progress') return true;
      if (c.tier === 'done') {
        const feMs = c.flowEnd ? c.flowEnd.getTime() : null;
        return feMs !== null && feMs >= wsMs;
      }
      return false;
    });

    const cycleTimes = throughputCards.filter(c => c.cycleTime != null).map(c => c.cycleTime);
    const medianCycleTime = arrMedian(cycleTimes);
    const reconstructedSle = reconstructSle(cards, isCurrent ? today : weekStart);

    let sleHits = 0, sleMisses = 0;
    if (reconstructedSle !== null) {
      for (const c of cards) {
        if (DISCARD_STATUSES.has(c.status)) continue;
        const fsMs = c.flowStart ? c.flowStart.getTime() : null;
        if (fsMs === null || fsMs < wsMs || fsMs >= weMs) continue;
        if (c.tier !== 'done' || c.cycleTime == null) continue;
        if (c.cycleTime <= reconstructedSle) sleHits++;
        else sleMisses++;
      }
    }

    return { weekOf: weekStart, weekEnd, throughput: throughputCards.length, wip: wipCards.length, medianCycleTime, cycleTimes, reconstructedSle, sleHits, sleMisses, isCurrent };
  });

  const complete = weeks.slice(0, 7);
  const tpVals   = complete.map(w => w.throughput);

  let allCt = [];
  complete.forEach(w => { allCt = allCt.concat(w.cycleTimes); });

  const sleSamples = complete.filter(w => w.reconstructedSle !== null).map(w => w.reconstructedSle);

  let sleHitCount = 0, sleHitTotal = 0;
  complete.forEach(w => { sleHitCount += w.sleHits; sleHitTotal += w.sleHits + w.sleMisses; });

  // At-risk active cards
  const breached = [], warning = [];
  let healthy = 0;
  for (const c of cards) {
    if (c.tier !== 'in_progress' || DISCARD_STATUSES.has(c.status)) continue;
    const fsMs = c.flowStart ? c.flowStart.getTime() : null;
    if (fsMs === null) continue;
    const cardSle = reconstructSle(cards, new Date(fsMs));
    if (cardSle === null) continue;
    const days = Math.round((todayMs - fsMs) / 86400000 * 10) / 10;
    const entry = { key: c.key, summary: c.summary, daysInFlight: days, sle: cardSle, status: c.status };
    if (days > cardSle)               breached.push(entry);
    else if (days / cardSle > 0.8)    warning.push(entry);
    else                               healthy++;
  }
  breached.sort((a, b) => (b.daysInFlight - b.sle) - (a.daysInFlight - a.sle));
  warning.sort((a, b) => (b.daysInFlight / b.sle) - (a.daysInFlight / a.sle));

  // Trend direction (first 4 vs last 3 complete weeks)
  const firstAvg  = arrMean(complete.slice(0, 4).map(w => w.throughput));
  const secondAvg = arrMean(complete.slice(4, 7).map(w => w.throughput));
  const tpDir = secondAvg > firstAvg * 1.1 ? 'up' : secondAvg < firstAvg * 0.9 ? 'down' : 'flat';

  let fc = [], sc = [];
  complete.slice(0, 4).forEach(w => { fc = fc.concat(w.cycleTimes); });
  complete.slice(4, 7).forEach(w => { sc = sc.concat(w.cycleTimes); });
  const fMed = arrMedian(fc), sMed = arrMedian(sc);
  const cycleDir = (fMed != null && sMed != null)
    ? (sMed < fMed * 0.9 ? 'improved' : sMed > fMed * 1.1 ? 'worsened' : 'stable')
    : 'stable';

  const avgThroughput      = Math.round(arrMean(tpVals) * 10) / 10;
  const lastWeekCount      = weeks[6].throughput;
  const medianCycleTime    = allCt.length ? Math.round(arrMedian(allCt) * 10) / 10 : null;
  const avgReconstructedSle = sleSamples.length ? Math.round(arrMean(sleSamples) * 10) / 10 : null;
  const sleHitRate         = sleHitTotal > 0 ? Math.round(sleHitCount / sleHitTotal * 100) : null;

  return {
    generatedAt: new Date(),
    weeks,
    kpi: {
      avgThroughput,
      lastWeekCount,
      lastWeekDelta: Math.round((lastWeekCount - avgThroughput) * 10) / 10,
      stdDev: Math.round(arrStdDev(tpVals) * 10) / 10,
      atRiskBreached: breached.length,
      atRiskWarning:  warning.length,
      atRiskHealthy:  healthy,
      medianCycleTime,
      avgReconstructedSle,
      sleHitRate,
      sleHitCount,
      sleHitTotal,
    },
    breached,
    warning,
    tpDir,
    cycleDir,
    currentSle: weeks[7].reconstructedSle,
  };
}

// ── Narrative ─────────────────────────────────────────────────────────────────

function buildNarrative({ kpi, tpDir, cycleDir }) {
  const parts = [];
  parts.push(tpDir === 'up'
    ? `Throughput is trending up over the past 8 weeks, averaging ${kpi.avgThroughput} cards/week.`
    : tpDir === 'down'
    ? `Throughput is trending down over the past 8 weeks, averaging ${kpi.avgThroughput} cards/week.`
    : `Throughput is holding steady at roughly ${kpi.avgThroughput} cards/week.`);

  if (kpi.medianCycleTime != null) {
    parts.push(cycleDir === 'improved'
      ? `Cycle time has improved recently (median ${kpi.medianCycleTime}d across the window).`
      : cycleDir === 'worsened'
      ? `Cycle time has worsened recently (median ${kpi.medianCycleTime}d across the window).`
      : `Cycle time is stable (median ${kpi.medianCycleTime}d).`);
  }

  if (kpi.sleHitRate != null) {
    parts.push(kpi.sleHitRate >= 85
      ? `SLE hit rate is strong at ${kpi.sleHitRate}% when measured against each card's era commitment.`
      : kpi.sleHitRate >= 70
      ? `SLE hit rate is ${kpi.sleHitRate}% — below the 85% target when measured against era commitments.`
      : `SLE hit rate is low at ${kpi.sleHitRate}% — significantly below target when measured against era commitments.`);
  }

  const urgentParts = [];
  if (kpi.atRiskBreached > 0) urgentParts.push(`${kpi.atRiskBreached} card${kpi.atRiskBreached !== 1 ? 's' : ''} past commitment`);
  if (kpi.atRiskWarning > 0)  urgentParts.push(`${kpi.atRiskWarning} at risk`);
  if (urgentParts.length) parts.push(urgentParts.join(', ') + ' among active work.');

  return parts.join(' ');
}

// ── SVG charts ────────────────────────────────────────────────────────────────

function throughputSvg(weeks, avg) {
  const VW = 480, VH = 185, MT = 15, MR = 30, MB = 52, ML = 36;
  const PW = VW - ML - MR, PH = VH - MT - MB;
  const maxTp = Math.max(1, ...weeks.map(w => w.throughput));
  const yMax  = Math.max(Math.ceil(maxTp / 5) * 5, 5);
  const xC = i => ML + (i + 0.5) * (PW / 8);
  const yP = v => MT + PH - (v / yMax) * PH;
  const bW  = Math.floor(PW / 8 * 0.55);
  const ly  = VH - 6;

  let s = `<svg viewBox="0 0 ${VW} ${VH}" width="100%" preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg">`;

  for (const v of [0, Math.round(yMax * 0.25), Math.round(yMax * 0.5), Math.round(yMax * 0.75), yMax]) {
    const y = yP(v);
    s += `<line x1="${ML}" y1="${y}" x2="${ML+PW}" y2="${y}" stroke="var(--color-border)" stroke-width="1" stroke-dasharray="2,2"/>`;
    s += `<text x="${ML-4}" y="${y+4}" text-anchor="end" font-size="9" fill="var(--color-text-secondary)">${v}</text>`;
  }

  weeks.forEach((w, i) => {
    const bH = Math.max((w.throughput / yMax) * PH, 0);
    const y  = MT + PH - bH;
    s += `<rect x="${xC(i)-bW/2}" y="${y}" width="${bW}" height="${bH}" fill="${w.isCurrent ? '#FFAB00' : '#4C9AFF'}" rx="2"/>`;
    if (w.throughput > 0) s += `<text x="${xC(i)}" y="${y-3}" text-anchor="middle" font-size="9" fill="var(--color-text-secondary)">${w.throughput}</text>`;
  });

  if (avg > 0) {
    const aY = yP(avg);
    s += `<line x1="${ML}" y1="${aY}" x2="${ML+PW}" y2="${aY}" stroke="#FF991F" stroke-width="1.5" stroke-dasharray="4,3"/>`;
    s += `<text x="${ML+PW+3}" y="${aY+4}" font-size="9" fill="#FF991F">avg</text>`;
  }

  weeks.forEach((w, i) => {
    const cx = xC(i), cy = MT + PH + 13;
    s += `<text transform="rotate(-45,${cx},${cy})" x="${cx}" y="${cy}" text-anchor="end" font-size="9" fill="var(--color-text-secondary)">${fmtShort(w.weekOf)}</text>`;
  });

  s += `<rect x="${ML}" y="${ly-7}" width="10" height="8" fill="#4C9AFF" rx="1"/>`;
  s += `<text x="${ML+13}" y="${ly}" font-size="9" fill="var(--color-text-secondary)">Throughput</text>`;
  s += `<rect x="${ML+90}" y="${ly-7}" width="10" height="8" fill="#FFAB00" rx="1"/>`;
  s += `<text x="${ML+103}" y="${ly}" font-size="9" fill="var(--color-text-secondary)">This week</text>`;
  s += `<line x1="${ML+178}" y1="${ly-3}" x2="${ML+190}" y2="${ly-3}" stroke="#FF991F" stroke-width="1.5" stroke-dasharray="4,3"/>`;
  s += `<text x="${ML+193}" y="${ly}" font-size="9" fill="#FF991F">Avg</text>`;
  s += '</svg>';
  return s;
}

function cycleTimeSvg(weeks, currentSle, avgSle) {
  const VW = 480, VH = 185, MT = 15, MR = 36, MB = 52, ML = 40;
  const PW = VW - ML - MR, PH = VH - MT - MB;
  const allVals = [];
  weeks.forEach(w => {
    if (w.medianCycleTime != null) allVals.push(w.medianCycleTime);
    if (w.reconstructedSle != null) allVals.push(w.reconstructedSle);
  });
  const yMax = Math.max(Math.ceil((allVals.length ? Math.max(...allVals) : 10) / 5) * 5, 5);
  const xL = i => ML + i * (PW / 8);
  const xR = i => ML + (i + 1) * (PW / 8);
  const xC = i => ML + (i + 0.5) * (PW / 8);
  const yP = v => MT + PH - (v / yMax) * PH;
  const ly = VH - 6;

  let s = `<svg viewBox="0 0 ${VW} ${VH}" width="100%" preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg">`;

  for (const v of [0, Math.round(yMax * 0.25), Math.round(yMax * 0.5), Math.round(yMax * 0.75), yMax]) {
    const y = yP(v);
    s += `<line x1="${ML}" y1="${y}" x2="${ML+PW}" y2="${y}" stroke="var(--color-border)" stroke-width="1" stroke-dasharray="2,2"/>`;
    s += `<text x="${ML-4}" y="${y+4}" text-anchor="end" font-size="9" fill="var(--color-text-secondary)">${v}d</text>`;
  }

  const slePoints = [];
  weeks.forEach((w, i) => {
    if (w.reconstructedSle == null) return;
    const y = yP(w.reconstructedSle);
    slePoints.push(`${xL(i)},${y}`, `${xR(i)},${y}`);
  });
  if (slePoints.length) {
    s += `<polyline points="${slePoints.join(' ')}" fill="none" stroke="#DE350B" stroke-width="1.5" stroke-dasharray="4,3"/>`;
    const lastSle = weeks[weeks.length - 1].reconstructedSle ?? currentSle ?? 0;
    s += `<text x="${ML+PW+3}" y="${yP(lastSle)+4}" font-size="9" fill="#DE350B">SLE</text>`;
  }

  const linePoints = [];
  weeks.forEach((w, i) => {
    if (w.medianCycleTime != null) linePoints.push(`${xC(i)},${yP(w.medianCycleTime)}`);
  });
  if (linePoints.length > 1) s += `<polyline points="${linePoints.join(' ')}" fill="none" stroke="#4C9AFF" stroke-width="2"/>`;

  weeks.forEach((w, i) => {
    if (w.medianCycleTime == null) return;
    const overSle = w.reconstructedSle != null && w.medianCycleTime > w.reconstructedSle;
    const fill = w.isCurrent ? '#FF991F' : overSle ? '#DE350B' : '#00875A';
    s += `<circle cx="${xC(i)}" cy="${yP(w.medianCycleTime)}" r="4" fill="${fill}" stroke="white" stroke-width="1.5"/>`;
  });

  weeks.forEach((w, i) => {
    const cx = xC(i), cy = MT + PH + 13;
    s += `<text transform="rotate(-45,${cx},${cy})" x="${cx}" y="${cy}" text-anchor="end" font-size="9" fill="var(--color-text-secondary)">${fmtShort(w.weekOf)}</text>`;
  });

  if (avgSle != null) {
    const ay = yP(avgSle);
    s += `<line x1="${ML}" y1="${ay}" x2="${ML+PW}" y2="${ay}" stroke="#FF991F" stroke-width="1" stroke-dasharray="6,3" opacity="0.7"/>`;
    s += `<text x="${ML+PW+3}" y="${ay+4}" font-size="9" fill="#FF991F">avg</text>`;
  }

  s += `<line x1="${ML}" y1="${ly-3}" x2="${ML+16}" y2="${ly-3}" stroke="#4C9AFF" stroke-width="2"/>`;
  s += `<circle cx="${ML+8}" cy="${ly-3}" r="3" fill="#00875A" stroke="white" stroke-width="1"/>`;
  s += `<text x="${ML+20}" y="${ly}" font-size="9" fill="var(--color-text-secondary)">Median CT</text>`;
  s += `<line x1="${ML+90}" y1="${ly-3}" x2="${ML+106}" y2="${ly-3}" stroke="#DE350B" stroke-width="1.5" stroke-dasharray="4,3"/>`;
  s += `<text x="${ML+109}" y="${ly}" font-size="9" fill="#DE350B">SLE (weekly P85)</text>`;
  if (avgSle != null) {
    s += `<line x1="${ML+225}" y1="${ly-3}" x2="${ML+241}" y2="${ly-3}" stroke="#FF991F" stroke-width="1" stroke-dasharray="6,3" opacity="0.7"/>`;
    s += `<text x="${ML+244}" y="${ly}" font-size="9" fill="#FF991F">SLE avg (${avgSle}d)</text>`;
  }
  s += '</svg>';
  return s;
}

// ── HTML generation ───────────────────────────────────────────────────────────

function kpiRow(kpi) {
  const dSign = kpi.lastWeekDelta >= 0 ? '+' : '';
  const dCls  = kpi.lastWeekDelta >= 0 ? 'fm-kpi-pos' : 'fm-kpi-neg';
  const total = kpi.atRiskBreached + kpi.atRiskWarning + kpi.atRiskHealthy;

  let atRisk = '<div class="fm-kpi-card"><div class="fm-kpi-label">At-Risk Cards</div>';
  if (total > 0) {
    const cls = kpi.atRiskBreached > 0 ? 'fm-kpi-neg' : kpi.atRiskWarning > 0 ? 'fm-kpi-warn' : 'fm-kpi-pos';
    atRisk += `<div class="fm-kpi-value ${cls}">${kpi.atRiskBreached + kpi.atRiskWarning}</div>`;
    atRisk += `<div class="fm-kpi-sub">${kpi.atRiskBreached} breached &middot; ${kpi.atRiskWarning} at risk &middot; ${kpi.atRiskHealthy} healthy</div>`;
  } else {
    atRisk += '<div class="fm-kpi-value fm-kpi-pos">0</div><div class="fm-kpi-sub">no active cards in flight</div>';
  }
  atRisk += '</div>';

  let cycle = '<div class="fm-kpi-card"><div class="fm-kpi-label">Median Cycle Time</div>';
  if (kpi.medianCycleTime != null) {
    const sub = kpi.avgReconstructedSle != null ? `7-wk avg SLE: ${kpi.avgReconstructedSle}d` : '7-week window';
    cycle += `<div class="fm-kpi-value">${kpi.medianCycleTime}<span style="font-size:var(--fs-sm);color:var(--color-text-secondary)">d</span></div><div class="fm-kpi-sub">${sub}</div>`;
  } else {
    cycle += '<div class="fm-kpi-value" style="color:var(--color-text-secondary)">--</div><div class="fm-kpi-sub">no data</div>';
  }
  cycle += '</div>';

  let sle = '<div class="fm-kpi-card"><div class="fm-kpi-label">SLE Hit Rate</div>';
  if (kpi.sleHitRate != null) {
    const cls = kpi.sleHitRate >= 85 ? 'fm-kpi-pos' : kpi.sleHitRate >= 70 ? 'fm-kpi-warn' : 'fm-kpi-neg';
    sle += `<div class="fm-kpi-value ${cls}">${kpi.sleHitRate}<span style="font-size:var(--fs-sm)">%</span></div><div class="fm-kpi-sub">${kpi.sleHitCount}/${kpi.sleHitTotal} vs era commitment</div>`;
  } else {
    sle += '<div class="fm-kpi-value" style="color:var(--color-text-secondary)">--</div><div class="fm-kpi-sub">no completed data</div>';
  }
  sle += '</div>';

  return `<div class="fm-kpi-row">
    <div class="fm-kpi-card"><div class="fm-kpi-label">7-Week Avg Throughput</div><div class="fm-kpi-value">${kpi.avgThroughput}</div><div class="fm-kpi-sub">cards / week</div></div>
    <div class="fm-kpi-card"><div class="fm-kpi-label">Last Week</div><div class="fm-kpi-value">${kpi.lastWeekCount}</div><div class="fm-kpi-sub"><span class="${dCls}">${dSign}${kpi.lastWeekDelta}</span> cards vs 7-wk avg</div></div>
    <div class="fm-kpi-card"><div class="fm-kpi-label">Throughput Std Dev</div><div class="fm-kpi-value">&plusmn;${kpi.stdDev}</div><div class="fm-kpi-sub">cards / week (7-week)</div></div>
    ${atRisk}${cycle}${sle}
  </div>`;
}

function detailTable(weeks) {
  let h = '<table class="fm-detail-table"><thead><tr><th>Week of</th><th>Throughput</th><th>WIP</th><th>Median CT</th><th>SLE (era)</th><th>Hit Rate</th></tr></thead><tbody>';

  for (const w of weeks) {
    const rowCls = w.isCurrent ? ' class="fm-current-week"' : '';
    const end    = new Date(w.weekOf.getTime() + 6 * 86400000);
    const label  = `${fmtShort(w.weekOf)} &ndash; ${fmtShort(end)}${w.isCurrent ? ' *' : ''}`;

    const ctDisplay = w.medianCycleTime != null ? `${Math.round(w.medianCycleTime)}d` : '--';
    let ctClass = '';
    if (w.reconstructedSle != null && w.medianCycleTime != null)
      ctClass = w.medianCycleTime > w.reconstructedSle ? ' class="fm-sle-miss-red"' : w.medianCycleTime > w.reconstructedSle * 0.8 ? ' class="fm-sle-miss"' : '';

    const sleEraTd = w.reconstructedSle != null
      ? `<td>${w.isCurrent ? '<strong>' : ''}${w.reconstructedSle}d${w.isCurrent ? '</strong>' : ''}</td>`
      : '<td>--</td>';

    const hitTotal = w.sleHits + w.sleMisses;
    let hitTd;
    if (w.isCurrent)       hitTd = '<td style="color:var(--color-text-secondary)">pending</td>';
    else if (hitTotal > 0) {
      const pct = Math.round(w.sleHits / hitTotal * 100);
      const cls = pct >= 85 ? '' : pct >= 70 ? ' class="fm-sle-miss"' : ' class="fm-sle-miss-red"';
      hitTd = `<td${cls}>${pct}% (${w.sleHits}/${hitTotal})</td>`;
    } else hitTd = '<td>--</td>';

    h += `<tr${rowCls}><td>${label}</td><td>${w.throughput}</td><td>${w.wip}</td><td${ctClass}>${ctDisplay}</td>${sleEraTd}${hitTd}</tr>`;
  }

  h += '</tbody></table>';
  h += '<div style="font-size:var(--fs-xs);color:var(--color-text-secondary);margin-top:var(--sp-2)">* current week (partial)</div>';
  return h;
}

function atRiskTable(breached, warning) {
  if (!breached.length && !warning.length) return '';

  let h = '<div class="fm-detail-section"><div class="fm-detail-title">Cards Requiring Attention</div>';
  h += '<table class="fm-detail-table"><thead><tr><th>Key</th><th>Status</th><th>Summary</th><th>In Flight</th><th>Commitment</th><th>Over / Left</th></tr></thead><tbody>';

  for (const c of breached) {
    const over = Math.round((c.daysInFlight - c.sle) * 10) / 10;
    h += `<tr>
      <td style="white-space:nowrap"><a href="${BASE}/browse/${c.key}" target="_blank" style="color:var(--color-brand);font-weight:var(--fw-semibold)">${c.key}</a></td>
      <td style="white-space:nowrap"><span class="badge badge-neutral badge-sm">${esc(c.status)}</span></td>
      <td>${esc(c.summary)}</td>
      <td style="white-space:nowrap">${c.daysInFlight}d</td>
      <td style="white-space:nowrap">${c.sle}d</td>
      <td class="fm-sle-miss-red" style="white-space:nowrap;font-weight:var(--fw-bold)">+${over}d</td>
    </tr>`;
  }

  for (const c of warning) {
    const left = Math.round((c.sle - c.daysInFlight) * 10) / 10;
    h += `<tr>
      <td style="white-space:nowrap"><a href="${BASE}/browse/${c.key}" target="_blank" style="color:var(--color-brand);font-weight:var(--fw-semibold)">${c.key}</a></td>
      <td style="white-space:nowrap"><span class="badge badge-neutral badge-sm">${esc(c.status)}</span></td>
      <td>${esc(c.summary)}</td>
      <td style="white-space:nowrap">${c.daysInFlight}d</td>
      <td style="white-space:nowrap">${c.sle}d</td>
      <td class="fm-sle-miss" style="white-space:nowrap">${left}d left</td>
    </tr>`;
  }

  h += '</tbody></table></div>';
  return h;
}

function generateHtml(data) {
  const { generatedAt, weeks, kpi, breached, warning, tpDir, cycleDir, currentSle } = data;

  const css = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:16px;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{min-height:100vh}
a{color:var(--color-brand);text-decoration:none}
a:hover{color:var(--color-brand-hover);text-decoration:underline}
:root{
--color-bg:#F8F9FB;--color-surface:#FFFFFF;--color-surface-alt:#F4F5F7;--color-surface-hover:#EBECF0;
--color-border:#DFE1E6;--color-border-light:#EBECF0;
--color-text:#172B4D;--color-text-secondary:#6B778C;--color-text-muted:#97A0AF;--color-text-inverse:#FFFFFF;
--color-brand:#0052CC;--color-brand-hover:#0747A6;--color-brand-light:#DEEBFF;
--color-success:#00875A;--color-success-bg:#E3FCEF;--color-success-border:#ABF5D1;
--color-warning:#FF8B00;--color-warning-bg:#FFFAE6;--color-warning-border:#FFE380;
--color-danger:#DE350B;--color-danger-bg:#FFEBE6;--color-danger-border:#FFBDAD;
--color-info:#0065FF;--color-info-bg:#DEEBFF;--color-info-border:#B3D4FF;
--font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;
--font-mono:'SF Mono','Fira Code','Cascadia Code',Menlo,monospace;
--fs-xs:0.6875rem;--fs-sm:0.8125rem;--fs-base:0.875rem;--fs-md:1rem;--fs-lg:1.25rem;--fs-xl:1.5rem;--fs-2xl:2rem;
--fw-normal:400;--fw-medium:500;--fw-semibold:600;--fw-bold:700;
--lh-tight:1.25;--lh-normal:1.5;
--sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:20px;--sp-6:24px;--sp-8:32px;--sp-10:40px;--sp-12:48px;
--radius-sm:4px;--radius-md:8px;--radius-lg:12px;--radius-full:9999px;
--shadow-sm:0 1px 2px rgba(23,43,77,.04);--shadow-md:0 2px 8px rgba(23,43,77,.08);
}
body{font-family:var(--font-family);font-size:var(--fs-base);line-height:var(--lh-normal);color:var(--color-text);background:var(--color-bg)}
h1,h2,h3,h4{font-weight:var(--fw-semibold);line-height:var(--lh-tight)}
h1{font-size:var(--fs-xl)}h2{font-size:var(--fs-lg)}h3{font-size:var(--fs-md)}h4{font-size:var(--fs-base)}
.badge{display:inline-flex;align-items:center;justify-content:center;padding:1px 8px;border-radius:var(--radius-full);font-size:var(--fs-xs);font-weight:var(--fw-semibold);line-height:1.6;white-space:nowrap}
.badge-neutral{background:var(--color-surface-alt);color:var(--color-text-secondary)}
.badge-sm{font-size:10px;padding:0 6px}
.fm-page{padding:var(--sp-6) var(--sp-8);max-width:1100px;margin:0 auto}
.fm-page-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:var(--sp-8)}
.fm-title{font-size:var(--fs-xl);font-weight:var(--fw-bold);color:var(--color-text);margin:0 0 var(--sp-1)}
.fm-subtitle{font-size:var(--fs-sm);color:var(--color-text-secondary)}
.fm-kpi-row{display:grid;grid-template-columns:repeat(6,1fr);gap:var(--sp-3);margin-bottom:var(--sp-8)}
.fm-kpi-card{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--sp-4)}
.fm-kpi-label{font-size:var(--fs-xs);color:var(--color-text-secondary);margin-bottom:var(--sp-2);font-weight:var(--fw-medium)}
.fm-kpi-value{font-size:var(--fs-2xl);font-weight:var(--fw-bold);line-height:1;color:var(--color-text);margin-bottom:var(--sp-1)}
.fm-kpi-sub{font-size:var(--fs-xs);color:var(--color-text-secondary)}
.fm-kpi-pos{color:var(--color-success)}.fm-kpi-neg{color:var(--color-danger)}.fm-kpi-warn{color:var(--color-warning)}
.fm-charts{display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-5);margin-bottom:var(--sp-8)}
.fm-chart-card{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--sp-4) var(--sp-5)}
.fm-chart-title{font-size:var(--fs-xs);font-weight:var(--fw-bold);color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:var(--sp-3)}
.fm-detail-section{margin-bottom:var(--sp-6)}
.fm-detail-title{font-size:var(--fs-xs);font-weight:var(--fw-bold);color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:.5px;margin-bottom:var(--sp-3)}
.fm-detail-table{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}
.fm-detail-table th{padding:var(--sp-2) var(--sp-3);text-align:left;font-weight:var(--fw-semibold);color:var(--color-text-secondary);border-bottom:2px solid var(--color-border);background:var(--color-surface-alt);white-space:nowrap}
.fm-detail-table th:not(:first-child){text-align:right}
.fm-detail-table td{padding:var(--sp-2) var(--sp-3);border-bottom:1px solid var(--color-border-light);color:var(--color-text)}
.fm-detail-table td:not(:first-child){text-align:right}
.fm-detail-table tr:last-child td{border-bottom:none}
.fm-detail-table tr.fm-current-week td{background:var(--color-warning-bg)}
.fm-sle-miss{color:var(--color-warning);font-weight:var(--fw-semibold)}
.fm-sle-miss-red{color:var(--color-danger);font-weight:var(--fw-semibold)}
.fm-narrative{background:var(--color-info-bg);border:1px solid var(--color-info-border);border-radius:var(--radius-md);padding:var(--sp-4) var(--sp-5);font-size:var(--fs-sm);color:var(--color-text);line-height:var(--lh-normal)}
@media(max-width:700px){.fm-kpi-row{grid-template-columns:repeat(2,1fr)}.fm-charts{grid-template-columns:1fr}}
`;

  const body = `<div class="fm-page">
  <div class="fm-page-header">
    <div>
      <h1 class="fm-title">Flow Metrics &mdash; ${esc(PROJECT)}</h1>
      <div class="fm-subtitle">8-week rolling window &middot; generated ${fmtFull(generatedAt)}</div>
    </div>
  </div>
  ${kpiRow(kpi)}
  <div class="fm-charts">
    <div class="fm-chart-card">
      <div class="fm-chart-title">Weekly Throughput</div>
      ${throughputSvg(weeks, kpi.avgThroughput)}
    </div>
    <div class="fm-chart-card">
      <div class="fm-chart-title">Cycle Time vs Adaptive SLE</div>
      ${cycleTimeSvg(weeks, currentSle, kpi.avgReconstructedSle)}
    </div>
  </div>
  <div class="fm-detail-section">
    <div class="fm-detail-title">Weekly Detail</div>
    ${detailTable(weeks)}
  </div>
  ${atRiskTable(breached, warning)}
  <div class="fm-narrative">${esc(buildNarrative(data))}</div>
</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flow Metrics &mdash; ${esc(PROJECT)}</title>
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  process.stderr.write(`Fetching ${PROJECT} issues from Jira...\n`);

  const [statusTypes, inProgress, done] = await Promise.all([
    jiraGet(`/rest/api/3/project/${PROJECT}/statuses`),
    searchAll(
      `project = ${PROJECT} AND statusCategory = "In Progress" AND issuetype != Epic`,
      'summary,status,statuscategorychangedate,created',
      'changelog'
    ),
    searchAll(
      `project = ${PROJECT} AND statusCategory = Done AND issuetype != Epic AND updated >= "-180d"`,
      'summary,status,statuscategorychangedate,created',
      'changelog'
    ),
  ]);

  process.stderr.write(`Fetched ${inProgress.length} in-progress, ${done.length} done issues. Computing metrics...\n`);

  const catMap = buildCategoryMap(statusTypes);
  const cards  = [...inProgress, ...done].map(i => parseCard(i, catMap));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const data = buildMetrics(cards, today);
  const html = generateHtml(data);

  const outPath = require('path').resolve(process.cwd(), 'metrics.html');
  require('fs').writeFileSync(outPath, html, 'utf8');

  const { kpi, currentSle } = data;
  console.log(`metrics.html written.`);
  console.log(`\nSLE (current): ${currentSle != null ? currentSle + 'd' : 'n/a'} (7-wk avg: ${kpi.avgReconstructedSle != null ? kpi.avgReconstructedSle + 'd' : 'n/a'})`);
  console.log(`Throughput: ${kpi.avgThroughput} cards/week avg | last week: ${kpi.lastWeekCount} | std dev: ±${kpi.stdDev}`);
  console.log(`SLE hit rate: ${kpi.sleHitRate != null ? kpi.sleHitRate + '%' : 'n/a'} (${kpi.sleHitCount}/${kpi.sleHitTotal})`);
  console.log(`At risk: ${kpi.atRiskBreached} breached, ${kpi.atRiskWarning} warning, ${kpi.atRiskHealthy} healthy`);
})().catch(e => { console.error(e.message); process.exit(1); });
