/* Sport Scores — zero-dependency client for ESPN's public soccer API.
   No API key, no build step. Two endpoints per competition do all the work:
     {comp}/scoreboard?dates=YYYYMMDD[-YYYYMMDD]  → fixtures, live clocks, goals, cards
     {comp}/standings                             → the league table + zone notes

   Navigation is fixture-based: each competition keeps an index of which days
   actually have matches and only ever moves between those, so the arrows and
   the date strip never land on an empty day. The index grows lazily because
   ESPN caps any single range response at 100 events — asking for a whole
   season would silently truncate and make real matchdays look empty.        */

const HOST_SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const HOST_V2   = 'https://site.api.espn.com/apis/v2/sports/soccer';

/* Add a competition here and it appears in the switcher. Nothing else is
   competition-specific: fixtures, the table and even the qualification-zone
   colours and legend are all derived from what the API returns. */
const COMPETITIONS = [
  { id: 'uefa.champions', label: 'Champions League' },
  { id: 'fra.1',          label: 'Ligue 1' },
];

const sbUrl = (comp) => `${HOST_SITE}/${comp}/scoreboard`;
const stUrl = (comp) => `${HOST_V2}/${comp}/standings`;

const LIVE_MS = 30_000;    // poll cadence while something is in play
const IDLE_MS = 300_000;   // …and when nothing is

const SEED_BACK = 20;      // days indexed behind today on first load
const SEED_FWD  = 25;      // …and ahead of it
const CHUNK     = 45;      // days per lazy index extension (keeps us under the 100-event cap)

/* How far from today the index will ever reach. This is the stop condition for
   lazy growth: ranged scoreboard responses omit calendarStartDate/EndDate (only
   the undated one carries them), so there are no season bounds to stop at and
   an exhausted search would otherwise fetch chunks forever. */
const SEARCH_DAYS = 400;

const minDate = (a, b) => (a < b ? a : b);
const maxDate = (a, b) => (a > b ? a : b);

/** Each competition gets its own fixture index, coverage window, selected date
    and table, so switching between them never mixes one's data into another. */
const blankComp = () => ({
  date: new Date(),
  index: new Map(),        // dayKey → Set of event ids (idempotent re-indexing)
  covFrom: null,           // contiguous indexed range, as Dates
  covTo: null,
  events: [],
  standings: null,
  seeded: false,
  title: '',
});

const state = {
  comp: COMPETITIONS[0].id,
  view: 'matches',
  expanded: new Set(),
  busy: false,
  timer: null,
  data: Object.fromEntries(COMPETITIONS.map((c) => [c.id, blankComp()])),
};

const C = () => state.data[state.comp];
const labelOf = (id) => COMPETITIONS.find((c) => c.id === id)?.label ?? id;

/* ── helpers ─────────────────────────────────────────────── */
const $  = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const skeletons = () => '<div class="skeleton"></div>'.repeat(3);

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
function absorb(compId, data) {
  const c = state.data[compId];
  const events = data.events ?? [];
  for (const e of events) {
    const k = dayKey(new Date(e.date));
    if (!c.index.has(k)) c.index.set(k, new Set());
    c.index.get(k).add(e.id);
  }

  const lg = data.leagues?.[0];
  if (lg) {
    const yr = lg.season?.year;
    const phase = lg.season?.type?.name ?? '';
    c.title = [
      labelOf(compId),
      yr ? `${yr}/${String((yr % 100) + 1).padStart(2, '0')}` : null,
      // Domestic leagues name the phase after the season ("2026-27 Ligue 1"),
      // which just repeats the two fields beside it. Keep only a phase that
      // adds something, like the Champions League's "League Phase".
      (/regular season/i.test(phase) || phase.toLowerCase().includes(labelOf(compId).toLowerCase())) ? null : phase,
    ].filter(Boolean).join(' · ');
  }
  if (compId === state.comp) renderTitle();
  return events;
}

const fetchRange = async (compId, from, to) =>
  absorb(compId, await getJSON(`${sbUrl(compId)}?dates=${apiDay(from)}-${apiDay(to)}`));

