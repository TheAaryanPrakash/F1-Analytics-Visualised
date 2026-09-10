"""
Core FastF1 data-loading and analysis functions.

This module is a direct evolution of the exploratory analysis originally
written in Code-1.ipynb: the same lap-cleaning, stint/pit detection, gap-to-
leader, tyre-degradation and telemetry logic, refactored into reusable,
JSON-serializable functions that the FastAPI layer (app.py) exposes as an API.
"""
from __future__ import annotations

import math
import os
import shutil
import tempfile
import threading
import warnings
from collections import OrderedDict
from typing import Any

import fastf1
import numpy as np
import pandas as pd

# Prefer a cache dir next to the source (persists across warm instances on a
# real VM/container). Serverless platforms (Vercel, Lambda) ship a read-only
# deployment bundle outside of /tmp, so fall back there when the preferred
# location isn't writable - the cache is then instance-local and ephemeral,
# which is fine: there's no cross-request persistence guarantee anywhere in
# this deployment, only within a single warm instance's lifetime.
CACHE_DIR = os.path.join(os.path.dirname(__file__), "f1_cache")
try:
    os.makedirs(CACHE_DIR, exist_ok=True)
except OSError:
    CACHE_DIR = os.path.join(tempfile.gettempdir(), "f1_cache")
    os.makedirs(CACHE_DIR, exist_ok=True)
fastf1.Cache.enable_cache(CACHE_DIR)

# Vercel's /tmp is small and shared with its own per-cold-start dependency
# install (~100MB+ into /tmp/_vc_deps), and fastf1's cache grows unbounded -
# every session and telemetry pull a warm instance handles adds more pickled
# data. Once /tmp genuinely fills up, fastf1's cache writes start failing
# with OSError: [Errno 28] No space left on device - and fastf1 catches that
# internally, logs a warning, and just leaves that data category unloaded
# rather than raising. That's what actually produces the confusing "the
# data you are trying to access has not been loaded yet" error later, on
# data that really was requested. Clearing the cache when free space gets
# low prevents the write failure in the first place; there's no cross-
# request persistence guarantee on this deployment to lose by doing so (see
# CACHE_DIR comment above).
_MIN_FREE_BYTES = 200 * 1024 * 1024  # 200MB safety margin


def _ensure_cache_space() -> None:
    try:
        free = shutil.disk_usage(CACHE_DIR).free
    except OSError:
        return
    if free < _MIN_FREE_BYTES:
        shutil.rmtree(CACHE_DIR, ignore_errors=True)
        os.makedirs(CACHE_DIR, exist_ok=True)
        fastf1.Cache.enable_cache(CACHE_DIR)


SESSION_CODES = ["FP1", "FP2", "FP3", "Q", "SQ", "S", "R"]

# Official-ish 2025 team liveries, keyed by team name as FastF1 reports it.
TEAM_COLORS: dict[str, str] = {
    "Red Bull Racing": "#3671C6",
    "McLaren": "#FF8000",
    "Ferrari": "#E80020",
    "Mercedes": "#27F4D2",
    "Aston Martin": "#229971",
    "Alpine": "#FF87BC",
    "Williams": "#64C4FF",
    "RB": "#6692FF",
    "Racing Bulls": "#6692FF",
    "Kick Sauber": "#52E252",
    "Sauber": "#52E252",
    "Haas F1 Team": "#B6BABD",
    "Haas": "#B6BABD",
}
DEFAULT_TEAM_COLOR = "#B6BABD"

# FIA-standard tyre-compound colors.
COMPOUND_COLORS: dict[str, str] = {
    "SOFT": "#DA291C",
    "MEDIUM": "#FFD12E",
    "HARD": "#F0F0F0",
    "INTERMEDIATE": "#43B02A",
    "WET": "#0067AD",
}


