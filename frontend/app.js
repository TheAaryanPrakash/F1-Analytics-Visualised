/* ---------- Constants ---------- */
const API = "";
const DEFAULT_EVENT = "Qatar Grand Prix";
const DEFAULT_DRIVERS = ["PIA", "NOR", "VER", "ANT", "RUS"];
const DASH_STYLES = ["solid", "dash", "dot"];
const MARKER_SYMBOLS = ["circle", "diamond", "square"];
const SECTOR_COLORS = ["#3987e5", "#d95926", "#199e70"]; // skill categorical slots 1-3 (dark)
const WEATHER_COLORS = { air: "#3987e5", track: "#e66767" }; // skill diverging pair (dark)
// skill's 8 dark categorical slots, reused for gear 1-8 (a natural 8-way categorical)
const GEAR_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

const CHART_CHROME = {
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor: "rgba(0,0,0,0)",
  font: { family: "Titillium Web, sans-serif", color: "#c3c2b7", size: 12 },
  margin: { t: 20, r: 20, b: 40, l: 50 },
  // type:'linear' is explicit and non-negotiable here: without it Plotly
  // guesses the axis type per-chart, and for some data shapes it guesses
  // 'category' for a numeric axis - which orders ticks by the order values
  // are first encountered across traces (e.g. by whichever driver's trace
  // was added first) instead of ascending value. Charts with a genuinely
  // categorical axis (driver codes) override this back to 'category'
  // explicitly at the call site, with their own categoryarray.
  xaxis: { gridcolor: "#2c2c2a", zerolinecolor: "#383835", color: "#898781", type: "linear" },
  yaxis: { gridcolor: "#2c2c2a", zerolinecolor: "#383835", color: "#898781", type: "linear" },
  legend: { font: { color: "#c3c2b7" }, orientation: "h", y: 1.12 },
  hoverlabel: { bgcolor: "#1c1c21", bordercolor: "#383835", font: { color: "#ffffff" } },
};
const PLOTLY_CONFIG = { displayModeBar: false, responsive: true };

/* ---------- State ---------- */
const state = {
  year: null,
  event: null,
  session: null,
  allDrivers: [],
  selectedDrivers: [],
  activeDrivers: new Set(), // subset currently visible (legend toggle)
  dashMap: {},
  analysis: null,
  telemetrySelected: [],
  telemetryData: {},
  maxLap: 1,
  scrubLap: 1,
  scrubTimer: null,
  trackMapData: null,
  trackColorMode: "speed",
  h2hData: null,
};

/* ---------- Helpers ---------- */
function fmtLapTime(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3);
  return `${m}:${s.padStart(6, "0")}`;
}
function fmtGap(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return "—";
  const sign = sec > 0 ? "+" : "";
  return `${sign}${sec.toFixed(3)}s`;
}
function fmtNum(v, digits = 1) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return Number(v).toFixed(digits);
}
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${res.status})`);
  }
  return res.json();
}
function setStatus(msg, isError = false) {
  const bar = document.getElementById("statusBar");
  bar.classList.remove("hidden");
  bar.textContent = msg;
  bar.classList.toggle("error", isError);
}
function clearStatus() {
  document.getElementById("statusBar").classList.add("hidden");
}
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
// Mix a color toward white so a lightened teammate variant stays visible
// against the dark background (darkening instead would risk sinking it
// into the page-plane color and losing it entirely).
function lighten(hex, amount) {
  const c = hexToRgb(hex);
  const white = [255, 255, 255];
  return rgbToHex(c.map((v, i) => v + (white[i] - v) * amount));
}
// Teammates share an identical team livery color, which makes them
// indistinguishable by hue alone on every chart type (not just lines, where
// dash style already helps) - bar fills, box plots, track map dots, etc all
// only carry color. Give same-color drivers a genuinely different shade so
// the distinction survives on any chart, plus dash/marker-symbol as a
// second, redundant channel for line charts specifically.
const TEAMMATE_LIGHTEN = [0, 0.45, 0.72];
function computeDashMap(driverCodes, driverMeta) {
  const byColor = {};
  const map = {};
  for (const code of driverCodes) {
    const baseColor = (driverMeta[code] || {}).color || "#888";
    byColor[baseColor] = byColor[baseColor] || [];
    const idx = byColor[baseColor].length;
    byColor[baseColor].push(code);
    map[code] = {
      color: lighten(baseColor, TEAMMATE_LIGHTEN[Math.min(idx, TEAMMATE_LIGHTEN.length - 1)]),
      baseColor,
      teammateIndex: idx,
      dash: DASH_STYLES[Math.min(idx, DASH_STYLES.length - 1)],
      symbol: MARKER_SYMBOLS[Math.min(idx, MARKER_SYMBOLS.length - 1)],
    };
  }
  return map;
}

/* ---------- Motion (purely presentational - never gates data/logic) ---------- */
// Sliding tab-underline: positions <span class="tab-indicator"> under the
// active tab. Falls back to a plain CSS transition if anime.js didn't load
// (e.g. offline/CDN blocked) - the static border-bottom in style.css covers
// the instant before this ever runs, so there's no broken/invisible state.
function positionTabIndicator(activeBtn) {
  const nav = document.getElementById("tabs");
  const indicator = nav && nav.querySelector(".tab-indicator");
  if (!indicator || !activeBtn) return;
  const x = activeBtn.offsetLeft;
  const y = activeBtn.offsetTop + activeBtn.offsetHeight - 2;
  indicator.style.width = `${activeBtn.offsetWidth}px`;
  indicator.style.opacity = "1";
  if (window.anime) {
    anime({ targets: indicator, translateX: x, translateY: y, duration: 420, easing: "spring(1, 80, 12, 0)" });
  } else {
    indicator.style.transform = `translate(${x}px, ${y}px)`;
  }
}
// Small tactile "pop" for click feedback on elements that persist across the
// click (i.e. aren't about to be torn down and rebuilt by innerHTML="").
function pulse(el) {
  if (!el) return;
  if (window.anime) {
    anime({ targets: el, scale: [1, 1.1, 1], duration: 280, easing: "easeOutBack" });
  } else {
    el.style.transition = "transform 150ms ease-out";
    el.style.transform = "scale(1.08)";
    setTimeout(() => { el.style.transform = ""; }, 150);
  }
}
// Cursor-follow spotlight on cards/tiles: only writes two CSS custom
// properties (read by a radial-gradient in style.css), throttled to one
// update per animation frame so it never floods layout/paint.
function initSpotlight() {
  let raf = null;
  let lastEvt = null;
  document.addEventListener("mousemove", (e) => {
    lastEvt = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const el = lastEvt.target.closest(".card, .stat-tile");
      if (!el) return;
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${lastEvt.clientX - rect.left}px`);
      el.style.setProperty("--my", `${lastEvt.clientY - rect.top}px`);
    });
  });
}

