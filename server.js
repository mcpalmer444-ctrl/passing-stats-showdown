const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const SEASON = 2026;
const START_WEEK = 3;
const LAST_REGULAR_WEEK = 18;
const REFRESH_MS = 45_000;
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const PLAYERS = [
  { id: '3046779', name: 'Jared Goff', team: 'Detroit Lions', teamCode: 'DET', color: '#0076B8' },
  { id: '4036378', name: 'Jordan Love', team: 'Green Bay Packers', teamCode: 'GB', color: '#203731' },
  { id: '2969939', name: 'Jameis Winston', team: 'NFL', teamCode: 'NFL', color: '#D6A329' }
];

const scoreboardCache = new Map();
const summaryCache = new Map();
let responseCache = { at: 0, value: null };

async function fetchJson(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'PassingStatsShowdown/1.0 (public stats dashboard)' }
    });
    if (!response.ok) throw new Error(`ESPN returned ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getScoreboard(week) {
  const key = `${SEASON}-2-${week}`;
  const cached = scoreboardCache.get(key);
  if (cached && Date.now() - cached.at < 120_000) return cached.data;
  const url = `${ESPN}/scoreboard?season=${SEASON}&seasontype=2&week=${week}`;
  const data = await fetchJson(url);
  scoreboardCache.set(key, { at: Date.now(), data });
  return data;
}

async function getSummary(eventId, isLive) {
  const cached = summaryCache.get(eventId);
  const ttl = isLive ? 15_000 : 6 * 60 * 60 * 1000;
  if (cached && Date.now() - cached.at < ttl) return cached.data;
  const data = await fetchJson(`${ESPN}/summary?event=${encodeURIComponent(eventId)}`);
  summaryCache.set(eventId, { at: Date.now(), data });
  return data;
}

function getPassingLine(summary, playerId) {
  const groups = summary?.boxscore?.players || [];
  for (const group of groups) {
    for (const statGroup of (group.statistics || [])) {
      const groupName = String(statGroup.name || statGroup.displayName || '').toLowerCase();
      const labels = (statGroup.keys || statGroup.labels || []).map(x => String(x).toLowerCase());
      const isPassing = groupName.includes('passing') || labels.some(x => x === 'int' || x.includes('cmp/att'));
      if (!isPassing) continue;
      const yardsIndex = labels.findIndex(x => x === 'yds' || x.includes('yards'));
      const tdIndex = labels.findIndex(x => x === 'td' || x.includes('touchdown'));
      const intIndex = labels.findIndex(x => x === 'int' || x.includes('interception'));
      for (const athleteLine of (statGroup.athletes || [])) {
        if (String(athleteLine.athlete?.id) !== String(playerId)) continue;
        const stats = athleteLine.stats || [];
        const numberAt = i => i >= 0 ? (Number(String(stats[i] ?? '0').replace(/,/g, '')) || 0) : 0;
        return { yards: numberAt(yardsIndex), tds: numberAt(tdIndex), ints: numberAt(intIndex) };
      }
    }
  }
  return null;
}

async function loadSeasonStats() {
  if (responseCache.value && Date.now() - responseCache.at < REFRESH_MS) return responseCache.value;
  const totals = Object.fromEntries(PLAYERS.map(p => [p.id, { yards: 0, tds: 0, ints: 0, games: 0, weekly: [] }]));
  const errors = [];
  let checkedGames = 0;
  let latestWeekWithGames = START_WEEK - 1;

  // Week 3 onward only. Preseason is excluded by using regular-season season type 2.
  const scoreboards = await Promise.all(Array.from({ length: LAST_REGULAR_WEEK - START_WEEK + 1 }, (_, i) => START_WEEK + i)
    .map(async week => {
      try { return { week, data: await getScoreboard(week) }; }
      catch (error) { errors.push(`Week ${week}: ${error.message}`); return { week, data: null }; }
    }));

  const events = [];
  for (const { week, data } of scoreboards) {
    if (!data) continue;
    for (const event of (data.events || [])) {
      const state = event.status?.type?.state;
      // Ignore games that have not started. Completed and live games count.
      if (state === 'pre') continue;
      if (state !== 'in' && state !== 'post') continue;
      events.push({ event, week, isLive: state === 'in' });
      latestWeekWithGames = Math.max(latestWeekWithGames, week);
    }
  }

  const summaries = await Promise.all(events.map(async item => {
    try { return { ...item, summary: await getSummary(item.event.id, item.isLive) }; }
    catch (error) { errors.push(`${item.event.name || item.event.id}: ${error.message}`); return { ...item, summary: null }; }
  }));

  for (const item of summaries) {
    if (!item.summary) continue;
    checkedGames++;
    for (const player of PLAYERS) {
      const line = getPassingLine(item.summary, player.id);
      if (!line) continue;
      const t = totals[player.id];
      t.yards += line.yards;
      t.tds += line.tds;
      t.ints += line.ints;
      // Count a player's game only when ESPN returns a passing line for that player.
      t.games += 1;
      t.weekly.push({ week: item.week, eventId: item.event.id, opponent: item.event.name || '', ...line });
    }
  }

  const result = {
    season: SEASON,
    startWeek: START_WEEK,
    lastRegularWeek: LAST_REGULAR_WEEK,
    throughWeek: latestWeekWithGames,
    checkedGames,
    refreshedAt: new Date().toISOString(),
    refreshEveryMs: REFRESH_MS,
    players: PLAYERS.map(p => ({ ...p, ...totals[p.id], weekly: totals[p.id].weekly.sort((a, b) => a.week - b.week) })),
    // Errors are summarized without exposing internal details to the page.
    partialData: errors.length > 0,
    errorCount: errors.length
  };
  responseCache = { at: Date.now(), value: result };
  return result;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/stats') {
    try {
      const data = await loadSeasonStats();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Live stats are temporarily unavailable.', detail: error.message }));
    }
    return;
  }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const target = path.resolve(ROOT, `.${pathname}`);
  if (!target.startsWith(ROOT + path.sep) && target !== path.join(ROOT, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(target, (err, body) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
    res.end(body);
  });
});

server.listen(PORT, () => console.log(`Passing Stats Showdown listening on ${PORT}`));