def _nan_to_none(value: Any) -> Any:
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, (float, np.floating)) and math.isnan(value):
        return None
    if isinstance(value, (np.generic,)):
        value = value.item()
    if isinstance(value, pd.Timedelta):
        value = value.total_seconds()
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, float):
        # Raw computed floats (std/mean/diffs) carry full binary precision
        # (e.g. 13.817934335456377) which is meaningless past millisecond
        # resolution for lap-time-scale data and just clutters hover/labels.
        return round(value, 3)
    return value


def records(df: pd.DataFrame) -> list[dict[str, Any]]:
    """DataFrame -> list of JSON-safe dicts (NaN -> None, Timedelta -> seconds)."""
    out = []
    for row in df.to_dict(orient="records"):
        out.append({k: _nan_to_none(v) for k, v in row.items()})
    return out


# fastf1's on-disk cache (a single shared SQLite file for the HTTP layer,
# via the fastf1.Cache.enable_cache() call above) isn't safe under
# concurrent writers - two requests loading data at once can corrupt or
# truncate each other's cache entries. That corruption doesn't raise where
# it happens; it surfaces later as FastF1 claiming data "has not been
# loaded yet" on data that really was requested, which is confusing and was
# showing up as an intermittent, hard-to-reproduce error. FastAPI runs sync
# route handlers in a thread pool, so without a lock, concurrent requests
# (e.g. a user with Telemetry/Track Map/Head-to-Head all loading around the
# same time) really do race on that shared cache. A single process-wide
# lock around every fastf1 network/cache call - not a per-key lock - trades
# a bit of concurrency for correctness: it serializes ALL loads, including
# for different sessions, because the shared SQLite file is at risk
# regardless of which session is being fetched. The right trade at this
# app's scale (personal project, low concurrent traffic).
_fastf1_io_lock = threading.Lock()

_EVENT_SCHEDULE_CACHE_MAXSIZE = 16
_event_schedule_cache: "OrderedDict[int, pd.DataFrame]" = OrderedDict()

_SESSION_CACHE_MAXSIZE = 32
_session_cache: "OrderedDict[tuple[int, str, str, bool], Any]" = OrderedDict()


def get_event_schedule(year: int) -> pd.DataFrame:
    with _fastf1_io_lock:
        if year in _event_schedule_cache:
            _event_schedule_cache.move_to_end(year)
            return _event_schedule_cache[year]
        schedule = fastf1.get_event_schedule(year, include_testing=False)
        _event_schedule_cache[year] = schedule
        if len(_event_schedule_cache) > _EVENT_SCHEDULE_CACHE_MAXSIZE:
            _event_schedule_cache.popitem(last=False)
        return schedule


def _load_session(year: int, event: str, session_code: str, with_telemetry: bool):
    key = (year, event, session_code, with_telemetry)
    with _fastf1_io_lock:
        if key in _session_cache:
            _session_cache.move_to_end(key)
            return _session_cache[key]
        _ensure_cache_space()
        session = fastf1.get_session(year, event, session_code)
        session.load(laps=True, telemetry=with_telemetry, weather=True, messages=False)
        _session_cache[key] = session
        if len(_session_cache) > _SESSION_CACHE_MAXSIZE:
            _session_cache.popitem(last=False)
        return session


def load_session(year: int, event: str, session_code: str, with_telemetry: bool = False):
    """Cached session loader. Telemetry loads are cached separately (heavier)."""
    return _load_session(year, event, session_code, with_telemetry)


def team_color(team: str | None) -> str:
    if not team:
        return DEFAULT_TEAM_COLOR
    return TEAM_COLORS.get(team, DEFAULT_TEAM_COLOR)


def prepare_driver_laps(laps_df, driver_code: str) -> pd.DataFrame:
    """Clean one driver's laps: lap-time seconds, pit-lap flag, stint-lap counter."""
    df = laps_df.pick_drivers(driver_code).reset_index(drop=True).copy()

    if "LapTime" in df.columns:
        df["LapTimeSeconds"] = df["LapTime"].dt.total_seconds()
    else:
        df["LapTimeSeconds"] = np.nan

    df["is_pitlap"] = df.get("PitInTime").notna() | df.get("PitOutTime").notna()

    if "Stint" in df.columns:
        df = df.sort_values("LapNumber")
        df["StintLap"] = df.groupby("Stint").cumcount() + 1

    df["Driver"] = driver_code
    return df


