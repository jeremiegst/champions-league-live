/* Champions League Scores — zero-dependency client for ESPN's public soccer API.
   No API key, no build step. Two endpoints do all the work:
     scoreboard?dates=YYYYMMDD[-YYYYMMDD]  → fixtures, live clocks, goals, cards
     standings                             → the 36-team league-phase table

   Navigation is fixture-based: the app keeps an index of which days actually
   have matches and only ever moves between those, so the arrows and the date
   strip never land on an empty day. The index grows lazily because ESPN caps
   any single range response at 100 events — asking for a whole season would
   silently truncate and make real matchdays look empty.                      */

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard';
const STANDINGS  = 'https://site.api.espn.com/apis/v2/sports/soccer/uefa.champions/standings';

const LIVE_MS = 30_000;    // poll cadence while something is in play
const IDLE_MS = 300_000;   // …and when nothing is

const SEED_BACK = 20;      // days indexed behind today on first load
const SEED_FWD  = 25;      // …and ahead of it
const CHUNK     = 45;      // days per lazy index extension (keeps us under the 100-event cap)

/* How far from today the index will ever reach. This is the stop condition for
   lazy growth: ranged scoreboard responses omit calendarStartDate/EndDate (only
   the undated one carries them), so there are no season bounds to stop at and
   an exhausted search would otherwise fetch chunks forever. 400 days spans this
   season plus the tail of the last one, which is why stepping back from the
   opening matchday reaches the previous final. */
const SEARCH_DAYS = 400;

const minDate = (a, b) => (a < b ? a : b);
const maxDate = (a, b) => (a > b ? a : b);

const state = {
  view: 'matches',
  date: new Date(),
  expanded: new Set(),
  events: [],
  standings: null,

  /** dayKey → Set of event ids. A Set makes re-indexing the same day idempotent. */
  index: new Map(),
  covFrom: null,           // contiguous indexed range, as Dates
  covTo: null,

  busy: false,
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
const fromDayKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };

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

/* ── fixture index ───────────────────────────────────────── */
function absorb(data) {
  const events = data.events ?? [];
  for (const e of events) {
    const k = dayKey(new Date(e.date));
    if (!state.index.has(k)) state.index.set(k, new Set());
    state.index.get(k).add(e.id);
  }

  const lg = data.leagues?.[0];
  if (lg) {
    const yr = lg.season?.year;
    const phase = lg.season?.type?.name ?? '';
    $('#season-line').textContent =
      [yr ? `${yr}/${String((yr % 100) + 1).padStart(2, '0')}` : null, phase]
        .filter(Boolean).join(' · ') || 'Season';
  }
  return events;
}

const fetchRange = async (from, to) =>
  absorb(await getJSON(`${SCOREBOARD}?dates=${apiDay(from)}-${apiDay(to)}`));

/** Push the indexed range one chunk further. Returns false at the search bound. */
async function growIndex(dir) {
  const floor = shiftDays(new Date(), -SEARCH_DAYS);
  const ceil  = shiftDays(new Date(),  SEARCH_DAYS);

  if (dir > 0) {
    if (state.covTo >= ceil) return false;
    const from = shiftDays(state.covTo, 1);
    const to = minDate(shiftDays(from, CHUNK), ceil);
    await fetchRange(from, to);
    state.covTo = to;
  } else {
    if (state.covFrom <= floor) return false;
    const to = shiftDays(state.covFrom, -1);
    const from = maxDate(shiftDays(to, -CHUNK), floor);
    await fetchRange(from, to);
    state.covFrom = from;
  }
  return true;
}

const sortedDays = () => [...state.index.keys()].sort();

/** Nearest day with fixtures strictly after (dir>0) or before (dir<0) `from`. */
async function findFixtureDay(from, dir) {
  const fromKey = dayKey(from);
  for (let guard = 0; guard < 14; guard++) {
    const days = sortedDays();
    const hit = dir > 0
      ? days.find((k) => k > fromKey)
      : days.filter((k) => k < fromKey).pop();
    // Coverage is contiguous and contains `from`, so the closest indexed day
    // in this direction really is the next fixture — no need to look further.
    if (hit) return fromDayKey(hit);
    if (!(await growIndex(dir))) return null;
  }
  return null;
}

/** Cheap, index-only guess at whether the arrow should be live. */
function canGo(dir) {
  const k = dayKey(state.date);
  const days = sortedDays();
  if (dir > 0) {
    return days.some((x) => x > k) || state.covTo < shiftDays(new Date(), SEARCH_DAYS);
  }
  return days.some((x) => x < k) || state.covFrom > shiftDays(new Date(), -SEARCH_DAYS);
}