/* ---------- Init ---------- */
document.addEventListener("DOMContentLoaded", init);

async function init() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  initSpotlight();
  document.getElementById("loadBtn").addEventListener("click", loadAnalysis);
  document.getElementById("loadTelemetryBtn").addEventListener("click", loadTelemetry);
  document.getElementById("loadTrackMapBtn").addEventListener("click", loadTrackMap);
  document.getElementById("loadH2HBtn").addEventListener("click", loadHeadToHead);
  document.querySelectorAll("#trackColorToggle .toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#trackColorToggle .toggle-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.trackColorMode = btn.dataset.mode;
      if (state.trackMapData) renderTrackMapChart();
    });
  });
  document.getElementById("scrubSlider").addEventListener("input", (e) => {
    stopScrubPlayback();
    state.scrubLap = Number(e.target.value);
    document.getElementById("scrubLabel").textContent = `Lap ${state.scrubLap}`;
    renderGapsPosition();
  });
  document.getElementById("scrubPlayBtn").addEventListener("click", toggleScrubPlayback);

  const tabsNav = document.getElementById("tabs");
  window.addEventListener("resize", () => positionTabIndicator(document.querySelector(".tab.active")));
  requestAnimationFrame(() => {
    tabsNav.classList.add("js-ready");
    positionTabIndicator(document.querySelector(".tab.active"));
  });

  const { seasons } = await getJSON(`${API}/api/meta/seasons`);
  const selYear = document.getElementById("selYear");
  selYear.innerHTML = seasons.map((y) => `<option value="${y}">${y}</option>`).join("");
  selYear.value = seasons.includes(2025) ? "2025" : seasons[0];
  selYear.addEventListener("change", onYearChange);
  document.getElementById("selEvent").addEventListener("change", onEventChange);
  document.getElementById("selSession").addEventListener("change", onSessionChange);

  await onYearChange();
}

async function onYearChange() {
  state.year = Number(document.getElementById("selYear").value);
  setStatus("Loading event calendar…");
  const { events } = await getJSON(`${API}/api/meta/events?year=${state.year}`);
  const selEvent = document.getElementById("selEvent");
  selEvent.innerHTML = events
    .map((e) => `<option value="${e.name}">Rd ${e.round} — ${e.name}</option>`)
    .join("");
  const hasDefault = events.some((e) => e.name === DEFAULT_EVENT);
  selEvent.value = hasDefault ? DEFAULT_EVENT : events[0].name;
  clearStatus();
  await onEventChange();
}

async function onEventChange() {
  state.event = document.getElementById("selEvent").value;
  setStatus("Loading sessions…");
  const { sessions } = await getJSON(
    `${API}/api/meta/sessions?year=${state.year}&event=${encodeURIComponent(state.event)}`
  );
  const selSession = document.getElementById("selSession");
  selSession.innerHTML = sessions.map((s) => `<option value="${s.code}">${s.name}</option>`).join("");
  const hasRace = sessions.some((s) => s.code === "R");
  selSession.value = hasRace ? "R" : sessions[0].code;
  clearStatus();
  await onSessionChange();
}

async function onSessionChange() {
  state.session = document.getElementById("selSession").value;
  const picker = document.getElementById("driverPicker");
  picker.textContent = "Loading drivers…";
  try {
    const { drivers } = await getJSON(
      `${API}/api/meta/drivers?year=${state.year}&event=${encodeURIComponent(state.event)}&session=${state.session}`
    );
    state.allDrivers = drivers;
    const defaultPresent = DEFAULT_DRIVERS.filter((d) => drivers.some((x) => x.code === d));
    state.selectedDrivers = defaultPresent.length >= 2 ? defaultPresent : drivers.slice(0, 5).map((d) => d.code);
    renderDriverPicker();
    clearStatus();
  } catch (err) {
    picker.textContent = "No lap data for this session yet.";
  }
}

function renderDriverPicker() {
  const picker = document.getElementById("driverPicker");
  picker.innerHTML = "";
  for (const d of state.allDrivers) {
    const chip = document.createElement("div");
    chip.className = "driver-chip";
    const selected = state.selectedDrivers.includes(d.code);
    chip.classList.toggle("selected", selected);
    chip.style.borderColor = selected ? d.color : "var(--border)";
    chip.innerHTML = `<span class="dot" style="background:${d.color}"></span>${d.code}`;
    chip.addEventListener("click", () => {
      const idx = state.selectedDrivers.indexOf(d.code);
      if (idx >= 0) state.selectedDrivers.splice(idx, 1);
      else state.selectedDrivers.push(d.code);
      renderDriverPicker();
    });
    picker.appendChild(chip);
  }
}

/* ---------- Tabs ---------- */
function switchTab(tab) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".panel-section").forEach((p) => p.classList.toggle("active", p.id === `panel-${tab}`));
  positionTabIndicator(document.querySelector(`.tab[data-tab="${tab}"]`));
  window.scrollTo({ top: 0, behavior: "smooth" }); // land on the new tab's content, not wherever the previous one left off
  window.dispatchEvent(new Event("resize")); // let Plotly resize newly-visible charts
}

