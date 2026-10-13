const $ = id => document.getElementById(id);
const fmt = n => Number(n || 0).toLocaleString('en-US');
let currentData = null;
let fetching = false;

function leaderIds(players, key, reverse = false) {
  if (!players.length) return [];
  const best = reverse ? Math.min(...players.map(p => p[key])) : Math.max(...players.map(p => p[key]));
  return players.filter(p => p[key] === best).map(p => p.id);
}
function displayName(name) {
  return name === 'Jared Goff' ? 'Jared Goff' : name === 'Jordan Love' ? 'Jordan Love' : 'Jameis Winston';
}
function renderChart(players, key, reverse) {
  const leaders = leaderIds(players, key, reverse);
  const maxValue = Math.max(1, ...players.map(p => p[key]));
  const sorted = [...players].sort((a, b) => reverse ? a[key] - b[key] : b[key] - a[key]);
  $(`${key}-chart`).innerHTML = sorted.map(p => {
    const isLeader = leaders.includes(p.id);
    const width = p[key] === 0 ? 0 : Math.max(2, (p[key] / maxValue) * 100);
    return `<div class="bar-row ${isLeader ? 'is-leader' : ''}"><div class="bar-meta"><span class="bar-player">${displayName(p.name)}${isLeader ? ' ♛' : ''}</span><span class="bar-value">${fmt(p[key])}</span></div><div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${p.color}"></div></div></div>`;
  }).join('');
}
function render(data) {
  currentData = data;
  const players = data.players || [];
  renderChart(players, 'yards', false);
  renderChart(players, 'tds', false);
  renderChart(players, 'ints', true);
  const stamp = new Date(data.refreshedAt);
  $('status-label').textContent = `Updated ${stamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
  document.querySelectorAll('.stat-card').forEach(card => {
    const key = card.dataset.stat;
    const leaders = leaderIds(players, key, key === 'ints');
    const names = players.filter(p => leaders.includes(p.id)).map(p => p.name).join(', ');
    const title = card.querySelector('h3');
    if (title) title.title = `Current leader: ${names || 'Tied'}`;
  });
  let banner = $('error-banner');
  if (data.partialData) {
    if (!banner) { banner = document.createElement('div'); banner.id = 'error-banner'; banner.className = 'error-banner'; $('charts-section').prepend(banner); }
    banner.textContent = 'Some game feeds did not respond. Displayed totals may be incomplete; the dashboard will retry automatically.';
  } else if (banner) banner.remove();
}
async function loadStats(force = false) {
  if (fetching) return;
  fetching = true;
  $('refresh-button').disabled = true;
  try {
    const response = await fetch(`/api/stats${force ? `?t=${Date.now()}` : ''}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load stats');
    render(data);
  } catch (error) {
    $('status-label').textContent = 'Stats temporarily unavailable';
    if (!currentData) {
      ['yards-chart', 'tds-chart', 'ints-chart'].forEach(id => { $(id).innerHTML = `<p class="empty-state">${error.message}. Retrying automatically…</p>`; });
    }
  } finally {
    fetching = false;
    $('refresh-button').disabled = false;
  }
}
$('refresh-button').addEventListener('click', () => loadStats(true));
loadStats();
setInterval(() => loadStats(), 45_000);