def build_driver_dfs(laps, drivers: list[str]) -> dict[str, pd.DataFrame]:
    driver_dfs = {}
    for d in drivers:
        try:
            df = prepare_driver_laps(laps, d)
            if len(df):
                driver_dfs[d] = df
        except Exception:
            continue
    return driver_dfs


def session_drivers(session) -> list[dict[str, Any]]:
    """All drivers present in a loaded session, with team + display info."""
    laps = session.laps
    out = []
    seen = set()
    codes = list(laps["Driver"].dropna().unique()) if "Driver" in laps.columns else []
    for code in codes:
        if code in seen:
            continue
        seen.add(code)
        row = laps[laps["Driver"] == code].iloc[0]
        team = row.get("Team")
        full_name = None
        number = None
        try:
            if session.results is not None and len(session.results):
                res_row = session.results[session.results["Abbreviation"] == code]
                if len(res_row):
                    full_name = res_row.iloc[0].get("FullName")
                    number = res_row.iloc[0].get("DriverNumber")
        except Exception:
            pass
        out.append(
            {
                "code": code,
                "team": team,
                "color": team_color(team),
                "fullName": full_name or code,
                "number": _nan_to_none(number),
            }
        )
    out.sort(key=lambda d: (d["team"] or "", d["code"]))
    return out


def gap_to_leader(combined: pd.DataFrame) -> pd.DataFrame:
    """Real cumulative time gap to the race leader at each lap (not a
    lap-time delta): each driver's elapsed session time when they crossed
    the line on lap N, minus the leader's elapsed time at lap N."""
    valid = combined.dropna(subset=["Time"])
    if valid.empty:
        return combined.assign(GapToLeader=np.nan, LeaderDriver=None)

    if "Position" in valid.columns and valid["Position"].notna().any() and (valid["Position"] == 1).any():
        leader_rows = valid[valid["Position"] == 1]
    else:
        leader_idx = valid.groupby("LapNumber")["Time"].idxmin()
        leader_rows = valid.loc[leader_idx]

    leader_per_lap = (
        leader_rows[["LapNumber", "Driver", "Time"]]
        .drop_duplicates(subset=["LapNumber"])
        .rename(columns={"Driver": "LeaderDriver", "Time": "LeaderTime"})
    )

    merged = combined.merge(leader_per_lap, on="LapNumber", how="left")
    merged["GapToLeader"] = (merged["Time"] - merged["LeaderTime"]).dt.total_seconds()
    return merged


