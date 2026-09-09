# Sport Scores

A small web app for following football results: live scores with the running
clock, goals and cards per match, and league tables with qualification zones.

Two competitions ship today — **Champions League** and **Ligue 1** — switchable
from the pills under the title. Adding another is a one-line change.

No API key, no signup, no build step, no dependencies — three static files and
a browser.

## Run it

It's plain static files, so any static server works. Ruby ships with macOS:

```bash
ruby -run -e httpd . -p 8123
```

Then open <http://localhost:8123>. Alternatives if you have them:

```bash
python3 -m http.server 8123
npx serve .
```

Opening `index.html` directly via `file://` is the one thing that won't work —
browsers block `fetch` from `file://` origins, so the app needs to be served
over HTTP. (`.claude/launch.json` is configured for the Ruby command above.)

## Where the data comes from

ESPN's public soccer API. Two endpoints per competition do everything, both
key-free and both sending `Access-Control-Allow-Origin: *`, which is why the
browser can call them directly with no backend:

| Endpoint | Gives you |
|---|---|
| `…/soccer/{comp}/scoreboard?dates=YYYYMMDD` | Fixtures, live clock, score, goals, cards, venue, TV |
| `…/soccer/{comp}/standings` | The league table + qualification-zone notes |

Bases: `https://site.api.espn.com/apis/site/v2/sports/soccer` for the
scoreboard, `https://site.api.espn.com/apis/v2/sports/soccer` for standings.

`dates` also accepts a range — `?dates=20260908-20260910` — which is how the app
discovers which days have fixtures. Two quirks matter here:

- **A ranged response is capped at 100 events.** So the fixture index is built
  in ~45-day chunks rather than a season at a time. Asking for a whole season
  truncates silently, which would make real matchdays look empty.
- **Ranged responses omit `calendarStartDate` / `calendarEndDate`.** Only the
  undated request carries them, so there are no season bounds available to stop
  a search at — hence the explicit ±400-day search bound below.

**This is an undocumented endpoint.** It's widely used and stable in practice,
but ESPN makes no promises about it. If you need a contract you can rely on,
[football-data.org](https://www.football-data.org/) has a free tier (competition
codes `CL` and `FL1`), though it needs a key and a small proxy since it doesn't
send permissive CORS headers.

## Files

| File | Role |
|---|---|
| `index.html` | Markup and the view shells |
| `styles.css` | All styling; light/dark via `prefers-color-scheme` |
| `app.js` | Fetching, state, rendering, refresh scheduling |

## Behaviour worth knowing

- **Fixture-only navigation** — the arrows, the date strip and `Today` only ever
  move between days that actually have matches, so you never land on an empty
  date. The app keeps an index of match days and grows it lazily as you
  navigate, bounded to ±400 days from today. That bound is what stops an
  exhausted search, and it's generous enough that stepping back from the
  Champions League's opening matchday reaches the previous season's final.
  Opening a competition on a day with no matches lands on the nearest matchday.
- **Per-competition state** — each competition keeps its own fixture index,
  coverage window, selected date and table, so switching never mixes one into
  another. In-flight responses are discarded if you switch mid-load.
- **Refresh cadence** — polls every 30s while any match is in play, every 5
  minutes otherwise, and stops entirely on a hidden tab (re-syncing the moment
  you come back). ESPN's own `Cache-Control` on the scoreboard is 3 seconds, so
  the data really is live. Only the visible competition is polled.
- **Timezones** — the app fetches a ±1-day window and filters to *your* local
  calendar day, so a 21:00 UTC kickoff shows under the right date wherever you
  are. All times render in the browser's locale (`Intl`), which is why the
  labels come out in French on a French-locale machine.
- **Keyboard** — `←` / `→` step between matchdays.
- **Match detail** — click any match to expand goals and cards, split into one
  column per team. Home/away is resolved from each competitor's `homeAway`
  field, never array position, because ESPN doesn't guarantee the order.
- **Knockout rounds** — penalty shootouts render as `4–3 pens` under the score,
  and ESPN's own note lines carry aggregates ("PSG advance 6-5 on aggregate").
  The eliminated side is dimmed.
- **Match odds** — upcoming matches show home / draw / away prices between each
  team name and the kick-off time, with the draw under the time. ESPN quotes
  American odds ("+230"); the app converts them to decimal, which is how
  football prices are read in Europe. Prices show **only before kick-off** — the
  API keeps them on finished matches, where a price beside a final score is just
  noise — and the sportsbook is credited in the expanded card. On narrow screens
  the three prices move to a stacked `1 / X / 2` row under the teams, because
  inline they squeeze the team names down to nothing. Odds are displayed as data
  only; the app deliberately does not link out to betting slips.

- **Table zones are data-driven** — the stripe colours and the legend are built
  from each table's own `note.description` and `note.color`. That is why the
  Champions League shows "1–8 · Qualifies for round of 16" while Ligue 1 shows
  "1–3 · Champions League" and "17–18 · Relegation" with no competition-specific
  code.

## Adding a competition

Add one entry to `COMPETITIONS` at the top of `app.js`:

```js
const COMPETITIONS = [
  { id: 'uefa.champions', label: 'Champions League' },
  { id: 'fra.1',          label: 'Ligue 1' },
  { id: 'eng.1',          label: 'Premier League' },   // ← like this
];
```

It appears in the switcher and everything else follows, because fixtures, the
table, the zone colours and the legend all come from the API. Verified slugs:
`eng.1` (Premier League), `esp.1` (La Liga), `ita.1` (Serie A), `ger.1`
(Bundesliga), `uefa.europa` (Europa League).

## Extending it

**Top scorers** — ESPN exposes them at `…/soccer/{comp}/leaders`; it slots in as
a third tab alongside `renderStandings`.

**Match pages** — each event carries an `id`; the summary endpoint
`…/soccer/{comp}/summary?event=<id>` returns lineups, stats and commentary.

**Favourite team** — team `id` is on every competitor, so filtering fixtures or
pinning a club to the top is a small addition to `renderMatches`.