/** Push the active competition's indexed range one chunk further.
    Returns false at the search bound. */
async function growIndex(dir) {
  const c = C();
  const floor = shiftDays(new Date(), -SEARCH_DAYS);
  const ceil  = shiftDays(new Date(),  SEARCH_DAYS);

  if (dir > 0) {
    if (c.covTo >= ceil) return false;
    const from = shiftDays(c.covTo, 1);
    const to = minDate(shiftDays(from, CHUNK), ceil);
    await fetchRange(state.comp, from, to);
    c.covTo = to;
  } else {
    if (c.covFrom <= floor) return false;
    const to = shiftDays(c.covFrom, -1);
    const from = maxDate(shiftDays(to, -CHUNK), floor);
    await fetchRange(state.comp, from, to);
    c.covFrom = from;
  }
  return true;
}

const sortedDays = () => [...C().index.keys()].sort();

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

/** Indexed fixture days inside the covered range. Boot uses this so the opening
    date can only ever be near today: growing the index at boot would make it
    depend on how the API answered, and a range response carrying stray
    out-of-window events could strand the viewer months away. */
function indexedDaysInCoverage() {
  const c = C();
  return sortedDays().filter((k) => {
    const d = fromDayKey(k);
    return d >= c.covFrom && d <= c.covTo;
  });
}

/** Cheap, index-only guess at whether the arrow should be live. */
function canGo(dir) {
  const c = C();
  const k = dayKey(c.date);
  const days = sortedDays();
  if (dir > 0) {
    return days.some((x) => x > k) || c.covTo < shiftDays(new Date(), SEARCH_DAYS);
  }
  return days.some((x) => x < k) || c.covFrom > shiftDays(new Date(), -SEARCH_DAYS);
}

/* ── data loading ────────────────────────────────────────── */
async function loadMatches({ quiet = false } = {}) {
  const comp = state.comp;
  const c = state.data[comp];
  if (!quiet) $('#matches').innerHTML = skeletons();

  // A ±1-day window filtered to the viewer's local day keeps late kickoffs on
  // the right date in every timezone, and refreshes live clocks.
  try {
    const events = await fetchRange(comp, shiftDays(c.date, -1), shiftDays(c.date, 1));
    if (comp !== state.comp) return;          // switched competition mid-flight
    const want = dayKey(c.date);
    c.events = events
      .filter((e) => dayKey(new Date(e.date)) === want)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    renderMatches();
    stampUpdated();
    scheduleRefresh();
  } catch (err) {
    if (comp !== state.comp) return;
    $('#matches').innerHTML =
      `<div class="error">Couldn't load fixtures — ${esc(err.message)}
       <button type="button" data-retry>Try again</button></div>`;
    $('#matches').querySelector('[data-retry]')?.addEventListener('click', () => loadMatches());
  }
}

async function loadStandings({ quiet = false } = {}) {
  const comp = state.comp;
  const c = state.data[comp];
  if (!quiet && !c.standings) $('#standings-wrap').innerHTML = '<div class="loading">Loading table…</div>';
  try {
    const data = await getJSON(stUrl(comp));
    if (comp !== state.comp) return;
    c.standings = data.children?.[0]?.standings?.entries ?? data.standings?.entries ?? [];
    renderStandings();
    stampUpdated();
  } catch (err) {
    if (comp !== state.comp) return;
    $('#standings-wrap').innerHTML =
      `<div class="error">Couldn't load the table — ${esc(err.message)}
       <button type="button" data-retry>Try again</button></div>`;
    $('#standings-wrap').querySelector('[data-retry]')?.addEventListener('click', () => loadStandings());
  }
}

