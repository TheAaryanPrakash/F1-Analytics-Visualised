# F1 Race Analytics

**Live at [f1-race-analytics-taupe.vercel.app](https://f1-race-analytics-taupe.vercel.app)**

An interactive, F1-website-styled dashboard built on top of the original `Code-1.ipynb`
exploratory analysis. The notebook's cleaning/analysis logic (lap-time cleaning,
pit-lap detection, stint/tyre-degradation, gap-to-leader, telemetry) has been
refactored into a FastAPI backend that calls the FastF1 API live, with a dark,
F1-branded frontend on top.

## Structure

```
Code-1.ipynb          original exploratory notebook (unchanged)
api/
  index.py             Vercel entrypoint - re-exports the FastAPI app below
backend/
  app.py               FastAPI app: REST API + serves the frontend
  analysis.py          FastF1 data loading/cleaning (evolved from the notebook)
  requirements.txt
  f1_cache/             FastF1's on-disk cache (created automatically; falls
                         back to a temp dir when the app dir isn't writable,
                         e.g. on Vercel)
frontend/
  index.html            page shell, tab layout
  style.css             dark F1-style theme
  app.js                fetches the API, renders Plotly.js charts
requirements.txt        mirrors backend/requirements.txt - Vercel's Python
                         runtime expects it at the project root
vercel.json              routes every request to api/index.py, 90s timeout
```

## Running it

```bash
cd backend
python3 -m venv ../.venv        # first time only
source ../.venv/bin/activate
pip install -r requirements.txt # first time only
uvicorn app:app --reload --port 8000
```

Then open **http://localhost:8000** — the FastAPI app serves the frontend directly,
so there's nothing else to start.

Pick a season, Grand Prix, and session, choose drivers, and hit **Load Analysis**.
The first load for any session downloads and caches data from FastF1 (can take
10–60s); subsequent loads of the same session are near-instant. Telemetry (the
Telemetry tab) is fetched separately and lazily since it's a much heavier download.

## Deploying (Vercel)

The live deployment runs on [Vercel](https://vercel.com)'s free Hobby tier as a
single Python serverless function (Fluid Compute gives it a 300s ceiling; we cap
it at 90s in `vercel.json`, well above the documented worst case). There's no
persistent disk on Vercel, so this deployment intentionally doesn't rely on one -
see **Caching** below.

```bash
npx vercel login     # one-time, opens a browser
npx vercel link       # first time only, links this directory to a Vercel project
npx vercel --prod
```

`api/index.py` just re-exports the FastAPI `app` from `backend/app.py` so Vercel's
Python runtime (which expects functions under `api/`) can find it; no logic lives
there. `vercel.json` rewrites every path to that one function since the FastAPI
app does its own internal routing for both `/api/*` and the frontend.

## What's on the dashboard

- **Overview** — event header, podium, key stats, full classification, fastest-lap ranking
- **Lap Times** — lap-by-lap progression, distribution (box plot), consistency (std dev)
- **Tyres & Pit Stops** — stint/strategy timeline, tyre degradation curves, compound
  performance, pit-stop durations, lap times with pit stops marked
- **Gaps & Position** — gap to race leader per lap, track position over time; a race-replay
  scrubber lets you step through the session lap by lap or animate it with Play
- **Sectors** — average sector times per driver
- **Track Map** — the circuit outline traced with a chosen driver's fastest (or any) lap,
  colored by speed or gear, with corner numbers
- **Head-to-Head** — cumulative time delta between two drivers' laps along the lap distance
  (the classic broadcast "who's pulling away" graphic), plus a speed comparison
- **Telemetry** — speed trace and throttle/brake overlay for up to 3 drivers' fastest laps
- **Weather** — track/air temperature, humidity, wind, rainfall

Driver colors follow real team liveries; teammates (same team color) are
distinguished with a dashed/dotted line style and always-visible driver-code
labels. Tyre-compound colors follow the FIA standard (soft = red, medium =
yellow, hard = white, intermediate = green, wet = blue). Click a driver chip in
the legend to isolate/hide that driver across every chart.

## Caching

FastF1 caches session/lap data to disk (`backend/f1_cache/`, or a temp dir when
that path isn't writable) and the backend additionally keeps a small in-process
LRU cache of loaded sessions - both make repeat requests for the same session
near-instant. Neither is guaranteed to persist: running locally or on a real
VM/container, the disk cache is durable across restarts; on Vercel, a warm
function instance reuses both caches for as long as it stays warm, but there's
no cross-deployment persistence by design (Vercel's writable filesystem is
`/tmp`-only and ephemeral). This deployment intentionally doesn't try to work
around that - it's a "call the API when a user requests something" setup, not
a hot-cache-at-all-costs one.

## Notes

- Requires internet access on first load per session (FastF1 downloads from the
  F1 live-timing API).
- `Code-1.ipynb` is left as-is as the original EDA deliverable; the dashboard is
  an additional, separate presentation layer built from the same analysis.
