/* Champions League Live — zero-dependency client for ESPN's public soccer API.
   No API key, no build step. Two endpoints do all the work:
     scoreboard?dates=YYYYMMDD[-YYYYMMDD]  → fixtures, live clocks, goals, cards
     standings                             → the 36-team league-phase table       */

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard';
const STANDINGS  = 'https://site.api.espn.com/apis/v2/sports/soccer/uefa.champions/standings';

const LIVE_MS = 30_000;    // poll cadence while something is in play
const IDLE_MS = 300_000;   // …and when nothing is

const state = {
  view: 'matches',
  date: new Date(),
  expanded: new Set(),
  events: [],
  standings: null,
  strip: null,
  timer: null,
};

/* ── helpers ─────────────────────────────────────────────── */
const $  = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Local calendar day, so a 21:00 UTC kickoff lands on the viewer's date. */
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const apiDay = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const shiftDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const chipFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/* Pull a competitor out by its role — never trust array order. */
const sideOf = (comp, role) => comp.competitors.find((c) => c.homeAway === role) ?? comp.competitors[0];
const logoOf = (team) => team?.logo ?? team?.logos?.[0]?.href ?? '';

/* ── data loading ────────────────────────────────────────── */
async function loadMatches({ quiet = false } = {}) {
  if (!quiet) $('#matches').innerHTML =
    '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';

  // Fetch a ±1-day window, then filter to the viewer's local day. This keeps
  // late kickoffs on the right date in every timezone.
  const from = apiDay(shiftDays(state.date, -1));
  const to   = apiDay(shiftDays(state.date, 1));

  try {
    const data = await getJSON(`${SCOREBOARD}?dates=${from}-${to}`);
    const want = dayKey(state.date);
    state.events = (data.events ?? [])
      .filter((e) => dayKey(new Date(e.date)) === want)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const league = data.leagues?.[0];
    if (league) {
      const phase = league.season?.type?.name ?? '';
      const yr = league.season?.year;
      $('#season-line').textContent =
        [yr ? `${yr}/${String((yr % 100) + 1).padStart(2, '0')}` : null, phase]
          .filter(Boolean).join(' · ') || 'Season';
    }

    renderMatches();
    stampUpdated();
    scheduleRefresh();
  } catch (err) {
    $('#matches').innerHTML =
      `<div class="error">Couldn't load fixtures — ${esc(err.message)}
       <button type="button" data-retry>Try again</button></div>`;
    $('#matches').querySelector('[data-retry]')?.addEventListener('click', () => loadMatches());
  }
}

async function loadStandings({ quiet = false } = {}) {
  if (!quiet && !state.standings) $('#standings-wrap').innerHTML = '<div class="loading">Loading table…</div>';
  try {
    const data = await getJSON(STANDINGS);
    state.standings = data.children?.[0]?.standings?.entries ?? data.standings?.entries ?? [];
    renderStandings();
    stampUpdated();
  } catch (err) {
    $('#standings-wrap').innerHTML =
      `<div class="error">Couldn't load the table — ${esc(err.message)}
       <button type="button" data-retry>Try again</button></div>`;
    $('#standings-wrap').querySelector('[data-retry]')?.addEventListener('click', () => loadStandings());
  }
}

/** Dates with fixtures in a 3-week window, for the quick-jump strip. */
async function loadStrip() {
  try {
    const data = await getJSON(
      `${SCOREBOARD}?dates=${apiDay(shiftDays(new Date(), -7))}-${apiDay(shiftDays(new Date(), 14))}`);
    const days = new Map();
    for (const e of data.events ?? []) {
      const d = new Date(e.date);
      const k = dayKey(d);
      if (!days.has(k)) days.set(k, { key: k, date: d, n: 0 });
      days.get(k).n++;
    }
    state.strip = [...days.values()].sort((a, b) => a.date - b.date);
    renderStrip();
  } catch { /* the strip is a convenience; failing it shouldn't break the page */ }
}