/* ── rendering: matches ──────────────────────────────────── */
function renderMatches() {
  const c = C();
  const box = $('#matches');
  const live = c.events.filter((e) => e.status?.type?.state === 'in').length;

  $('#live-badge').hidden = live === 0;
  $('#live-count').textContent = live;

  $('#date-label').textContent = dateFmt.format(c.date);
  const today = dayKey(new Date()) === dayKey(c.date);
  const n = c.events.length;
  $('#date-sub').textContent =
    `${today ? 'Today · ' : ''}${n === 0 ? 'no fixtures' : n === 1 ? '1 match' : `${n} matches`}`;

  if (!c.events.length) {
    box.innerHTML = `<div class="empty">No ${esc(labelOf(state.comp))} matches on this date.</div>`;
  } else {
    box.innerHTML = c.events.map(matchCard).join('');
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
    const pens = [home, away].some((x) => x.shootoutScore != null && x.shootoutScore !== 0)
      ? `<span class="pens">${home.shootoutScore}–${away.shootoutScore} pens</span>` : '';
    centre = `<div class="score">${esc(home.score ?? 0)}–${esc(away.score ?? 0)}</div>
              <span class="status${isLive ? ' live' : ''}">${esc(label)}</span>${pens}`;
  }

  const side = (x, role) => {
    const lost = done && x.winner === false && comp.competitors.some((y) => y.winner === true);
    const logo = logoOf(x.team);
    return `<div class="side ${role}${lost ? ' loser' : ''}">
      ${logo ? `<img src="${esc(logo)}" alt="" loading="lazy">` : ''}
      <span class="tname">${esc(x.team?.shortDisplayName || x.team?.displayName || '—')}</span>
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
  const c = C();
  const box = $('#matchday-strip');
  const days = sortedDays();
  if (!days.length) { box.hidden = true; return; }

  const cur = dayKey(c.date);
  const todayKey = dayKey(new Date());
  box.hidden = false;
  box.innerHTML = days.map((k) => {
    const n = c.index.get(k).size;
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

/* ── rendering: table ────────────────────────────────────── */
const statOf = (entry, name) => entry.stats?.find((s) => s.name === name);
const num  = (entry, name) => Number(statOf(entry, name)?.value ?? 0);
const disp = (entry, name) => statOf(entry, name)?.displayValue ?? '0';

function renderStandings() {
  const c = C();
  const rows = [...(c.standings ?? [])].sort((a, b) => num(a, 'rank') - num(b, 'rank'));
  if (!rows.length) {
    $('#standings-wrap').innerHTML = '<div class="empty">No table available.</div>';
    $('#legend').innerHTML = '';
    return;
  }

  const played = rows.reduce((t, r) => t + num(r, 'gamesPlayed'), 0);

  const body = rows.map((r) => {
    const gd = num(r, 'pointDifferential');
    // Zone colour comes straight from the API, so it is correct for any
    // competition — the Champions League league phase and Ligue 1 have
    // completely different qualification and relegation bands.
    return `<tr>
      <td class="rank" style="--zone:${esc(r.note?.color ?? 'transparent')}">${num(r, 'rank')}</td>
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
    ${played === 0 ? '<div class="loading" style="padding:14px 16px;text-align:left">No results recorded yet — this table fills in as matches finish.</div>' : ''}
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

  renderLegend(rows);
}

/** Build the zone legend from the table's own notes, ordered by position. */
function renderLegend(rows) {
  const zones = new Map();
  for (const r of rows) {
    const note = r.note;
    if (!note?.description) continue;
    if (!zones.has(note.description)) zones.set(note.description, { color: note.color, ranks: [] });
    zones.get(note.description).ranks.push(num(r, 'rank'));
  }

  $('#legend').innerHTML = [...zones.entries()]
    .sort((a, b) => Math.min(...a[1].ranks) - Math.min(...b[1].ranks))
    .map(([desc, z]) => {
      const lo = Math.min(...z.ranks), hi = Math.max(...z.ranks);
      return `<li><i class="sw" style="background:${esc(z.color ?? 'transparent')}"></i>${
        lo === hi ? lo : `${lo}–${hi}`} · ${esc(desc)}</li>`;
    }).join('');
}

/* ── refresh scheduling ──────────────────────────────────── */
function scheduleRefresh() {
  clearTimeout(state.timer);
  if (document.hidden) return;                       // don't poll a background tab
  const live = C().events.some((e) => e.status?.type?.state === 'in');
  state.timer = setTimeout(refreshAll, live ? LIVE_MS : IDLE_MS);
}

function refreshAll() {
  loadMatches({ quiet: true });
  if (state.view === 'standings' || C().standings) loadStandings({ quiet: true });
}

function stampUpdated() {
  $('#updated').textContent = `Updated ${timeFmt.format(new Date())}`;
}

const renderTitle = () => { $('#season-line').textContent = C().title || labelOf(state.comp); };

/* ── navigation ──────────────────────────────────────────── */
async function goTo(date) {
  C().date = date;
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
    const target = await findFixtureDay(C().date, dir);
    if (target) { state.busy = false; await goTo(target); return; }
  } catch { /* fall through and just re-enable the controls */ }
  state.busy = false;
  syncNav();
}