def build_analysis(year: int, event: str, session_code: str, drivers: list[str]) -> dict[str, Any]:
    session = load_session(year, event, session_code, with_telemetry=False)
    laps = session.laps
    results = session.results if hasattr(session, "results") else None

    driver_dfs = build_driver_dfs(laps, drivers)
    resolved_drivers = list(driver_dfs.keys())
    if not resolved_drivers:
        raise ValueError("None of the requested drivers have lap data in this session")

    combined = pd.concat(driver_dfs.values(), ignore_index=True)

    driver_meta = {}
    for d in resolved_drivers:
        team = driver_dfs[d]["Team"].iloc[0] if "Team" in driver_dfs[d].columns and len(driver_dfs[d]) else None
        driver_meta[d] = {"code": d, "team": team, "color": team_color(team)}

    # --- Lap times ---
    laps_by_driver = {
        d: records(
            driver_dfs[d][
                [c for c in [
                    "LapNumber", "LapTimeSeconds", "Compound", "Stint", "StintLap",
                    "is_pitlap", "Position", "Sector1Time", "Sector2Time", "Sector3Time",
                ] if c in driver_dfs[d].columns]
            ]
        )
        for d in resolved_drivers
    }

    fastest = (
        combined.groupby("Driver")["LapTimeSeconds"].min().sort_values().reset_index()
        .rename(columns={"LapTimeSeconds": "FastestLapSec"})
    )
    # Excludes pit in/out laps: their inflated lap times would otherwise
    # dominate the std dev and make "consistency" meaningless.
    variance = (
        combined[~combined["is_pitlap"]].groupby("Driver")["LapTimeSeconds"].std().reset_index()
        .rename(columns={"LapTimeSeconds": "LapTimeStdSec"})
    )

    # --- Compound performance ---
    df_comp = (
        combined.dropna(subset=["Compound", "LapTimeSeconds"])
        .groupby(["Driver", "Compound"])["LapTimeSeconds"].mean().reset_index()
    )

    # --- Pit stops ---
    pitlaps = combined[combined["is_pitlap"] == True][  # noqa: E712
        ["Driver", "LapNumber", "LapTimeSeconds", "PitInTime", "PitOutTime"]
    ].sort_values(["Driver", "LapNumber"])

    # Pit-in and pit-out times usually land on two consecutive laps (the
    # in-lap and the out-lap), not the same row, so pair them across laps.
    pit_durations = []
    if "PitInTime" in combined.columns and "PitOutTime" in combined.columns:
        for d in resolved_drivers:
            ddf = combined[combined["Driver"] == d].sort_values("LapNumber")
            in_laps = ddf.dropna(subset=["PitInTime"])
            out_laps = ddf.dropna(subset=["PitOutTime"])
            for _, in_row in in_laps.iterrows():
                candidates = out_laps[out_laps["LapNumber"] >= in_row["LapNumber"]]
                if candidates.empty:
                    continue
                out_row = candidates.iloc[0]
                if out_row["LapNumber"] - in_row["LapNumber"] > 1:
                    continue
                duration = (out_row["PitOutTime"] - in_row["PitInTime"]).total_seconds()
                if duration > 0:
                    pit_durations.append(
                        {"Driver": d, "LapNumber": _nan_to_none(in_row["LapNumber"]), "PitDurationSec": round(duration, 3)}
                    )

    num_pits = combined.groupby("Driver")["is_pitlap"].sum().reset_index().rename(
        columns={"is_pitlap": "NumPitLaps"}
    )

    # --- Gap to leader ---
    merged_gap = gap_to_leader(combined)
    gap_by_driver = {
        d: records(
            merged_gap[merged_gap["Driver"] == d][["LapNumber", "GapToLeader", "LeaderDriver"]]
        )
        for d in resolved_drivers
    }

    # --- Tyre degradation ---
    degradation = []
    if "StintLap" in combined.columns:
        deg = (
            combined.dropna(subset=["StintLap", "LapTimeSeconds"])
            .groupby(["Compound", "StintLap"])["LapTimeSeconds"].mean().reset_index()
        )
        degradation = records(deg)

    stint_counts = (
        combined.dropna(subset=["Stint"]).groupby(["Driver", "Stint"])["LapNumber"].count()
        .reset_index(name="LapsInStint")
    )
    # attach compound used in each stint
    if "Compound" in combined.columns:
        stint_compound = (
            combined.dropna(subset=["Stint"]).groupby(["Driver", "Stint"])["Compound"].first().reset_index()
        )
        stint_counts = stint_counts.merge(stint_compound, on=["Driver", "Stint"], how="left")

    # --- Position over time ---
    position_by_driver = {}
    if "Position" in combined.columns:
        for d in resolved_drivers:
            df = combined[combined["Driver"] == d]
            position_by_driver[d] = records(df[["LapNumber", "Position"]].dropna())

    # --- Sector times ---
    sector_avg = []
    if all(c in combined.columns for c in ["Sector1Time", "Sector2Time", "Sector3Time"]):
        sec = combined.copy()
        for c in ["Sector1Time", "Sector2Time", "Sector3Time"]:
            sec[c] = sec[c].dt.total_seconds()
        sector_avg = records(sec.groupby("Driver")[["Sector1Time", "Sector2Time", "Sector3Time"]].mean().reset_index())

    # --- Results / classification ---
    results_table = []
    if results is not None and len(results):
        cols = [c for c in ["Abbreviation", "TeamName", "Position", "GridPosition", "Time", "Status", "Points"] if c in results.columns]
        rt = results[cols].copy()
        if "Time" in rt.columns:
            rt["Time"] = rt["Time"].apply(lambda t: t.total_seconds() if isinstance(t, pd.Timedelta) else t)
        results_table = records(rt)

    # --- Weather ---
    weather_summary = None
    try:
        w = session.weather_data
        if w is not None and len(w):
            weather_summary = {
                "AirTempAvg": round(float(w["AirTemp"].mean()), 1) if "AirTemp" in w else None,
                "TrackTempAvg": round(float(w["TrackTemp"].mean()), 1) if "TrackTemp" in w else None,
                "Humidity": round(float(w["Humidity"].mean()), 1) if "Humidity" in w else None,
                "Rainfall": bool(w["Rainfall"].any()) if "Rainfall" in w else False,
                "WindSpeedAvg": round(float(w["WindSpeed"].mean()), 1) if "WindSpeed" in w else None,
                "series": records(w[[c for c in ["Time", "AirTemp", "TrackTemp", "Humidity", "Rainfall"] if c in w.columns]]),
            }
            if weather_summary["series"]:
                for row in weather_summary["series"]:
                    if isinstance(row.get("Time"), pd.Timedelta):
                        row["Time"] = row["Time"].total_seconds()
    except Exception:
        weather_summary = None

    return {
        "meta": {
            "year": year,
            "event": event,
            "session": session_code,
            "drivers": resolved_drivers,
            "driverMeta": driver_meta,
        },
        "lapsByDriver": laps_by_driver,
        "fastestLap": records(fastest),
        "lapTimeVariance": records(variance),
        "compoundPerformance": records(df_comp),
        "pitLaps": records(pitlaps),
        "pitDurations": pit_durations,
        "numPits": records(num_pits),
        "gapToLeaderByDriver": gap_by_driver,
        "degradation": degradation,
        "stintCounts": records(stint_counts),
        "positionByDriver": position_by_driver,
        "sectorAverages": sector_avg,
        "results": results_table,
        "weather": weather_summary,
        "compoundColors": COMPOUND_COLORS,
    }


