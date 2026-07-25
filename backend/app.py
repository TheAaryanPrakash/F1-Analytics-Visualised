from __future__ import annotations

import datetime as dt
import os

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import analysis

app = FastAPI(title="F1 Race Analysis API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def no_cache_static(request, call_next):
    """Frontend is under active development - never let the browser cache
    index.html/app.js/style.css, so a page reload always reflects the
    latest edits without relying on the user hard-refreshing."""
    response = await call_next(request)
    if request.url.path in ("/", "/index.html", "/app.js", "/style.css"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return response

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")


def _session_or_404(year: int, event: str, session: str, telemetry: bool = False):
    try:
        return analysis.load_session(year, event, session, with_telemetry=telemetry)
    except Exception as exc:  # fastf1 raises a variety of exception types
        raise HTTPException(status_code=404, detail=f"Could not load session: {exc}") from exc


@app.get("/api/meta/seasons")
def seasons():
    current_year = dt.date.today().year
    return {"seasons": list(range(2018, current_year + 1))[::-1]}


@app.get("/api/meta/events")
def events(year: int = Query(...)):
    try:
        schedule = analysis.get_event_schedule(year)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    out = []
    for _, row in schedule.iterrows():
        out.append(
            {
                "round": int(row["RoundNumber"]),
                "name": row["EventName"],
                "officialName": row.get("OfficialEventName"),
                "location": row.get("Location"),
                "country": row.get("Country"),
                "date": row["EventDate"].isoformat() if hasattr(row["EventDate"], "isoformat") else str(row["EventDate"]),
                "format": row.get("EventFormat"),
            }
        )
    return {"year": year, "events": out}


@app.get("/api/meta/sessions")
def sessions(year: int = Query(...), event: str = Query(...)):
    try:
        schedule = analysis.get_event_schedule(year)
        row = schedule[schedule["EventName"] == event]
        if row.empty:
            raise ValueError(f"Unknown event '{event}' for {year}")
        row = row.iloc[0]
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    out = []
    for i in range(1, 6):
        name = row.get(f"Session{i}")
        if not name or not isinstance(name, str):
            continue
        code_map = {
            "Practice 1": "FP1", "Practice 2": "FP2", "Practice 3": "FP3",
            "Qualifying": "Q", "Sprint Qualifying": "SQ", "Sprint Shootout": "SQ",
            "Sprint": "S", "Race": "R",
        }
        code = code_map.get(name, name)
        out.append({"code": code, "name": name})
    if not out:
        out = [{"code": c, "name": c} for c in analysis.SESSION_CODES]
    return {"year": year, "event": event, "sessions": out}


@app.get("/api/meta/drivers")
def drivers(year: int = Query(...), event: str = Query(...), session: str = Query(...)):
    s = _session_or_404(year, event, session)
    return {"drivers": analysis.session_drivers(s)}


@app.get("/api/analysis")
def get_analysis(
    year: int = Query(...),
    event: str = Query(...),
    session: str = Query(...),
    drivers: str = Query(..., description="Comma-separated driver codes, e.g. PIA,NOR,VER"),
):
    driver_list = [d.strip().upper() for d in drivers.split(",") if d.strip()]
    if not driver_list:
        raise HTTPException(status_code=400, detail="No drivers provided")
    if len(driver_list) > 8:
        raise HTTPException(status_code=400, detail="Please select 8 drivers or fewer")
    try:
        return analysis.build_analysis(year, event, session, driver_list)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/telemetry")
def get_telemetry(
    year: int = Query(...),
    event: str = Query(...),
    session: str = Query(...),
    driver: str = Query(...),
    lap: str = Query("fastest"),
):
    try:
        return analysis.build_telemetry(year, event, session, driver.upper(), lap)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/trackmap")
def get_track_map(
    year: int = Query(...),
    event: str = Query(...),
    session: str = Query(...),
    driver: str = Query(...),
    lap: str = Query("fastest"),
):
    try:
        return analysis.build_track_map(year, event, session, driver.upper(), lap)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/delta")
def get_delta(
    year: int = Query(...),
    event: str = Query(...),
    session: str = Query(...),
    driver1: str = Query(...),
    driver2: str = Query(...),
    lap1: str = Query("fastest"),
    lap2: str = Query("fastest"),
):
    if driver1.upper() == driver2.upper():
        raise HTTPException(status_code=400, detail="Pick two different drivers")
    try:
        return analysis.build_delta(year, event, session, driver1.upper(), driver2.upper(), lap1, lap2)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/health")
def health():
    return {"status": "ok"}


# Serve the frontend as static files, with index.html at "/"
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