/** Today if it has matches, otherwise the closest matchday either side. */
async function goToday() {
  if (state.busy) return;
  const now = new Date();
  if (C().index.has(dayKey(now))) return goTo(now);

  state.busy = true; syncNav();
  const [next, prev] = [await findFixtureDay(now, 1), await findFixtureDay(now, -1)];
  state.busy = false;
  const pick = !next ? prev : !prev ? next
    : (next - now <= now - prev ? next : prev);      // ties go to the upcoming one
  return goTo(pick ?? now);
}

/* ── competition switching ───────────────────────────────── */
function renderComps() {
  $('#comps').innerHTML = COMPETITIONS.map((c) =>
    `<button type="button" class="comp${c.id === state.comp ? ' is-active' : ''}"
       data-comp="${esc(c.id)}" aria-pressed="${c.id === state.comp}">${esc(c.label)}</button>`).join('');
  $('#comps').querySelectorAll('.comp').forEach((b) =>
    b.addEventListener('click', () => switchComp(b.dataset.comp)));
}

/** Seed a competition's index the first time it is shown. */
async function seedComp(compId) {
  const c = state.data[compId];
  if (c.seeded) return;
  c.seeded = true;

  const from = shiftDays(new Date(), -SEED_BACK);
  const to   = shiftDays(new Date(),  SEED_FWD);
  c.covFrom = from;
  c.covTo = to;

  try {
    await fetchRange(compId, from, to);
  } catch {
    // Index unavailable; the day view still works on its own.
  }

  // Never open on an empty day, and never land outside the seed window.
  if (!c.index.has(dayKey(c.date))) {
    const days = [...c.index.keys()].sort().filter((k) => {
      const d = fromDayKey(k);
      return d >= c.covFrom && d <= c.covTo;
    });
    if (days.length) {
      const now = new Date();
      c.date = fromDayKey(days.reduce((best, k) =>
        Math.abs(fromDayKey(k) - now) < Math.abs(fromDayKey(best) - now) ? k : best));
    }
  }
}

async function switchComp(id) {
  if (id === state.comp || state.busy) return;
  state.comp = id;
  state.expanded.clear();
  clearTimeout(state.timer);

  renderComps();
  renderTitle();
  $('#matches').innerHTML = skeletons();
  $('#standings-wrap').innerHTML = '';
  $('#legend').innerHTML = '';
  $('#matchday-strip').hidden = true;

  await seedComp(id);
  if (id !== state.comp) return;                     // switched again mid-seed

  renderStrip();
  syncNav();
  await loadMatches();
  if (state.view === 'standings') {
    C().standings ? renderStandings() : await loadStandings();
  }
}

/* ── wiring ──────────────────────────────────────────────── */
$('#prev-day').addEventListener('click', () => step(-1));
$('#next-day').addEventListener('click', () => step(1));
$('#today-btn').addEventListener('click', goToday);

$('#refresh-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.classList.add('is-spinning');
  await Promise.all([loadMatches({ quiet: true }), C().standings ? loadStandings({ quiet: true }) : null]);
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
    if (state.view === 'standings') {
      C().standings ? renderStandings() : loadStandings();
    }
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
  renderComps();
  renderTitle();
  $('#matches').innerHTML = skeletons();
  await seedComp(state.comp);
  renderStrip();
  syncNav();
  await loadMatches();
})();