/* ── rendering: matches ──────────────────────────────────── */
function renderMatches() {
  const box = $('#matches');
  const live = state.events.filter((e) => e.status?.type?.state === 'in').length;

  $('#live-badge').hidden = live === 0;
  $('#live-count').textContent = live;

  $('#date-label').textContent = dateFmt.format(state.date);
  const today = dayKey(new Date()) === dayKey(state.date);
  const n = state.events.length;
  $('#date-sub').textContent =
    `${today ? 'Today · ' : ''}${n === 0 ? 'no fixtures' : n === 1 ? '1 match' : `${n} matches`}`;

  if (!state.events.length) {
    box.innerHTML = `<div class="empty">No Champions League matches on this date.<br>
      Use the arrows or the dates above to find the next matchday.</div>`;
    renderStrip();
    return;
  }

  box.innerHTML = state.events.map(matchCard).join('');
  box.querySelectorAll('.match-head').forEach((head) => {
    head.addEventListener('click', () => {
      const id = head.closest('.match').dataset.id;
      state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
      renderMatches();
    });
  });
  renderStrip();
}

function matchCard(ev) {
  const comp  = ev.competitions[0];
  const st    = ev.status?.type ?? {};
  const home  = sideOf(comp, 'home');
  const away  = sideOf(comp, 'away');
  const isLive = st.state === 'in';
  const isPre  = st.state === 'pre';
  const done   = st.state === 'post';
  const open   = state.expanded.has(ev.id);

  // Centre column: kickoff before the match, score once it's under way.
  let centre;
  if (isPre) {
    centre = `<div class="kickoff">${timeFmt.format(new Date(ev.date))}</div>`;
  } else {
    const label = isLive
      ? (/HALFTIME/i.test(st.name ?? '') ? 'HT' : (ev.status.displayClock || 'LIVE'))
      : (st.detail || 'FT').replace(/-/g, ' · ');
    const pens = [home, away].some((c) => c.shootoutScore != null && c.shootoutScore !== 0)
      ? `<span class="pens">${home.shootoutScore}–${away.shootoutScore} pens</span>` : '';
    centre = `<div class="score">${esc(home.score ?? 0)}–${esc(away.score ?? 0)}</div>
              <span class="status${isLive ? ' live' : ''}">${esc(label)}</span>${pens}`;
  }

  const side = (c, role) => {
    const lost = done && c.winner === false && comp.competitors.some((x) => x.winner === true);
    const logo = logoOf(c.team);
    return `<div class="side ${role}${lost ? ' loser' : ''}">
      ${logo ? `<img src="${esc(logo)}" alt="" loading="lazy">` : ''}
      <span class="tname">${esc(c.team?.shortDisplayName || c.team?.displayName || '—')}</span>
    </div>`;
  };

  // "Arsenal advance 2-1 on aggregate", "PSG win 4-3 on penalties", leg labels…
  const note = (comp.notes ?? []).map((x) => x.headline || x.text).filter(Boolean).join(' · ');

  return `<article class="match${isLive ? ' is-live' : ''}" data-id="${esc(ev.id)}">
    <div class="match-head" role="button" tabindex="0" aria-expanded="${open}">
      ${side(home, 'home')}
      <div class="center">${centre}</div>
      ${side(away, 'away')}
    </div>
    ${note ? `<div class="note-line">${esc(note)}</div>` : ''}
    ${open ? detailPanel(ev, comp, home, away, isPre) : ''}
  </article>`;
}

