# F1 Race Analytics

An interactive, F1-website-styled dashboard built on top of the original `Code-1.ipynb`
exploratory analysis. The notebook's cleaning/analysis logic (lap-time cleaning,
pit-lap detection, stint/tyre-degradation, gap-to-leader, telemetry) has been
refactored into a FastAPI backend that calls the FastF1 API live, with a dark,
F1-branded frontend on top.

## Structure

```
Code-1.ipynb          original exploratory notebook (unchanged)
backend/
  app.py               FastAPI app: REST API + serves the frontend
  analysis.py          FastF1 data loading/cleaning (evolved from the notebook)
  requirements.txt
  f1_cache/             FastF1's on-disk cache (created automatically)
frontend/
  index.html            page shell, tab layout
  style.css             dark F1-style theme
  app.js                fetches the API, renders Plotly.js charts
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

## What's on the dashboard

- **Overview** — event header, podium, key stats, full classification, fastest-lap ranking
- **Lap Times** — lap-by-lap progression, distribution (box plot), consistency (std dev)
- **Tyres & Pit Stops** — stint/strategy timeline, tyre degradation curves, compound
  performance, pit-stop durations, lap times with pit stops marked
- **Gaps & Position** — gap to race leader per lap, track position over time
- **Sectors** — average sector times per driver
- **Telemetry** — speed trace and throttle/brake overlay for up to 3 drivers' fastest laps
- **Weather** — track/air temperature, humidity, wind, rainfall

Driver colors follow real team liveries; teammates (same team color) are
distinguished with a dashed/dotted line style and always-visible driver-code
labels. Tyre-compound colors follow the FIA standard (soft = red, medium =
yellow, hard = white, intermediate = green, wet = blue). Click a driver chip in
the legend to isolate/hide that driver across every chart.

## Notes

- Requires internet access on first load per session (FastF1 downloads from the
  F1 live-timing API); afterwards everything is served from `backend/f1_cache/`.
- `Code-1.ipynb` is left as-is as the original EDA deliverable; the dashboard is
  an additional, separate presentation layer built from the same analysis.