def build_telemetry(year: int, event: str, session_code: str, driver: str, lap: str) -> dict[str, Any]:
    session = load_session(year, event, session_code, with_telemetry=True)
    chosen = _pick_lap(session, driver, lap)

    tel = chosen.get_telemetry()
    cols = [c for c in ["Distance", "Speed", "Throttle", "Brake", "nGear", "RPM", "DRS"] if c in tel.columns]
    data = records(tel[cols])

    return {
        "driver": driver,
        "lapNumber": _nan_to_none(chosen.get("LapNumber")),
        "lapTimeSeconds": _nan_to_none(chosen["LapTime"].total_seconds()) if pd.notna(chosen.get("LapTime")) else None,
        "compound": chosen.get("Compound"),
        "telemetry": data,
    }


def _rotate(x: np.ndarray, y: np.ndarray, angle_deg: float) -> tuple[np.ndarray, np.ndarray]:
    """Rotate points by the circuit's map rotation, per FastF1's circuit-info convention."""
    angle = math.radians(angle_deg)
    rot = np.array([[math.cos(angle), math.sin(angle)], [-math.sin(angle), math.cos(angle)]])
    xy = np.column_stack([x, y])
    rotated = xy.dot(rot)
    return rotated[:, 0], rotated[:, 1]


def _pick_lap(session, driver: str, lap: str):
    driver_laps = session.laps.pick_drivers(driver)
    if lap == "fastest" or lap is None:
        # Prefer laps FastF1 flags as self-consistent ("accurate") before
        # picking the fastest one. A lap can have a low recorded LapTime
        # (e.g. from timing quirks around a red flag / safety car restart)
        # while its telemetry is truncated or otherwise not representative
        # of a genuine flying lap - pick_accurate() filters those out.
        accurate = driver_laps.pick_accurate()
        candidates = accurate if len(accurate) else driver_laps
        return candidates.pick_fastest()
    return driver_laps[driver_laps["LapNumber"] == float(lap)].iloc[0]