function detailPanel(ev, comp, home, away, isPre) {
  // One column per team. Each team's events stay in its own column and in
  // chronological order — mixing them into a single auto-placed grid lets a
  // home event slide into the away column whenever the two interleave.
  const cols = { home: [], away: [] };

  for (const d of comp.details ?? []) {
    const kind = classify(d);
    if (!kind) continue;
    // ESPN omits athletesInvolved on some cards; the mark already says what
    // happened, so leave the name blank rather than echoing "Yellow Card".
    const who = d.athletesInvolved?.[0]?.displayName ?? '';
    const min = d.clock?.displayValue ?? '';
    const side = String(d.team?.id) === String(away.team?.id) ? 'away' : 'home';
    cols[side].push(`<div class="ev">
      <span class="min">${esc(min)}</span>
      <span class="ico">${kind.mark}</span>
      <span class="who">${esc(who)}${who ? kind.suffix : ''}</span>
    </div>`);
  }

  const rows = (cols.home.length || cols.away.length)
    ? `<div class="col">${cols.home.join('')}</div><div class="col away">${cols.away.join('')}</div>`
    : '';

  const meta = [
    comp.venue?.fullName && `${esc(comp.venue.fullName)}${comp.venue.address?.city ? `, ${esc(comp.venue.address.city)}` : ''}`,
    comp.attendance > 0 && `${comp.attendance.toLocaleString()} in attendance`,
    comp.broadcasts?.[0]?.names?.[0] && `TV: ${esc(comp.broadcasts[0].names[0])}`,
    isPre && `Kick-off ${timeFmt.format(new Date(ev.date))}`,
  ].filter(Boolean);

  if (!rows && !meta.length) return '';
  return `<div class="detail">
    ${rows || '<div class="col"><div class="ev muted">No goals or cards recorded yet.</div></div>'}
    ${meta.length ? `<div class="meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>` : ''}
  </div>`;
}

/* Marks are CSS shapes, not emoji — emoji fall back to monochrome glyphs at
   this size on many systems, which makes a yellow card indistinguishable
   from a red one. */
const BALL  = '<i class="mk ball"></i>';
const YELLO = '<i class="mk card y"></i>';
const RED   = '<i class="mk card r"></i>';

/** Map an ESPN detail entry to a mark, or null to skip it. */
function classify(d) {
  const t = (d.type?.text ?? '').toLowerCase();
  if (t.includes('own goal'))                 return { mark: BALL, suffix: ' (OG)' };
  if (d.scoringPlay && t.includes('penalty')) return { mark: BALL, suffix: ' (P)' };
  if (d.scoringPlay)                          return { mark: BALL, suffix: '' };
  if (t.includes('yellow') && t.includes('red')) return { mark: YELLO + RED, suffix: '' };
  if (t.includes('red card'))                 return { mark: RED, suffix: '' };
  if (t.includes('yellow card'))              return { mark: YELLO, suffix: '' };
  if (t.includes('penalty') && (t.includes('miss') || t.includes('saved')))
    return { mark: '<i class="mk miss">✗</i>', suffix: ' (pen missed)' };
  return null;
}

function renderStrip() {
  const box = $('#matchday-strip');
  if (!state.strip?.length) { box.hidden = true; return; }
  const cur = dayKey(state.date);
  box.hidden = false;
  box.innerHTML = state.strip.map((d) =>
    `<button type="button" class="md-chip${d.key === cur ? ' is-active' : ''}" data-day="${d.key}">
       ${esc(chipFmt.format(d.date))} <span class="muted">· ${d.n}</span>
     </button>`).join('');
  box.querySelectorAll('.md-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const [y, m, dd] = chip.dataset.day.split('-').map(Number);
      state.date = new Date(y, m - 1, dd);
      state.expanded.clear();
      loadMatches();
    });
  });
}

/* ── rendering: standings ────────────────────────────────── */
const ZONES = [
  [/round of 16/i,            'var(--zone-r16)'],
  [/playoffs?\s*-\s*seeded/i, 'var(--zone-seeded)'],
  [/playoffs?\s*-\s*unseeded/i, 'var(--zone-unseeded)'],
  [/eliminated/i,             'var(--zone-out)'],
];
const zoneFor = (note, rank) => {
  for (const [re, col] of ZONES) if (re.test(note ?? '')) return col;
  return rank <= 8 ? 'var(--zone-r16)' : rank <= 16 ? 'var(--zone-seeded)'
       : rank <= 24 ? 'var(--zone-unseeded)' : 'var(--zone-out)';
};

const statOf = (entry, name) => entry.stats?.find((s) => s.name === name);
const num = (entry, name) => Number(statOf(entry, name)?.value ?? 0);
const disp = (entry, name) => statOf(entry, name)?.displayValue ?? '0';

function renderStandings() {
  const rows = [...(state.standings ?? [])].sort((a, b) => num(a, 'rank') - num(b, 'rank'));
  if (!rows.length) { $('#standings-wrap').innerHTML = '<div class="empty">No table available.</div>'; return; }

  const played = rows.reduce((t, r) => t + num(r, 'gamesPlayed'), 0);

  const body = rows.map((r) => {
    const rank = num(r, 'rank');
    const gd = num(r, 'pointDifferential');
    return `<tr>
      <td class="rank" style="--zone:${zoneFor(r.note?.description, rank)}">${rank}</td>
      <td class="team"><div class="cell">
        ${logoOf(r.team) ? `<img src="${esc(logoOf(r.team))}" alt="" loading="lazy">` : ''}
        <span>${esc(r.team?.displayName ?? '—')}</span>
      </div></td>
      <td>${disp(r, 'gamesPlayed')}</td>
      <td class="hide-sm">${disp(r, 'wins')}</td>
      <td class="hide-sm">${disp(r, 'ties')}</td>
      <td class="hide-sm">${disp(r, 'losses')}</td>
      <td class="hide-sm">${disp(r, 'pointsFor')}</td>
      <td class="hide-sm">${disp(r, 'pointsAgainst')}</td>
      <td class="gd ${gd > 0 ? 'pos' : gd < 0 ? 'neg' : ''}">${gd > 0 ? '+' : ''}${gd}</td>
      <td class="pts">${disp(r, 'points')}</td>
    </tr>`;
  }).join('');

  $('#standings-wrap').innerHTML = `
    ${played === 0 ? '<div class="loading" style="padding:14px 16px;text-align:left">The league phase hasn\'t produced results yet — this table fills in as matches finish.</div>' : ''}
    <table>
      <thead><tr>
        <th class="l" style="text-align:left">#</th><th class="l">Team</th>
        <th>MP</th>
        <th class="hide-sm">W</th><th class="hide-sm">D</th><th class="hide-sm">L</th>
        <th class="hide-sm">GF</th><th class="hide-sm">GA</th>
        <th>GD</th><th>Pts</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/* ── refresh scheduling ──────────────────────────────────── */
function scheduleRefresh() {
  clearTimeout(state.timer);
  if (document.hidden) return;                       // don't poll a background tab
  const live = state.events.some((e) => e.status?.type?.state === 'in');
  state.timer = setTimeout(refreshAll, live ? LIVE_MS : IDLE_MS);
}

function refreshAll() {
  loadMatches({ quiet: true });
  if (state.view === 'standings' || state.standings) loadStandings({ quiet: true });
}

function stampUpdated() {
  $('#updated').textContent = `Updated ${timeFmt.format(new Date())}`;
}

/* ── wiring ──────────────────────────────────────────────── */
function go(days) {
  state.date = shiftDays(state.date, days);
  state.expanded.clear();
  loadMatches();
}

$('#prev-day').addEventListener('click', () => go(-1));
$('#next-day').addEventListener('click', () => go(1));
$('#today-btn').addEventListener('click', () => {
  state.date = new Date();
  state.expanded.clear();
  loadMatches();
});

$('#refresh-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.classList.add('is-spinning');
  await Promise.all([loadMatches({ quiet: true }), state.standings ? loadStandings({ quiet: true }) : null]);
  btn.classList.remove('is-spinning');
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.view = tab.dataset.view;
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    $('#view-matches').hidden   = state.view !== 'matches';
    $('#view-standings').hidden = state.view !== 'standings';
    if (state.view === 'standings' && !state.standings) loadStandings();
  });
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.key === 'ArrowLeft')  go(-1);
  if (e.key === 'ArrowRight') go(1);
});

// Re-sync the moment the tab comes back, so scores are never stale on focus.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(state.timer);
  else refreshAll();
});

loadMatches();
loadStrip();
