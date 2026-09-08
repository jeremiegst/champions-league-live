# Champions League Scores

A small web app for following Champions League results: live scores with the
running clock, goals and cards per match, and the 36-team league-phase table
with qualification zones.

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

ESPN's public soccer API. Two endpoints do everything, both key-free and both
sending `Access-Control-Allow-Origin: *`, which is why the browser can call
them directly with no backend:

| Endpoint | Gives you |
|---|---|
| `…/soccer/uefa.champions/scoreboard?dates=YYYYMMDD` | Fixtures, live clock, score, goals, cards, venue, TV |
| `…/soccer/uefa.champions/standings` | The league-phase table + qualification-zone notes |

Base: `https://site.api.espn.com/apis/site/v2/sports` (standings live under
`https://site.api.espn.com/apis/v2/sports`).

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
[football-data.org](https://www.football-data.org/) has a free tier with the
Champions League under competition code `CL` (registration + `X-Auth-Token`
header, ~10 requests/minute), and would need a small proxy since it doesn't
send permissive CORS headers.

## Files

| File | Role |
|---|---|
| `index.html` | Markup and the two view shells |
| `styles.css` | All styling; light/dark via `prefers-color-scheme` |
| `app.js` | Fetching, state, rendering, refresh scheduling |

## Behaviour worth knowing

- **Refresh cadence** — polls every 30s while any match is in play, every 5
  minutes otherwise, and stops entirely on a hidden tab (re-syncing the moment
  you come back). ESPN's own `Cache-Control` on the scoreboard is 3 seconds, so
  the data really is live.
- **Timezones** — the app fetches a ±1-day window and filters to *your* local
  calendar day, so a 21:00 UTC kickoff shows under the right date wherever you
  are. All times render in the browser's locale (`Intl`), which is why the
  labels come out in French on a French-locale machine.
- **Fixture-only navigation** — the arrows, the date strip and `Today` only ever
  move between days that actually have matches, so you never land on an empty
  date. The app keeps an index of match days and grows it lazily as you
  navigate, bounded to ±400 days from today. That bound is what stops an
  exhausted search, and it's generous enough that stepping back from the opening
  matchday reaches the previous season's final. Opening the app on a day with no
  matches lands on the nearest matchday instead.
- **Keyboard** — `←` / `→` step between matchdays.
- **Match detail** — click any match to expand goals and cards, split into one
  column per team. Home/away is resolved from each competitor's `homeAway`
  field, never array position, because ESPN doesn't guarantee the order.
- **Knockout rounds** — penalty shootouts render as `4–3 pens` under the score,
  and ESPN's own note lines carry aggregates ("PSG advance 6-5 on aggregate").
  The eliminated side is dimmed.

## Extending it

**Another competition** — change the slug in `app.js`. Verified working:
`fra.1` (Ligue 1), `eng.1` (Premier League), `esp.1` (La Liga), `ita.1`
(Serie A), `ger.1` (Bundesliga), `uefa.europa`.

**Top scorers** — ESPN exposes them at
`…/soccer/uefa.champions/leaders`; it slots in as a third tab alongside
`renderStandings`.

**Match pages** — each event carries an `id`; the summary endpoint
`…/soccer/uefa.champions/summary?event=<id>` returns lineups, stats and
commentary for a full match-detail view.

**Favourite team** — the pieces are already there: team `id` is on every
competitor, so filtering fixtures or pinning a club to the top is a small
addition to `renderMatches`.