/* ---------- Load analysis ---------- */
async function loadAnalysis() {
  if (state.selectedDrivers.length === 0) {
    setStatus("Select at least one driver.", true);
    return;
  }
  const btn = document.getElementById("loadBtn");
  btn.disabled = true;
  setStatus(`Loading ${state.event} ${state.session} ${state.year}… this can take a while the first time (FastF1 is downloading + caching session data).`);
  try {
    const data = await getJSON(
      `${API}/api/analysis?year=${state.year}&event=${encodeURIComponent(state.event)}&session=${state.session}&drivers=${state.selectedDrivers.join(",")}`
    );
    state.analysis = data;
    state.activeDrivers = new Set(data.meta.drivers);
    state.dashMap = computeDashMap(data.meta.drivers, data.meta.driverMeta);
    state.maxLap = Math.max(
      ...Object.values(data.lapsByDriver).map((laps) => Math.max(...laps.map((l) => l.LapNumber || 0), 1)),
      1
    );
    stopScrubPlayback();
    state.scrubLap = state.maxLap;
    const slider = document.getElementById("scrubSlider");
    slider.min = 1;
    slider.max = state.maxLap;
    slider.value = state.maxLap;
    document.getElementById("scrubLabel").textContent = `Lap ${state.maxLap}`;

    document.getElementById("app").classList.remove("hidden");
    renderDriverLegend();
    renderAll();
    state.telemetrySelected = data.meta.drivers.slice(0, 2);
    renderTelemetryPicker();
    renderTrackAndH2HSelectors();
    clearStatus();
  } catch (err) {
    setStatus(`Failed to load: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function renderDriverLegend() {
  const legend = document.getElementById("driverLegend");
  legend.innerHTML = "";
  const { drivers, driverMeta } = state.analysis.meta;
  drivers.forEach((code, i) => {
    const meta = state.dashMap[code];
    const chip = document.createElement("div");
    chip.className = "driver-chip selected" + (meta.dash !== "solid" ? " dashed" : "");
    chip.style.borderColor = meta.color;
    chip.style.setProperty("--i", i);
    chip.dataset.driver = code;
    chip.innerHTML = `<span class="dot" style="background:${meta.color}"></span>${code} <span style="color:var(--text-muted); font-weight:400;">${driverMeta[code].team || ""}</span>`;
    chip.addEventListener("click", () => {
      if (state.activeDrivers.has(code)) state.activeDrivers.delete(code);
      else state.activeDrivers.add(code);
      chip.classList.toggle("selected", state.activeDrivers.has(code));
      chip.style.opacity = state.activeDrivers.has(code) ? "1" : "0.35";
      pulse(chip);
      renderAll();
    });
    legend.appendChild(chip);
  });
}

function activeList() {
  return state.analysis.meta.drivers.filter((d) => state.activeDrivers.has(d));
}

// Categorical (driver-axis) charts should rank drivers by pace, not by
// whatever arbitrary order they were selected/requested in - otherwise the
// axis reads as "driver data came first" rather than a meaningful order.
function rankedActiveList() {
  const active = activeList();
  const fastestByDriver = {};
  for (const r of state.analysis.fastestLap) fastestByDriver[r.Driver] = r.FastestLapSec;
  return [...active].sort((a, b) => (fastestByDriver[a] ?? Infinity) - (fastestByDriver[b] ?? Infinity));
}

/* ---------- Render everything ---------- */
function renderAll() {
  renderOverview();
  renderLapTimes();
  renderTyres();
  renderGapsPosition();
  renderSectors();
  renderWeather();
}

/* ---------- Overview ---------- */
function renderOverview() {
  const d = state.analysis;
  const hero = document.getElementById("eventHero");
  const podiumRows = (d.results || []).slice(0, 3);
  hero.innerHTML = `
    <div class="event-name">${d.meta.event} ${d.meta.year}</div>
    <div class="event-sub">Session: ${d.meta.session} &middot; ${d.meta.drivers.length} drivers analyzed</div>
    <div class="podium">
      ${podiumRows
        .map((r, i) => {
          const meta = Object.values(d.meta.driverMeta).find((m) => m.code === r.Abbreviation);
          const color = meta ? meta.color : "#888";
          return `<div class="podium-card" style="border-left-color:${color}">
            <div class="pos">P${i + 1}</div>
            <div class="name">${r.Abbreviation}</div>
            <div class="team">${r.TeamName || ""}</div>
          </div>`;
        })
        .join("")}
    </div>`;

  const fastestOverall = d.fastestLap[0];
  const totalLaps = Math.max(...Object.values(d.lapsByDriver).map((laps) => Math.max(...laps.map((l) => l.LapNumber || 0), 0)), 0);
  const numPitStops = d.pitDurations.length;
  const w = d.weather;
  const tiles = [
    { label: "Fastest Lap", value: fastestOverall ? fmtLapTime(fastestOverall.FastestLapSec) : "—", sub: fastestOverall ? fastestOverall.Driver : "" },
    { label: "Total Laps", value: totalLaps || "—", sub: "recorded" },
    { label: "Pit Stops", value: numPitStops, sub: "across selected drivers" },
    { label: "Track Temp", value: w ? `${fmtNum(w.TrackTempAvg)}°C` : "—", sub: "average" },
    { label: "Air Temp", value: w ? `${fmtNum(w.AirTempAvg)}°C` : "—", sub: "average" },
    { label: "Rainfall", value: w && w.Rainfall ? "Yes" : "No", sub: "during session" },
  ];
  document.getElementById("statTiles").innerHTML = tiles
    .map((t) => `<div class="stat-tile"><div class="label">${t.label}</div><div class="value">${t.value}</div><div class="sub">${t.sub}</div></div>`)
    .join("");

  // results table
  const cols = ["Position", "Abbreviation", "TeamName", "GridPosition", "Points", "Status"];
  const rows = d.results || [];
  const tableHtml = `<table class="results"><thead><tr>${cols
    .map((c) => `<th>${c === "Abbreviation" ? "Driver" : c === "TeamName" ? "Team" : c === "GridPosition" ? "Grid" : c}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map((r) => {
      const meta = Object.values(d.meta.driverMeta).find((m) => m.code === r.Abbreviation);
      const dot = meta ? `<span class="team-dot" style="background:${meta.color}"></span>` : "";
      const highlight = d.meta.drivers.includes(r.Abbreviation) ? "highlight" : "";
      return `<tr class="${highlight}">${cols
        .map((c) => {
          if (c === "Abbreviation") return `<td>${dot}${r[c] ?? ""}</td>`;
          if (c === "Points") return `<td>${r[c] ?? 0}</td>`;
          return `<td>${r[c] ?? "—"}</td>`;
        })
        .join("")}</tr>`;
    })
    .join("")}</tbody></table>`;
  document.getElementById("resultsTable").innerHTML = tableHtml;

  // Fastest lap chart: bar length = gap to the overall fastest lap (not
  // absolute seconds) — absolute lap times cluster within ~1-2s of each
  // other, so 0-based absolute bars all look the same length and the chart
  // reads as flat. The gap format is also the standard F1 broadcast framing.
  const best = d.fastestLap.length ? Math.min(...d.fastestLap.map((r) => r.FastestLapSec)) : 0;
  const fl = [...d.fastestLap].sort((a, b) => b.FastestLapSec - a.FastestLapSec);
  Plotly.newPlot(
    "fastestLapChart",
    [
      {
        type: "bar",
        orientation: "h",
        x: fl.map((r) => r.FastestLapSec - best),
        y: fl.map((r) => r.Driver),
        marker: { color: fl.map((r) => state.dashMap[r.Driver].color), cornerradius: 4 },
        customdata: fl.map((r) => [fmtLapTime(r.FastestLapSec), r.FastestLapSec === best]),
        text: fl.map((r) => (r.FastestLapSec === best ? fmtLapTime(r.FastestLapSec) : `+${(r.FastestLapSec - best).toFixed(3)}s`)),
        textposition: "outside",
        textfont: { color: "#c3c2b7", size: 12, family: "Titillium Web, sans-serif" },
        hovertemplate: "%{y}: %{customdata[0]}<extra></extra>",
      },
    ],
    {
      ...CHART_CHROME,
      bargap: 0.45,
      xaxis: { ...CHART_CHROME.xaxis, title: "Gap to Fastest (s)" },
      yaxis: { ...CHART_CHROME.yaxis, type: "category", categoryorder: "array", categoryarray: fl.map((r) => r.Driver) },
      showlegend: false,
      margin: { t: 10, r: 55, b: 40, l: 60 },
    },
    PLOTLY_CONFIG
  );
}

/* ---------- Lap times ---------- */
function renderLapTimes() {
  const d = state.analysis;
  const active = activeList();

  const lapTraces = active.map((code) => {
    const laps = d.lapsByDriver[code].filter((l) => !l.is_pitlap && l.LapTimeSeconds != null);
    const m = state.dashMap[code];
    return {
      type: "scatter",
      mode: "lines+markers",
      name: code,
      x: laps.map((l) => l.LapNumber),
      y: laps.map((l) => l.LapTimeSeconds),
      line: { color: m.color, dash: m.dash, width: 2 },
      marker: { color: m.color, symbol: m.symbol, size: 5 },
      hovertemplate: `${code}: %{y:.3f}s (lap %{x})<extra></extra>`,
    };
  });
  Plotly.newPlot("lapTimeChart", lapTraces, {
    ...CHART_CHROME,
    xaxis: { ...CHART_CHROME.xaxis, title: "Lap" },
    yaxis: { ...CHART_CHROME.yaxis, title: "Lap Time (s)" },
    hovermode: "x unified",
  }, PLOTLY_CONFIG);

  // Ranked by fastest lap (ascending) so the driver axis reads as a
  // meaningful order, not the arbitrary order drivers were selected in.
  const ranked = rankedActiveList();

  const boxTraces = ranked.map((code) => {
    const laps = d.lapsByDriver[code].filter((l) => l.LapTimeSeconds != null);
    const m = state.dashMap[code];
    return { type: "box", name: code, y: laps.map((l) => l.LapTimeSeconds), marker: { color: m.color }, boxpoints: "outliers" };
  });
  Plotly.newPlot(
    "lapDistChart",
    boxTraces,
    { ...CHART_CHROME, showlegend: false, xaxis: { ...CHART_CHROME.xaxis, type: "category", categoryorder: "array", categoryarray: ranked }, yaxis: { ...CHART_CHROME.yaxis, title: "Lap Time (s)" } },
    PLOTLY_CONFIG
  );

  const varData = ranked
    .map((code) => d.lapTimeVariance.find((r) => r.Driver === code))
    .filter(Boolean)
    .sort((a, b) => a.LapTimeStdSec - b.LapTimeStdSec);
  Plotly.newPlot(
    "lapVarChart",
    [{ type: "bar", x: varData.map((r) => r.Driver), y: varData.map((r) => r.LapTimeStdSec), marker: { color: varData.map((r) => state.dashMap[r.Driver].color) }, hovertemplate: "%{x}: %{y:.2f}s<extra></extra>" }],
    { ...CHART_CHROME, showlegend: false, xaxis: { ...CHART_CHROME.xaxis, type: "category", categoryorder: "array", categoryarray: varData.map((r) => r.Driver) }, yaxis: { ...CHART_CHROME.yaxis, title: "Std Dev (s)" } },
    PLOTLY_CONFIG
  );
}

/* ---------- Tyres & pit stops ---------- */
function renderTyres() {
  const d = state.analysis;
  const active = activeList();
  const ranked = rankedActiveList();

  // Stint timeline (strategy gantt). Plotly's barmode:'stack' explicitly
  // ignores/overrides a per-trace 'base', so with N stint-traces per driver
  // the auto-stacking and our manual offsets fight each other and only the
  // last segment ends up visible. Fix: compute the offsets ourselves (one
  // trace per COMPOUND, each holding every driver's bar of that compound
  // with an explicit base array) and render with barmode:'overlay', which
  // draws bars exactly where 'base' + 'x' say to, no auto-stacking involved.
  const baseByDriverStint = {};
  for (const code of active) {
    const stints = d.stintCounts.filter((s) => s.Driver === code).sort((a, b) => a.Stint - b.Stint);
    let base = 0;
    for (const s of stints) {
      baseByDriverStint[`${code}|${s.Stint}`] = base;
      base += s.LapsInStint;
    }
  }
  const stintCompounds = [...new Set(d.stintCounts.filter((s) => active.includes(s.Driver)).map((s) => s.Compound))];
  const stintTraces = stintCompounds.map((comp) => {
    const rows = d.stintCounts.filter((s) => active.includes(s.Driver) && s.Compound === comp);
    return {
      type: "bar",
      orientation: "h",
      name: comp,
      x: rows.map((s) => s.LapsInStint),
      y: rows.map((s) => s.Driver),
      base: rows.map((s) => baseByDriverStint[`${s.Driver}|${s.Stint}`]),
      marker: { color: d.compoundColors[comp] || "#999", line: { color: "#0d0d0d", width: 1 } },
      text: rows.map((s) => `${s.LapsInStint} laps`),
      hovertemplate: `%{y}: ${comp} — %{text}<extra></extra>`,
    };
  });
  Plotly.newPlot("stintChart", stintTraces, {
    ...CHART_CHROME,
    barmode: "overlay",
    xaxis: { ...CHART_CHROME.xaxis, title: "Lap" },
    yaxis: { ...CHART_CHROME.yaxis, type: "category", categoryorder: "array", categoryarray: [...ranked].reverse() },
  }, PLOTLY_CONFIG);

  // Degradation
  const compounds = [...new Set(d.degradation.map((r) => r.Compound))];
  const degTraces = compounds.map((comp) => {
    const rows = d.degradation.filter((r) => r.Compound === comp).sort((a, b) => a.StintLap - b.StintLap);
    return {
      type: "scatter",
      mode: "lines+markers",
      name: comp,
      x: rows.map((r) => r.StintLap),
      y: rows.map((r) => r.LapTimeSeconds),
      line: { color: d.compoundColors[comp] || "#999", width: 2 },
      marker: { color: d.compoundColors[comp] || "#999", size: 6 },
      hovertemplate: `${comp} lap %{x}: %{y:.2f}s<extra></extra>`,
    };
  });
  Plotly.newPlot("degradationChart", degTraces, {
    ...CHART_CHROME,
    xaxis: { ...CHART_CHROME.xaxis, title: "Tyre Age (laps)" },
    yaxis: { ...CHART_CHROME.yaxis, title: "Avg Lap Time (s)" },
  }, PLOTLY_CONFIG);

  // Compound performance
  const compTraces = compounds.map((comp) => {
    const rows = ranked.map((code) => {
      const r = d.compoundPerformance.find((x) => x.Driver === code && x.Compound === comp);
      return r ? r.LapTimeSeconds : null;
    });
    return { type: "bar", name: comp, x: ranked, y: rows, marker: { color: d.compoundColors[comp] || "#999" }, hovertemplate: `%{x}: ${comp} — %{y:.2f}s<extra></extra>` };
  });
  Plotly.newPlot("compoundChart", compTraces, {
    ...CHART_CHROME,
    barmode: "group",
    xaxis: { ...CHART_CHROME.xaxis, type: "category", categoryorder: "array", categoryarray: ranked },
    yaxis: { ...CHART_CHROME.yaxis, title: "Avg Lap Time (s)" },
  }, PLOTLY_CONFIG);

  // Pit duration (median bar + range)
  const pitByDriver = {};
  for (const p of d.pitDurations) {
    if (!active.includes(p.Driver)) continue;
    (pitByDriver[p.Driver] = pitByDriver[p.Driver] || []).push(p.PitDurationSec);
  }
  const pitDrivers = ranked.filter((c) => pitByDriver[c]);
  const medians = pitDrivers.map((c) => {
    const arr = [...pitByDriver[c]].sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  });
  Plotly.newPlot(
    "pitDurationChart",
    [
      {
        type: "bar",
        x: pitDrivers,
        y: medians,
        marker: { color: pitDrivers.map((c) => state.dashMap[c].color) },
        error_y: {
          type: "data",
          symmetric: false,
          array: pitDrivers.map((c, i) => Math.max(...pitByDriver[c]) - medians[i]),
          arrayminus: pitDrivers.map((c, i) => medians[i] - Math.min(...pitByDriver[c])),
          color: "#898781",
        },
        text: medians.map((m) => `${m.toFixed(1)}s`),
        textposition: "outside",
        hovertemplate: "%{x}: %{y:.1f}s median<extra></extra>",
      },
    ],
    { ...CHART_CHROME, showlegend: false, xaxis: { ...CHART_CHROME.xaxis, type: "category", categoryorder: "array", categoryarray: pitDrivers }, yaxis: { ...CHART_CHROME.yaxis, title: "Pit Duration (s)" } },
    PLOTLY_CONFIG
  );

  // Pit markers on lap times. This chart intentionally includes every lap
  // (unlike Lap Time Progression, which drops pit laps), because it needs
  // pit in/out laps on-scale to mark them. But a Safety Car / red flag lap
  // is also slow and NOT a pit stop, and can be far slower than any real
  // pit-affected lap (e.g. 145s vs ~110s) - left uncapped, that one outlier
  // stretches the axis so much the actual pit-stop bumps this chart exists
  // to show get compressed into an unreadable sliver. Cap the y-range to
  // comfortably fit every real pit lap (so pit markers are never clipped)
  // and let anything slower than that run off the top of the chart instead
  // of flattening everything else.
  const pitTraces = [];
  const allLapTimes = [];
  const allPitLapTimes = [];
  for (const code of active) {
    const laps = d.lapsByDriver[code].filter((l) => l.LapTimeSeconds != null);
    const m = state.dashMap[code];
    pitTraces.push({
      type: "scatter", mode: "lines", name: code,
      x: laps.map((l) => l.LapNumber), y: laps.map((l) => l.LapTimeSeconds),
      line: { color: m.color, dash: m.dash, width: 1.5 }, opacity: 0.7,
      hovertemplate: `${code}: %{y:.3f}s (lap %{x})<extra></extra>`,
    });
    const pits = laps.filter((l) => l.is_pitlap);
    pitTraces.push({
      type: "scatter", mode: "markers", name: `${code} pit`, showlegend: false,
      x: pits.map((l) => l.LapNumber), y: pits.map((l) => l.LapTimeSeconds),
      marker: { color: m.color, symbol: "x", size: 11, line: { width: 2, color: "#0d0d0d" } },
      hovertemplate: `${code} PIT (lap %{x})<extra></extra>`,
    });
    laps.forEach((l) => allLapTimes.push(l.LapTimeSeconds));
    pits.forEach((l) => allPitLapTimes.push(l.LapTimeSeconds));
  }
  const yMin = allLapTimes.length ? Math.min(...allLapTimes) * 0.97 : undefined;
  const yMax = allPitLapTimes.length
    ? Math.max(...allPitLapTimes) * 1.15
    : allLapTimes.length
    ? Math.max(...allLapTimes) * 1.05
    : undefined;
  Plotly.newPlot("pitMarkerChart", pitTraces, {
    ...CHART_CHROME,
    xaxis: { ...CHART_CHROME.xaxis, title: "Lap" },
    yaxis: { ...CHART_CHROME.yaxis, title: "Lap Time (s)", range: yMin != null ? [yMin, yMax] : undefined, autorange: yMin == null },
  }, PLOTLY_CONFIG);
}

/* ---------- Gaps & position ---------- */
function renderGapsPosition() {
  const d = state.analysis;
  const active = activeList();
  const scrub = state.scrubLap || state.maxLap;
  const xRange = [1, state.maxLap];

  const allGaps = active.flatMap((code) => (d.gapToLeaderByDriver[code] || []).map((r) => r.GapToLeader)).filter((v) => v != null);
  const gapPad = allGaps.length ? (Math.max(...allGaps) - Math.min(0, ...allGaps)) * 0.08 + 0.5 : 1;
  const gapRange = allGaps.length ? [Math.min(0, ...allGaps) - gapPad, Math.max(...allGaps) + gapPad] : undefined;

  const gapTraces = active.map((code) => {
    const rows = (d.gapToLeaderByDriver[code] || []).filter((r) => r.GapToLeader != null && r.LapNumber <= scrub);
    const m = state.dashMap[code];
    return {
      type: "scatter", mode: "lines+markers", name: code,
      x: rows.map((r) => r.LapNumber), y: rows.map((r) => r.GapToLeader),
      line: { color: m.color, dash: m.dash, width: 2 }, marker: { color: m.color, symbol: m.symbol, size: 5 },
      hovertemplate: `${code}: %{y:.2f}s (lap %{x})<extra></extra>`,
    };
  });
  Plotly.newPlot("gapChart", gapTraces, {
    ...CHART_CHROME,
    xaxis: { ...CHART_CHROME.xaxis, title: "Lap", range: xRange, autorange: false },
    yaxis: { ...CHART_CHROME.yaxis, title: "Gap to Leader (s)", zeroline: true, range: gapRange, autorange: !gapRange },
    shapes: [{ type: "line", x0: 0, x1: 1, xref: "paper", y0: 0, y1: 0, line: { color: "#383835", dash: "dash" } }],
    hovermode: "x unified",
  }, PLOTLY_CONFIG);

  const hasPosition = active.some((c) => (d.positionByDriver[c] || []).length);
  if (hasPosition) {
    const posTraces = active.map((code) => {
      const rows = (d.positionByDriver[code] || []).filter((r) => r.LapNumber <= scrub);
      const m = state.dashMap[code];
      return {
        type: "scatter", mode: "lines+markers", name: code,
        x: rows.map((r) => r.LapNumber), y: rows.map((r) => r.Position),
        line: { color: m.color, dash: m.dash, width: 2 }, marker: { color: m.color, symbol: m.symbol, size: 5 },
        hovertemplate: `${code}: P%{y} (lap %{x})<extra></extra>`,
      };
    });
    // P1 should read at the TOP of the chart, like a leaderboard.
    Plotly.newPlot("positionChart", posTraces, {
      ...CHART_CHROME,
      xaxis: { ...CHART_CHROME.xaxis, title: "Lap", range: xRange, autorange: false },
      yaxis: { ...CHART_CHROME.yaxis, title: "Position", autorange: "reversed", dtick: 1 },
      hovermode: "x unified",
    }, PLOTLY_CONFIG);
  } else {
    Plotly.purge("positionChart");
  }
}

function toggleScrubPlayback() {
  const btn = document.getElementById("scrubPlayBtn");
  if (state.scrubTimer) {
    stopScrubPlayback();
    return;
  }
  if (state.scrubLap >= state.maxLap) {
    state.scrubLap = 1;
  }
  btn.innerHTML = "&#10074;&#10074; Pause";
  state.scrubTimer = setInterval(() => {
    state.scrubLap += 1;
    if (state.scrubLap >= state.maxLap) {
      state.scrubLap = state.maxLap;
      stopScrubPlayback();
    }
    document.getElementById("scrubSlider").value = state.scrubLap;
    document.getElementById("scrubLabel").textContent = `Lap ${state.scrubLap}`;
    renderGapsPosition();
  }, 200);
}

function stopScrubPlayback() {
  if (state.scrubTimer) {
    clearInterval(state.scrubTimer);
    state.scrubTimer = null;
  }
  const btn = document.getElementById("scrubPlayBtn");
  if (btn) btn.innerHTML = "&#9654; Play";
}

/* ---------- Sectors ---------- */
function renderSectors() {
  const d = state.analysis;
  if (!d.sectorAverages || !d.sectorAverages.length) {
    Plotly.purge("sectorChart");
    return;
  }
  const ranked = rankedActiveList();
  const sectors = ["Sector1Time", "Sector2Time", "Sector3Time"];
  const traces = sectors.map((sec, i) => ({
    type: "bar",
    name: `Sector ${i + 1}`,
    x: ranked,
    y: ranked.map((code) => {
      const r = d.sectorAverages.find((x) => x.Driver === code);
      return r ? r[sec] : null;
    }),
    marker: { color: SECTOR_COLORS[i] },
  }));
  Plotly.newPlot("sectorChart", traces, {
    ...CHART_CHROME,
    barmode: "group",
    xaxis: { ...CHART_CHROME.xaxis, type: "category", categoryorder: "array", categoryarray: ranked },
    yaxis: { ...CHART_CHROME.yaxis, title: "Avg Sector Time (s)" },
  }, PLOTLY_CONFIG);
}

/* ---------- Weather ---------- */
function renderWeather() {
  const d = state.analysis;
  const w = d.weather;
  const tiles = w
    ? [
        { label: "Air Temp", value: `${fmtNum(w.AirTempAvg)}°C` },
        { label: "Track Temp", value: `${fmtNum(w.TrackTempAvg)}°C` },
        { label: "Humidity", value: `${fmtNum(w.Humidity)}%` },
        { label: "Wind Speed", value: `${fmtNum(w.WindSpeedAvg)} m/s` },
        { label: "Rainfall", value: w.Rainfall ? "Yes" : "No" },
      ]
    : [];
  document.getElementById("weatherTiles").innerHTML = tiles
    .map((t) => `<div class="stat-tile"><div class="label">${t.label}</div><div class="value">${t.value}</div></div>`)
    .join("");

  if (!w || !w.series || !w.series.length) {
    Plotly.purge("weatherChart");
    return;
  }
  const t = w.series.map((r) => r.Time / 60);
  Plotly.newPlot(
    "weatherChart",
    [
      { type: "scatter", mode: "lines", name: "Air Temp", x: t, y: w.series.map((r) => r.AirTemp), line: { color: WEATHER_COLORS.air, width: 2 }, hovertemplate: "Air %{y:.1f}°C<extra></extra>" },
      { type: "scatter", mode: "lines", name: "Track Temp", x: t, y: w.series.map((r) => r.TrackTemp), line: { color: WEATHER_COLORS.track, width: 2 }, hovertemplate: "Track %{y:.1f}°C<extra></extra>" },
    ],
    { ...CHART_CHROME, xaxis: { ...CHART_CHROME.xaxis, title: "Session Time (min)" }, yaxis: { ...CHART_CHROME.yaxis, title: "°C" }, hovermode: "x unified" },
    PLOTLY_CONFIG
  );
}

/* ---------- Telemetry ---------- */
function renderTelemetryPicker() {
  const picker = document.getElementById("telemetryPicker");
  picker.innerHTML = "";
  for (const code of state.analysis.meta.drivers) {
    const m = state.dashMap[code];
    const chip = document.createElement("div");
    chip.className = "driver-chip" + (state.telemetrySelected.includes(code) ? " selected" : "");
    chip.style.borderColor = m.color;
    chip.innerHTML = `<span class="dot" style="background:${m.color}"></span>${code}`;
    chip.addEventListener("click", () => {
      const idx = state.telemetrySelected.indexOf(code);
      if (idx >= 0) {
        state.telemetrySelected.splice(idx, 1);
      } else {
        if (state.telemetrySelected.length >= 3) state.telemetrySelected.shift();
        state.telemetrySelected.push(code);
      }
      renderTelemetryPicker();
    });
    picker.appendChild(chip);
  }
}

async function loadTelemetry() {
  if (!state.telemetrySelected.length) return;
  const statusEl = document.getElementById("telemetryStatus");
  const btn = document.getElementById("loadTelemetryBtn");
  btn.disabled = true;
  state.telemetryData = {};
  for (const code of state.telemetrySelected) {
    statusEl.textContent = `Downloading telemetry for ${code}…`;
    try {
      const data = await getJSON(
        `${API}/api/telemetry?year=${state.year}&event=${encodeURIComponent(state.event)}&session=${state.session}&driver=${code}&lap=fastest`
      );
      state.telemetryData[code] = data;
    } catch (err) {
      statusEl.textContent = `Failed to load telemetry for ${code}: ${err.message}`;
    }
  }
  statusEl.textContent = `Loaded telemetry for ${Object.keys(state.telemetryData).join(", ")}.`;
  btn.disabled = false;
  renderTelemetryCharts();
}

function renderTelemetryCharts() {
  const codes = Object.keys(state.telemetryData);
  if (!codes.length) return;

  const speedTraces = codes.map((code) => {
    const m = state.dashMap[code];
    const tel = state.telemetryData[code].telemetry;
    return {
      type: "scatter", mode: "lines", name: `${code} (${fmtLapTime(state.telemetryData[code].lapTimeSeconds)})`,
      x: tel.map((p) => p.Distance), y: tel.map((p) => p.Speed),
      line: { color: m.color, dash: m.dash, width: 2 },
      hovertemplate: `${code}: %{y:.0f} km/h<extra></extra>`,
    };
  });
  Plotly.newPlot("speedChart", speedTraces, {
    ...CHART_CHROME,
    xaxis: { ...CHART_CHROME.xaxis, title: "Distance (m)" },
    yaxis: { ...CHART_CHROME.yaxis, title: "Speed (km/h)" },
    hovermode: "x unified",
  }, PLOTLY_CONFIG);

  // Throttle & brake: one row per driver
  const n = codes.length;
  const gap = 0.06;
  const rowHeight = (1 - gap * (n - 1)) / n;
  const traces = [];
  const layout = { ...CHART_CHROME, showlegend: false, margin: { t: 20, r: 20, b: 40, l: 50 } };
  codes.forEach((code, i) => {
    const m = state.dashMap[code];
    const tel = state.telemetryData[code].telemetry;
    const top = 1 - i * (rowHeight + gap);
    const bottom = top - rowHeight;
    const xKey = i === 0 ? "x" : `x${i + 1}`;
    const yKey = i === 0 ? "y" : `y${i + 1}`;
    const xAxisKey = i === 0 ? "xaxis" : `xaxis${i + 1}`;
    const yAxisKey = i === 0 ? "yaxis" : `yaxis${i + 1}`;
    layout[xAxisKey] = { ...CHART_CHROME.xaxis, domain: [0, 1], anchor: yKey, title: i === n - 1 ? "Distance (m)" : "" };
    layout[yAxisKey] = { ...CHART_CHROME.yaxis, domain: [bottom, top], anchor: xKey, title: `${code} %`, range: [-5, 105] };
    traces.push({
      type: "scatter", mode: "lines", name: `${code} Throttle`, xaxis: xKey, yaxis: yKey,
      x: tel.map((p) => p.Distance), y: tel.map((p) => p.Throttle),
      line: { color: m.color, width: 1.5 },
      hovertemplate: "Throttle %{y:.0f}%<extra></extra>",
    });
    traces.push({
      type: "scatter", mode: "lines", name: `${code} Brake`, xaxis: xKey, yaxis: yKey,
      x: tel.map((p) => p.Distance), y: tel.map((p) => (p.Brake ? 100 : 0)),
      line: { color: "#d03b3b", width: 1.5 }, fill: "tozeroy", fillcolor: "rgba(208,59,59,0.15)",
      hovertemplate: "Brake %{y:.0f}%<extra></extra>",
    });
  });
  Plotly.newPlot("throttleBrakeChart", traces, layout, PLOTLY_CONFIG);
}

/* ---------- Track Map & Head-to-Head selectors ---------- */
function renderTrackAndH2HSelectors() {
  const drivers = state.analysis.meta.drivers;
  const optionHtml = drivers.map((c) => `<option value="${c}">${c}</option>`).join("");

  const trackSelect = document.getElementById("trackDriverSelect");
  trackSelect.innerHTML = optionHtml;
  trackSelect.value = drivers[0];

  const d1 = document.getElementById("h2hDriver1");
  const d2 = document.getElementById("h2hDriver2");
  d1.innerHTML = optionHtml;
  d2.innerHTML = optionHtml;
  d1.value = drivers[0];
  d2.value = drivers.length > 1 ? drivers[1] : drivers[0];

  state.trackMapData = null;
  state.h2hData = null;
  Plotly.purge("trackMapChart");
  Plotly.purge("deltaChart");
  Plotly.purge("h2hSpeedChart");
  document.getElementById("trackMapStatus").textContent = "";
  document.getElementById("h2hStatus").textContent = "";
}

/* ---------- Track Map ---------- */
async function loadTrackMap() {
  const driver = document.getElementById("trackDriverSelect").value;
  const statusEl = document.getElementById("trackMapStatus");
  const btn = document.getElementById("loadTrackMapBtn");
  btn.disabled = true;
  statusEl.textContent = `Loading track map for ${driver}'s fastest lap…`;
  try {
    const data = await getJSON(
      `${API}/api/trackmap?year=${state.year}&event=${encodeURIComponent(state.event)}&session=${state.session}&driver=${driver}&lap=fastest`
    );
    state.trackMapData = data;
    statusEl.textContent = `${driver} — lap ${Math.round(data.lapNumber)}, ${fmtLapTime(data.lapTimeSeconds)} (${data.compound || "?"})`;
    renderTrackMapChart();
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function renderTrackMapChart() {
  const data = state.trackMapData;
  if (!data) return;
  const pts = data.points;
  const mode = state.trackColorMode;

  const trace = {
    type: "scattergl",
    mode: "markers",
    x: pts.map((p) => p.x),
    y: pts.map((p) => p.y),
    marker:
      mode === "speed"
        ? {
            color: pts.map((p) => p.speed),
            colorscale: "Viridis",
            size: 6,
            colorbar: { title: "km/h", titlefont: { color: "#c3c2b7" }, tickfont: { color: "#c3c2b7" }, outlinewidth: 0 },
          }
        : { color: pts.map((p) => GEAR_COLORS[Math.min((p.gear || 1) - 1, GEAR_COLORS.length - 1)]), size: 6 },
    text: pts.map((p) => (mode === "speed" ? `${Math.round(p.speed)} km/h` : `Gear ${p.gear}`)),
    hovertemplate: "%{text}<extra></extra>",
    showlegend: false,
  };

  const annotations = data.corners.map((c) => ({
    x: c.labelX,
    y: c.labelY,
    text: c.number,
    showarrow: false,
    font: { color: "#898781", size: 10, family: "Titillium Web, sans-serif" },
  }));
  const cornerDots = {
    type: "scatter",
    mode: "markers",
    x: data.corners.map((c) => c.x),
    y: data.corners.map((c) => c.y),
    marker: { color: "#52514e", size: 5, symbol: "circle-open" },
    hoverinfo: "skip",
    showlegend: false,
  };

  const traces = [trace, cornerDots];
  const legendTraces =
    mode === "gear"
      ? [1, 2, 3, 4, 5, 6, 7, 8].map((g) => ({
          type: "scatter", mode: "markers", x: [null], y: [null], name: `Gear ${g}`,
          marker: { color: GEAR_COLORS[g - 1], size: 9 }, showlegend: true,
        }))
      : [];

  Plotly.newPlot(
    "trackMapChart",
    [...traces, ...legendTraces],
    {
      ...CHART_CHROME,
      xaxis: { visible: false, scaleanchor: "y", scaleratio: 1 },
      yaxis: { visible: false },
      annotations,
      showlegend: mode === "gear",
      margin: { t: 10, r: 10, b: 10, l: 10 },
    },
    PLOTLY_CONFIG
  );
}

/* ---------- Head-to-Head ---------- */
async function loadHeadToHead() {
  const driver1 = document.getElementById("h2hDriver1").value;
  const driver2 = document.getElementById("h2hDriver2").value;
  const statusEl = document.getElementById("h2hStatus");
  if (driver1 === driver2) {
    statusEl.textContent = "Pick two different drivers.";
    return;
  }
  const btn = document.getElementById("loadH2HBtn");
  btn.disabled = true;
  statusEl.textContent = `Comparing ${driver1} vs ${driver2}…`;
  try {
    const data = await getJSON(
      `${API}/api/delta?year=${state.year}&event=${encodeURIComponent(state.event)}&session=${state.session}&driver1=${driver1}&driver2=${driver2}`
    );
    state.h2hData = data;
    statusEl.textContent = `${driver1} lap ${Math.round(data.reference.lapNumber)} (${fmtLapTime(data.reference.lapTimeSeconds)}) vs ${driver2} lap ${Math.round(data.compare.lapNumber)} (${fmtLapTime(data.compare.lapTimeSeconds)})`;
    renderHeadToHeadCharts();
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function renderHeadToHeadCharts() {
  const data = state.h2hData;
  if (!data) return;
  const refCode = data.reference.driver;
  const cmpCode = data.compare.driver;
  const refColor = (state.dashMap[refCode] || {}).color || "#3987e5";
  const cmpColor = (state.dashMap[cmpCode] || {}).color || "#e66767";

  const dist = data.delta.map((r) => r.distance);
  const deltaPos = data.delta.map((r) => Math.max(r.delta, 0)); // reference ahead
  const deltaNeg = data.delta.map((r) => Math.min(r.delta, 0)); // compare ahead

  Plotly.newPlot(
    "deltaChart",
    [
      {
        type: "scatter", mode: "none", x: dist, y: deltaPos, fill: "tozeroy",
        fillcolor: refColor + "55", name: `${refCode} ahead`,
        hoverinfo: "skip",
      },
      {
        type: "scatter", mode: "none", x: dist, y: deltaNeg, fill: "tozeroy",
        fillcolor: cmpColor + "55", name: `${cmpCode} ahead`,
        hoverinfo: "skip",
      },
      {
        type: "scatter", mode: "lines", x: dist, y: data.delta.map((r) => r.delta),
        line: { color: "#ffffff", width: 1.5 }, name: "Delta",
        hovertemplate: "%{y:.3f}s at %{x:.0f}m<extra></extra>",
      },
    ],
    {
      ...CHART_CHROME,
      xaxis: { ...CHART_CHROME.xaxis, title: "Distance (m)" },
      yaxis: { ...CHART_CHROME.yaxis, title: `← ${cmpCode} ahead   |   ${refCode} ahead →` },
      hovermode: "x",
    },
    PLOTLY_CONFIG
  );

  Plotly.newPlot(
    "h2hSpeedChart",
    [
      {
        type: "scatter", mode: "lines", name: refCode,
        x: dist, y: data.delta.map((r) => r.refSpeed),
        line: { color: refColor, width: 2 },
        hovertemplate: `${refCode}: %{y:.0f} km/h<extra></extra>`,
      },
      {
        type: "scatter", mode: "lines", name: cmpCode,
        x: data.compareSpeed.map((r) => r.distance), y: data.compareSpeed.map((r) => r.speed),
        line: { color: cmpColor, width: 2 },
        hovertemplate: `${cmpCode}: %{y:.0f} km/h<extra></extra>`,
      },
    ],
    {
      ...CHART_CHROME,
      xaxis: { ...CHART_CHROME.xaxis, title: "Distance (m)" },
      yaxis: { ...CHART_CHROME.yaxis, title: "Speed (km/h)" },
      hovermode: "x unified",
    },
    PLOTLY_CONFIG
  );
}