def build_track_map(year: int, event: str, session_code: str, driver: str, lap: str) -> dict[str, Any]:
    session = load_session(year, event, session_code, with_telemetry=True)
    chosen = _pick_lap(session, driver, lap)
    tel = chosen.get_telemetry()

    circuit = session.get_circuit_info()
    rotation = float(circuit.rotation)

    tx, ty = _rotate(tel["X"].to_numpy(), tel["Y"].to_numpy(), rotation)

    corners = []
    offset_len = 450.0
    for _, corner in circuit.corners.iterrows():
        cx, cy = _rotate(np.array([corner["X"]]), np.array([corner["Y"]]), rotation)
        offset_angle = math.radians(corner["Angle"])
        ox = offset_len * math.cos(offset_angle)
        oy = offset_len * math.sin(offset_angle)
        lx, ly = _rotate(np.array([corner["X"] + ox]), np.array([corner["Y"] + oy]), rotation)
        corners.append(
            {
                "number": f"{int(corner['Number'])}{corner['Letter'] or ''}",
                "x": float(cx[0]),
                "y": float(cy[0]),
                "labelX": float(lx[0]),
                "labelY": float(ly[0]),
            }
        )

    points = []
    for i in range(len(tel)):
        points.append(
            {
                "x": float(tx[i]),
                "y": float(ty[i]),
                "distance": _nan_to_none(tel["Distance"].iloc[i]),
                "speed": _nan_to_none(tel["Speed"].iloc[i]),
                "gear": _nan_to_none(tel["nGear"].iloc[i]),
                "throttle": _nan_to_none(tel["Throttle"].iloc[i]) if "Throttle" in tel.columns else None,
                "brake": bool(tel["Brake"].iloc[i]) if "Brake" in tel.columns else None,
            }
        )

    return {
        "driver": driver,
        "lapNumber": _nan_to_none(chosen.get("LapNumber")),
        "lapTimeSeconds": _nan_to_none(chosen["LapTime"].total_seconds()) if pd.notna(chosen.get("LapTime")) else None,
        "compound": chosen.get("Compound"),
        "points": points,
        "corners": corners,
    }


def build_delta(
    year: int, event: str, session_code: str, driver1: str, driver2: str, lap1: str = "fastest", lap2: str = "fastest"
) -> dict[str, Any]:
    import fastf1.utils as ff1_utils

    session = load_session(year, event, session_code, with_telemetry=True)
    ref_lap = _pick_lap(session, driver1, lap1)
    cmp_lap = _pick_lap(session, driver2, lap2)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        delta, ref_tel, cmp_tel = ff1_utils.delta_time(ref_lap, cmp_lap)

    rows = []
    for i in range(len(ref_tel)):
        rows.append(
            {
                "distance": _nan_to_none(ref_tel["Distance"].iloc[i]),
                "delta": _nan_to_none(delta.iloc[i]),
                "refSpeed": _nan_to_none(ref_tel["Speed"].iloc[i]),
            }
        )
    cmp_speed = [
        {"distance": _nan_to_none(cmp_tel["Distance"].iloc[i]), "speed": _nan_to_none(cmp_tel["Speed"].iloc[i])}
        for i in range(len(cmp_tel))
    ]

    return {
        "reference": {
            "driver": driver1,
            "lapNumber": _nan_to_none(ref_lap.get("LapNumber")),
            "lapTimeSeconds": _nan_to_none(ref_lap["LapTime"].total_seconds()) if pd.notna(ref_lap.get("LapTime")) else None,
        },
        "compare": {
            "driver": driver2,
            "lapNumber": _nan_to_none(cmp_lap.get("LapNumber")),
            "lapTimeSeconds": _nan_to_none(cmp_lap["LapTime"].total_seconds()) if pd.notna(cmp_lap.get("LapTime")) else None,
        },
        "delta": rows,
        "compareSpeed": cmp_speed,
    }