/* ── data loading ────────────────────────────────────────── */
async function loadMatches({ quiet = false } = {}) {
  if (!quiet) $('#matches').innerHTML =
    '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';

  // A ±1-day window filtered to the viewer's local day keeps late kickoffs on
  // the right date in every timezone, and refreshes live clocks.
  try {
    const events = await fetchRange(shiftDays(state.date, -1), shiftDays(state.date, 1));
    const want = dayKey(state.date);
    state.events = events
      .filter((e) => dayKey(new Date(e.date)) === want)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

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
    box.innerHTML = `<div class="empty">No Champions League matches on this date.</div>`;
  } else {
    box.innerHTML = state.events.map(matchCard).join('');
    box.querySelectorAll('.match-head').forEach((head) => {
      head.addEventListener('click', () => {
        const id = head.closest('.match').dataset.id;
        state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
        renderMatches();
      });
    });
  }
  renderStrip();
  syncNav();
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

/* ── rendering: the fixture-date strip ───────────────────── */
function renderStrip() {
  const box = $('#matchday-strip');
  const days = sortedDays();
  if (!days.length) { box.hidden = true; return; }

  const cur = dayKey(state.date);
  const todayKey = dayKey(new Date());
  box.hidden = false;
  box.innerHTML = days.map((k) => {
    const n = state.index.get(k).size;
    return `<button type="button" class="md-chip${k === cur ? ' is-active' : ''}${k === todayKey ? ' is-today' : ''}"
              data-day="${k}" title="${n} match${n === 1 ? '' : 'es'}">
        ${esc(chipFmt.format(fromDayKey(k)))} <span class="cnt">${n}</span>
      </button>`;
  }).join('');

  box.querySelectorAll('.md-chip').forEach((chip) => {
    chip.addEventListener('click', () => goTo(fromDayKey(chip.dataset.day)));
  });

  // Keep the selected day visible as the index grows in either direction.
  box.querySelector('.is-active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function syncNav() {
  $('#prev-day').disabled = state.busy || !canGo(-1);
  $('#next-day').disabled = state.busy || !canGo(1);
  $('#today-btn').disabled = state.busy;
}

/* ── rendering: standings ────────────────────────────────── */
const ZONES = [
  [/round of 16/i,              'var(--zone-r16)'],
  [/playoffs?\s*-\s*seeded/i,   'var(--zone-seeded)'],
  [/playoffs?\s*-\s*unseeded/i, 'var(--zone-unseeded)'],
  [/eliminated/i,               'var(--zone-out)'],
];
const zoneFor = (note, rank) => {
  for (const [re, col] of ZONES) if (re.test(note ?? '')) return col;
  return rank <= 8 ? 'var(--zone-r16)' : rank <= 16 ? 'var(--zone-seeded)'
       : rank <= 24 ? 'var(--zone-unseeded)' : 'var(--zone-out)';
};

const statOf = (entry, name) => entry.stats?.find((s) => s.name === name);
const num  = (entry, name) => Number(statOf(entry, name)?.value ?? 0);
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

/* ── navigation ──────────────────────────────────────────── */
async function goTo(date) {
  state.date = date;
  state.expanded.clear();
  renderStrip();
  syncNav();
  await loadMatches();
}

/** Move to the previous/next day that actually has matches. */
async function step(dir) {
  if (state.busy) return;
  state.busy = true;
  syncNav();
  try {
    const target = await findFixtureDay(state.date, dir);
    if (target) { state.busy = false; await goTo(target); return; }
  } catch { /* fall through and just re-enable the controls */ }
  state.busy = false;
  syncNav();
}

/** Today if it has matches, otherwise the closest matchday either side. */
async function goToday() {
  if (state.busy) return;
  const now = new Date();
  if (state.index.has(dayKey(now))) return goTo(now);

  state.busy = true; syncNav();
  const [next, prev] = [await findFixtureDay(now, 1), await findFixtureDay(now, -1)];
  state.busy = false;
  const pick = !next ? prev : !prev ? next
    : (next - now <= now - prev ? next : prev);      // ties go to the upcoming one
  return goTo(pick ?? now);
}

$('#prev-day').addEventListener('click', () => step(-1));
$('#next-day').addEventListener('click', () => step(1));
$('#today-btn').addEventListener('click', goToday);

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
  if (e.key === 'ArrowLeft')  step(-1);
  if (e.key === 'ArrowRight') step(1);
});

// Re-sync the moment the tab comes back, so scores are never stale on focus.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(state.timer);
  else refreshAll();
});

/* ── boot ────────────────────────────────────────────────── */
(async function init() {
  $('#matches').innerHTML =
    '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';

  const from = shiftDays(new Date(), -SEED_BACK);
  const to   = shiftDays(new Date(), SEED_FWD);
  state.covFrom = from;
  state.covTo = to;

  try {
    await fetchRange(from, to);
  } catch {
    // Index unavailable; the day view below still works on its own.
  }

  // Never open on an empty day.
  if (state.index.size && !state.index.has(dayKey(state.date))) {
    await goToday();
  } else {
    renderStrip();
    syncNav();
    await loadMatches();
  }
})();
