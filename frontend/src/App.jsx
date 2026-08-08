/*
 * E!BA Dashboard — single-file SPA (by design until >=5 real
 * content tabs justify a split; see docs/DECISION.md).
 *
 * Auth shell -> group/sub-tab nav (state in React + sessionStorage, no router)
 * -> one component per tab, each fetching its /api/* endpoint through useApi,
 * which always sends the JWT + the X-EBA-Client header. Charts via recharts.
 * Inline styles only — no CSS framework.
 */

import { createContext, Fragment, isValidElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, ComposedChart, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, Cell, LabelList,
} from "recharts";
import { DEMO, DEMO_FILTERS } from "./demoData";

// ─── Config ─────────────────────────────────────────────────────────────────
const API_BASE = import.meta.env.VITE_API_URL || "https://eba-dashboard-api.educateapps.work";
const CLIENT_TOKEN = import.meta.env.VITE_CLIENT_TOKEN || "eba-dashboard-v1";
const CLIENT_HEADER = { "X-EBA-Client": CLIENT_TOKEN };
const TOKEN_KEY = "eba_token";

// True whenever the dashboard is showing bundled demo data instead of live
// BigQuery results. Set at the root from the /api/filters probe; read by Card to
// badge every panel. See docs/DECISION.md ADR-008.
const DemoContext = createContext(false);

// ─── Palette (from the prototype) ─────────────────────────────────────────────
const C = {
  ink: "#0F2238", inkSoft: "#1C3A56", gold: "#D9A441", cream: "#F7F4ED",
  teal: "#2E6E73", coral: "#C7634A", green: "#4C7A52", line: "#E3DDCC",
  text: "#241F18", muted: "#6B6358", white: "#ffffff",
};
const CHART_COLORS = [C.teal, C.gold, C.coral, C.green, C.inkSoft, C.muted];

// ─── Token helpers ────────────────────────────────────────────────────────────
function getToken() { return sessionStorage.getItem(TOKEN_KEY); }
function saveToken(t) { sessionStorage.setItem(TOKEN_KEY, t); }
function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }

// Google OAuth callback lands on FRONTEND_URL/#token=<jwt>. Read it, store it,
// then strip the fragment so the token isn't left in the address bar.
function consumeOAuthHash() {
  const h = window.location.hash;
  if (h && h.startsWith("#token=")) {
    const t = h.slice("#token=".length);
    saveToken(t);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return t;
  }
  return null;
}

function logout() { clearToken(); window.location.reload(); }

// ─── Filter -> query string ─────────────────────────────────────────────────────
function buildParams(filters) {
  const p = new URLSearchParams();
  if (filters.district) p.append("district", filters.district);
  if (filters.gender) p.append("gender", filters.gender);
  if (filters.cohort) p.append("cohort", filters.cohort);
  const s = p.toString();
  return s ? `?${s}` : "";
}

// Same as buildParams, but overriding specific filter keys — for panels that
// need a forced gender split (e.g. a Female/Male breakdown chart) regardless
// of the global filter bar's current gender selection.
function buildParamsOverride(filters, overrides) {
  return buildParams({ ...filters, ...overrides });
}

// Appends an endpoint-specific date_from/date_to on top of buildParams(filters)
// — kept separate from buildParams itself since date_from/date_to are only
// meaningful to the handful of endpoints that actually accept them (Milestones,
// Mobilisation), not every /api/* call the global filter bar's fields feed.
function withDateRange(filters, dateFrom, dateTo) {
  const base = buildParams(filters);
  const extra = [];
  if (dateFrom) extra.push(`date_from=${encodeURIComponent(dateFrom)}`);
  if (dateTo) extra.push(`date_to=${encodeURIComponent(dateTo)}`);
  if (!extra.length) return base;
  return base ? `${base}&${extra.join("&")}` : `?${extra.join("&")}`;
}

function sumBy(rows, key) {
  return (rows || []).reduce((s, r) => s + (Number(r[key]) || 0), 0);
}

// One-shot fetch for on-demand loads (e.g. a drill panel's per-district
// queries fired on click) where a `useApi()` hook's mount-time auto-fetch
// doesn't apply. No demo-data fallback — a drill that can't reach the API
// surfaces its error in the panel rather than silently showing dummy rows.
function apiGet(endpoint) {
  return fetch(`${API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${getToken()}`, ...CLIENT_HEADER },
  }).then((res) => {
    if (res.status === 401) { logout(); throw new Error("Session expired"); }
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  });
}

// ─── Data hook ──────────────────────────────────────────────────────────────────
// Module-level — survives a component unmount/remount, which is what
// switching tabs actually does here (pages are conditionally rendered with
// `{page === "x" && <Page/>}`, not kept alive off-screen). Without this, every
// tab switch re-triggered a full fetch even when the data was seconds old.
// 15 minutes matches the backend's own proactive cache warm-up (see
// app/core/warmup.py) — a cache miss here usually still lands on an
// already-warm backend cache rather than a cold multi-query BigQuery wait.
const CLIENT_CACHE_TTL_MS = 15 * 60 * 1000;
const _apiCache = new Map(); // endpoint -> { data, isDemo, timestamp }

// `pollMs` is opt-in (undefined for every existing caller — identical
// behavior to before) — pass it for a page that should keep itself current
// against live BigQuery without a manual reload (e.g. Call Centre Insights,
// whose free-text classification re-runs over whatever rows exist right
// now). A poll refresh is silent — no loading spinner, no error card on a
// transient failure — so it never disrupts someone actively reading the
// page; only a successful poll replaces the shown data. The same "silent"
// path also backs cache revalidation below — a stale-but-present cache entry
// shows instantly while a background fetch quietly brings it current.
function useApi(endpoint, { pollMs } = {}) {
  const cached = _apiCache.get(endpoint);
  const [data, setData] = useState(cached?.data ?? null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!cached);
  const [isDemo, setIsDemo] = useState(cached?.isDemo ?? false);

  useEffect(() => {
    let alive = true;
    let intervalId;

    function load(background) {
      // Resetting load/error state at the start of a (re)fetch is the intended
      // React<->network sync point — done from a plain function called out of
      // the effect, not the effect body itself, so the strict rule doesn't
      // flag it here the way it did with this logic inline.
      if (!background) {
        setLoading(true);
        setError(null);
        setIsDemo(false);
      }
      const token = getToken();
      fetch(`${API_BASE}${endpoint}`, {
        headers: { Authorization: `Bearer ${token}`, ...CLIENT_HEADER },
      })
        .then((res) => {
          if (res.status === 401) { logout(); return null; }
          if (!res.ok) { const err = new Error(`API ${res.status}`); err.status = res.status; throw err; }
          return res.json();
        })
        .then((json) => {
          if (alive && json !== null) {
            setData(json);
            setIsDemo(false);
            _apiCache.set(endpoint, { data: json, isDemo: false, timestamp: Date.now() });
          }
        })
        .catch((e) => {
          if (!alive || background) return;
          // "Not connected to live data" cases — a 503 (upstream BigQuery table
          // missing, i.e. the BC5 feed isn't live) or an unreachable API — fall
          // back to bundled demo data so the panel still shows how it will look.
          // A genuine server error (500, etc.) still surfaces as an error card.
          // Demo fallback is intentionally NOT cached — keep retrying on the
          // next mount/poll so it self-heals the moment the backend recovers.
          const demo = DEMO[endpoint.split("?")[0]];
          const disconnected = e.status === 503 || e.status === undefined;
          if (demo && disconnected) { setData(demo); setIsDemo(true); }
          else { setError(e.message); }
        })
        .finally(() => { if (alive && !background) setLoading(false); });
    }

    const entry = _apiCache.get(endpoint);
    const fresh = entry && (Date.now() - entry.timestamp < CLIENT_CACHE_TTL_MS);
    if (entry) {
      // Show cached data immediately, no spinner — a tab switch should never
      // feel like a fresh page load. The `useState(cached?.data ?? null)`
      // initializer above already covers first mount; this covers `endpoint`
      // changing (e.g. a filter change) while the component stays mounted,
      // which re-runs this effect but not the state initializers — same
      // intended React<->cache sync point as `load`'s state resets below.
      /* eslint-disable react-hooks/set-state-in-effect */
      setData(entry.data);
      setIsDemo(entry.isDemo);
      setError(null);
      setLoading(false);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
    if (!fresh) load(!!entry); // stale-while-revalidate when entry exists; normal foreground load otherwise

    if (pollMs) intervalId = setInterval(() => load(true), pollMs);
    return () => { alive = false; if (intervalId) clearInterval(intervalId); };
  }, [endpoint, pollMs]);

  return { data, error, loading, isDemo };
}

// ─── Presentational primitives ─────────────────────────────────────────────────
// Chip tones match the reference design's .chip.real/.chip.sim pill badges —
// "real" (green) for live-BigQuery panels, "sim" (coral) for anything not yet
// backed by real data. PII is a separate concern (masking), not a tone, but
// reuses the pill shape.
const CHIP_TONE = {
  real: { bg: "#E4EEE3", color: C.green },
  sim:  { bg: "#F5E2DA", color: C.coral },
  pii:  { bg: C.line, color: C.text },
};
function Chip({ children, tone = "real" }) {
  const t = CHIP_TONE[tone] || CHIP_TONE.real;
  return (
    <span style={{ background: t.bg, color: t.color, fontSize: 10, fontWeight: 700, letterSpacing: 0.4, padding: "3px 9px", borderRadius: 10, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

// CSS-grid card row — matches the reference's .grid/.grid.g3/.grid.g2 (4/3/2
// equal columns, collapsing to 2 under 900px).
function Grid({ cols = 4, children }) {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth <= 900);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const effectiveCols = narrow ? Math.min(cols, 2) : cols;
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${effectiveCols}, 1fr)`, gap: 14, marginBottom: 20 }}>
      {children}
    </div>
  );
}

function Card({ title, subtitle, children, chip, chipTone = "real" }) {
  const demo = useContext(DemoContext);
  return (
    <div style={{ background: C.white, border: `1px solid ${C.line}`, borderRadius: 6, padding: 20, marginBottom: 20 }}>
      {(title || chip || demo) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <div>
            {title && <h3 style={{ fontSize: 17, color: C.ink, fontWeight: 600 }}>{title}</h3>}
            {subtitle && <p style={{ fontSize: 12, color: C.muted, marginTop: 3, maxWidth: 560 }}>{subtitle}</p>}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
            {demo && <Chip tone="sim">Demo data</Chip>}
            {chip && <Chip tone={chipTone}>{chip}</Chip>}
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

// Matches the reference's .card KPI tile: compact padding, a colored top
// border + tiny corner tag as the real/sample data-provenance signal.
// onClick, when given, makes the tile a drill trigger — matches the reference
// design's "hover and you'll see a click-to-drill cue" convention.
//
// The border follows RAG, not just data-provenance, whenever `value` is
// already a color-coded `<span style={{color: X}}>...</span>` — the
// established pattern every rate-vs-target tile already uses (rateColor,
// categorizeRate+RATE_CATEGORY_COLOR, femaleShareStatus, callReachColor).
// Picking that color up here means every such tile gets a matching border
// for free, with no per-call-site change — a tile with no target (a plain
// count) has no colored span, so it falls back to the tone-based green/coral
// provenance color exactly as before.
// Recurses into Fragments/children (not just the top-level element) since a
// few tiles mix a colored span with plain trailing text — e.g. "Confirmed
// female"'s sub is `<>{coloredSpan} of confirmed · target 60%</>`, a
// Fragment whose own style is never set.
function kpiTileColorOf(node) {
  if (!isValidElement(node)) return undefined;
  if (node.props?.style?.color) return node.props.style.color;
  const kids = node.props?.children;
  for (const child of Array.isArray(kids) ? kids : [kids]) {
    const found = kpiTileColorOf(child);
    if (found) return found;
  }
  return undefined;
}
function KpiTile({ label, value, sub, tone = "real", tag, onClick, hint }) {
  const t = CHIP_TONE[tone] || CHIP_TONE.real;
  // `sub` fallback covers tiles where the headline value is a plain count and
  // the RAG-evaluated rate lives in the caption instead (e.g. "Confirmed
  // female" — the count itself has no target, only its % of total does).
  const ragColor = kpiTileColorOf(value) || kpiTileColorOf(sub);
  const border = ragColor || t.color;
  return (
    <div onClick={onClick} style={{ background: C.white, border: `1px solid ${C.line}`, borderRadius: 6, padding: "11px 13px 10px", borderTop: `3px solid ${border}`, position: "relative", cursor: onClick ? "pointer" : undefined }}>
      {tag && <span style={{ position: "absolute", top: 8, right: 9, fontSize: 8, fontWeight: 700, letterSpacing: 0.4, color: t.color }}>{tag}</span>}
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: C.ink, lineHeight: 1.1 }}>{value ?? "—"}{onClick && !hint && <span style={{ fontSize: 12, color: C.muted, marginLeft: 6 }}>›</span>}</div>
      {sub && <div style={{ fontSize: 10.5, color: C.muted, marginTop: 3, lineHeight: 1.35 }}>{sub}</div>}
      {/* Matches the reference prototype's .drill-hint — an explicit
          "View youth ⌄" line, distinct from the generic "›" chevron every
          other clickable tile uses. */}
      {hint && <div style={{ fontSize: 11, color: C.teal, fontWeight: 700, marginTop: 8 }}>{hint} ⌄</div>}
    </div>
  );
}

function State({ loading, error, empty, children }) {
  if (loading) return <div style={{ padding: 40, textAlign: "center", color: C.muted }}>Loading…</div>;
  if (error) return (
    <div style={{ padding: 24, background: "#FBEDEA", border: `1px solid ${C.coral}`, borderRadius: 8, color: C.coral, fontSize: 13 }}>
      Data unavailable — {error}. The BC5 BigQuery feed may not be live yet (see docs/CONTEXT.md).
    </div>
  );
  if (empty) return <div style={{ padding: 40, textAlign: "center", color: C.muted }}>No data for the current filters.</div>;
  return children;
}

// Second-level page nav inside a tab that has multiple sub-pages (e.g.
// Awareness's Awareness Overview / Mobilisers / KYC / Forecast) — matches the
// reference design's .pbtn pill buttons.
function PageNav({ pages, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
      {pages.map((p) => {
        const isActive = active === p.key;
        return (
          <div key={p.key} onClick={() => onChange(p.key)} style={{
            background: isActive ? C.ink : C.white,
            border: `1px solid ${isActive ? C.ink : C.line}`,
            color: isActive ? C.white : C.inkSoft,
            padding: "8px 14px", borderRadius: 20, fontSize: 12.5, fontWeight: 600,
            cursor: "pointer",
          }}>{p.label}</div>
        );
      })}
    </div>
  );
}

// Simple horizontal-bar gauge — % filled, with a target tick mark. Used for
// "female share vs 60% target" style panels; deliberately not a recharts
// radial gauge, to keep this first pass to plain inline-style primitives.
function Gauge({ label, pct, target, onClick }) {
  const filled = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const belowTarget = target != null && pct != null && pct < target;
  return (
    <div onClick={onClick} style={{ marginBottom: 16, cursor: onClick ? "pointer" : undefined }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: C.text, fontWeight: 600 }}>{label}{onClick && <span style={{ color: C.muted, marginLeft: 5 }}>›</span>}</span>
        <span>
          <span style={{ color: belowTarget ? C.coral : C.green, fontWeight: 700 }}>{fmtPct(pct)}</span>
          {/* Explicit target text, not just the tick mark below — a hover-only
              title attribute on a 2px line is easy to miss. */}
          {target != null && <span style={{ color: C.muted, fontWeight: 600, marginLeft: 6 }}>· target {target}%</span>}
        </span>
      </div>
      <div style={{ background: C.line, borderRadius: 6, height: 10, position: "relative" }}>
        <div style={{ width: `${filled}%`, background: belowTarget ? C.coral : C.teal, height: "100%", borderRadius: 6 }} />
        {target != null && (
          <div title={`Target ${target}%`} style={{ position: "absolute", left: `${target}%`, top: -3, bottom: -3, width: 2, background: C.ink }} />
        )}
      </div>
    </div>
  );
}

// Numbered section divider, matching the reference design's "exec-band" style.
// Prominent context/formula callout — matches the reference prototype's
// ".note" box exactly (gold-tinted background, bold key phrases) rather than
// a plain muted paragraph, so a page's core definition reads with the same
// weight the reference design gives it.
function PageNote({ children }) {
  return (
    <div style={{ background: "#FBF3E3", border: "1px solid #E9D9B0", borderRadius: 4, padding: "10px 14px", fontSize: 12, color: "#7A5A1E", marginBottom: 16 }}>
      {children}
    </div>
  );
}

function ExecBand({ num, title }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "26px 0 14px" }}>
      <span style={{ width: 26, height: 26, borderRadius: "50%", background: C.ink, color: C.white, fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{num}</span>
      <h3 style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>{title}</h3>
      <div style={{ flex: 1, height: 1, background: C.line }} />
    </div>
  );
}

// Left-accent-bordered callout card for auto-generated insights/recommendations.
function Insight({ tone = "neutral", children }) {
  const border = { pos: C.green, warn: C.gold, risk: C.coral, neutral: C.teal }[tone];
  const icon = { pos: "✔", warn: "▲", risk: "✕", neutral: "◆" }[tone];
  return (
    <div style={{ display: "flex", gap: 12, background: C.white, border: `1px solid ${C.line}`, borderLeft: `4px solid ${border}`, borderRadius: 6, padding: "13px 16px", fontSize: 13, lineHeight: 1.5 }}>
      <span style={{ fontWeight: 700, color: border, flexShrink: 0 }}>{icon}</span>
      <div>{children}</div>
    </div>
  );
}

// Persistent duplicate-records callout shown on Mobilisation and Acquisition
// — matches the reference prototype's ".dupe-flag" banner (real phone-number
// duplicates flagged across the FULL recruitment file, not just the eligible
// subset the KYC page's duplicate_rate covers). Green/"clean" variant when
// the live duplicate_rate comes back at 0.
function DuplicateRecordsBanner({ filters }) {
  const { data, loading, error } = useApi(`/api/recruitment/duplicate-summary${buildParams(filters)}`);
  if (loading || error || !data?.total_count) return null;
  const clean = !data.duplicate_count;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 11,
      background: clean ? "#E9F1EC" : "#FBF3E3",
      border: `1px solid ${clean ? "#CFE3D6" : "#E9D9B0"}`,
      borderLeft: `4px solid ${clean ? C.green : C.gold}`,
      borderRadius: 6, padding: "9px 14px", fontSize: 12,
      color: clean ? "#2F5D3A" : "#7A5A1E", marginBottom: 16,
    }}>
      <span style={{ fontWeight: 700, fontSize: 16, color: clean ? C.green : C.coral, flexShrink: 0 }}>{fmtNum(data.duplicate_count)}</span>
      <div>
        <b>Duplicate records identified</b> — {fmtNum(data.duplicate_count)} repeated phone numbers ({fmtPct(data.duplicate_rate)}) flagged across the recruitment file ({fmtNum(data.total_count)} total, this cohort). Real-time checks recommended at registration.
      </div>
    </div>
  );
}

// Horizontal funnel visualization — bar width proportional to the first
// stage's count, worst single drop-off outlined.
function FunnelViz({ stages, onStageClick }) {
  const max = Math.max(1, ...stages.map((s) => s.count || 0));
  let worstIdx = -1, worstLost = -1;
  stages.forEach((s, i) => { if (i > 0 && (s.lost || 0) > worstLost) { worstLost = s.lost; worstIdx = i; } });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {stages.map((s, i) => {
        const pct = max ? Math.round((100 * (s.count || 0)) / max) : 0;
        const worst = i === worstIdx;
        return (
          <div key={s.stage} onClick={onStageClick ? () => onStageClick(s) : undefined} style={{ display: "flex", alignItems: "center", gap: 12, cursor: onStageClick ? "pointer" : undefined }}>
            <div style={{ width: 110, flexShrink: 0, fontSize: 12.5, fontWeight: 700, color: C.ink, textAlign: "right" }}>{s.stage}</div>
            <div style={{ flex: 1, position: "relative", height: 38, background: "#F4EFE3", borderRadius: 6, overflow: "hidden", outline: worst ? `2px solid ${C.coral}` : "none", outlineOffset: 1 }}>
              <div style={{ width: `${pct}%`, height: "100%", display: "flex", alignItems: "center", paddingLeft: 12, color: C.white, fontWeight: 700, fontSize: 13.5, borderRadius: 6, background: worst ? C.coral : C.teal, transition: "width .3s" }}>
                {fmtNum(s.count)}{onStageClick && <span style={{ marginLeft: 6, opacity: 0.8 }}>›</span>}
              </div>
            </div>
            <div style={{ width: 190, flexShrink: 0, fontSize: 11, color: C.muted }}>
              {i === 0 ? "start" : `${s.pct_of_previous}% of previous · ${fmtNum(s.lost)} lost`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Drill panel ────────────────────────────────────────────────────────────────
// One reusable slide-over (matches the reference design's #drillPanel /
// #drillBackdrop) shared by every tab: click a metric -> a root-level table
// (e.g. by district), click a root row -> a child-level table for just that
// row (e.g. by venue/parish), "‹ Back" to go up. `openDrill(spec)` is exposed
// via useDrill() to any component; spec:
//   title       - panel heading
//   tone/tagLabel - Chip shown next to the title (e.g. tone="real", tagLabel="REAL")
//   rootKey/rootLabel   - field holding the root row's name + its column header
//   columns     - value columns shown in both the root and child tables
//   rootRows    - array, OR () => rows | Promise<rows> (lazy — e.g. the N+1
//                 per-district fetch pages need this since no single response
//                 already returns a by-district breakdown)
//   childKey/childLabel - same as root but for the drilled-into level; omit
//                 childLabel entirely for a metric with no deeper level
//   getChildRows(rootRow) - rows | Promise<rows> for that one root row
const DrillContext = createContext(null);

function useDrill() {
  return useContext(DrillContext);
}

function DrillTable({ nameKey, nameLabel, columns, rows, onRowClick }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "7px 8px", borderBottom: `2px solid ${C.line}`, color: C.muted, fontWeight: 600, textTransform: "uppercase", fontSize: 10.5 }}>{nameLabel}</th>
            {columns.map((c) => (
              <th key={c.key} style={{ textAlign: c.align || "right", padding: "7px 8px", borderBottom: `2px solid ${C.line}`, color: C.muted, fontWeight: 600, textTransform: "uppercase", fontSize: 10.5 }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r[nameKey] ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} style={onRowClick ? { cursor: "pointer" } : undefined}>
              <td style={{ padding: "7px 8px", borderBottom: `1px solid ${C.line}`, color: C.ink, fontWeight: 600 }}>
                {onRowClick && <span style={{ color: C.muted, marginRight: 4 }}>›</span>}{r[nameKey] ?? "—"}
              </td>
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align || "right", padding: "7px 8px", borderBottom: `1px solid ${C.line}`, color: C.text }}>
                  {c.render ? c.render(r[c.key], r) : (r[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Third level is optional — a spec without getGrandchildRows renders exactly
// as a normal 2-level drill (child rows get no onRowClick, so no cursor
// pointer / no-op). Specs that DO set it (e.g. district -> parish -> venue,
// where the venue grain is target-only) get a further "‹ Back" hop.
function DrillPanelUI({ open, spec, rootRows, rootLoading, rootError, child, grandchild, onClose, onDrillInto, onDrillIntoGrandchild, onBack, onBackToChild }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, background: "rgba(15,34,56,.40)", zIndex: 80,
        opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none", transition: "opacity .2s",
      }} />
      <aside role="dialog" aria-label="Metric breakdown" style={{
        position: "fixed", top: 0, right: 0, height: "100%", width: 520, maxWidth: "92vw",
        background: C.cream, zIndex: 90, transform: open ? "translateX(0)" : "translateX(100%)",
        transition: "transform .25s cubic-bezier(.2,.8,.2,1)", display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 28px rgba(0,0,0,.14)",
      }}>
        {spec && (
          <>
            <div style={{ padding: "20px 24px 16px", borderBottom: `1px solid ${C.line}`, background: C.white, flexShrink: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                <Chip tone={spec.tone || "real"}>{spec.tagLabel || (spec.tone === "sim" ? "SAMPLE" : "REAL")}</Chip>
                <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", fontSize: 22, color: C.muted, cursor: "pointer", padding: "0 6px", lineHeight: 1 }}>&times;</button>
              </div>
              <div style={{ fontSize: 17, fontWeight: 700, marginTop: 6, color: C.ink }}>
                {grandchild
                  ? `${spec.title} — ${child.rootRow[spec.rootKey]} — ${grandchild.childRow[spec.childKey]}`
                  : child
                    ? `${spec.title} — ${child.rootRow[spec.rootKey]}`
                    : spec.title}
              </div>
              {grandchild && (
                <div onClick={onBackToChild} style={{ marginTop: 6, fontSize: 12, color: C.teal, fontWeight: 600, cursor: "pointer" }}>
                  ‹ Back to {spec.childLabel.toLowerCase()}s
                </div>
              )}
              {child && !grandchild && (
                <div onClick={onBack} style={{ marginTop: 6, fontSize: 12, color: C.teal, fontWeight: 600, cursor: "pointer" }}>
                  ‹ Back to {spec.rootLabel.toLowerCase()}s
                </div>
              )}
            </div>
            <div style={{ padding: "18px 24px 30px", overflowY: "auto", flex: 1 }}>
              {!child && (
                <State loading={rootLoading} error={rootError} empty={!rootLoading && !rootError && (rootRows || []).length === 0}>
                  <DrillTable nameKey={spec.rootKey} nameLabel={spec.rootLabel} columns={spec.columns} rows={rootRows || []}
                    onRowClick={spec.getChildRows ? onDrillInto : undefined} />
                </State>
              )}
              {child && !grandchild && (
                <State loading={child.loading} error={child.error} empty={!child.loading && !child.error && (child.rows || []).length === 0}>
                  <DrillTable nameKey={spec.childKey} nameLabel={spec.childLabel} columns={spec.columns} rows={child.rows || []}
                    onRowClick={spec.getGrandchildRows ? onDrillIntoGrandchild : undefined} />
                </State>
              )}
              {grandchild && (
                <State loading={grandchild.loading} error={grandchild.error} empty={!grandchild.loading && !grandchild.error && (grandchild.rows || []).length === 0}>
                  <DrillTable nameKey={spec.grandchildKey} nameLabel={spec.grandchildLabel} columns={spec.grandchildColumns || spec.columns} rows={grandchild.rows || []} />
                </State>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function DrillProvider({ children }) {
  const [spec, setSpec] = useState(null);
  const [open, setOpen] = useState(false);
  const [rootRows, setRootRows] = useState(null);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState(null);
  const [child, setChild] = useState(null);
  const [grandchild, setGrandchild] = useState(null);

  // Opens showing the root (e.g. district) table.
  const openDrill = useCallback((newSpec) => {
    setSpec(newSpec);
    setOpen(true);
    setChild(null);
    setGrandchild(null);
    setRootRows(null);
    setRootError(null);
  }, []);

  // Opens straight into the child (e.g. venue) table for a known root row —
  // e.g. a chart bar click already identifies its district, no need to make
  // the user pick it again from a root list. "‹ Back" still lazy-loads root.
  const openAt = useCallback((newSpec, rootRow) => {
    setSpec(newSpec);
    setOpen(true);
    setRootRows(null);
    setRootError(null);
    setGrandchild(null);
    setChild({ rootRow, rows: null, loading: true, error: null });
    Promise.resolve(newSpec.getChildRows(rootRow))
      .then((rows) => setChild({ rootRow, rows, loading: false, error: null }))
      .catch((e) => setChild({ rootRow, rows: null, loading: false, error: e.message || "Failed to load" }));
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const drillInto = useCallback((row) => {
    if (!spec?.getChildRows) return;
    setGrandchild(null);
    setChild({ rootRow: row, rows: null, loading: true, error: null });
    Promise.resolve(spec.getChildRows(row))
      .then((rows) => setChild({ rootRow: row, rows, loading: false, error: null }))
      .catch((e) => setChild({ rootRow: row, rows: null, loading: false, error: e.message || "Failed to load" }));
  }, [spec]);

  // Child -> grandchild — the optional third level (e.g. parish -> venue).
  const drillIntoGrandchild = useCallback((row) => {
    if (!spec?.getGrandchildRows) return;
    setGrandchild({ childRow: row, rows: null, loading: true, error: null });
    Promise.resolve(spec.getGrandchildRows(row))
      .then((rows) => setGrandchild({ childRow: row, rows, loading: false, error: null }))
      .catch((e) => setGrandchild({ childRow: row, rows: null, loading: false, error: e.message || "Failed to load" }));
  }, [spec]);

  const backToRoot = useCallback(() => { setChild(null); setGrandchild(null); }, []);
  const backToChild = useCallback(() => setGrandchild(null), []);

  // Lazy-load the root table whenever it's needed and not yet loaded —
  // covers both a fresh openDrill() and "‹ Back" from an openAt() launch.
  useEffect(() => {
    if (!open || child || rootRows !== null || rootLoading || !spec) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- kicking off the async load IS the sync point */
    setRootLoading(true);
    Promise.resolve(typeof spec.rootRows === "function" ? spec.rootRows() : (spec.rootRows || []))
      .then((rows) => { setRootRows(rows); setRootLoading(false); })
      .catch((e) => { setRootError(e.message || "Failed to load"); setRootLoading(false); });
  }, [open, child, rootRows, rootLoading, spec]);

  return (
    <DrillContext.Provider value={{ open: openDrill, openAt }}>
      {children}
      <DrillPanelUI open={open} spec={spec} rootRows={rootRows} rootLoading={rootLoading} rootError={rootError}
        child={child} grandchild={grandchild} onClose={close} onDrillInto={drillInto}
        onDrillIntoGrandchild={drillIntoGrandchild} onBack={backToRoot} onBackToChild={backToChild} />
    </DrillContext.Provider>
  );
}

// ─── OKR tracker — leader-entered, persisted in localStorage only ──────────────
const OKR_STORAGE_KEY = "eba_okrs";
function loadOkrs() {
  try { return JSON.parse(localStorage.getItem(OKR_STORAGE_KEY)) || []; } catch { return []; }
}
function saveOkrs(okrs) { localStorage.setItem(OKR_STORAGE_KEY, JSON.stringify(okrs)); }

function OkrTracker() {
  const [okrs, setOkrs] = useState(loadOkrs);
  const [form, setForm] = useState({ objective: "", kr: "", target: "", current: "", status: "On Track" });
  const inputStyle = { fontSize: 12, padding: "8px 10px", border: `1px solid ${C.line}`, borderRadius: 5 };
  const statusColor = { "Completed": C.green, "On Track": "#A87A1E", "At Risk": "#A87A1E", "Off Track": C.coral };

  function addOkr(e) {
    e.preventDefault();
    if (!form.objective.trim() || !form.kr.trim()) return;
    const next = [...okrs, { ...form, id: Date.now() }];
    setOkrs(next); saveOkrs(next);
    setForm({ objective: "", kr: "", target: "", current: "", status: "On Track" });
  }
  function removeOkr(id) {
    const next = okrs.filter((o) => o.id !== id);
    setOkrs(next); saveOkrs(next);
  }

  return (
    <Card title="This cycle's Objectives & Key Results" subtitle="Add your OKRs directly — saved locally in your browser, so they're here next time you open this dashboard" chip="EDITABLE — LEADER-ENTERED" chipTone="sim">
      <form onSubmit={addOkr} style={{ display: "grid", gridTemplateColumns: "1.6fr 1.6fr 0.7fr 0.7fr 0.9fr auto", gap: 8, marginBottom: 16 }}>
        <input placeholder="Objective" value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} style={inputStyle} />
        <input placeholder="Key Result" value={form.kr} onChange={(e) => setForm({ ...form, kr: e.target.value })} style={inputStyle} />
        <input placeholder="Target" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} style={inputStyle} />
        <input placeholder="Current" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} style={inputStyle} />
        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} style={inputStyle}>
          <option>On Track</option><option>Completed</option><option>At Risk</option><option>Off Track</option>
        </select>
        <button type="submit" style={{ background: C.ink, color: C.white, border: "none", borderRadius: 5, fontSize: 12.5, fontWeight: 700, padding: "8px 16px", cursor: "pointer" }}>+ Add</button>
      </form>
      {okrs.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.muted, fontStyle: "italic", textAlign: "center", padding: 20, border: `1px dashed ${C.line}`, borderRadius: 6 }}>
          No OKRs added yet — use the form above to add your first one.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {okrs.map((o) => {
            const target = Number(o.target) || 0;
            const current = Number(o.current) || 0;
            const pct = target ? Math.min(100, Math.round((100 * current) / target)) : 0;
            return (
              <div key={o.id} style={{ display: "grid", gridTemplateColumns: "1.6fr 1.6fr 1fr 1fr auto", gap: 10, alignItems: "center", background: C.white, border: `1px solid ${C.line}`, borderRadius: 6, padding: "12px 14px", fontSize: 12.5 }}>
                <div style={{ fontWeight: 700, color: C.ink, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.2 }}>{o.objective}</div>
                <div style={{ color: C.text }}>{o.kr}</div>
                <div>
                  <div style={{ background: "#EEE6D4", borderRadius: 3, height: 6, overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", borderRadius: 3, background: pct >= 100 ? C.green : pct >= 60 ? C.gold : C.coral }} />
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{o.current || "—"} / {o.target || "—"}</div>
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "4px 10px", borderRadius: 10, background: "#FBF3E3", color: statusColor[o.status] || C.muted, justifySelf: "start", whiteSpace: "nowrap" }}>{o.status}</span>
                <button onClick={() => removeOkr(o.id)} style={{ background: "none", border: "none", color: C.muted, fontSize: 16, cursor: "pointer", justifySelf: "end" }}>×</button>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// column.onHeaderClick, when given, makes that header a drill trigger —
// matches the reference design's "column headers ... clickable" convention.
// onRowClick, when given, makes every row a drill trigger (matches
// DrillTable's row-click convention) — used e.g. by the mobiliser table to
// open a per-mobiliser district->parish drill, and by the Forecast page's
// district table to open its parish drill.
// stickyHeader/maxBodyHeight -- same meaning as GroupedDataTable's (single
// header row here, so no row-offset math needed: just position:sticky;top:0
// with a solid background so scrolling body rows don't show through).
function DataTable({ columns, rows, onRowClick, stickyHeader, maxBodyHeight }) {
  const stickyTop = stickyHeader ? { position: "sticky", top: 0, zIndex: 2, background: C.white } : {};
  return (
    <div style={maxBodyHeight ? { overflow: "auto", maxHeight: maxBodyHeight } : { overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>{columns.map((c) => (
            <th key={c.key} onClick={c.onHeaderClick} style={{ textAlign: c.align || "left", padding: "8px 10px", borderBottom: `2px solid ${C.line}`, color: C.muted, fontWeight: 600, textTransform: "uppercase", fontSize: 11, cursor: c.onHeaderClick ? "pointer" : undefined, ...stickyTop }}>
              {c.label}{c.onHeaderClick && " ›"}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} onClick={onRowClick ? () => onRowClick(r) : undefined} style={onRowClick ? { cursor: "pointer" } : undefined}>{columns.map((c) => (
              <td key={c.key} style={{ textAlign: c.align || "left", padding: "8px 10px", borderBottom: `1px solid ${C.line}`, color: C.text }}>
                {c.render ? c.render(r[c.key], r) : (r[c.key] ?? "—")}
              </td>
            ))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Same look as DataTable, but with a second header band grouping columns
// under a tinted, spanning label (e.g. "Call-center" / "Auto-confirmed" /
// "Total") — for tables wide enough that a flat row of column headers alone
// makes it hard to tell which numbers belong together at a glance.
// `leading`/`trailing` render as normal ungrouped columns (name, Status);
// `groups` is [{ label, color, columns }] — each group's columns get a
// left border + the group's tinted spanning header so the visual grouping
// carries down into the body, not just the header.
// stickyLeading pins the leading column(s) to the left edge while the group
// columns scroll underneath -- e.g. Venue Performance's venue+district cell
// stays visible while scrolling through Week 1..N. Assumes a single leading
// column (this table's only current use of it combines Venue+District into
// one cell for exactly that reason); a solid background is required so the
// scrolling group columns don't show through underneath it.
//
// maxBodyHeight caps the table to roughly that many pixels (~5 rows worth)
// and adds a vertical scrollbar for the rest, instead of rendering every row
// -- e.g. Parish performance's ~40+ parishes. Independent of stickyLeading;
// either can be used alone or together.
//
// stickyHeader pins BOTH header rows to the top of the scroll container while
// the body scrolls underneath -- only visibly does anything when the table
// actually scrolls internally (maxBodyHeight set, or the table is tall enough
// on its own). The group-header row gets a fixed height (GROUP_HEADER_ROW_H)
// so the sub-header row's own sticky `top` offset is a reliable constant
// rather than a measured value; a solid background is required on every
// sticky header cell so body rows scrolling underneath don't show through.
const GROUP_HEADER_ROW_H = 33;
function GroupedDataTable({ leading, groups, trailing, rows, onRowClick, stickyLeading, maxBodyHeight, stickyHeader }) {
  const grouped = groups.flatMap((g) => g.columns.map((c, i) => ({ ...c, groupColor: g.color, groupStart: i === 0 })));
  const thStyle = { padding: "8px 10px", borderBottom: `2px solid ${C.line}`, color: C.muted, fontWeight: 600, textTransform: "uppercase", fontSize: 11 };
  const tdStyle = { padding: "8px 10px", borderBottom: `1px solid ${C.line}`, color: C.text };
  const stickyCellStyle = stickyLeading ? { position: "sticky", left: 0, background: C.white, borderRight: `1px solid ${C.line}` } : {};
  const stickyTop1 = stickyHeader ? { position: "sticky", top: 0, zIndex: 4, background: C.white } : {};
  const stickyTop2 = stickyHeader ? { position: "sticky", top: GROUP_HEADER_ROW_H, zIndex: 4, background: C.white } : {};
  const cornerStyle = { ...stickyCellStyle, ...stickyTop1, zIndex: stickyLeading || stickyHeader ? 5 : undefined };
  return (
    <div style={maxBodyHeight ? { overflow: "auto", maxHeight: maxBodyHeight } : { overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {(leading || []).map((c) => <th key={c.key} rowSpan={2} style={{ ...thStyle, textAlign: c.align || "left", verticalAlign: "bottom", ...cornerStyle }}>{c.label}</th>)}
            {groups.map((g) => (
              <th
                key={g.label}
                colSpan={g.columns.length}
                onClick={g.onHeaderClick}
                style={{
                  padding: "6px 10px", height: GROUP_HEADER_ROW_H, boxSizing: "border-box",
                  borderBottom: `1px solid ${C.line}`, borderLeft: `2px solid ${C.line}`,
                  background: stickyHeader ? `linear-gradient(${g.color}18, ${g.color}18), ${C.white}` : `${g.color}18`,
                  color: g.color, fontWeight: 700, textTransform: "uppercase", fontSize: 10.5, textAlign: "center",
                  cursor: g.onHeaderClick ? "pointer" : undefined, ...stickyTop1,
                  // A table `height` is a floor, not a cap -- a wrapped 2-line
                  // label would render taller than GROUP_HEADER_ROW_H, throwing
                  // off the sub-header row's sticky offset below it (confirmed
                  // live: "Auto-confirmed (awareness, parish-level)" wraps and
                  // visibly overlaps). Forcing nowrap when sticky keeps this
                  // row's real height equal to the fixed constant it promises.
                  whiteSpace: stickyHeader ? "nowrap" : undefined,
                }}
              >
                {g.label}{g.onHeaderClick ? " ›" : ""}
              </th>
            ))}
            {(trailing || []).map((c) => <th key={c.key} rowSpan={2} style={{ ...thStyle, textAlign: c.align || "left", verticalAlign: "bottom", ...stickyTop1, zIndex: stickyHeader ? 4 : undefined }}>{c.label}</th>)}
          </tr>
          <tr>
            {grouped.map((c) => (
              <th key={c.key} style={{ ...thStyle, textAlign: c.align || "left", borderLeft: c.groupStart ? `2px solid ${C.line}` : undefined, ...stickyTop2 }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} onClick={onRowClick ? () => onRowClick(r) : undefined} style={onRowClick ? { cursor: "pointer" } : undefined}>
              {(leading || []).map((c) => (
                <td key={c.key} style={{ ...tdStyle, textAlign: c.align || "left", ...stickyCellStyle, zIndex: stickyLeading ? 1 : undefined }}>{c.render ? c.render(r[c.key], r) : (r[c.key] ?? "—")}</td>
              ))}
              {grouped.map((c) => (
                <td key={c.key} style={{ ...tdStyle, textAlign: c.align || "left", borderLeft: c.groupStart ? `2px solid ${C.line}` : undefined, background: `${c.groupColor}0c` }}>
                  {c.render ? c.render(r[c.key], r) : (r[c.key] ?? "—")}
                </td>
              ))}
              {(trailing || []).map((c) => (
                <td key={c.key} style={{ ...tdStyle, textAlign: c.align || "left" }}>{c.render ? c.render(r[c.key], r) : (r[c.key] ?? "—")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Executive Summary ───────────────────────────────────────────────────────
const RATE_TARGETS = {
  eligibility_rate:  { good: 80, warn: 70, label: "Eligibility" },
  mobilisation_rate: { good: 85, warn: 75, label: "Mobilisation" },
  acquisition_rate:  { good: 80, warn: 70, label: "Acquisition" },
  activation_rate:   { good: 90, warn: 80, label: "Activation" },
  retention_rate:    { good: 85, warn: 75, label: "Retention" },
  all_sessions_rate: { good: 75, warn: 60, label: "All-sessions attendance" },
  attendance_rate:   { good: 95, warn: 90, label: "Attendance" },
  reach_rate:        { good: 70, warn: 60, label: "Reach" },
  timely_rate:       { good: 90, warn: 75, label: "Timely reporting" },
};

// One color rule for every rate-vs-target figure that uses RATE_TARGETS'
// good/warn bands, so a KpiTile value and the Insight callout describing the
// same metric always agree on what counts as on/off track.
function rateColor(value, targetKey) {
  if (value == null) return C.muted;
  const t = RATE_TARGETS[targetKey];
  if (!t) return C.ink;
  return value >= t.good ? C.green : value >= t.warn ? C.gold : C.coral;
}

// present÷activated-style ratios occasionally exceed 100% on live data (a
// mart snapshot lags a day or two behind another mart it's joined against --
// confirmed live 2026-08-08: 8 of 43 venues have ATTENDANCE_SUMMARY's present
// exceed SITE_FUNNEL_METRICS' activated_youth by 1-2 youth). The backend's
// own attendance_rate fields are already capped at the source (see
// attendance()'s _rate, backend); this covers the frontend's own client-side
// re-derivations (KPI means, drill rollups) so a rate never renders as a
// nonsensical >100% while the raw present/absent counts stay exactly as
// reported.
function capRate(v) {
  return v == null ? null : Math.min(v, 100);
}

// Shared DataTable column renderers for the three color bands used
// throughout the app, so every table showing one of these metrics is
// colored consistently rather than some tables getting color and others not.
function renderRateCell(targetKey) {
  return (v) => <span style={{ color: rateColor(v, targetKey), fontWeight: 700 }}>{fmtPct(v)}</span>;
}
function renderProgressPctCell(v) {
  return <span style={{ color: RATE_CATEGORY_COLOR[categorizeRate(v)], fontWeight: 700 }}>{fmtPct(v)}</span>;
}
function renderPctFemaleCell(v) {
  const c = femaleShareStatus(v)?.color;
  return <span style={{ color: c || C.ink, fontWeight: 700 }}>{fmtPct(v)}</span>;
}

function buildExecInsights(rates, stages, genderStages) {
  const insights = [];
  const drops = stages.slice(1)
    .map((s, i) => ({ from: stages[i].stage, to: s.stage, lost: s.lost }))
    .sort((a, b) => b.lost - a.lost);
  if (drops[0]?.lost > 0) {
    insights.push({ tone: "risk", text: <><b>{fmtNum(drops[0].lost)} youth lost</b> between {drops[0].from} and {drops[0].to} — the largest single drop-off in the funnel.</> });
  }
  Object.entries(RATE_TARGETS).forEach(([key, { good, warn, label }]) => {
    const v = rates[key];
    if (v == null) return;
    if (v >= good) insights.push({ tone: "pos", text: <><b>{label} rate is {v}%</b> — at or above the {good}% target.</> });
    else if (v < warn) insights.push({ tone: "risk", text: <><b>{label} rate is {v}%</b> — below the {warn}% warning threshold (target {good}%).</> });
    else insights.push({ tone: "warn", text: <><b>{label} rate is {v}%</b> — between the {warn}% warning line and the {good}% target.</> });
  });
  (genderStages || []).forEach((s) => {
    if (s.pct_female != null && Math.abs(s.pct_female - 60) > 5) {
      const dir = s.pct_female < 60 ? "below" : "above";
      insights.push({ tone: s.pct_female < 60 ? "warn" : "pos", text: <><b>{s.stage} female share is {fmtPct(s.pct_female)}</b> — {dir} the 60% target by {Math.abs(Math.round((s.pct_female - 60) * 10) / 10)}pp.</> });
    }
  });
  return insights;
}

function buildExecRecommendations(insights) {
  const risks = insights.filter((i) => i.tone === "risk" || i.tone === "warn");
  if (!risks.length) return ["No rate or gender gap is currently flagged — maintain current pace and mobiliser mix."];
  return risks.map((i, idx) => <span key={idx}>Investigate and address: {i.text}</span>);
}

function ExecutiveSummaryTab({ filters }) {
  const [page, setPage] = useState("summary");
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Executive Summary</h2>
      <p style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>
        The whole E!BA recruitment funnel on one screen — are we on track, where are youth
        dropping off, and where should we act. Read top-to-bottom: Awareness → Mobilisation →
        Acquisition. Everything below responds to the filters above.
      </p>
      <PageNav
        active={page}
        onChange={setPage}
        pages={[{ key: "summary", label: "Summary" }, { key: "cohort", label: "Cohort Comparison" }]}
      />
      {page === "summary" && <ExecutiveSummaryPage filters={filters} />}
      {page === "cohort" && <CohortComparisonPage />}
    </div>
  );
}

// Overview endpoints only ever return one aggregate for whatever district
// filter is already applied — no single response carries a by_district
// breakdown (unlike Awareness/Acquisition/Retention). Since they DO already
// accept a `district` param, the district-level drill table is built by
// firing one request per district (lazily, only when a drill is opened) and
// reusing the same endpoint + extractor rather than needing new backend SQL.
function fetchPerDistrict(endpoint, filters, districts, extract) {
  return Promise.all(
    districts.map((d) =>
      apiGet(`${endpoint}${buildParamsOverride(filters, { district: d })}`)
        .then((json) => ({ district: d, value: extract(json) }))
        .catch(() => ({ district: d, value: null }))
    )
  ).then((rows) => rows.sort((a, b) => (b.value || 0) - (a.value || 0)));
}

// Export-only variant of fetchPerDistrict: the interactive drills above only
// ever need one field at a time (whichever metric was clicked), so N+1 per
// district is fine. The export report wants every field a page's drills can
// show, for every district, in one pass — firing one request per FIELD per
// district would multiply out fast (e.g. Executive Summary's 5 rates), so this
// fires exactly one request per district and pulls every field in `extractMap`
// (key -> extractor(json)) out of that single response.
function fetchPerDistrictFields(endpoint, filters, districts, extractMap) {
  return Promise.all(
    districts.map((d) =>
      apiGet(`${endpoint}${buildParamsOverride(filters, { district: d })}`)
        .then((json) => {
          const row = { district: d };
          Object.entries(extractMap).forEach(([key, extract]) => { row[key] = extract(json); });
          return row;
        })
        .catch(() => {
          const row = { district: d };
          Object.keys(extractMap).forEach((key) => { row[key] = null; });
          return row;
        })
    )
  );
}

function ExecutiveSummaryPage({ filters }) {
  const drill = useDrill();
  const q = buildParams(filters);
  const kpis = useApi(`/api/overview/kpis${q}`);
  const funnel = useApi(`/api/overview/funnel${q}`);
  const funnelSplit = useApi(`/api/overview/funnel-split${q}`);
  const stageProgress = useApi(`/api/overview/stage-progress${q}`);
  const gender = useApi(`/api/overview/gender${q}`);
  const genderSplit = useApi(`/api/overview/gender-split${q}`);
  const barriers = useApi(`/api/overview/eligibility-barriers${q}`);
  const filterMeta = useApi("/api/filters");
  const allDistricts = filterMeta.data?.districts || [];

  const rates = kpis.data?.rates || {};

  function openRateDrill(rateKey, label) {
    drill.open({
      title: `${label} rate — by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [{ key: "value", label: `${label} rate`, align: "right", render: fmtPct }],
      rootRows: () => fetchPerDistrict("/api/overview/kpis", filters, allDistricts, (json) => json?.rates?.[rateKey] ?? null),
    });
  }

  const genderDrillColumns = [
    { key: "female", label: "Female", align: "right", render: fmtNum },
    { key: "male", label: "Male", align: "right", render: fmtNum },
    { key: "pct_female", label: "% Female", align: "right", render: fmtPct },
  ];

  function openGenderStageDrill(stage, pathwayKey) {
    drill.open({
      title: `${stage} — Female vs Male by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: genderDrillColumns,
      rootRows: () => fetchPerDistrictFields("/api/overview/gender-split", filters, allDistricts, {
        female: (json) => (json?.[pathwayKey] || []).find((s) => s.stage === stage)?.female ?? null,
        male: (json) => (json?.[pathwayKey] || []).find((s) => s.stage === stage)?.male ?? null,
        pct_female: (json) => (json?.[pathwayKey] || []).find((s) => s.stage === stage)?.pct_female ?? null,
      }),
    });
  }

  function openGenderSplitDrill(fieldKey, label) {
    drill.open({
      title: `${label} — Female vs Male by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: genderDrillColumns,
      rootRows: () => fetchPerDistrictFields("/api/overview/gender-split", filters, allDistricts, {
        female: (json) => json?.[fieldKey]?.female ?? null,
        male: (json) => json?.[fieldKey]?.male ?? null,
        pct_female: (json) => json?.[fieldKey]?.pct_female ?? null,
      }),
    });
  }

  const stages = funnel.data?.stages || [];
  const genderStages = gender.data?.stages || [];
  function renderGenderRetentionCell(v, r) {
    const gap = r.female_pct_of_previous != null && r.male_pct_of_previous != null
      ? Math.abs(r.female_pct_of_previous - r.male_pct_of_previous) : null;
    const flagged = gap != null && gap > 5;
    return <span style={{ color: flagged ? C.coral : "inherit", fontWeight: flagged ? 700 : 400 }}>{v == null ? "start" : fmtPct(v)}</span>;
  }
  const genderTableColumns = [
    { key: "stage", label: "Stage" },
    { key: "female", label: "Female", align: "right", render: (v) => fmtNum(v) },
    { key: "male", label: "Male", align: "right", render: (v) => fmtNum(v) },
    { key: "female_pct_of_previous", label: "Female Retention", align: "right", render: renderGenderRetentionCell },
    { key: "male_pct_of_previous", label: "Male Retention", align: "right", render: renderGenderRetentionCell },
  ];

  const dropoffs = stages.slice(1)
    .map((s, i) => ({ from_stage: stages[i].stage, to_stage: s.stage, lost: s.lost }))
    .sort((a, b) => b.lost - a.lost)
    .slice(0, 5);

  const insights = buildExecInsights(rates, stages, genderStages);
  const recommendations = buildExecRecommendations(insights);

  return (
    <div>
      <ExecBand num={1} title="Executive conversion metrics" />
      <State loading={kpis.loading} error={kpis.error} empty={!kpis.loading && !kpis.error && Object.keys(rates).length === 0}>
        <Grid cols={4}>
          <KpiTile label="Eligibility" value={<span style={{ color: rateColor(rates.eligibility_rate, "eligibility_rate") }}>{fmtPct(rates.eligibility_rate)}</span>} sub="Eligible / Interested" onClick={() => openRateDrill("eligibility_rate", "Eligibility")} />
          <KpiTile label="Mobilisation" value={<span style={{ color: rateColor(rates.mobilisation_rate, "mobilisation_rate") }}>{fmtPct(rates.mobilisation_rate)}</span>} sub="Confirmed / Reached" onClick={() => openRateDrill("mobilisation_rate", "Mobilisation")} />
          <KpiTile label="Acquisition" value={<span style={{ color: rateColor(rates.acquisition_rate, "acquisition_rate") }}>{fmtPct(rates.acquisition_rate)}</span>} sub="Acquired / Confirmed" onClick={() => openRateDrill("acquisition_rate", "Acquisition")} />
          <KpiTile label="Activation" value={<span style={{ color: rateColor(rates.activation_rate, "activation_rate") }}>{fmtPct(rates.activation_rate)}</span>} sub="Activated / Acquired" onClick={() => openRateDrill("activation_rate", "Activation")} />
          <KpiTile label="Retention" value={<span style={{ color: rateColor(rates.retention_rate, "retention_rate") }}>{fmtPct(rates.retention_rate)}</span>} sub="Retained / Activated" onClick={() => openRateDrill("retention_rate", "Retention")} />
        </Grid>
      </State>

      <ExecBand num={2} title="Progress on target — by stage" />
      <State loading={stageProgress.loading} error={stageProgress.error} empty={!stageProgress.loading && (stageProgress.data?.stages || []).length === 0}>
        <Grid cols={3}>
          {(stageProgress.data?.stages || []).map((s) => (
            <KpiTile
              key={s.stage}
              label={s.stage}
              value={fmtNum(s.count)}
              sub={s.target ? `${fmtPct(s.pct_of_target)} of ${fmtNum(s.target)} target${s.target_is_implied ? " (implied)" : ""}` : "no target set"}
              tone={s.target_is_implied ? "sim" : "real"}
              tag={s.target_is_implied ? "IMPLIED" : "REAL"}
            />
          ))}
        </Grid>
      </State>

      <ExecBand num={3} title="What is locking youth out — eligibility barriers" />
      <Card title="Why reached youth do not qualify" subtitle="Among youth who did not meet the eligibility rule, which criteria they failed (a youth can fail more than one)" chip="REAL">
        <State loading={barriers.loading} error={barriers.error} empty={!barriers.loading && (barriers.data?.barriers || []).length === 0}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={barriers.data?.barriers || []} layout="vertical" margin={{ left: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="barrier" tick={{ fontSize: 11 }} width={150} />
              <Tooltip />
              <Bar dataKey="count" fill={C.coral} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </State>
      </Card>

      <ExecBand num={4} title="Recruitment funnel — by pathway" />
      <Card
        title="BC3 Control List vs New Recruits (have randomisation)"
        subtitle="Two genuinely different pathways — BC3 Control List is pure call-center/acquisition data (the same BC3 Control List on the Mobilisation tab); New Recruits comes from the awareness table, randomised into Treatment vs Control once eligible. Both converge into one shared funnel below once confirmed."
        chip="REAL"
      >
        <State loading={funnelSplit.loading} error={funnelSplit.error} empty={!funnelSplit.loading && (funnelSplit.data?.waiting_list || []).length === 0 && (funnelSplit.data?.new_recruits || []).length === 0}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, marginBottom: 8 }}>BC3 Control List</div>
              <FunnelViz stages={funnelSplit.data?.waiting_list || []} />
            </div>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, marginBottom: 8 }}>New Recruits (have randomisation)</div>
              <FunnelViz stages={funnelSplit.data?.new_recruits || []} />
              {(funnelSplit.data?.new_recruits_treatment != null || funnelSplit.data?.new_recruits_control != null) && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3, marginTop: 12 }}>
                    Randomisation, after Eligible
                  </div>
                  <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                    <div style={{ flex: 1, background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 10px" }}>
                      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3 }}>Treatment (confirmed)</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>{fmtNum(funnelSplit.data.new_recruits_treatment)}</div>
                    </div>
                    <div style={{ flex: 1, background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 10px" }}>
                      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3 }}>Control</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>{fmtNum(funnelSplit.data.new_recruits_control)}</div>
                    </div>
                  </div>
                </>
              )}
              <p style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
                Every eligible youth is randomised into Treatment or Control — Treatment-arm youth are auto-confirmed by policy (Confirmed = Treatment, no separate drop), while Control is a comparison group held out by design, not attrition.
              </p>
            </div>
          </div>
        </State>
      </Card>
      <Card title="Arrival → Acquisition → Activation → Retention" subtitle="Both pathways converge here — confirmed youth from BC3 Control List and New Recruits attend the same bootcamp from this point on." chip="REAL">
        <State loading={funnelSplit.loading} error={funnelSplit.error} empty={!funnelSplit.loading && (funnelSplit.data?.merged || []).length === 0}>
          <FunnelViz stages={funnelSplit.data?.merged || []} />
          <p style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
            Shown as one shared journey — the live site-level data (venue x gender x cycle) doesn't carry a BC3 Control List vs New Recruits marker past this point, so a genuine per-pathway split isn't available yet.
          </p>
        </State>
      </Card>

      <ExecBand num={5} title="Gender performance summary" />
      <Card
        title="Male vs female — by pathway"
        subtitle="Stage-to-stage retention within each gender — e.g. Confirmed female count ÷ Reached female count. Gaps over 5pp between Female and Male retention are flagged. Click a stage to drill by district."
        chip="REAL"
      >
        <State loading={genderSplit.loading} error={genderSplit.error} empty={!genderSplit.loading && (genderSplit.data?.bc3_control_list || []).length === 0 && (genderSplit.data?.new_recruits || []).length === 0}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, marginBottom: 8 }}>BC3 Control List</div>
              <DataTable
                columns={genderTableColumns}
                rows={genderSplit.data?.bc3_control_list || []}
                onRowClick={(r) => openGenderStageDrill(r.stage, "bc3_control_list")}
              />
            </div>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink, marginBottom: 8 }}>New Recruits</div>
              <DataTable
                columns={genderTableColumns}
                rows={genderSplit.data?.new_recruits || []}
                onRowClick={(r) => openGenderStageDrill(r.stage, "new_recruits")}
              />
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3, marginTop: 12, marginBottom: 6 }}>
                Randomisation, after Eligible
              </div>
              <DataTable
                columns={genderTableColumns}
                rows={[genderSplit.data?.new_recruits_treatment, genderSplit.data?.new_recruits_control].filter(Boolean)}
                onRowClick={(r) => openGenderSplitDrill(r.stage === "Control" ? "new_recruits_control" : "new_recruits_treatment", r.stage)}
              />
            </div>
          </div>
        </State>
      </Card>
      <Card title="Arrival → Retention — gender" subtitle="Both pathways converge here — same shared journey as the funnel-by-pathway card above. Click a stage to drill by district." chip="REAL">
        <State loading={genderSplit.loading} error={genderSplit.error} empty={!genderSplit.loading && (genderSplit.data?.merged || []).length === 0}>
          <DataTable
            columns={genderTableColumns}
            rows={genderSplit.data?.merged || []}
            onRowClick={(r) => openGenderStageDrill(r.stage, "merged")}
          />
          <p style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
            Verified and Assigned are omitted — the live data has no gender breakdown for either.
          </p>
        </State>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 4 }}>
        <div>
          <ExecBand num={6} title="Drop-off analysis" />
          <Card title="Where we lose the most youth" chip="DERIVED">
            <State loading={funnel.loading} error={funnel.error} empty={!funnel.loading && dropoffs.length === 0}>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={dropoffs} layout="vertical" margin={{ left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="to_stage" tick={{ fontSize: 10.5 }} width={90} />
                  <Tooltip formatter={(v, _n, p) => [`${fmtNum(v)} lost`, `${p.payload.from_stage} → ${p.payload.to_stage}`]} />
                  <Bar dataKey="lost" fill={C.coral} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </State>
          </Card>
        </div>
        <div>
          <ExecBand num={7} title="Executive insights" />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {insights.map((ins, i) => <Insight key={i} tone={ins.tone}>{ins.text}</Insight>)}
          </div>
        </div>
      </div>

      <ExecBand num={8} title="Recommended actions" />
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 22 }}>
        {recommendations.map((r, i) => <Insight key={i} tone="neutral">{r}</Insight>)}
      </div>

      <ExecBand num="+" title="OKR tracker" />
      <OkrTracker />
    </div>
  );
}

function CohortComparisonPage() {
  const { data, loading, error } = useApi(`/api/overview/cohort-comparison`);
  const awareness = data?.awareness || [];
  const mobilisation = data?.mobilisation || [];
  const acquisition = data?.acquisition || [];

  return (
    <div>
      <p style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
        Cohort comparison across the whole funnel — Awareness, Mobilisation and Acquisition —
        for every cycle in the live data (BOOTCAMP_2 through the current cycle).
      </p>
      <State loading={loading} error={error} empty={!loading && !awareness.length && !mobilisation.length && !acquisition.length}>
        <ExecBand num="A" title="Awareness by cohort" />
        <Card chip="REAL">
          <DataTable
            columns={[
              { key: "cohort", label: "Cohort" },
              { key: "eligible", label: "Eligible", align: "right", render: (v) => fmtNum(v) },
              { key: "eligibility_rate", label: "Eligibility rate", align: "right", render: renderRateCell("eligibility_rate") },
              { key: "pct_female", label: "% Female", align: "right", render: renderPctFemaleCell },
              { key: "progress_pct", label: "Progress on target", align: "right", render: renderProgressPctCell },
              { key: "parishes", label: "# Parishes", align: "right", render: (v) => fmtNum(v) },
            ]}
            rows={awareness}
          />
        </Card>

        <ExecBand num="M" title="Mobilisation by cohort" />
        <Card chip="REAL">
          <DataTable
            columns={[
              { key: "cohort", label: "Cohort" },
              { key: "assigned", label: "# Assigned", align: "right", render: (v) => fmtNum(v) },
              { key: "reach_rate", label: "Reach rate", align: "right", render: renderRateCell("reach_rate") },
              { key: "mobilisation_rate", label: "Mobilisation rate", align: "right", render: renderRateCell("mobilisation_rate") },
              { key: "progress_pct", label: "Progress on target", align: "right", render: renderProgressPctCell },
              { key: "pct_female", label: "% Female", align: "right", render: renderPctFemaleCell },
            ]}
            rows={mobilisation}
          />
        </Card>

        <ExecBand num="Q" title="Acquisition by cohort" />
        <Card chip="REAL">
          <DataTable
            columns={[
              { key: "cohort", label: "Cohort" },
              { key: "acquired", label: "# Acquired", align: "right", render: (v) => fmtNum(v) },
              { key: "acquisition_rate", label: "Acquisition rate", align: "right", render: renderRateCell("acquisition_rate") },
              { key: "overall_conversion", label: "Overall conversion", align: "right", render: (v) => fmtPct(v) },
              { key: "progress_pct", label: "Progress on target", align: "right", render: renderProgressPctCell },
              { key: "pct_female", label: "% Female", align: "right", render: renderPctFemaleCell },
            ]}
            rows={acquisition}
          />
        </Card>
      </State>
    </div>
  );
}

// ─── Recruitment tabs ──────────────────────────────────────────────────────────

// Awareness — the top of the funnel: 4 sub-pages (Awareness Overview,
// Mobilisers, KYC/Youth Profile, Forecast), matching the design's multi-page layout.
function AwarenessTab({ filters }) {
  const [page, setPage] = useState("overview");
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Awareness</h2>
      <p style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>
        The top of the recruitment funnel: youth reached at awareness events, how many express
        training interest, and how many are eligible — by district, parish and mobiliser.
        Target: 60% of eligible youth female.
      </p>
      <PageNav
        active={page}
        onChange={setPage}
        pages={[
          { key: "overview", label: "Awareness Overview" },
          { key: "mobilisers", label: "Mobilisers" },
          { key: "kyc", label: "KYC / Youth Profile" },
          { key: "forecast", label: "Forecast" },
        ]}
      />
      {page === "overview" && <AwarenessOverviewPage filters={filters} />}
      {page === "mobilisers" && <AwarenessMobilisersPage filters={filters} />}
      {page === "kyc" && <AwarenessKycPage filters={filters} />}
      {page === "forecast" && <AwarenessForecastPage filters={filters} />}
    </div>
  );
}

// Awareness's district rows call the reached count "registered"; its parish
// rows call the same thing "reached" — normalise so one drill spec's columns
// work against either grain.
function withEligibilityRate(r) {
  return { ...r, eligibility_rate: r.interested ? Math.round((1000 * r.eligible) / r.interested) / 10 : null };
}

// District comparison table + its drills: matched parishes rolled up by
// district — hoisted to module scope (no closure over component state, only
// its own parishRows argument) so the export builder can reuse it too.
function groupParishRowsByDistrict(parishRows) {
  const byDistrict = {};
  parishRows.forEach((r) => {
    if (!byDistrict[r.district]) {
      byDistrict[r.district] = {
        district: r.district, registered: 0, interested: 0, eligible: 0, eligible_female: 0, target: 0, usesHardcodedTarget: false,
        eligible_treatment: 0, eligible_control: 0,
      };
    }
    const d = byDistrict[r.district];
    d.registered += r.reached || 0;
    d.interested += r.interested || 0;
    d.eligible += r.eligible || 0;
    d.eligible_female += r.eligible_female || 0;
    d.target += r.target || 0;
    d.eligible_treatment += r.eligible_treatment || 0;
    d.eligible_control += r.eligible_control || 0;
    if (r.target_source === "hardcoded") d.usesHardcodedTarget = true;
  });
  return Object.values(byDistrict)
    .map((d) => ({ ...d, pct_female: d.eligible ? Math.round((1000 * d.eligible_female) / d.eligible) / 10 : null }))
    .sort((a, b) => a.district.localeCompare(b.district));
}

// Maps a stage's district-grain field name (used e.g. by openMetricDrill) to
// the parish endpoint's per-gender column prefix — "registered" everywhere
// else, "reached" on parish rows. Hoisted alongside groupParishRowsByDistrict
// for the same reason.
const GENDER_FIELD_PREFIX = { registered: "reached", interested: "interested", eligible: "eligible" };

function sumGenderByDistrict(parishRows, metricKey) {
  const prefix = GENDER_FIELD_PREFIX[metricKey];
  const byDistrict = {};
  parishRows.forEach((r) => {
    if (!byDistrict[r.district]) byDistrict[r.district] = { district: r.district, female: 0, male: 0 };
    byDistrict[r.district].female += r[`${prefix}_female`] || 0;
    byDistrict[r.district].male += r[`${prefix}_male`] || 0;
  });
  return Object.values(byDistrict);
}

// RCT assignment card + drill — Treatment/Control/Unassigned, straight off
// the same parish-grain rows (`awareness-parish`, via eligible_treatment(_
// female/_male) and eligible_control(_female/_male)) every other card on
// this page already reads. No separate fetch, so a district/parish search
// narrows this card exactly like every other one — it's the same rows.
function withGenderShare(base, female, male) {
  const t = female + male;
  return { ...base, female, male, pct_female: t ? Math.round((1000 * female) / t) / 10 : null };
}

// Expands each enriched parish row into up to 3 flat {arm, district, parish,
// female, male} rows (Treatment/Control/Unassigned) — Unassigned is whatever
// of that parish's eligible female/male isn't in either arm.
function toArmRows(parishRows) {
  const rows = [];
  parishRows.forEach((r) => {
    const { district, parish } = r;
    const tf = r.eligible_treatment_female || 0, tm = r.eligible_treatment_male || 0;
    const cf = r.eligible_control_female || 0, cm = r.eligible_control_male || 0;
    const ef = r.eligible_female || 0, em = r.eligible_male || 0;
    if (tf || tm) rows.push({ arm: "Treatment", district, parish, female: tf, male: tm });
    if (cf || cm) rows.push({ arm: "Control", district, parish, female: cf, male: cm });
    const uf = ef - tf - cf, um = em - tm - cm;
    if (uf || um) rows.push({ arm: "Unassigned", district, parish, female: uf, male: um });
  });
  return rows;
}

function armRootRows(armRows) {
  const totals = {};
  armRows.forEach((r) => {
    if (!totals[r.arm]) totals[r.arm] = { female: 0, male: 0 };
    totals[r.arm].female += r.female || 0;
    totals[r.arm].male += r.male || 0;
  });
  return ["Treatment", "Control"]
    .filter((arm) => totals[arm])
    .map((arm) => withGenderShare({ arm }, totals[arm].female, totals[arm].male));
}

function armDistrictRows(armRows, arm) {
  const byDistrict = {};
  armRows.filter((r) => r.arm === arm).forEach((r) => {
    if (!byDistrict[r.district]) byDistrict[r.district] = { district: r.district, arm, female: 0, male: 0 };
    byDistrict[r.district].female += r.female || 0;
    byDistrict[r.district].male += r.male || 0;
  });
  return Object.values(byDistrict)
    .map((d) => withGenderShare(d, d.female, d.male))
    .sort((a, b) => (b.female + b.male) - (a.female + a.male));
}

function armParishRows(armRows, arm, district) {
  return armRows
    .filter((r) => r.arm === arm && r.district === district)
    .map((r) => withGenderShare({ parish: r.parish }, r.female, r.male))
    .sort((a, b) => (b.female + b.male) - (a.female + a.male));
}

// RCT assignment card's headline counts, summed directly off the same
// (possibly search-matched) parish rows the rest of the page uses.
function assignmentTotals(parishRows) {
  const eligible_count = sumBy(parishRows, "eligible");
  const treatment_count = sumBy(parishRows, "eligible_treatment");
  const control_count = sumBy(parishRows, "eligible_control");
  const assigned_count = treatment_count + control_count;
  const unassigned_count = eligible_count - assigned_count;
  return {
    eligible_count,
    treatment_count,
    control_count,
    unassigned_count,
    assigned_count,
    pct_treatment: assigned_count ? Math.round((1000 * treatment_count) / assigned_count) / 10 : null,
    pct_control: assigned_count ? Math.round((1000 * control_count) / assigned_count) / 10 : null,
    pct_unassigned: eligible_count ? Math.round((1000 * unassigned_count) / eligible_count) / 10 : null,
  };
}

function AwarenessOverviewPage({ filters }) {
  const drill = useDrill();
  const [search, setSearch] = useState("");
  const [parishCat, setParishCat] = useState("All");
  const [districtCat, setDistrictCat] = useState("All");
  const [parishPage, setParishPage] = useState(0);
  const parish = useApi(`/api/recruitment/awareness-parish${buildParams(filters)}`);

  const parishRowsRaw = parish.data?.parishes || [];

  // Universal search: every metric on this page — score cards, funnel chart,
  // gauges, District comparison, the RCT assignment card and its drill, and
  // the parish table — is computed straight from matched PARISH rows, so a
  // specific-parish search (e.g. "bubugo") narrows every one of them to that
  // exact parish's own numbers, not its whole containing district. A
  // district-wide search (e.g. "bugweri") sums to the same totals as
  // searching nothing scoped to that district, since it matches every
  // parish inside it. The parish endpoint carries real per-gender columns
  // too (reached/interested/eligible x female/male, same total_*_female/male
  // source _stage_counts uses at district grain in overview.py), plus the
  // RCT eligible_treatment/eligible_control (+ female/male) columns — this
  // is the one data source the whole page needs.
  const q = search.trim().toLowerCase();
  const matchedParishRowsForSearch = q
    ? parishRowsRaw.filter((r) => (r.district || "").toLowerCase().includes(q) || (r.parish || "").toLowerCase().includes(q))
    : parishRowsRaw;

  const assignmentAgg = assignmentTotals(matchedParishRowsForSearch);

  // District comparison table + its drills: matched parishes rolled up by
  // district (groupParishRowsByDistrict, module-scope above) — narrows in
  // row COUNT (fewer districts) for a district-wide search, and in VALUE
  // (smaller totals) for a specific-parish search, since only the matched
  // parishes are summed into each district's row.
  const filteredRows = groupParishRowsByDistrict(matchedParishRowsForSearch);

  // Same rate-vs-target bands as the parish-level "Parish Performance" section
  // below (eligible ÷ registration target, aggregated up from the same
  // per-parish targets) — districts get the identical score-card + status
  // treatment parishes already have, not just a bare Target column.
  const districtRowsWithCat = filteredRows.map((d) => {
    const rate = d.target ? Math.round((1000 * d.eligible) / d.target) / 10 : null;
    return { ...d, rate, category: categorizeRate(rate) };
  });
  const districtCatCounts = { All: districtRowsWithCat.length };
  RATE_CATEGORY_ORDER.forEach((c) => { districtCatCounts[c] = districtRowsWithCat.filter((r) => r.category === c).length; });
  const filteredDistrictRows = districtCat === "All" ? districtRowsWithCat : districtRowsWithCat.filter((r) => r.category === districtCat);

  const reached = sumBy(matchedParishRowsForSearch, "reached");
  const interested = sumBy(matchedParishRowsForSearch, "interested");
  const eligible = sumBy(matchedParishRowsForSearch, "eligible");
  const target = sumBy(matchedParishRowsForSearch, "target");
  const eligibilityRate = interested ? Math.round((1000 * eligible) / interested) / 10 : null;

  // Percentages + RAG status for the top score-card row — same read as the
  // reference prototype's awareKpi strip, computed live from this cohort.
  const intRate = reached ? Math.round((1000 * interested) / reached) / 10 : null;
  const eligRateOfReached = reached ? Math.round((1000 * eligible) / reached) / 10 : null;
  const progressPct = target ? Math.round((1000 * eligible) / target) / 10 : null;
  const progressCategory = categorizeRate(progressPct);
  const eligTarget = RATE_TARGETS.eligibility_rate;
  const eligStatus = eligibilityRate == null ? null
    : eligibilityRate >= eligTarget.good ? { label: `At/above the ${eligTarget.good}% target`, color: C.green }
    : eligibilityRate >= eligTarget.warn ? { label: `Approaching the ${eligTarget.good}% target`, color: C.gold }
    : { label: `Below the ${eligTarget.warn}% warning threshold`, color: C.coral };

  function openMetricDrill(metricKey, label, formatter = fmtNum) {
    const rootRows = filteredRows.map(withEligibilityRate).sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0));
    drill.open({
      title: `${label} — by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [{ key: metricKey, label, align: "right", render: formatter }],
      rootRows,
      childKey: "parish", childLabel: "Parish",
      getChildRows: (root) => parishRowsRaw
        .filter((p) => p.district === root.district)
        .map((p) => withEligibilityRate({ ...p, registered: p.reached }))
        .sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0)),
    });
  }

  // RCT assignment card -> gender split by arm, then district and parish
  // within whichever arm was clicked. "‹ Back" from the district table goes
  // to the arm root (both Treatment and Control gender ratios), matching
  // openAt's usual use — the click already identifies the arm, no need to
  // make the user pick it again from that root list. Reads the same
  // search-matched rows as the card itself, so drilling in doesn't reset
  // whatever district/parish search is active.
  function openArmAssignmentDrill(arm) {
    const armRows = toArmRows(matchedParishRowsForSearch);
    const spec = {
      title: "Eligible youth — RCT assignment, by gender",
      tone: "real", tagLabel: "REAL",
      rootKey: "arm", rootLabel: "Arm",
      columns: [
        { key: "female", label: "Female", align: "right", render: fmtNum },
        { key: "male", label: "Male", align: "right", render: fmtNum },
        { key: "pct_female", label: "% Female", align: "right", render: fmtPct },
      ],
      rootRows: () => armRootRows(toArmRows(matchedParishRowsForSearch)),
      childKey: "district", childLabel: "District",
      getChildRows: (root) => armDistrictRows(toArmRows(matchedParishRowsForSearch), root.arm),
      grandchildKey: "parish", grandchildLabel: "Parish",
      getGrandchildRows: (child) => armParishRows(toArmRows(matchedParishRowsForSearch), child.arm, child.district),
    };
    const rootRow = armRootRows(armRows).find((r) => r.arm === arm) || { arm, female: 0, male: 0, pct_female: null };
    drill.openAt(spec, rootRow);
  }

  const stageStats = [
    { key: "registered", label: "Reached" },
    { key: "interested", label: "Interested" },
    { key: "eligible", label: "Eligible" },
  ].map(({ key, label }) => {
    const prefix = GENDER_FIELD_PREFIX[key];
    const f = sumBy(matchedParishRowsForSearch, `${prefix}_female`);
    const m = sumBy(matchedParishRowsForSearch, `${prefix}_male`);
    const t = f + m;
    return {
      key, stage: label, female: f, male: m,
      pct_female: t ? Math.round((1000 * f) / t) / 10 : null,
      pct_male: t ? Math.round((1000 * m) / t) / 10 : null,
    };
  });
  const genderLoading = parish.loading;
  const genderError = parish.error;

  // Bar click -> drill this exact stage+gender's count by district, grouped
  // from the same search-matched parish rows the chart itself uses — so the
  // drill stays consistent with whatever the chart is currently showing.
  function openFunnelBarDrill(metricKey, gender, stageLabel) {
    const byDistrict = sumGenderByDistrict(matchedParishRowsForSearch, metricKey);
    const rootRows = byDistrict
      .map((r) => ({ district: r.district, [metricKey]: gender === "Female" ? r.female : r.male }))
      .sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0));
    drill.open({
      title: `${stageLabel} (${gender}) — by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [{ key: metricKey, label: stageLabel, align: "right", render: fmtNum }],
      rootRows,
    });
  }

  // Gauge / "Eligible female" tile click -> % female (and the female/male
  // counts behind it) for this exact stage, by district then parish — same
  // search-matched parish rows as the gauge itself. Parish rows carry their
  // own overall pct_female (used by the Parish Performance table), so the
  // stage-specific share is written last to override it.
  function openGenderStageDrill(metricKey, stageLabel) {
    const prefix = GENDER_FIELD_PREFIX[metricKey];
    const withStageShare = (row, female, male) => {
      const t = female + male;
      return { ...row, female, male, pct_female: t ? Math.round((1000 * female) / t) / 10 : null };
    };
    const rootRows = sumGenderByDistrict(matchedParishRowsForSearch, metricKey)
      .map((r) => withStageShare({ district: r.district }, r.female, r.male))
      .sort((a, b) => (b.pct_female ?? -1) - (a.pct_female ?? -1));
    drill.open({
      title: `${stageLabel} — % female by district`,
      tone: "real", tagLabel: "DERIVED",
      rootKey: "district", rootLabel: "District",
      columns: [
        { key: "female", label: "Female", align: "right", render: fmtNum },
        { key: "male", label: "Male", align: "right", render: fmtNum },
        { key: "pct_female", label: "% Female", align: "right", render: fmtPct },
      ],
      rootRows,
      childKey: "parish", childLabel: "Parish",
      getChildRows: (root) => matchedParishRowsForSearch
        .filter((p) => p.district === root.district)
        .map((p) => withStageShare(p, p[`${prefix}_female`] || 0, p[`${prefix}_male`] || 0))
        .sort((a, b) => (b.pct_female ?? -1) - (a.pct_female ?? -1)),
    });
  }

  function renderFunnelBarLabel(genderKey) {
    return (props) => {
      const { x, y, width, value, index } = props;
      const row = stageStats[index];
      const pct = genderKey === "female" ? row?.pct_female : row?.pct_male;
      const text = pct != null ? `${fmtNum(value)} (${fmtPct(pct)})` : fmtNum(value);
      return (
        <text x={x + width / 2} y={y - 6} textAnchor="middle" fontSize={10.5} fontWeight={600} fill={C.ink}>
          {text}
        </text>
      );
    };
  }

  // Data-driven read on where the 60% female target is actually being lost —
  // mirrors the reference prototype's "the lever is reach, not eligibility"
  // note, computed live from this cohort's real Reached vs Eligible split.
  const reachedFemalePct = stageStats[0]?.pct_female;
  const eligibleFemalePct = stageStats[2]?.pct_female;
  // Headline female-eligible share for the score-card row. Taken from the
  // same per-gender parish columns the funnel chart and gauges use, so the
  // tile, the Eligible gauge and this page's search filter can never
  // disagree — female / (female + male) at the Eligible stage.
  const eligibleFemaleStatus = femaleShareStatus(eligibleFemalePct);
  let femaleGapInsight = null;
  if (reachedFemalePct != null && eligibleFemalePct != null) {
    const holds = eligibleFemalePct >= reachedFemalePct - 1;
    femaleGapInsight = {
      tone: holds ? (eligibleFemalePct >= 60 ? "pos" : "warn") : "risk",
      text: holds
        ? `Female share ${eligibleFemalePct >= reachedFemalePct ? "holds or improves" : "roughly holds"} through eligibility screening — ${fmtPct(reachedFemalePct)} at Reached vs ${fmtPct(eligibleFemalePct)} at Eligible. ${eligibleFemalePct >= 60 ? "At or above the 60% target." : "The gap to the 60% target opens at reach, not screening — eligibility itself isn't the constraint."}`
        : `Female share drops through eligibility screening — ${fmtPct(reachedFemalePct)} at Reached falls to ${fmtPct(eligibleFemalePct)} at Eligible. Unlike reach, this gap is being created by who qualifies, not just who's contacted.`,
    };
  }

  // Same rate-vs-target bands as the Mobilisation/Acquisition venue
  // categorisation (see RATE_CATEGORY_* / EntityCategorisation), applied here
  // at parish grain: eligible ÷ registration target. Carries every field the
  // detail table needs too, so the category tiles and the table are driven
  // by one row set — click a tile, filter the same table, no separate panel.
  const parishRowsWithCat = parishRowsRaw.map((r) => {
    const rate = r.target ? Math.round((1000 * r.eligible) / r.target) / 10 : null;
    return { ...r, rate, category: categorizeRate(rate) };
  });
  const parishCatCounts = { All: parishRowsWithCat.length };
  RATE_CATEGORY_ORDER.forEach((c) => { parishCatCounts[c] = parishRowsWithCat.filter((r) => r.category === c).length; });

  const filteredParishRows = parishRowsWithCat.filter((r) => {
    if (parishCat !== "All" && r.category !== parishCat) return false;
    if (!q) return true;
    return (r.district || "").toLowerCase().includes(q) || (r.parish || "").toLowerCase().includes(q);
  });
  const parishPageSize = 10;
  const parishMaxPage = Math.max(0, Math.ceil(filteredParishRows.length / parishPageSize) - 1);
  const parishPageClamped = Math.min(parishPage, parishMaxPage);
  const pagedParishRows = filteredParishRows.slice(parishPageClamped * parishPageSize, parishPageClamped * parishPageSize + parishPageSize);

  return (
    <div>
      <input
        type="text"
        value={search}
        onChange={(e) => { setSearch(e.target.value); setParishPage(0); }}
        placeholder="Search parish or district…"
        style={{ width: "100%", fontSize: 12, padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 5, marginBottom: 4 }}
      />
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 14 }}>
        Filters every metric on this page to the exact parish or district you search for — score cards, the RCT assignment card and its drill, the funnel chart, gauges, District comparison, and the parish table below.
      </div>

      <Grid cols={4}>
        <KpiTile label="Reached" value={fmtNum(reached)} sub="Engaged at an awareness activity" onClick={() => openMetricDrill("registered", "Reached")} />
        <KpiTile
          label="Interested" value={fmtNum(interested)}
          sub={intRate != null ? `${intRate}% of reached expressed training interest` : undefined}
          onClick={() => openMetricDrill("interested", "Interested")}
        />
        <KpiTile
          label="Eligible" value={fmtNum(eligible)}
          sub={eligRateOfReached != null ? `${eligRateOfReached}% of reached qualify — age 18–30, P5–S3, ≤UGX 30,000 income` : undefined}
          onClick={() => openMetricDrill("eligible", "Eligible")}
        />
        <KpiTile
          label="Registration target" value={fmtNum(target)}
          sub={progressPct != null ? <span style={{ color: RATE_CATEGORY_COLOR[progressCategory], fontWeight: 700 }}>{fmtPct(progressPct)} of target reached — {progressCategory}</span> : undefined}
          onClick={() => openMetricDrill("target", "Registration target")}
        />
        <KpiTile
          label="Eligibility rate" value={fmtPct(eligibilityRate)}
          sub={eligStatus ? <span style={{ color: eligStatus.color, fontWeight: 700 }}>{eligStatus.label}</span> : "Eligible / Interested"}
          onClick={() => openMetricDrill("eligibility_rate", "Eligibility rate", fmtPct)}
        />
        <KpiTile
          label="Eligible female" value={fmtPct(eligibleFemalePct)}
          sub={eligibleFemaleStatus
            ? <span style={{ color: eligibleFemaleStatus.color, fontWeight: 700 }}>{eligibleFemaleStatus.label} (60% target)</span>
            : "Female share of eligible youth"}
          onClick={() => openGenderStageDrill("eligible", "Eligible")}
        />
      </Grid>

      <Card
        title="Eligible youth — RCT assignment"
        subtitle="Of eligible youth with a recorded Treatment/Control assignment, the share in each arm. Coverage is cohort-dependent — BOOTCAMP_2/3 predate randomization and BOOTCAMP_4 is only partially assigned, so 'not yet assigned' is usually the majority whenever those cohorts are in view; narrow the cohort filter to BOOTCAMP_5 to see where assignment is most complete. Click either card for the gender split, by district and parish."
        chip="REAL"
      >
        <State loading={parish.loading} error={parish.error} empty={!parish.loading && !assignmentAgg.eligible_count}>
          <Grid cols={2}>
            <KpiTile
              label="Eligible — Treatment" value={fmtNum(assignmentAgg.treatment_count)}
              sub={assignmentAgg.pct_treatment != null ? `${fmtPct(assignmentAgg.pct_treatment)} of assigned eligible youth` : undefined}
              onClick={() => openArmAssignmentDrill("Treatment")}
            />
            <KpiTile
              label="Eligible — Control" value={fmtNum(assignmentAgg.control_count)}
              sub={assignmentAgg.pct_control != null ? `${fmtPct(assignmentAgg.pct_control)} of assigned eligible youth` : undefined}
              onClick={() => openArmAssignmentDrill("Control")}
            />
          </Grid>
          {assignmentAgg.unassigned_count > 0 && (
            <p style={{ fontSize: 11, color: C.muted, marginTop: -6 }}>
              <b>{fmtNum(assignmentAgg.unassigned_count)}</b> eligible youth ({fmtPct(assignmentAgg.pct_unassigned)} of {fmtNum(assignmentAgg.eligible_count)}) have no Treatment/Control assignment recorded yet — not folded into the percentages above, which are of the assigned pool only.
            </p>
          )}
        </State>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <Card title="Awareness funnel Numbers disaggregated by Gender" subtitle="Female vs male at each stage (value and % of that stage) — click a bar to drill by district" chip="REAL">
          <State loading={genderLoading} error={genderError} empty={!genderLoading && stageStats.every((s) => !s.female && !s.male)}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={stageStats} margin={{ top: 20, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis dataKey="stage" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip /><Legend />
                <Bar
                  dataKey="female" name="Female" fill={C.coral} radius={[4, 4, 0, 0]} cursor="pointer"
                  label={renderFunnelBarLabel("female")}
                  onClick={(_, index) => openFunnelBarDrill(stageStats[index].key, "Female", stageStats[index].stage)}
                />
                <Bar
                  dataKey="male" name="Male" fill={C.teal} radius={[4, 4, 0, 0]} cursor="pointer"
                  label={renderFunnelBarLabel("male")}
                  onClick={(_, index) => openFunnelBarDrill(stageStats[index].key, "Male", stageStats[index].stage)}
                />
              </BarChart>
            </ResponsiveContainer>
          </State>
        </Card>
        <Card title="Female representation vs 60% target" subtitle="Share of each funnel stage that is female — click a gauge to drill by district" chip="DERIVED">
          <State loading={genderLoading} error={genderError} empty={!genderLoading && stageStats.every((s) => s.pct_female == null)}>
            <div style={{ paddingTop: 8 }}>
              {stageStats.map((s) => (
                <Gauge key={s.stage} label={s.stage} pct={s.pct_female} target={60} onClick={() => openGenderStageDrill(s.key, s.stage)} />
              ))}
            </div>
            {femaleGapInsight && (
              <div style={{ marginTop: 4 }}>
                <Insight tone={femaleGapInsight.tone}>{femaleGapInsight.text}</Insight>
              </div>
            )}
          </State>
        </Card>
      </div>

      <Card title="District comparison — vs. registration target" subtitle="Reached, interested, eligible (with its Treatment/Control RCT split), target and female share by district — narrows to the exact parish you search for, rolled up by district. Click a score card to filter by category — color shows status throughout." chip="REAL">
        <State loading={parish.loading} error={parish.error} empty={!parish.loading && districtRowsWithCat.length === 0}>
          <CategoryFilterTiles counts={districtCatCounts} active={districtCat} onChange={setDistrictCat} entityLabelPlural="districts" />
          <DataTable
            columns={[
              { key: "district", label: "District" },
              { key: "registered", label: "Reached", align: "right", render: (v) => fmtNum(v) },
              { key: "interested", label: "Interested", align: "right", render: (v) => fmtNum(v) },
              { key: "eligible", label: "Eligible", align: "right", render: (v) => fmtNum(v) },
              { key: "eligible_treatment", label: "Treatment", align: "right", render: (v) => fmtNum(v) },
              { key: "eligible_control", label: "Control", align: "right", render: (v) => fmtNum(v) },
              {
                key: "target", label: "Target", align: "right",
                render: (v, r) => <span title={r.usesHardcodedTarget ? "Includes the hardcoded BC5 planning target for at least one parish in this district" : undefined}>{fmtNum(v)}{r.usesHardcodedTarget ? " *" : ""}</span>,
              },
              { key: "pct_female", label: "% Female", align: "right", render: renderPctFemaleCell },
              { key: "rate", label: "Progress", align: "right", render: (v, r) => <span style={{ color: RATE_CATEGORY_COLOR[r.category], fontWeight: 700 }}>{fmtPct(v)}</span> },
              { key: "category", label: "Status", render: (v) => <span style={{ background: `${RATE_CATEGORY_COLOR[v]}22`, color: RATE_CATEGORY_COLOR[v], fontWeight: 700, fontSize: 11, padding: "3px 9px", borderRadius: 10, whiteSpace: "nowrap" }}>{v}</span> },
            ]}
            rows={filteredDistrictRows}
          />
          {filteredDistrictRows.length === 0 && (
            <div style={{ padding: 24, textAlign: "center", color: C.muted, fontSize: 12.5 }}>No districts match this filter.</div>
          )}
          <p style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>* Target includes the hardcoded BC5 planning sheet for at least one parish — see Parish Performance below for the exact per-parish source.</p>
        </State>
      </Card>

      <Card title="Parish Performance" subtitle="Reached, interested, eligible (with its Treatment/Control RCT split), target and % female per parish. Click a score card to filter by category — color shows status throughout." chip="REAL">
        <State loading={parish.loading} error={parish.error} empty={!parish.loading && parishRowsWithCat.length === 0}>
          <CategoryFilterTiles counts={parishCatCounts} active={parishCat} onChange={(c) => { setParishCat(c); setParishPage(0); }} entityLabelPlural="parishes" />
          {filteredParishRows.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: C.muted, fontSize: 12.5 }}>No parishes match this filter.</div>
          ) : (
            <>
              <DataTable
                columns={[
                  { key: "district", label: "District" },
                  { key: "parish", label: "Parish" },
                  { key: "reached", label: "Reached", align: "right", render: (v) => fmtNum(v) },
                  { key: "interested", label: "Interested", align: "right", render: (v) => fmtNum(v) },
                  { key: "eligible", label: "Eligible", align: "right", render: (v) => fmtNum(v) },
                  { key: "eligible_treatment", label: "Treatment", align: "right", render: (v) => fmtNum(v) },
                  { key: "eligible_control", label: "Control", align: "right", render: (v) => fmtNum(v) },
                  {
                    key: "target", label: "Target", align: "right",
                    render: (v, r) => <span title={r.target_source === "hardcoded" ? "Hardcoded BC5 planning target" : undefined}>{fmtNum(v)}{r.target_source === "hardcoded" ? " *" : ""}</span>,
                  },
                  { key: "pct_female", label: "% Female", align: "right", render: (v) => <span style={{ color: v == null ? C.muted : v >= 60 ? C.green : C.coral, fontWeight: 700 }}>{fmtPct(v)}</span> },
                  { key: "rate", label: "Progress", align: "right", render: (v, r) => <span style={{ color: RATE_CATEGORY_COLOR[r.category], fontWeight: 700 }}>{fmtPct(v)}</span> },
                  { key: "category", label: "Status", render: (v) => <span style={{ background: `${RATE_CATEGORY_COLOR[v]}22`, color: RATE_CATEGORY_COLOR[v], fontWeight: 700, fontSize: 11, padding: "3px 9px", borderRadius: 10, whiteSpace: "nowrap" }}>{v}</span> },
                ]}
                rows={pagedParishRows}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9, fontSize: 11, color: C.muted }}>
                <span>{parishPageClamped * parishPageSize + 1}–{Math.min(filteredParishRows.length, parishPageClamped * parishPageSize + parishPageSize)} of {filteredParishRows.length}</span>
                <span style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => setParishPage(Math.max(0, parishPageClamped - 1))} disabled={parishPageClamped === 0} style={{ ...PAGER_BTN, opacity: parishPageClamped === 0 ? 0.5 : 1 }}>‹ Prev</button>
                  <button onClick={() => setParishPage(Math.min(parishMaxPage, parishPageClamped + 1))} disabled={parishPageClamped === parishMaxPage} style={{ ...PAGER_BTN, opacity: parishPageClamped === parishMaxPage ? 0.5 : 1 }}>Next ›</button>
                </span>
              </div>
              <p style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>* Hardcoded BC5 planning target (currently MAYUGE/IGANGA only) — no target is shown for any other parish (no live source since the Awareness tab moved off the gold summary mart).</p>
            </>
          )}
        </State>
      </Card>
    </div>
  );
}

// Female-share status band shown on the mobiliser table's Status column —
// a 3-tier read (On target / Approaching / Below target) matching the
// reference prototype's femaleStatus(), distinct from the 5-tier
// RATE_CATEGORY_* bands used elsewhere (which measure progress vs a
// registration target, not gender share).
function femaleShareStatus(pct) {
  if (pct == null) return null;
  if (pct >= 60) return { label: "On target", color: C.green };
  if (pct >= 50) return { label: "Approaching", color: C.gold };
  return { label: "Below target", color: C.coral };
}

function AwarenessMobilisersPage({ filters }) {
  const drill = useDrill();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [insightFilter, setInsightFilter] = useState(null); // null | "top" | "below" | "spread"
  const { data, loading, error } = useApi(`/api/recruitment/awareness-mobilisers${buildParams(filters)}`);
  const parish = useApi(`/api/recruitment/awareness-parish${buildParams(filters)}`);
  const detail = useApi(`/api/recruitment/awareness-mobiliser-detail${buildParams(filters)}`);
  const allRows = data?.mobilisers || [];

  const q = search.trim().toLowerCase();
  const rows = (q ? allRows.filter((r) => (r.mobiliser_name || "").toLowerCase().includes(q)) : allRows)
    .map((r) => ({ ...r, eligibility_rate: r.reached ? Math.round((1000 * r.eligible) / r.reached) / 10 : null }));

  const distinctMobilisers = new Set(rows.map((r) => r.mobiliser_name)).size;
  const totalReached = sumBy(rows, "reached");
  const totalEligible = sumBy(rows, "eligible");
  const eligibilityRate = totalReached ? Math.round((1000 * totalEligible) / totalReached) / 10 : null;

  // Data-driven reads on the current (search-filtered) mobiliser set — no
  // fabricated target exists per mobiliser (see below), so insights focus on
  // volume leadership and the real female-share spread instead.
  const withFemaleData = rows.filter((r) => r.pct_eligible_female != null);
  const topMobiliser = rows.length ? [...rows].sort((a, b) => (b.eligible || 0) - (a.eligible || 0))[0] : null;
  const belowTarget = withFemaleData.filter((r) => r.pct_eligible_female < 60);
  const best = withFemaleData.length ? withFemaleData.reduce((a, b) => (b.pct_eligible_female > a.pct_eligible_female ? b : a)) : null;
  const worst = withFemaleData.length ? withFemaleData.reduce((a, b) => (b.pct_eligible_female < a.pct_eligible_female ? b : a)) : null;
  const spread = best && worst ? Math.round((best.pct_eligible_female - worst.pct_eligible_female) * 10) / 10 : null;

  // Each insight is also a filter — click one to narrow the table below to
  // exactly the mobiliser(s) it's about; click the active one again to reset.
  const sameMobiliser = (a, b) => a.mobiliser_name === b.mobiliser_name && a.district === b.district;
  let displayRows = rows;
  let filterLabel = null;
  if (insightFilter === "top" && topMobiliser) {
    displayRows = rows.filter((r) => sameMobiliser(r, topMobiliser));
    filterLabel = `Top mobiliser: ${topMobiliser.mobiliser_name}`;
  } else if (insightFilter === "below") {
    displayRows = belowTarget;
    filterLabel = "Below the 60% female-eligible target";
  } else if (insightFilter === "spread" && best && worst) {
    displayRows = rows.filter((r) => sameMobiliser(r, best) || sameMobiliser(r, worst));
    filterLabel = `Female-share spread: ${worst.mobiliser_name} vs ${best.mobiliser_name}`;
  }

  const pageSize = 10;
  const maxPage = Math.max(0, Math.ceil(displayRows.length / pageSize) - 1);
  const clampedPage = Math.min(page, maxPage);
  const pagedRows = displayRows.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);

  // Top KPI tiles -> district-then-parish drill for that metric, sourced
  // from the same awareness-parish data the Awareness Overview page uses
  // (real counts at parish grain, not values re-derived from mobiliser rows).
  function openMetricDrill(metricKey, label, formatter = fmtNum) {
    const parishRows = parish.data?.parishes || [];
    const byDistrict = {};
    parishRows.forEach((r) => {
      if (!byDistrict[r.district]) byDistrict[r.district] = { district: r.district, reached: 0, eligible: 0 };
      const d = byDistrict[r.district];
      d.reached += r.reached || 0;
      d.eligible += r.eligible || 0;
    });
    const rootRows = Object.values(byDistrict).sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0));
    drill.open({
      title: `${label} — by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [{ key: metricKey, label, align: "right", render: formatter }],
      rootRows,
      childKey: "parish", childLabel: "Parish",
      getChildRows: (root) => parishRows
        .filter((p) => p.district === root.district)
        .sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0)),
    });
  }

  // Mobiliser row click -> district-then-parish drill for that one mobiliser,
  // matched by mobilizer_id (stable, not PII) so it works regardless of
  // whether the name is masked.
  function openMobiliserDrill(mobiliserRow) {
    const detailRows = (detail.data?.detail || []).filter((r) => r.mobilizer_id === mobiliserRow.mobilizer_id);
    const byDistrict = {};
    detailRows.forEach((r) => {
      if (!byDistrict[r.district]) byDistrict[r.district] = { district: r.district, reached: 0, eligible: 0, eligible_female: 0 };
      const d = byDistrict[r.district];
      d.reached += r.reached || 0;
      d.eligible += r.eligible || 0;
      d.eligible_female += r.eligible_female || 0;
    });
    const rootRows = Object.values(byDistrict)
      .map((d) => ({ ...d, pct_eligible_female: d.eligible ? Math.round((1000 * d.eligible_female) / d.eligible) / 10 : null }))
      .sort((a, b) => (b.eligible || 0) - (a.eligible || 0));
    drill.open({
      title: `${mobiliserRow.mobiliser_name} — by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [
        { key: "reached", label: "Reached", align: "right", render: fmtNum },
        { key: "eligible", label: "Eligible", align: "right", render: fmtNum },
        { key: "pct_eligible_female", label: "% Eligible Female", align: "right", render: fmtPct },
      ],
      rootRows,
      childKey: "parish", childLabel: "Parish",
      getChildRows: (root) => detailRows
        .filter((r) => r.district === root.district)
        .sort((a, b) => (b.eligible || 0) - (a.eligible || 0)),
    });
  }

  function toggleInsightFilter(key) {
    setInsightFilter((cur) => (cur === key ? null : key));
    setPage(0);
  }

  return (
    <div>
      <input
        type="text"
        value={search}
        onChange={(e) => { setSearch(e.target.value); setPage(0); }}
        placeholder="Search mobiliser…"
        style={{ width: "100%", fontSize: 12, padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 5, marginBottom: 4 }}
      />
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 14 }}>
        Searches the "Performance by mobiliser" table below.
      </div>

      {/* Overall female-eligible share lives on the Awareness Overview page's
          score-card row — this page keeps the per-mobiliser female read only
          (the insights and the table's % Eligible Female / Status columns). */}
      <Grid cols={3}>
        <KpiTile label="Mobilisers" value={String(distinctMobilisers)} sub="in view" />
        <KpiTile label="Reached" value={fmtNum(totalReached)} onClick={() => openMetricDrill("reached", "Reached")} />
        <KpiTile
          label="Eligible" value={fmtNum(totalEligible)}
          sub={eligibilityRate != null ? `${eligibilityRate}% eligibility rate` : undefined}
          onClick={() => openMetricDrill("eligible", "Eligible")}
        />
      </Grid>

      {rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 8 }}>
          {topMobiliser && (
            <div
              onClick={() => toggleInsightFilter("top")}
              style={{ cursor: "pointer", borderRadius: 6, outline: insightFilter === "top" ? `2px solid ${C.green}` : "none", outlineOffset: 1 }}
            >
              <Insight tone="pos">
                <b>{topMobiliser.mobiliser_name}</b> ({topMobiliser.district}) has reached the most eligible youth — <b>{fmtNum(topMobiliser.eligible)}</b> eligible ({fmtPct(topMobiliser.eligibility_rate)} eligibility rate). <i>Click to filter.</i>
              </Insight>
            </div>
          )}
          {withFemaleData.length > 0 && (
            <div
              onClick={() => toggleInsightFilter("below")}
              style={{ cursor: "pointer", borderRadius: 6, outline: insightFilter === "below" ? `2px solid ${belowTarget.length ? C.gold : C.green}` : "none", outlineOffset: 1 }}
            >
              <Insight tone={belowTarget.length ? "warn" : "pos"}>
                <b>{belowTarget.length}</b> of {withFemaleData.length} mobilisers are below the 60% female-eligible target — see the Status column. <i>Click to filter.</i>
              </Insight>
            </div>
          )}
          {best && worst && best !== worst && (
            <div
              onClick={() => toggleInsightFilter("spread")}
              style={{ cursor: "pointer", borderRadius: 6, outline: insightFilter === "spread" ? `2px solid ${C.teal}` : "none", outlineOffset: 1 }}
            >
              <Insight tone="neutral">
                Female-eligible share ranges from <b>{fmtPct(worst.pct_eligible_female)}</b> ({worst.mobiliser_name}) to <b>{fmtPct(best.pct_eligible_female)}</b> ({best.mobiliser_name}) — a {spread}pp spread across mobilisers. <i>Click to filter.</i>
              </Insight>
            </div>
          )}
        </div>
      )}

      {filterLabel && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, fontSize: 12 }}>
          <span style={{ color: C.muted }}>Filtered by:</span>
          <span style={{ background: C.ink, color: C.white, fontWeight: 700, padding: "3px 10px", borderRadius: 10, fontSize: 11 }}>{filterLabel}</span>
          <span onClick={() => toggleInsightFilter(insightFilter)} style={{ color: C.teal, fontWeight: 700, cursor: "pointer" }}>✕ Clear</span>
        </div>
      )}

      <Card title="Performance by mobiliser" subtitle="Who is reaching youth, and whether their reach converts to eligible — and to eligible female. Click a row to drill that mobiliser by district, then parish." chip="PII" chipTone="pii">
        <State loading={loading} error={error} empty={!loading && displayRows.length === 0}>
          <DataTable
            columns={[
              { key: "mobiliser_name", label: "Mobiliser" },
              { key: "district", label: "District" },
              { key: "reached", label: "Reached", align: "right", render: (v) => fmtNum(v) },
              { key: "eligible", label: "Eligible", align: "right", render: (v) => fmtNum(v) },
              { key: "eligibility_rate", label: "Elig. rate", align: "right", render: (v) => fmtPct(v) },
              { key: "eligible_female", label: "Eligible (F)", align: "right", render: (v) => fmtNum(v) },
              {
                key: "pct_eligible_female", label: "% Eligible Female", align: "right",
                render: (v) => {
                  const st = femaleShareStatus(v);
                  const color = st ? st.color : C.muted;
                  return (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                      <div style={{ width: 60, background: C.line, borderRadius: 4, height: 7, overflow: "hidden" }}>
                        <div style={{ width: `${v == null ? 0 : Math.max(0, Math.min(100, v))}%`, height: "100%", background: color }} />
                      </div>
                      <span style={{ color, fontWeight: 700, minWidth: 38, textAlign: "right" }}>{fmtPct(v)}</span>
                    </div>
                  );
                },
              },
              {
                key: "status", label: "Status",
                render: (_v, r) => {
                  const st = femaleShareStatus(r.pct_eligible_female);
                  return st ? <span style={{ background: `${st.color}22`, color: st.color, fontWeight: 700, fontSize: 11, padding: "3px 9px", borderRadius: 10, whiteSpace: "nowrap" }}>{st.label}</span> : "—";
                },
              },
            ]}
            rows={pagedRows}
            onRowClick={openMobiliserDrill}
          />
          {displayRows.length > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9, fontSize: 11, color: C.muted }}>
              <span>{clampedPage * pageSize + 1}–{Math.min(displayRows.length, clampedPage * pageSize + pageSize)} of {displayRows.length}</span>
              <span style={{ display: "flex", gap: 6 }}>
                <button onClick={() => setPage(Math.max(0, clampedPage - 1))} disabled={clampedPage === 0} style={{ ...PAGER_BTN, opacity: clampedPage === 0 ? 0.5 : 1 }}>‹ Prev</button>
                <button onClick={() => setPage(Math.min(maxPage, clampedPage + 1))} disabled={clampedPage === maxPage} style={{ ...PAGER_BTN, opacity: clampedPage === maxPage ? 0.5 : 1 }}>Next ›</button>
              </span>
            </div>
          )}
        </State>
      </Card>
    </div>
  );
}

// Persona strip for the KYC / Youth Profile page — matches the reference
// prototype's "Eligible youth profile" card layout (a row of clickable %
// cards read as "X% ... of eligible youth") exactly, but every card is
// computed from the live AWARENESS_KYC table instead of the prototype's
// illustrative sample fields; two of the reference's six persona traits
// (marital status, family-at-event) have no live BigQuery column and are
// swapped for % Female and Duplicate records, which do.
const KYC_PERSONA_CARDS = [
  { key: "pct_p5_p7", label: "Completed P5–P7", sub: "of eligible youth" },
  { key: "pct_age_18_25", label: "Aged 18–25", sub: "of eligible youth" },
  // Bands mirror buildKycInsights below exactly, so the card and its insight
  // never disagree on what counts as on/off track.
  { key: "pct_owns_phone", label: "Own a phone", sub: "reachable by SMS", color: (v) => (v == null ? null : v >= 85 ? C.green : C.gold) },
  { key: "pct_owns_business", label: "Own a business", sub: "already running one" },
  { key: "pct_female", label: "Female", sub: "of eligible youth · 60% target", color: (v) => femaleShareStatus(v)?.color },
  { key: "duplicate_rate", label: "Duplicate records", sub: "flagged in the system", color: (v) => (v == null ? null : v >= 5 ? C.coral : v >= 2 ? C.gold : C.teal) },
];

// Bar label for a horizontal bar (BarChart layout="vertical") showing the raw
// count with a caller-supplied percentage in brackets, e.g. "1,234 (56%)" —
// positioned just past the bar's end.
function hBarPctLabel(rows, getPct) {
  return (props) => {
    const { x, y, width, height, value, index } = props;
    const pct = getPct(rows[index]);
    const text = pct != null ? `${fmtNum(value)} (${fmtPct(pct)})` : fmtNum(value);
    return (
      <text x={x + width + 6} y={y + height / 2} dy={4} textAnchor="start" fontSize={10.5} fontWeight={600} fill={C.ink}>
        {text}
      </text>
    );
  };
}

// Data-driven insights for the KYC / Youth Profile page — where the eligible
// pool over/under-shoots the female target, how reachable it is, whether the
// data needs cleaning, what draws youth in, and which channel/gender splits
// need a closer look. Every figure comes straight off this cohort's
// AWARENESS_KYC response, nothing hardcoded.
function buildKycInsights(demo, channels, bizByGenderDistrict, reasons) {
  const insights = [];

  if (demo.pct_female != null) {
    const v = demo.pct_female;
    if (v >= 60) insights.push({ tone: "pos", text: <><b>Female share is {fmtPct(v)}</b> of the eligible pool — at or above the 60% target.</> });
    else if (v >= 50) insights.push({ tone: "warn", text: <><b>Female share is {fmtPct(v)}</b> of the eligible pool — below the 60% target.</> });
    else insights.push({ tone: "risk", text: <><b>Female share is only {fmtPct(v)}</b> of the eligible pool — well short of the 60% target.</> });
  }

  if (demo.pct_owns_phone != null) {
    const v = demo.pct_owns_phone;
    if (v >= 85) insights.push({ tone: "pos", text: <><b>{fmtPct(v)}</b> of eligible youth own a phone — most of the pool is reachable by SMS/call for mobilisation.</> });
    else insights.push({ tone: "warn", text: <><b>Only {fmtPct(v)}</b> of eligible youth own a phone — the rest need in-person or venue-based mobilisation, not SMS.</> });
  }

  if (demo.duplicate_rate != null && demo.duplicate_rate > 0) {
    const tone = demo.duplicate_rate >= 5 ? "risk" : demo.duplicate_rate >= 2 ? "warn" : "neutral";
    insights.push({
      tone,
      text: <><b>{fmtPct(demo.duplicate_rate)}</b> of eligible records ({fmtNum(demo.duplicate_count)} youth) are flagged duplicates{tone === "risk" ? " — worth a data-cleaning pass before mobilisation lists are finalised." : "."}</>,
    });
  }

  if (reasons && reasons.length > 0 && demo.eligible_count) {
    const top = reasons[0];
    const pct = Math.round(1000 * top.count / demo.eligible_count) / 10;
    insights.push({ tone: "neutral", text: <><b>{top.reason}</b> is the top reason eligible youth give for enrolling ({fmtPct(pct)} of the eligible pool) — lead with this in outreach messaging.</> });
  }

  const byGender = {};
  (bizByGenderDistrict || []).forEach((r) => {
    const g = (r.gender || "").toUpperCase();
    if (!byGender[g]) byGender[g] = { owners: 0, total: 0 };
    byGender[g].owners += r.owners || 0;
    byGender[g].total += r.total || 0;
  });
  const female = byGender.FEMALE;
  const male = byGender.MALE;
  if (female?.total && male?.total) {
    const fPct = Math.round(1000 * female.owners / female.total) / 10;
    const mPct = Math.round(1000 * male.owners / male.total) / 10;
    if (Math.abs(mPct - fPct) >= 5) {
      insights.push({
        tone: "warn",
        text: <>Business ownership skews {mPct > fPct ? "male" : "female"} among eligible youth: <b>{fmtPct(mPct)}</b> of men own a business vs <b>{fmtPct(fPct)}</b> of women.</>,
      });
    } else {
      insights.push({ tone: "neutral", text: <>Business ownership is roughly even by gender among eligible youth — <b>{fmtPct(mPct)}</b> of men vs <b>{fmtPct(fPct)}</b> of women.</> });
    }
  }

  const withRate = (channels || [])
    .map((c) => ({ ...c, total: (c.eligible || 0) + (c.ineligible || 0) }))
    .filter((c) => c.total >= 10)
    .map((c) => ({ ...c, rate: Math.round(1000 * c.eligible / c.total) / 10 }));
  if (withRate.length > 1) {
    const best = [...withRate].sort((a, b) => b.rate - a.rate)[0];
    const worst = [...withRate].sort((a, b) => a.rate - b.rate)[0];
    if (best.channel !== worst.channel) {
      insights.push({
        tone: "neutral",
        text: <><b>{best.channel}</b> converts eligible youth at the highest rate ({fmtPct(best.rate)}), while <b>{worst.channel}</b> is lowest ({fmtPct(worst.rate)}) — worth weighting outreach spend toward the stronger channel.</>,
      });
    }
  }

  return insights;
}

function AwarenessKycPage({ filters }) {
  const drill = useDrill();
  const { data, loading, error } = useApi(`/api/recruitment/awareness-kyc${buildParams(filters)}`);
  const demo = data?.demographics || {};
  const bizByGenderDistrict = data?.business?.by_gender_district || [];
  const filterMeta = useApi("/api/filters");
  const allDistricts = filterMeta.data?.districts || [];

  const channels = data?.channels || [];
  const totalChannelEligible = sumBy(channels, "eligible");
  const totalChannelIneligible = sumBy(channels, "ineligible");
  const activity = data?.activity || [];
  const reasons = data?.reasons || [];
  const consultation = data?.consultation || [];
  const supportRequired = data?.support_required || [];
  const parentalRelationship = data?.parental_relationship || [];
  const questions = data?.questions || [];
  const kycInsights = buildKycInsights(demo, channels, bizByGenderDistrict, reasons);

  function openPersonaDrill(metricKey, label, sub) {
    drill.open({
      title: `${label} — by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [{ key: "value", label: sub || label, align: "right", render: fmtPct }],
      rootRows: () => fetchPerDistrict("/api/recruitment/awareness-kyc", filters, allDistricts, (json) => json?.demographics?.[metricKey] ?? null),
    });
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
        Who the eligible youth are and what locks others out — persona of the eligible pool,
        current activity, why they enrol, who they consult and what support they need before
        deciding, their household situation, how they heard about us, and what they're still
        asking. Eligibility rule: interested AND age 18–30 AND education P5–S3 AND income
        ≤ UGX 30,000.
      </p>

      <Card title="Eligible youth profile" subtitle="Persona snapshot of the eligible pool — click a card to drill by district" chip="REAL">
        <State loading={loading} error={error} empty={!loading && !demo.eligible_count}>
          <Grid cols={4}>
            {KYC_PERSONA_CARDS.map((c) => {
              const color = c.color?.(demo[c.key]);
              return (
                <KpiTile
                  key={c.key}
                  label={c.label}
                  value={color ? <span style={{ color }}>{fmtPct(demo[c.key])}</span> : fmtPct(demo[c.key])}
                  sub={c.sub}
                  hint="View youth"
                  onClick={() => openPersonaDrill(c.key, c.label, c.sub)}
                />
              );
            })}
          </Grid>
          <p style={{ fontSize: 11, color: C.muted, marginTop: 10 }}>
            {fmtNum(demo.eligible_count)} eligible youth in this cohort · average age {demo.avg_age ?? "—"}.
          </p>
        </State>
      </Card>

      <ExecBand num="!" title="Insights" />
      <State loading={loading} error={error} empty={!loading && !demo.eligible_count}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
          {kycInsights.map((ins, i) => <Insight key={i} tone={ins.tone}>{ins.text}</Insight>)}
        </div>
      </State>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <Card title="What youth are currently doing" subtitle="Multiselect, so youth can appear under more than one activity" chip="REAL">
          <State loading={loading} error={error} empty={!loading && activity.length === 0}>
            <DataTable
              columns={[
                { key: "activity", label: "Activity" },
                { key: "count", label: "Youth", align: "right", render: (v) => fmtNum(v) },
                { key: "pct_of_eligible", label: "% of eligible", align: "right", render: (v) => fmtPct(v) },
              ]}
              rows={activity.map((a) => ({ ...a, pct_of_eligible: demo.eligible_count ? Math.round((1000 * a.count) / demo.eligible_count) / 10 : null }))}
            />
          </State>
        </Card>
        <Card title="Why youth are enrolling" subtitle="Value-proposition alignment — multiselect, so youth can appear under more than one reason" chip="REAL">
          <State loading={loading} error={error} empty={!loading && reasons.length === 0}>
            <DataTable
              columns={[
                { key: "reason", label: "Reason" },
                { key: "count", label: "Youth", align: "right", render: (v) => fmtNum(v) },
                { key: "pct_of_eligible", label: "% of eligible", align: "right", render: (v) => fmtPct(v) },
              ]}
              rows={reasons.map((r) => ({ ...r, pct_of_eligible: demo.eligible_count ? Math.round((1000 * r.count) / demo.eligible_count) / 10 : null }))}
            />
          </State>
        </Card>
      </div>

      <ExecBand num="◆" title="Decision-making & support needs" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <Card title="Who youth consult for decisions" subtitle="Who eligible youth say they turn to before deciding to join" chip="REAL">
          <State loading={loading} error={error} empty={!loading && consultation.length === 0}>
            <DataTable
              columns={[
                { key: "consultant", label: "Consulted" },
                { key: "count", label: "Youth", align: "right", render: (v) => fmtNum(v) },
                {
                  key: "pct_of_eligible", label: "% of eligible", align: "right",
                  render: (v) => fmtPct(v),
                },
              ]}
              rows={consultation.map((c) => ({ ...c, pct_of_eligible: demo.eligible_count ? Math.round((1000 * c.count) / demo.eligible_count) / 10 : null }))}
            />
          </State>
        </Card>
        <Card title="Support youth say they need" subtitle="Self-reported support needs, ahead of the bootcamp" chip="REAL">
          <State loading={loading} error={error} empty={!loading && supportRequired.length === 0}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={supportRequired} layout="vertical" margin={{ left: 40, right: 50 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="support" tick={{ fontSize: 10 }} width={110} />
                <Tooltip />
                <Bar dataKey="count" fill={C.teal} radius={[0, 4, 4, 0]}
                  label={hBarPctLabel(supportRequired, (row) => demo.eligible_count ? Math.round(1000 * row.count / demo.eligible_count) / 10 : null)} />
              </BarChart>
            </ResponsiveContainer>
          </State>
        </Card>
      </div>

      <Card title="Parental relationship" subtitle="Household situation of the eligible pool" chip="REAL">
        <State loading={loading} error={error} empty={!loading && parentalRelationship.length === 0}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={parentalRelationship} layout="vertical" margin={{ left: 40, right: 50 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="relationship" tick={{ fontSize: 10 }} width={150} />
              <Tooltip />
              <Bar dataKey="count" fill={C.gold} radius={[0, 4, 4, 0]}
                label={hBarPctLabel(parentalRelationship, (row) => demo.eligible_count ? Math.round(1000 * row.count / demo.eligible_count) / 10 : null)} />
            </BarChart>
          </ResponsiveContainer>
        </State>
      </Card>

      <Card title="Who already owns a business" subtitle="Share of eligible youth, by gender and district" chip="REAL">
        <State loading={loading} error={error} empty={!loading && bizByGenderDistrict.length === 0}>
          <DataTable
            columns={[
              { key: "district", label: "District" },
              { key: "gender", label: "Gender" },
              { key: "owners", label: "Owners", align: "right", render: (v) => fmtNum(v) },
              { key: "total", label: "Eligible", align: "right", render: (v) => fmtNum(v) },
              { key: "pct_owns_business", label: "% Owning", align: "right", render: (v) => fmtPct(v) },
            ]}
            rows={bizByGenderDistrict}
          />
        </State>
      </Card>

      <Card title="Recruitment channels — how they heard about us" subtitle="Eligible vs ineligible split by channel" chip="REAL">
        <State loading={loading} error={error} empty={!loading && channels.length === 0}>
          <DataTable
            columns={[
              { key: "channel", label: "Channel" },
              { key: "eligible", label: "Eligible", align: "right", render: (v) => <span style={{ color: C.green, fontWeight: 600 }}>{fmtNum(v)}</span> },
              { key: "ineligible", label: "Ineligible", align: "right", render: (v) => <span style={{ color: C.coral, fontWeight: 600 }}>{fmtNum(v)}</span> },
              {
                key: "eligibility_rate", label: "Eligibility rate", align: "right",
                render: (v) => {
                  const { good, warn } = RATE_TARGETS.eligibility_rate;
                  const color = v == null ? C.muted : v >= good ? C.green : v >= warn ? C.gold : C.coral;
                  return <span style={{ color, fontWeight: 700 }}>{fmtPct(v)}</span>;
                },
              },
              { key: "pct_of_eligible", label: "% of all eligible", align: "right", render: (v) => fmtPct(v) },
              { key: "pct_of_ineligible", label: "% of all ineligible", align: "right", render: (v) => fmtPct(v) },
            ]}
            rows={channels.map((c) => {
              const total = (c.eligible || 0) + (c.ineligible || 0);
              return {
                ...c,
                eligibility_rate: total ? Math.round(1000 * c.eligible / total) / 10 : null,
                pct_of_eligible: totalChannelEligible ? Math.round(1000 * c.eligible / totalChannelEligible) / 10 : null,
                pct_of_ineligible: totalChannelIneligible ? Math.round(1000 * c.ineligible / totalChannelIneligible) / 10 : null,
              };
            })}
          />
        </State>
      </Card>

      <ExecBand num="?" title="Q&A — what youth are asking" />
      <Card
        title="Open questions raised before joining"
        subtitle="Free-text answers, qualitatively coded into themes rather than grouped by exact wording — most raw phrasings are one-off, so grouping by exact text buried the real signal under typo variants of &ldquo;no questions&rdquo;. Each theme's example is its single most common raw phrasing."
        chip="REAL"
      >
        <State loading={loading} error={error} empty={!loading && questions.length === 0}>
          <DataTable
            columns={[
              { key: "theme", label: "Theme" },
              { key: "count", label: "Youth", align: "right", render: (v) => fmtNum(v) },
              { key: "pct_of_eligible", label: "% of eligible", align: "right", render: (v) => fmtPct(v) },
              { key: "example", label: "Representative example", render: (v) => <span style={{ fontStyle: "italic", color: C.muted }}>&ldquo;{v}&rdquo;</span> },
            ]}
            rows={questions.map((q) => ({ ...q, pct_of_eligible: demo.eligible_count ? Math.round((1000 * q.count) / demo.eligible_count) / 10 : null }))}
          />
        </State>
      </Card>
    </div>
  );
}

// Data-driven insights for the Forecast page — progress against the real
// registration target, pace to close the gap, and which districts are
// furthest ahead/behind. No fabricated cycle length or likelihood score:
// there's no live "days left in cycle" field, so every figure here is a
// direct read off the awareness-forecast/awareness-parish responses.
function buildForecastInsights(data, byDistrict) {
  const insights = [];
  // `target` is an eligible-youth quota where hardcoded, a raw-registration
  // quota where live-fallback (see awareness_forecast's docstring) — so
  // progress compares against actual_to_date_for_target, not a fixed
  // registered/eligible column.
  const progressPct = data?.target ? Math.round(1000 * (data.actual_to_date_for_target || 0) / data.target) / 10 : null;

  if (progressPct != null) {
    insights.push({ tone: progressPct >= 95 ? "pos" : progressPct >= 75 ? "warn" : "risk", text: <><b>{fmtNum(data.actual_to_date_for_target)}</b> of the <b>{fmtNum(data.target)}</b> target — <b>{fmtPct(progressPct)}</b> of the way there.</> });
  }

  if (data?.days_to_target != null && data?.avg_daily_rate) {
    insights.push({
      tone: "neutral",
      text: <>At the current pace of <b>{fmtNum(data.avg_daily_rate)}</b> youth/day, the remaining gap closes in about <b>{fmtNum(data.days_to_target)}</b> day{data.days_to_target === 1 ? "" : "s"}.</>,
    });
  }

  if (data?.eligibility_rate != null) {
    const { good, warn } = RATE_TARGETS.eligibility_rate;
    const tone = data.eligibility_rate >= good ? "pos" : data.eligibility_rate >= warn ? "warn" : "risk";
    insights.push({
      tone,
      text: <><b>{fmtPct(data.eligibility_rate)}</b> of interested youth are eligible ({fmtNum(data.eligible_to_date)} of {fmtNum(data.interested_to_date)}) — {tone === "pos" ? `at or above the ${good}% target.` : `below the ${good}% target (warning line ${warn}%).`}</>,
    });
  }

  const withTarget = byDistrict.filter((d) => d.target);
  if (withTarget.length > 1) {
    const sorted = [...withTarget].sort((a, b) => (b.pct_of_target ?? -1) - (a.pct_of_target ?? -1));
    const best = sorted[0], worst = sorted[sorted.length - 1];
    if (best.district !== worst.district) {
      insights.push({ tone: "neutral", text: <><b>{best.district}</b> is furthest along ({fmtPct(best.pct_of_target)} of target), while <b>{worst.district}</b> trails at {fmtPct(worst.pct_of_target)}.</> });
    }
    const behind = withTarget.filter((d) => (d.pct_of_target ?? 0) < 75);
    if (behind.length > 0) {
      insights.push({ tone: "warn", text: <><b>{behind.length}</b> district{behind.length === 1 ? "" : "s"} {behind.length === 1 ? "is" : "are"} below 75% of target — see the table below for days-to-target at the current pace.</> });
    }
  }

  return insights;
}

function AwarenessForecastPage({ filters }) {
  const drill = useDrill();
  const { data, loading, error } = useApi(`/api/recruitment/awareness-forecast${buildParams(filters)}`);
  const parishData = useApi(`/api/recruitment/awareness-parish${buildParams(filters)}`);
  const daily = data?.daily || [];
  const byDistrict = data?.by_district || [];

  // Click-to-toggle legend: click a series name to hide/show it, so the
  // chart can be narrowed down to just eligible or just the target line.
  const [hiddenSeries, setHiddenSeries] = useState({});
  function toggleSeries(dataKey) {
    setHiddenSeries((h) => ({ ...h, [dataKey]: !h[dataKey] }));
  }
  function legendFormatter(value, entry) {
    const isHidden = !!hiddenSeries[entry.dataKey];
    return <span style={{ textDecoration: isHidden ? "line-through" : "none", opacity: isHidden ? 0.5 : 1 }}>{value}</span>;
  }

  let eligCum = 0;
  const cumDaily = daily.map((d) => {
    eligCum += d.eligible || 0;
    return { event_date: d.event_date, eligible_cum: eligCum, target: data?.target ?? null };
  });

  // Target is an eligible-youth quota (AWARENESS_ELIGIBLE_TARGET_BC5, the
  // only target source now that Awareness is off the gold summary mart) —
  // progress/gap/pace all compare against eligible, not raw registrations.
  const progressPct = data?.target ? Math.round(1000 * (data.actual_to_date_for_target || 0) / data.target) / 10 : null;

  const districtRows = byDistrict.map((d) => ({ ...d, category: categorizeRate(d.pct_of_target) }));

  const parishRows = (parishData.data?.parishes || []).map((p) => {
    const registered = p.reached || 0;
    const eligible = p.eligible || 0;
    const target = p.target || 0;
    const gap = Math.max(target - eligible, 0);
    const rate = data?.n_days ? eligible / data.n_days : null;
    return {
      district: p.district,
      parish: p.parish,
      registered,
      eligible,
      target,
      target_source: p.target_source,
      gap,
      pct_of_target: target ? Math.round(1000 * eligible / target) / 10 : null,
      days_to_target: rate ? Math.round(gap / rate) : null,
    };
  });

  const forecastColumns = [
    { key: "registered", label: "Registered", align: "right", render: (v) => fmtNum(v) },
    { key: "eligible", label: "Eligible", align: "right", render: (v) => fmtNum(v) },
    {
      key: "target", label: "Target", align: "right",
      render: (v, r) => <span title={r.target_source === "hardcoded" ? "Hardcoded BC5 planning target — an eligible-youth quota" : undefined}>{fmtNum(v)}{r.target_source === "hardcoded" ? " *" : ""}</span>,
    },
    { key: "gap", label: "Gap", align: "right", render: (v) => fmtNum(v) },
    { key: "days_to_target", label: "Days to target", align: "right", render: (v) => (v == null ? "—" : v <= 0 ? "Met" : `${fmtNum(v)} d`) },
    { key: "pct_of_target", label: "% of target", align: "right", render: (v) => fmtPct(v) },
    { key: "category", label: "Status", align: "left", render: (v) => <span style={{ color: RATE_CATEGORY_COLOR[v], fontWeight: 700 }}>{v}</span> },
  ];

  function openParishDrill(districtRow) {
    drill.openAt({
      title: "Days to target — by parish",
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: forecastColumns,
      rootRows: districtRows,
      childKey: "parish", childLabel: "Parish",
      getChildRows: (root) => parishRows.filter((p) => p.district === root.district).map((p) => ({ ...p, category: categorizeRate(p.pct_of_target) })),
    }, districtRow);
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
        Eligible-youth pace against target — daily trend, progress by district, and days-to-target at the
        current pace. Target is the hardcoded BC5 planning sheet only (marked *) — no target is shown for a
        district/parish it doesn't cover. Click a district row to drill into its parishes.
      </p>

      <Grid cols={4}>
        <KpiTile label="Registered to date" value={fmtNum(data?.registered_to_date)} tag="REAL" />
        <KpiTile label="Registration target" value={fmtNum(data?.target)} tag="REAL" />
        <KpiTile label="Progress on target" value={<span style={{ color: RATE_CATEGORY_COLOR[categorizeRate(progressPct)] }}>{fmtPct(progressPct)}</span>} sub="eligible ÷ target" tag="DERIVED" tone="sim" />
        <KpiTile label="Days to target" value={data?.days_to_target ?? "—"} sub={`at current pace · ${fmtNum(data?.avg_daily_rate)}/day`} tag="DERIVED" tone="sim" />
        <KpiTile label="Eligible to date" value={fmtNum(data?.eligible_to_date)} sub={`of ${fmtNum(data?.interested_to_date)} interested`} tag="REAL" />
        <KpiTile label="Eligibility rate" value={<span style={{ color: rateColor(data?.eligibility_rate, "eligibility_rate") }}>{fmtPct(data?.eligibility_rate)}</span>} sub={`eligible ÷ interested · ${RATE_TARGETS.eligibility_rate.good}% target`} tag="DERIVED" tone="sim" />
      </Grid>

      <ExecBand num="!" title="Insights" />
      <State loading={loading} error={error} empty={!loading && !data?.target && !data?.registered_to_date}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
          {buildForecastInsights(data || {}, byDistrict).map((ins, i) => <Insight key={i} tone={ins.tone}>{ins.text}</Insight>)}
        </div>
      </State>

      <Card title="Daily trend — reached vs eligible" subtitle="Youth reached (registered) and eligible each day — not cumulative, so a slow day reads as a dip rather than a flattening curve" chip="REAL">
        <State loading={loading} error={error} empty={!loading && daily.length === 0}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={daily} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="event_date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend onClick={(e) => toggleSeries(e.dataKey)} formatter={legendFormatter} wrapperStyle={{ cursor: "pointer" }} />
              <Bar name="Reached" dataKey="registered" fill={C.teal} radius={[3, 3, 0, 0]} hide={!!hiddenSeries.registered} />
              <Bar name="Eligible" dataKey="eligible" fill={C.gold} radius={[3, 3, 0, 0]} hide={!!hiddenSeries.eligible} />
            </BarChart>
          </ResponsiveContainer>
        </State>
      </Card>

      <Card title="Daily trend — eligible youth vs target (cumulative)" subtitle="Running total of eligible youth against the registration target (hardcoded BC5 sheet — MAYUGE/IGANGA only, no target elsewhere) — stands in for the reference design's eligible-youth target line" chip="REAL">
        <State loading={loading} error={error} empty={!loading && daily.length === 0}>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={cumDaily} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <defs>
                <linearGradient id="forecastEligibleFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.teal} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={C.teal} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="event_date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend onClick={(e) => toggleSeries(e.dataKey)} formatter={legendFormatter} wrapperStyle={{ cursor: "pointer" }} />
              <Area type="monotone" name="Eligible (cumulative)" dataKey="eligible_cum" stroke={C.teal} strokeWidth={2} fill="url(#forecastEligibleFill)" hide={!!hiddenSeries.eligible_cum} />
              <Area type="monotone" name="Registration target" dataKey="target" stroke={C.coral} strokeDasharray="6 4" strokeWidth={2} fill="none" dot={false} hide={!!hiddenSeries.target} />
            </AreaChart>
          </ResponsiveContainer>
        </State>
      </Card>

      <Card title="Days to target, by district" subtitle="Eligible youth vs target at current pace — click a district to see its parishes" chip="REAL">
        <State loading={loading} error={error} empty={!loading && districtRows.length === 0}>
          <DataTable
            columns={[{ key: "district", label: "District" }, ...forecastColumns]}
            rows={districtRows}
            onRowClick={openParishDrill}
          />
          <p style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>* Hardcoded BC5 planning target (currently MAYUGE/IGANGA only) — no target is shown for any other district/parish (no live source since the Awareness tab moved off the gold summary mart).</p>
        </State>
      </Card>
    </div>
  );
}

// `drill`, when given, makes each bar clickable — jumps straight to that
// district's venue-level breakdown (the chart itself already IS the district
// root view, so there's no need to make the user pick the district again).
// Shape: { childKey, childLabel, columns, getChildRows(districtRow) }
function DistrictBarTab({ endpoint, filters, title, subtitle, bars, drill }) {
  const drillCtx = useDrill();
  const { data, loading, error } = useApi(`${endpoint}${buildParams(filters)}`);
  const rows = data?.by_district || [];

  function onBarClick(row) {
    if (!drill) return;
    drillCtx.openAt({
      title: `${title} — by venue`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: drill.columns,
      rootRows: rows,
      childKey: drill.childKey, childLabel: drill.childLabel,
      getChildRows: drill.getChildRows,
    }, row);
  }

  return (
    <Card title={title} subtitle={subtitle} chip="REAL">
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
            <XAxis dataKey="district" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip /><Legend />
            {bars.map((b, i) => (
              <Bar key={b.key} dataKey={b.key} name={b.label} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[4, 4, 0, 0]}
                cursor={drill ? "pointer" : undefined}
                onClick={drill ? (d) => onBarClick(d.payload || d) : undefined} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </State>
      {drill && <p style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>Click a bar to see that district's venues.</p>}
    </Card>
  );
}

function AcquisitionTab({ filters }) {
  const [page, setPage] = useState("overview");
  // Fetched here (not inside DistrictBarTab) so a district-bar click can drill
  // straight to that district's venues — the venue grain lives on the Arrival
  // & Verification sub-page's endpoint, already fetched either way once this
  // tab is open.
  const arrival = useApi(`/api/recruitment/acquisition-arrival${buildParams(filters)}`);
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Acquisition</h2>
      <p style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>
        Verified → acquired at Karibu Day arrival, by district and by venue.
      </p>
      <DuplicateRecordsBanner filters={filters} />
      <PageNav
        active={page}
        onChange={setPage}
        pages={[
          { key: "overview", label: "Overview" },
          { key: "arrival", label: "Arrival & Verification" },
        ]}
      />
      {page === "overview" && <AcquisitionOverviewPage filters={filters} arrival={arrival} />}
      {page === "arrival" && <AcquisitionArrivalPage filters={filters} />}
    </div>
  );
}

function AcquisitionOverviewPage({ filters, arrival }) {
  const { data } = useApi(`/api/recruitment/acquisition${buildParams(filters)}`);
  const totals = data?.totals || {};
  return (
    <div>
      <Grid cols={3}>
        <KpiTile label="Acquisition rate" value={<span style={{ color: rateColor(totals.acquisition_rate, "acquisition_rate") }}>{fmtPct(totals.acquisition_rate)}</span>} sub={`${fmtNum(totals.acquired)} acquired ÷ ${fmtNum(totals.verified)} verified`} tag="REAL" />
        <KpiTile label="Overall conversion" value={fmtPct(totals.overall_conversion_rate)} sub={`${fmtNum(totals.acquired)} acquired ÷ ${fmtNum(totals.registered)} registered`} tag="REAL" />
        <KpiTile label="Retention rate" value={<span style={{ color: rateColor(totals.retention_rate, "retention_rate") }}>{fmtPct(totals.retention_rate)}</span>} sub={`${fmtNum(totals.retained)} retained ÷ ${fmtNum(totals.activated)} activated`} tag="REAL" />
      </Grid>
      <DistrictBarTab endpoint="/api/recruitment/acquisition" filters={filters} title="Acquisition" subtitle="Verified → Acquired by district"
        bars={[{ key: "verified", label: "Verified" }, { key: "acquired", label: "Acquired" }]}
        drill={{
          childKey: "venue", childLabel: "Venue",
          columns: [
            { key: "verified", label: "Verified", align: "right", render: fmtNum },
            { key: "acquired", label: "Acquired", align: "right", render: fmtNum },
            { key: "acquisition_rate", label: "Rate", align: "right", render: fmtPct },
          ],
          getChildRows: (root) => (arrival.data?.by_venue || []).filter((v) => v.district === root.district),
        }}
      />
    </div>
  );
}

function AcquisitionArrivalPage({ filters }) {
  const { data, loading, error } = useApi(`/api/recruitment/acquisition-arrival${buildParams(filters)}`);
  const rows = data?.by_venue || [];
  const venueRows = rows.map((r) => ({
    venue: r.venue, district: r.district, verified: r.verified, acquired: r.acquired,
    rate: r.acquisition_rate, category: categorizeRate(r.acquisition_rate),
  }));
  const totalVerified = rows.reduce((a, r) => a + (r.verified || 0), 0);
  const totalAcquired = rows.reduce((a, r) => a + (r.acquired || 0), 0);
  const totalAcquiredFemale = rows.reduce((a, r) => a + (r.acquired_female || 0), 0);
  const pctFemaleAcquired = totalAcquired ? Math.round((1000 * totalAcquiredFemale) / totalAcquired) / 10 : null;
  const acqRate = totalVerified ? Math.round((1000 * totalAcquired) / totalVerified) / 10 : null;

  return (
    <div>
      <p style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
        Arrival & verification at Karibu Day, at venue grain — the same live SITE_FUNNEL_METRICS mart as
        the Overview page above, broken out by venue instead of district.
      </p>
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <Grid cols={4}>
          <KpiTile label="Verified" value={fmtNum(totalVerified)} tag="REAL" />
          <KpiTile label="Acquired (waiver)" value={fmtNum(totalAcquired)} sub="verified & waiver signed" tag="REAL" />
          <KpiTile label="Acquisition rate" value={<span style={{ color: RATE_CATEGORY_COLOR[categorizeRate(acqRate)] }}>{fmtPct(acqRate)}</span>} sub="acquired ÷ verified" tag="REAL" />
          <KpiTile label="Acquired female" value={fmtNum(totalAcquiredFemale)} sub={<>
            <span style={{ color: femaleShareStatus(pctFemaleAcquired)?.color, fontWeight: 700 }}>{fmtPct(pctFemaleAcquired)}</span> of acquired · target 60% (verified has no gender split in the live feed)
          </>} tag="REAL" />
        </Grid>
        <ExecBand num="◆" title="Performance categorisation — venues vs target (filters)" />
        <EntityCategorisation
          rows={venueRows}
          metricA={{ key: "verified", label: "Verified" }}
          metricB={{ key: "acquired", label: "Acquired" }}
          rateFraction="acquired ÷ verified"
          entityKey="venue" entityLabel="venue" entityLabelPlural="venues"
        />
      </State>
    </div>
  );
}

function MobilisationTab({ filters }) {
  const [page, setPage] = useState("funnel");
  // One shared date range for every sub-page on this tab — filters by each
  // report's own event date (call_date/report_date/date_added/created_at,
  // see the backend's per-endpoint docstrings), never a static target. Kept
  // at this level (not per sub-page) so switching sub-tabs doesn't reset it.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Mobilisation</h2>
      <p style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>
        Treatment assigned → reached at mobilisation → attendance confirmed. Reach rate and
        mobilisation rate, the funnel by day and venue, daily pace against target, and the
        randomised control arm.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <span style={{ fontSize: 11, color: C.muted, fontWeight: 700, textTransform: "uppercase" }}>Date range (all Mobilisation pages)</span>
        <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} style={{ fontSize: 12, padding: "6px 8px", border: `1px solid ${C.line}`, borderRadius: 5, color: C.text }} />
        <span style={{ fontSize: 11, color: C.muted }}>to</span>
        <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} style={{ fontSize: 12, padding: "6px 8px", border: `1px solid ${C.line}`, borderRadius: 5, color: C.text }} />
        {(dateFrom || dateTo) && (
          <button onClick={() => { setDateFrom(""); setDateTo(""); }} style={PAGER_BTN}>Clear dates</button>
        )}
      </div>
      <PageNav
        active={page}
        onChange={setPage}
        pages={[
          { key: "funnel", label: "Mobilisation Overview" },
          { key: "forecast", label: "Mobilisation Forecasts" },
          { key: "mobilisers", label: "Mobiliser Performance" },
          { key: "control", label: "Control Mobilisation Calls" },
          { key: "insights", label: "Call Centre Insights" },
          { key: "qa", label: "Quality Assurance Calls" },
        ]}
      />
      {page === "funnel" && <MobRecruitmentFunnelPage filters={filters} dateFrom={dateFrom} dateTo={dateTo} />}
      {page === "forecast" && <MobForecastsPage filters={filters} dateFrom={dateFrom} dateTo={dateTo} />}
      {page === "mobilisers" && <MobPerformancePage filters={filters} />}
      {page === "control" && <MobControlCallsPage dateFrom={dateFrom} dateTo={dateTo} />}
      {page === "insights" && <MobCallCentreInsightsPage dateFrom={dateFrom} dateTo={dateTo} />}
      {page === "qa" && <MobQualityAssuranceCallsPage />}
      {page === "mobilisers" && (
        <p style={{ fontSize: 11, color: C.muted, marginTop: -10 }}>
          The date range above doesn't apply here — Mobiliser Performance has no live per-mobiliser table yet (see MOBILISER_PERF, tables.py), so there's nothing dated to filter.
        </p>
      )}
      {page === "qa" && (
        <p style={{ fontSize: 11, color: C.muted, marginTop: -10 }}>
          The date range above doesn't apply here either — Quality Assurance Calls is backed by a pre-aggregated rollup with no date column at all (see QUALITY_ASSURANCE_BC5, tables.py).
        </p>
      )}
    </div>
  );
}

function MobRecruitmentFunnelPage({ filters, dateFrom, dateTo }) {
  const drill = useDrill();
  const mob = useApi(`/api/recruitment/mobilisation${withDateRange(filters, dateFrom, dateTo)}`);
  const heatmap = useApi(`/api/recruitment/mobilisation-heatmap${withDateRange(filters, dateFrom, dateTo)}`);
  const filterMeta = useApi("/api/filters");
  const allDistricts = filterMeta.data?.districts || [];
  const data = mob.data;
  const [parishCat, setParishCat] = useState("All");
  const [mobGrain, setMobGrain] = useState("parish");
  const [mobSearch, setMobSearch] = useState("");
  const [selectedParishes, setSelectedParishes] = useState([]);
  const [selectedVenues, setSelectedVenues] = useState([]);
  // Venue-grain only — no insight here depends on call_date. Day-level
  // tracking has proven sparse/unreliable for some cohorts (see the by_venue/
  // by_day split below), so score cards and insights are built entirely from
  // venue and cohort aggregates, which are consistently populated.
  const byVenue = heatmap.data?.by_venue || [];

  // Same N+1-per-district approach as Executive Summary: /api/recruitment/
  // mobilisation already accepts a `district` filter but only ever returns
  // one aggregate — no by_district breakdown in a single response.
  function openMobDrill(metricKey, label, formatter = fmtNum) {
    drill.open({
      title: `${label} — by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [{ key: "value", label, align: "right", render: formatter }],
      rootRows: () => fetchPerDistrict("/api/recruitment/mobilisation", filters, allDistricts, (json) => json?.[metricKey] ?? null),
    });
  }

  // `target`/`assigned` are live per-venue where the cohort's target measure
  // carries venue_name (confirmed for BOOTCAMP_5's 'venue_targets'), else
  // `target` falls back to the hardcoded VENUE_MOBILISATION_TARGET and
  // `assigned` stays 0 (see mobilisation_heatmap()). `rate`/`conversionCategory`
  // (confirmed ÷ reached — call-center conversion) drive the Insights section
  // below; `progressPct`/`category` (confirmed ÷ target) drive the merged
  // District → Parish → Venue categorisation table/drill instead.
  // autoConfirmed/autoConfirmedFemale/treatmentTarget are PARISH-level, not
  // venue-specific (see mobilisation_heatmap()'s docstring) — a parish with
  // more than one venue shows the same figure on each of its venues. Shown
  // for structural parity with Parish's Auto-confirmed block; deliberately
  // NOT folded into confirmed/target/reached/rate/progressPct above, which
  // stay call-center-only, since summing those across a parish's venues
  // would otherwise double-count that parish's real auto-confirmed number.
  const venueRows = byVenue.map((v) => {
    const assigned = v.assigned || 0, reached = v.reached || 0, confirmed = v.confirmed || 0, target = v.target ?? null;
    const rate = reached ? Math.round((1000 * confirmed) / reached) / 10 : null;
    const pctFemale = confirmed ? Math.round((1000 * (v.confirmed_female || 0)) / confirmed) / 10 : null;
    const progressPct = target ? Math.round((1000 * confirmed) / target) / 10 : null;
    const autoConfirmed = v.auto_confirmed || 0, autoConfirmedFemale = v.auto_confirmed_female || 0;
    const autoPctFemale = autoConfirmed ? Math.round((1000 * autoConfirmedFemale) / autoConfirmed) / 10 : null;
    const treatmentTarget = v.treatment_target || 0;
    const autoProgressPct = treatmentTarget ? Math.round((1000 * autoConfirmed) / treatmentTarget) / 10 : null;
    return {
      district: v.district, parish: v.parish, venue: v.venue, assigned, reached, confirmed, pctFemale, target,
      rate, conversionCategory: categorizeRate(rate), progressPct, category: categorizeRate(progressPct),
      autoConfirmed, autoPctFemale, treatmentTarget, autoProgressPct,
    };
  }).sort((a, b) => b.confirmed - a.confirmed);

  const topVenue = venueRows[0];

  // Parish grain — the main visible/filterable table on this page (per the
  // recruitment team, 2026-08-04: parishes are the useful grain to see
  // directly; district only has 2 rows for BC5, too coarse to be the primary
  // table). Every count is disaggregated by source — call-center (from
  // 'daily_aggregates') vs the auto-confirm awareness pathway — AND checked
  // against each source's OWN target, per the recruitment team, 2026-08-04:
  // one blended progress % hid which pathway was actually driving (or
  // missing) progress. mobilisationTarget is the acquisition-side target;
  // treatmentTarget is this parish's share of the awareness-stage eligible
  // target (BC5-only). target/confirmed/reached/pctFemale stay as the
  // combined totals too, for the district-level summary card and anything
  // that just wants one number. See mobilisation_heatmap()'s docstring for
  // why the call-center component was 0 before the agent_district fix.
  function buildSourceRow(p) {
    const assigned = p.assigned || 0;
    const mobilisationTarget = p.mobilisation_target || 0, treatmentTarget = p.treatment_target || 0;
    const target = p.target || 0;
    const callCentreReached = p.call_centre_reached || 0, callCentreConfirmed = p.call_centre_confirmed || 0;
    const callCentreConfirmedFemale = p.call_centre_confirmed_female || 0;
    const autoConfirmed = p.auto_confirmed || 0, autoConfirmedFemale = p.auto_confirmed_female || 0;
    const reached = p.reached || 0, confirmed = p.confirmed || 0, confirmedFemale = p.confirmed_female || 0;
    // Whole-number percentages throughout this table (not the usual 1dp) —
    // it's already dense with numbers, one less digit per cell helps it
    // read at a glance.
    const progressPct = target ? Math.round((100 * confirmed) / target) : null;
    return {
      district: p.district, parish: p.parish, assigned,
      mobilisationTarget, treatmentTarget, target,
      callCentreReached, callCentreConfirmed,
      callCentrePctFemale: callCentreConfirmed ? Math.round((100 * callCentreConfirmedFemale) / callCentreConfirmed) : null,
      callCentreProgressPct: mobilisationTarget ? Math.round((100 * callCentreConfirmed) / mobilisationTarget) : null,
      autoConfirmed,
      autoPctFemale: autoConfirmed ? Math.round((100 * autoConfirmedFemale) / autoConfirmed) : null,
      autoProgressPct: treatmentTarget ? Math.round((100 * autoConfirmed) / treatmentTarget) : null,
      reached, confirmed,
      pctFemale: confirmed ? Math.round((100 * confirmedFemale) / confirmed) : null,
      progressPct, category: categorizeRate(progressPct),
    };
  }

  const byParish = heatmap.data?.by_parish || [];
  const parishRows = byParish.map(buildSourceRow).sort((a, b) => b.confirmed - a.confirmed);
  const byDistrictTotals = heatmap.data?.by_district || [];
  const districtTotalRows = byDistrictTotals.map(buildSourceRow).sort((a, b) => b.confirmed - a.confirmed);

  // Free-text search matches parish, venue, or district; the Parishes/
  // Venues multi-selects narrow further on top of it (AND, not OR) — same
  // combined-filter-panel convention as Milestones' Venue x Week. Parish
  // rows have no venue of their own, so selectedVenues only narrows the
  // venue grain below; selectedParishes narrows both.
  const mq = mobSearch.trim().toLowerCase();
  const matchesMobText = (parish, venue, district) => {
    if (!mq) return true;
    if ((parish || "").toLowerCase().includes(mq)) return true;
    if ((venue || "").toLowerCase().includes(mq)) return true;
    if ((district || "").toLowerCase().includes(mq)) return true;
    return false;
  };
  const parishOptions = distinctValues(parishRows, "parish");
  const venueOptions = distinctValues(venueRows, "venue");

  const parishCatCounts = { All: parishRows.length };
  RATE_CATEGORY_ORDER.forEach((c) => { parishCatCounts[c] = parishRows.filter((p) => p.category === c).length; });
  const filteredParishRows = parishRows
    .filter((p) => parishCat === "All" || p.category === parishCat)
    .filter((p) => matchesMobText(p.parish, null, p.district))
    .filter((p) => selectedParishes.length === 0 || selectedParishes.includes(p.parish))
    .sort((a, b) => (b.progressPct ?? -1) - (a.progressPct ?? -1));

  // Same columns as before, regrouped for GroupedDataTable — three
  // color-coded, bordered blocks (Call-center / Auto-confirmed / Total)
  // instead of one flat row of 12 numbers, so it's visually obvious which
  // figures belong together without reading every header. Every percentage
  // still RAG-colored (progressPct/category via RATE_CATEGORY_COLOR, %
  // Female via renderPctFemaleCell's own bands).
  const sourceGroups = [
    {
      label: "Call-center", color: C.teal,
      columns: [
        { key: "assigned", label: "Assigned", align: "right", render: (v) => fmtNum(v) },
        { key: "callCentreReached", label: "Reached", align: "right", render: (v) => fmtNum(v) },
        { key: "callCentreConfirmed", label: "Confirmed", align: "right", render: (v) => fmtNum(v) },
        { key: "callCentreProgressPct", label: "% vs target", align: "right", render: (v) => <span style={{ color: RATE_CATEGORY_COLOR[categorizeRate(v)], fontWeight: 700 }}>{fmtPct(v)}</span> },
        { key: "callCentrePctFemale", label: "% Female", align: "right", render: renderPctFemaleCell },
      ],
    },
    {
      label: "Auto-confirmed (awareness)", color: C.gold,
      columns: [
        { key: "autoConfirmed", label: "Confirmed", align: "right", render: (v) => fmtNum(v) },
        { key: "autoProgressPct", label: "% vs target", align: "right", render: (v) => <span style={{ color: RATE_CATEGORY_COLOR[categorizeRate(v)], fontWeight: 700 }}>{fmtPct(v)}</span> },
        { key: "autoPctFemale", label: "% Female", align: "right", render: renderPctFemaleCell },
      ],
    },
    {
      label: "Total", color: C.inkSoft,
      columns: [
        { key: "confirmed", label: "Confirmed", align: "right", render: (v) => fmtNum(v) },
        { key: "target", label: "Target", align: "right", render: (v) => (v == null ? "—" : fmtNum(v)) },
        { key: "progressPct", label: "% vs target", align: "right", render: (v, r) => <span style={{ color: RATE_CATEGORY_COLOR[r.category], fontWeight: 700 }}>{fmtPct(v)}</span> },
        { key: "pctFemale", label: "% Female", align: "right", render: renderPctFemaleCell },
      ],
    },
  ];
  const sourceTrailingColumns = [
    { key: "category", label: "Status", render: (v) => <span style={{ color: RATE_CATEGORY_COLOR[v], fontWeight: 700 }}>{v}</span> },
  ];

  // Venue rows have no auto-confirm/treatment-target split (no venue-level
  // awareness data exists — see mobilisation_heatmap()), so there's no
  // "Auto-confirmed" block to show — but still grouped the same way as
  // Parish (GroupedDataTable, color-coded blocks) for a consistent look
  // switching between the two. Assigned/Reached live in the Call-center
  // block; Confirmed/Target/% vs target/% Female live in Total, since
  // Confirmed here already IS the total (there's no second source to sum
  // in) — keeping it to one column, not duplicated across both blocks.
  const venueGroups = [
    {
      label: "Call-center", color: C.teal,
      columns: [
        { key: "assigned", label: "Assigned", align: "right", render: (v) => fmtNum(v) },
        { key: "reached", label: "Reached", align: "right", render: (v) => fmtNum(v) },
      ],
    },
    {
      // Parish-level, not venue-specific — see venueRows' note above. A
      // parish with more than one venue shows the same figures on each.
      label: "Auto-confirmed (awareness, parish-level)", color: C.gold,
      columns: [
        { key: "autoConfirmed", label: "Confirmed", align: "right", render: (v) => fmtNum(v) },
        { key: "autoProgressPct", label: "% vs target", align: "right", render: (v) => <span style={{ color: RATE_CATEGORY_COLOR[categorizeRate(v)], fontWeight: 700 }}>{fmtPct(v)}</span> },
        { key: "autoPctFemale", label: "% Female", align: "right", render: renderPctFemaleCell },
      ],
    },
    {
      label: "Total", color: C.inkSoft,
      columns: [
        { key: "confirmed", label: "Confirmed", align: "right", render: (v) => fmtNum(v) },
        { key: "target", label: "Target", align: "right", render: (v) => (v == null ? "—" : fmtNum(v)) },
        { key: "progressPct", label: "% vs target", align: "right", render: (v, r) => <span style={{ color: RATE_CATEGORY_COLOR[r.category], fontWeight: 700 }}>{fmtPct(v)}</span> },
        { key: "pctFemale", label: "% Female", align: "right", render: renderPctFemaleCell },
      ],
    },
  ];
  const venueTrailingColumns = [
    { key: "category", label: "Status", render: (v) => <span style={{ color: RATE_CATEGORY_COLOR[v], fontWeight: 700 }}>{v}</span> },
  ];

  // Parish vs Venue is a plain grain toggle, not a drill — both tables use
  // the same GroupedDataTable layout, switched by clicking one of two tabs.
  // Parish is the default (per the recruitment team, 2026-08-04) since it's
  // the grain with real combined numbers; Venue only has the call-center
  // component (see venueGroups' note).
  const venueCatCounts = { All: venueRows.length };
  RATE_CATEGORY_ORDER.forEach((c) => { venueCatCounts[c] = venueRows.filter((v) => v.category === c).length; });
  const filteredVenueRows = venueRows
    .filter((v) => parishCat === "All" || v.category === parishCat)
    .filter((v) => matchesMobText(v.parish, v.venue, v.district))
    .filter((v) => selectedParishes.length === 0 || selectedParishes.includes(v.parish))
    .filter((v) => selectedVenues.length === 0 || selectedVenues.includes(v.venue))
    .sort((a, b) => (b.progressPct ?? -1) - (a.progressPct ?? -1));

  return (
    <div>
      <ExecBand num="◆" title="Progress on target" />
      <State loading={mob.loading} error={mob.error} empty={!mob.loading && !data}>
        <Grid cols={4}>
          <KpiTile label="Assigned to treatment" value={fmtNum(data?.assigned)} tag="REAL" onClick={() => openMobDrill("assigned", "Assigned to treatment")} />
          <KpiTile label="Youth called" value={fmtNum(data?.called)} sub={`unique youth IDs dialed, of ${fmtNum(data?.assigned)} assigned`} tag="REAL" onClick={() => openMobDrill("called", "Youth called")} />
          <KpiTile label="Youth reached" value={fmtNum(data?.reached)} sub={`of ${fmtNum(data?.assigned)} assigned`} tag="REAL" onClick={() => openMobDrill("reached", "Youth reached")} />
          <KpiTile label="Reach rate" value={<span style={{ color: rateColor(data?.reach_rate, "reach_rate") }}>{fmtPct(data?.reach_rate)}</span>} sub="reached ÷ assigned · target 70%" tag="REAL" onClick={() => openMobDrill("reach_rate", "Reach rate", fmtPct)} />
          <KpiTile label="Youth confirmed" value={fmtNum(data?.confirmed)} sub={`of ${fmtNum(data?.reached)} reached`} tag="REAL" onClick={() => openMobDrill("confirmed", "Youth confirmed")} />
          <KpiTile label="Confirmed female" value={fmtNum(data?.confirmed_female)} sub={<><span style={{ color: femaleShareStatus(data?.confirmed_female_pct)?.color, fontWeight: 700 }}>{fmtPct(data?.confirmed_female_pct)}</span> of confirmed · target 60%</>} tag="REAL" onClick={() => openMobDrill("confirmed_female", "Confirmed female")} />
          <KpiTile label="Mobilisation rate" value={<span style={{ color: rateColor(data?.mobilisation_rate, "mobilisation_rate") }}>{fmtPct(data?.mobilisation_rate)}</span>} sub="confirmed ÷ reached" tag="REAL" onClick={() => openMobDrill("mobilisation_rate", "Mobilisation rate", fmtPct)} />
          <KpiTile label="Progress on target" value={<span style={{ color: RATE_CATEGORY_COLOR[categorizeRate(data?.progress_pct)] }}>{fmtPct(data?.progress_pct)}</span>} sub={`confirmed ÷ target (${fmtNum(data?.target)}) — call-center only, see Combined progress below`} tag="REAL" onClick={() => openMobDrill("progress_pct", "Progress on target", fmtPct)} />
        </Grid>
        <p style={{ fontSize: 11.5, color: C.muted, margin: "-6px 0 14px" }}>
          Everything above is built from the call-center pathway alone (DAILY_ACQUISITION_SUMMARY) — the auto-confirmed Newly registered pathway is deliberately kept out of these numbers so it never blends into one confusing rate. See it on its own below, and combined with this pathway in "Combined progress."
        </p>
        <Card title="BC3 Control List vs Newly registered" subtitle="Newly registered subcounties are auto-confirmed by policy — a distinct pathway with its own numbers, not blended into the BC3 Control List's rates." chip="REAL">
          <DataTable
            columns={[
              { key: "label", label: "Cycle" },
              { key: "assigned", label: "Assigned", align: "right", render: (v) => fmtNum(v) },
              { key: "reached", label: "Reached", align: "right", render: (v) => fmtNum(v) },
              { key: "confirmed", label: "Confirmed", align: "right", render: (v) => fmtNum(v) },
              { key: "reach_rate", label: "Reach rate", align: "right", render: renderRateCell("reach_rate") },
              { key: "mobilisation_rate", label: "Mobilisation rate", align: "right", render: renderRateCell("mobilisation_rate") },
              { key: "pct_female", label: "% Female", align: "right", render: renderPctFemaleCell },
            ]}
            rows={[
              { label: "BC3 Control List", ...data?.four_week },
              { label: "Newly registered", ...data?.two_half_week },
            ]}
            stickyHeader
          />
        </Card>

        {data?.combined && (
          <Card
            title="Combined progress — call-center + auto-confirm"
            subtitle="The one place both pathways are added together: auto-confirmed (awareness pilot) + confirmed (call-center), against a combined target (mobilisation target + the awareness-stage eligible target). Kept separate from the clean call-center numbers above on purpose."
            chip="REAL"
          >
            <Grid cols={3}>
              <KpiTile label="Auto-confirmed (awareness)" value={fmtNum(data.combined.auto_confirmed)} tag="REAL" />
              <KpiTile label="Confirmed (call-center)" value={fmtNum(data.combined.call_centre_confirmed)} tag="REAL" />
              <KpiTile label="Total so far" value={fmtNum(data.combined.total_so_far)} sub={`of ${fmtNum(data.combined.target)} combined target`} tag="REAL" />
            </Grid>
            <div style={{ margin: "4px 0 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: C.text, fontWeight: 600 }}>Progress on combined target</span>
                <span style={{ color: RATE_CATEGORY_COLOR[categorizeRate(data.combined.progress_pct)], fontWeight: 700 }}>{fmtPct(data.combined.progress_pct)}</span>
              </div>
              <div style={{ background: C.line, borderRadius: 6, height: 10 }}>
                <div style={{ width: `${Math.max(0, Math.min(100, data.combined.progress_pct || 0))}%`, background: RATE_CATEGORY_COLOR[categorizeRate(data.combined.progress_pct)], height: "100%", borderRadius: 6 }} />
              </div>
            </div>
            <DataTable
              columns={[
                { key: "label", label: "Target component" },
                { key: "value", label: "Value", align: "right", render: (v) => fmtNum(v) },
              ]}
              rows={[
                { label: "Mobilisation target (acquisition)", value: data.combined.mobilisation_target },
                { label: "Eligible target (awareness)", value: data.combined.eligible_target },
                { label: "Treatment target (of the acquisition target, by RCT split)", value: data.combined.treatment_target },
                { label: "Control target (of the acquisition target, by RCT split)", value: data.combined.control_target },
              ]}
              stickyHeader
            />
          </Card>
        )}

      </State>

      <ExecBand num="!" title="Insights" />
      <State loading={mob.loading || heatmap.loading} error={mob.error || heatmap.error} empty={!mob.loading && !heatmap.loading && !data && byVenue.length === 0}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
          {(data?.date_cutoff_cohorts || []).map((c) => {
            const cutoffAssigned = data?.two_half_week?.assigned || 0;
            const pctOfAssigned = data?.assigned ? Math.round(1000 * cutoffAssigned / data.assigned) / 10 : null;
            return (
              <Insight key={c.cohort} tone="warn">
                <b>{c.cohort}</b>'s auto-confirmed count is an open-ended rule — any youth registered on/after <b>{c.since}</b> counts as the pilot, unlike BOOTCAMP_4's fixed subcounty list, so it keeps growing every day the cutoff stays active. Right now <b>{fmtNum(cutoffAssigned)}</b> youth ({fmtPct(pctOfAssigned)} of Assigned) are counted this way — auto-confirmed by policy, not verified through the call center. Expect Assigned/Confirmed for this cohort to keep rising until a real upstream flag replaces this date rule.
              </Insight>
            );
          })}
          {data?.progress_pct != null && (() => {
            const tone = data.progress_pct >= 95 ? "pos" : data.progress_pct >= 75 ? "warn" : "risk";
            return <Insight tone={tone}><b>{fmtPct(data.progress_pct)}</b> of the mobilisation target reached — {fmtNum(data.confirmed)} of {fmtNum(data.target)} youth confirmed.</Insight>;
          })()}
          {data?.confirmed_female_pct != null && (() => {
            const pct = data.confirmed_female_pct;
            const tone = pct >= 60 ? "pos" : pct >= 50 ? "warn" : "risk";
            return (
              <Insight tone={tone}>
                Confirmed female share is <b>{fmtPct(pct)}</b> ({fmtNum(data.confirmed_female)} of {fmtNum(data.confirmed)} confirmed) — {tone === "pos" ? "at or above the 60% target." : "below the 60% target."}
              </Insight>
            );
          })()}
          {data?.four_week?.mobilisation_rate != null && data?.mobilisation_rate != null && Math.abs(data.mobilisation_rate - data.four_week.mobilisation_rate) >= 1 && (
            <Insight tone="warn">
              The blended mobilisation rate (<b>{fmtPct(data.mobilisation_rate)}</b>) reads {data.mobilisation_rate > data.four_week.mobilisation_rate ? "higher" : "lower"} than the BC3 Control List's real call-center rate (<b>{fmtPct(data.four_week.mobilisation_rate)}</b>) — the {fmtNum(data?.two_half_week?.assigned)} auto-confirmed Newly registered youth skew the overall figure. See the cycle breakdown above.
            </Insight>
          )}
          {topVenue && (
            <Insight tone="pos"><b>{topVenue.venue}</b> confirmed the most youth overall ({fmtNum(topVenue.confirmed)}, {fmtPct(topVenue.rate)} of reached).</Insight>
          )}
          {venueRows.filter((v) => v.conversionCategory === "High Risk").length > 0 && (
            <Insight tone="risk"><b>{venueRows.filter((v) => v.conversionCategory === "High Risk").length} venue(s)</b> are confirming fewer than 75% of reached youth — see the table below.</Insight>
          )}
        </div>
      </State>

      <ExecBand num="◆" title="Performance categorisation — Parish / Venue vs target (filters)" />
      <State loading={heatmap.loading} error={heatmap.error} empty={!heatmap.loading && parishRows.length === 0 && venueRows.length === 0}>
        <Card
          title="District totals"
          subtitle="Same disaggregation as the parish table below, summed to district grain — call-center vs auto-confirmed (awareness), each checked against its own target."
          chip="REAL"
        >
          <GroupedDataTable
            leading={[{ key: "district", label: "District" }]}
            groups={sourceGroups}
            trailing={sourceTrailingColumns}
            rows={districtTotalRows}
            stickyHeader
          />
        </Card>

        <Insight tone="neutral">
          <b>How to use these filters.</b> Click <b>Parish</b> or <b>Venue</b> to switch grain — Parish is the default and shows the full call-center vs auto-confirmed split; Venue is call-center only (see below). Click a status to filter the table to just those rows. Click <b>All</b> to reset.
        </Insight>

        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          <button onClick={() => setMobGrain("parish")} style={{ fontSize: 12, fontWeight: 700, padding: "7px 16px", border: `1px solid ${mobGrain === "parish" ? C.gold : C.line}`, borderRadius: 5, background: mobGrain === "parish" ? C.gold : C.white, color: mobGrain === "parish" ? C.ink : C.inkSoft, cursor: "pointer" }}>Parish</button>
          <button onClick={() => setMobGrain("venue")} style={{ fontSize: 12, fontWeight: 700, padding: "7px 16px", border: `1px solid ${mobGrain === "venue" ? C.gold : C.line}`, borderRadius: 5, background: mobGrain === "venue" ? C.gold : C.white, color: mobGrain === "venue" ? C.ink : C.inkSoft, cursor: "pointer" }}>Venue</button>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
          <input
            type="text"
            value={mobSearch}
            onChange={(e) => setMobSearch(e.target.value)}
            placeholder="Search parish, venue, or district…"
            style={{ flex: "1 1 240px", fontSize: 12, padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 5 }}
          />
          <MultiSelectDropdown label="Parishes" options={parishOptions} selected={selectedParishes} onChange={setSelectedParishes} />
          <MultiSelectDropdown label="Venues" options={venueOptions} selected={selectedVenues} onChange={setSelectedVenues} />
        </div>

        <CategoryFilterTiles counts={mobGrain === "parish" ? parishCatCounts : venueCatCounts} active={parishCat} onChange={setParishCat} entityLabelPlural={mobGrain === "parish" ? "parishes" : "venues"} />
        <Card
          title={mobGrain === "parish" ? "Parish performance vs target" : "Venue performance vs target"}
          subtitle={mobGrain === "parish"
            ? `Call-center confirmed (vs mobilisation target) and auto-confirmed from awareness-eligible youth (vs treatment target) shown separately, plus the total confirmed vs combined target. 5 parishes visible at a time — scroll down for the rest.`
            : "Call-center confirmed (vs mobilisation target) shown alongside its parish's auto-confirmed figure (vs treatment target) — awareness records carry no venue at all, only district/parish, so that middle block is the same number on every venue in that parish, not venue-specific. Total stays call-center-only, to avoid double-counting a shared parish figure across sibling venues."}
          chip="REAL"
        >
          {mobGrain === "parish" ? (
            <GroupedDataTable
              leading={[{
                key: "parish",
                label: "Parish",
                render: (v, r) => (
                  <div>
                    <div>{v}</div>
                    <div style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>{r.district}</div>
                  </div>
                ),
              }]}
              groups={sourceGroups}
              trailing={sourceTrailingColumns}
              rows={filteredParishRows}
              stickyLeading
              stickyHeader
              maxBodyHeight={300}
            />
          ) : (
            <GroupedDataTable
              leading={[{ key: "district", label: "District" }, { key: "venue", label: "Venue" }]}
              groups={venueGroups}
              trailing={venueTrailingColumns}
              rows={filteredVenueRows}
              stickyHeader
              maxBodyHeight={300}
            />
          )}
        </Card>
      </State>
    </div>
  );
}

// Categories mirror the reference design's risk bands. Originally venue-only
// (confirmed ÷ reached call-center conversion — see tables.py's
// DAILY_ACQUISITION_SUMMARY note on why reached, not assigned, is the
// denominator); now reused by any entity (venue, parish, ...) that has a
// rate against a target, so every categorisation panel in the app shares one
// color scheme instead of each tab inventing its own.
const RATE_CATEGORY_ORDER = ["Target Achieved", "On Track", "Low Risk", "High Risk", "Not Started"];
const RATE_CATEGORY_COLOR = { "Target Achieved": C.green, "On Track": C.teal, "Low Risk": C.gold, "High Risk": C.coral, "Not Started": C.muted };
function categorizeRate(rate) {
  if (rate == null) return "Not Started";
  if (rate >= 95) return "Target Achieved";
  if (rate >= 85) return "On Track";
  if (rate >= 75) return "Low Risk";
  return "High Risk";
}
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// Venue name-mismatch categorisation — Quality Assurance Calls' venue table.
// Inverted severity from RATE_CATEGORY_COLOR above (a HIGH rate is bad here,
// not good), so this is its own small scheme rather than reusing that one.
const VENUE_MISMATCH_ORDER = ["High mismatch", "Low mismatch", "No mismatch"];
const VENUE_MISMATCH_COLOR = { "High mismatch": C.coral, "Low mismatch": C.gold, "No mismatch": C.green };
function categorizeVenueMismatch(rate) {
  if (rate == null || rate === 0) return "No mismatch";
  if (rate > 20) return "High mismatch";
  return "Low mismatch";
}

const PAGER_BTN = { fontSize: 11, fontWeight: 700, padding: "5px 10px", border: `1px solid ${C.line}`, borderRadius: 4, background: C.white, color: C.inkSoft, cursor: "pointer" };

function EntityPagedTable({ title, subtitle, chip, chipTone, rows, metricA, metricB, entityKey, entityLabel }) {
  const [page, setPage] = useState(0);
  const pageSize = 5;
  const maxPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const clamped = Math.min(page, maxPage);
  const slice = rows.slice(clamped * pageSize, clamped * pageSize + pageSize);
  return (
    <Card title={title} subtitle={subtitle} chip={chip} chipTone={chipTone}>
      <DataTable
        columns={[
          { key: entityKey, label: cap(entityLabel) },
          { key: metricA.key, label: metricA.label, align: "right", render: (v) => fmtNum(v) },
          { key: metricB.key, label: metricB.label, align: "right", render: (v) => fmtNum(v) },
          { key: "rate", label: "Rate", align: "right", render: (v, r) => <span style={{ color: RATE_CATEGORY_COLOR[r.category], fontWeight: 700 }}>{fmtPct(v)}</span> },
          { key: "category", label: "Status", render: (v) => <span style={{ color: RATE_CATEGORY_COLOR[v], fontWeight: 700 }}>{v}</span> },
        ]}
        rows={slice}
      />
      {rows.length > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9, fontSize: 11, color: C.muted }}>
          <span>{clamped * pageSize + 1}–{Math.min(rows.length, clamped * pageSize + pageSize)} of {rows.length}</span>
          <span style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setPage(Math.max(0, clamped - 1))} disabled={clamped === 0} style={{ ...PAGER_BTN, opacity: clamped === 0 ? 0.5 : 1 }}>‹ Prev</button>
            <button onClick={() => setPage(Math.min(maxPage, clamped + 1))} disabled={clamped === maxPage} style={{ ...PAGER_BTN, opacity: clamped === maxPage ? 0.5 : 1 }}>Next ›</button>
          </span>
        </div>
      )}
    </Card>
  );
}

// Shared click-to-filter chip row for any category breakdown (parish
// categorisation, venue categorisation, ...) — one look everywhere in the app.
// Matches the reference design's small pill "fchip" filters (colored dot +
// bold count, dark-filled when active) rather than full score-card tiles.
function CategoryFilterTiles({ counts, active, onChange, entityLabelPlural }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
      {["All", ...RATE_CATEGORY_ORDER].map((c) => {
        const isActive = active === c;
        const dotColor = RATE_CATEGORY_COLOR[c];
        return (
          <span
            key={c}
            onClick={() => onChange(isActive && c !== "All" ? "All" : c)}
            style={{
              border: `1px solid ${isActive ? C.ink : C.line}`,
              background: isActive ? C.ink : C.white,
              color: isActive ? C.white : C.inkSoft,
              borderRadius: 20, padding: "6px 13px", fontSize: 12, fontWeight: 600,
              cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7,
            }}
          >
            {c !== "All" && <span style={{ width: 10, height: 10, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />}
            {c === "All" ? `All ${entityLabelPlural}` : c}
            <span style={{ fontWeight: 800, color: isActive ? C.gold : undefined }}>{counts[c] ?? 0}</span>
          </span>
        );
      })}
    </div>
  );
}

function EntityCategorisation({ rows: entityRows, metricA, metricB, rateFraction, entityKey = "venue", entityLabel = "venue", entityLabelPlural = "venues" }) {
  const [cat, setCat] = useState("All");
  const counts = { All: entityRows.length };
  RATE_CATEGORY_ORDER.forEach((c) => { counts[c] = entityRows.filter((v) => v.category === c).length; });
  const filtered = cat === "All" ? entityRows : entityRows.filter((v) => v.category === cat);
  const sortedDesc = [...filtered].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const sortedAsc = [...sortedDesc].reverse();
  const sumA = filtered.reduce((a, v) => a + (v[metricA.key] || 0), 0);
  const sumB = filtered.reduce((a, v) => a + (v[metricB.key] || 0), 0);
  const filteredRate = sumA ? Math.round((1000 * sumB) / sumA) / 10 : null;

  const closestToTarget = [...filtered]
    .filter((v) => v.category === "Low Risk" || v.category === "High Risk")
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1))[0];

  return (
    <div>
      <Insight tone="neutral">
        <b>How to use these filters.</b> Click a category to filter the score cards and {entityLabelPlural} tables below to just those {entityLabelPlural}. Click <b>All</b> to reset.
      </Insight>
      <CategoryFilterTiles counts={counts} active={cat} onChange={setCat} entityLabelPlural={entityLabelPlural} />
      <Grid cols={4}>
        <KpiTile label={`${cap(entityLabelPlural)} in view`} value={String(filtered.length)} sub={cat} tag="REAL" />
        <KpiTile label={`${metricA.label} (sum)`} value={fmtNum(sumA)} sub={`sum of these ${entityLabelPlural}`} tag="REAL" />
        <KpiTile label={`${metricB.label} (sum)`} value={fmtNum(sumB)} sub={`sum of these ${entityLabelPlural}`} tag="REAL" />
        <KpiTile label="Rate" value={<span style={{ color: RATE_CATEGORY_COLOR[categorizeRate(filteredRate)] }}>{fmtPct(filteredRate)}</span>} sub={rateFraction} tag="DERIVED" tone="sim" />
      </Grid>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <EntityPagedTable title={`Top ${entityLabelPlural}`} subtitle={`Highest rate (${rateFraction})`} chip="STRONGEST" chipTone="real" rows={sortedDesc} metricA={metricA} metricB={metricB} entityKey={entityKey} entityLabel={entityLabel} />
        <EntityPagedTable title={`Bottom ${entityLabelPlural}`} subtitle="Lowest — priority for a closing follow-up round" chip="FOLLOW UP" chipTone="sim" rows={sortedAsc} metricA={metricA} metricB={metricB} entityKey={entityKey} entityLabel={entityLabel} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
        <Insight tone={counts["Target Achieved"] + counts["On Track"] >= filtered.length / 2 ? "pos" : "neutral"}>
          <b>{counts["Target Achieved"]}</b> {entityLabelPlural} have hit Target Achieved and <b>{counts["On Track"]}</b> are On Track, out of {entityRows.length} reporting {entityLabelPlural}.
        </Insight>
        {closestToTarget && (
          <Insight tone="warn">
            <b>{closestToTarget[entityKey]}</b> is the closest {entityLabel} below target ({fmtPct(closestToTarget.rate)} {rateFraction}) — one follow-up round would likely tip it into On Track.
          </Insight>
        )}
      </div>
    </div>
  );
}


// Same avg-daily-rate ÷ remaining-to-target formula the backend uses for the
// page-level "Days to target" KPI (see mobilisation_forecast in recruitment.py),
// applied per-district/venue instead of in aggregate. `nDays` (how many
// calendar days the current cohort/date-range's daily series covers) is
// shared across every district/venue — it isn't entity-specific, just the
// window length — so this only needs each entity's own real confirmed/target,
// nothing estimated.
function daysToTargetFor(confirmed, target, nDays) {
  if (!target) return null;
  if (confirmed >= target) return 0;
  const avgDailyRate = nDays ? confirmed / nDays : 0;
  if (!avgDailyRate) return null;
  return Math.round((target - confirmed) / avgDailyRate);
}

const FORECAST_DRILL_COLUMNS = [
  { key: "target", label: "Target", align: "right", render: (v) => (v == null ? "—" : fmtNum(v)) },
  { key: "progressPct", label: "Progress on target", align: "right", render: (v, r) => <span style={{ color: RATE_CATEGORY_COLOR[r.category], fontWeight: 700 }}>{fmtPct(v)}</span> },
  { key: "daysToTarget", label: "Days to target", align: "right", render: (v) => (v == null ? "—" : v <= 0 ? "Met" : fmtNum(v)) },
];

function MobForecastsPage({ filters, dateFrom, dateTo }) {
  const drill = useDrill();
  const { data, loading, error } = useApi(`/api/recruitment/mobilisation-forecast${withDateRange(filters, dateFrom, dateTo)}`);
  // Reference prototype's "Site early-warning flags" panel uses a fabricated
  // "days elapsed / 16" cycle-length pace rule and hardcoded sample venues
  // (explicitly tagged SIMULATED RULE there) — no such cycle-length field
  // exists in live data. Real equivalent: flag venues by the same
  // confirmed÷reached conversion-rate bands used on the Mobilisation overview
  // page's venue categorisation, driven by the live mobilisation-heatmap
  // venue rollup instead of a fabricated pace projection.
  const heatmap = useApi(`/api/recruitment/mobilisation-heatmap${withDateRange(filters, dateFrom, dateTo)}`);
  const daily = data?.daily || [];
  const nDays = daily.length;
  // Sorted worst-first (lowest conversion first) — the sites needing a
  // follow-up round surface at the top, not buried under the healthy ones.
  const flaggedVenues = (heatmap.data?.by_venue || [])
    .map((v) => {
      const reached = v.reached || 0, confirmed = v.confirmed || 0;
      const rate = reached ? Math.round((1000 * confirmed) / reached) / 10 : null;
      return { venue: v.venue, district: v.district, reached, confirmed, rate, category: categorizeRate(rate) };
    })
    .filter((v) => v.category === "Low Risk" || v.category === "High Risk")
    .sort((a, b) => (a.rate ?? -1) - (b.rate ?? -1));

  const highRiskVenues = flaggedVenues.filter((v) => v.category === "High Risk");
  const worstVenue = flaggedVenues[0];
  // District with the most flagged sites — a concentration here points to a
  // district-level fix (retrain agents, add a follow-up round) rather than
  // one-off site visits.
  const flaggedByDistrict = {};
  flaggedVenues.forEach((v) => { flaggedByDistrict[v.district] = (flaggedByDistrict[v.district] || 0) + 1; });
  const worstDistrict = Object.entries(flaggedByDistrict).sort((a, b) => b[1] - a[1])[0];

  // District root -> venue child, same "Days to target" formula at both
  // grains, off the same heatmap data the rest of this page already uses.
  function openDaysToTargetDrill() {
    const districtRows = (heatmap.data?.by_district || []).map((d) => {
      const target = d.target || 0, confirmed = d.confirmed || 0;
      const progressPct = target ? Math.round((1000 * confirmed) / target) / 10 : null;
      return { district: d.district, target, progressPct, daysToTarget: daysToTargetFor(confirmed, target, nDays), category: categorizeRate(progressPct) };
    });
    drill.open({
      title: "Days to target — by district",
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      childKey: "venue", childLabel: "Venue",
      columns: FORECAST_DRILL_COLUMNS,
      rootRows: districtRows,
      getChildRows: (root) => (heatmap.data?.by_venue || [])
        .filter((v) => v.district === root.district)
        .map((v) => {
          const target = v.target ?? null, confirmed = v.confirmed || 0;
          const progressPct = target ? Math.round((1000 * confirmed) / target) / 10 : null;
          return { venue: v.venue, target, progressPct, daysToTarget: daysToTargetFor(confirmed, target, nDays), category: categorizeRate(progressPct) };
        })
        .sort((a, b) => (a.daysToTarget ?? Infinity) - (b.daysToTarget ?? Infinity)),
    });
  }

  return (
    <div>
      <Grid cols={4}>
        <KpiTile label="Confirmed to date" value={fmtNum(data?.confirmed_to_date)} tag="REAL" />
        <KpiTile label="Mobilisation target" value={fmtNum(data?.target)} tag="REAL" />
        <KpiTile label="Avg daily rate" value={fmtNum(data?.avg_daily_rate)} tag="REAL" />
        <KpiTile label="Days to target" value={data?.days_to_target ?? "—"} sub="At current pace" tag="DERIVED" tone="sim" onClick={openDaysToTargetDrill} />
      </Grid>
      <Card title="Daily trend — youth confirmed vs unique call attempts" subtitle="Daily reach/confirm volume against the mobilisation target" chip="REAL">
        <State loading={loading} error={error} empty={!loading && daily.length === 0}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={daily} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="event_date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip /><Legend />
              <Line type="monotone" dataKey="reached" name="Reached" stroke={C.teal} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="confirmed" name="Confirmed" stroke={C.gold} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </State>
      </Card>
      <Card title="Site early-warning flags" subtitle="Venues confirming below 85% of reached youth, worst first — see Mobilisation overview → Performance categorisation for the full breakdown. Shows 10 at a time — scroll for the rest." chip="REAL">
        <State loading={heatmap.loading} error={heatmap.error} empty={!heatmap.loading && flaggedVenues.length === 0}>
          <DataTable
            columns={[
              { key: "venue", label: "Site" },
              { key: "district", label: "District" },
              { key: "reached", label: "Reached", align: "right", render: (v) => fmtNum(v) },
              { key: "confirmed", label: "Confirmed", align: "right", render: (v) => fmtNum(v) },
              { key: "rate", label: "Confirmed ÷ reached", align: "right", render: (v, r) => <span style={{ color: RATE_CATEGORY_COLOR[r.category], fontWeight: 700 }}>{fmtPct(v)}</span> },
              { key: "category", label: "Status", render: (v) => <span style={{ color: RATE_CATEGORY_COLOR[v], fontWeight: 700 }}>{v}</span> },
            ]}
            rows={flaggedVenues}
            maxBodyHeight={380}
            stickyHeader
          />
        </State>
      </Card>
      {flaggedVenues.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
          {worstVenue && (
            <Insight tone="risk">
              <b>{worstVenue.venue}</b> ({worstVenue.district}) has the lowest conversion at <b>{fmtPct(worstVenue.rate)}</b> ({fmtNum(worstVenue.confirmed)} of {fmtNum(worstVenue.reached)} reached) — prioritise this site for a follow-up call round first.
            </Insight>
          )}
          {highRiskVenues.length > 0 && (
            <Insight tone="risk">
              <b>{fmtNum(highRiskVenues.length)} of {fmtNum(flaggedVenues.length)} flagged sites are High Risk</b> (confirming below 75% of reached) — these are the ones a single follow-up round is unlikely to fix on its own; consider re-assigning call-center agents or re-checking the reached-list quality at these sites specifically.
            </Insight>
          )}
          {worstDistrict && worstDistrict[1] > 1 && (
            <Insight tone="warn">
              <b>{worstDistrict[0]}</b> has <b>{fmtNum(worstDistrict[1])}</b> flagged sites — more than any other district. Worth a district-level fix (agent retraining, an extra call round) rather than site-by-site follow-up.
            </Insight>
          )}
        </div>
      )}
    </div>
  );
}

function MobPerformancePage({ filters }) {
  return (
    <div>
      <p style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
        Named mobiliser performance and the offline (field mobiliser) vs online (telemarketer)
        channel split. No live table currently has both a named mobiliser/channel tag AND
        reach/confirm counts together — <code>daily_acquisition_summary</code>'s
        <code>mobilizer_name</code>, <code>collection_type</code> and <code>offline_venue</code>{" "}
        columns are all 100% empty. Same gap as the Recruitment → Mobilisers tab.
      </p>
      <MobilisersTab filters={filters} />
    </div>
  );
}

function MobControlCallsPage({ dateFrom, dateTo }) {
  const { data, loading, error } = useApi(`/api/recruitment/control-calls${withDateRange({}, dateFrom, dateTo)}`);
  return (
    <div>
      <p style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
        The randomised control/comparison arm — eligible youth tracked for status and
        reachability only (no mobilisation pitch), so the team can measure what mobilisation
        actually adds. Decision/interest fields are empty by design for this arm.
      </p>
      <State loading={loading} error={error} empty={!loading && !data}>
        <Grid cols={4}>
          <KpiTile label="Control youth tracked" value={fmtNum(data?.total)} sub={`${fmtNum(data?.control)} control · ${fmtNum(data?.mobilization)} mobilization arm`} tag="REAL" />
          <KpiTile label="Successfully reached" value={fmtPct(data?.reach_pct)} sub={`${fmtNum(data?.reached)} of ${fmtNum(data?.total)}`} tag="REAL" />
          <KpiTile label="Female share" value={<span style={{ color: femaleShareStatus(data?.pct_female)?.color }}>{fmtPct(data?.pct_female)}</span>} sub="target 60%" tag="REAL" />
          <KpiTile label="Mean age" value={data?.avg_age ?? "—"} sub="years" tag="REAL" />
        </Grid>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
          <Card title="Call status" subtitle="Outcome of the status-tracking call" chip="REAL">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data?.by_status || []} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="status" tick={{ fontSize: 10.5 }} width={90} />
                <Tooltip />
                <Bar dataKey="n" name="# Youth" fill={C.teal} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
          <Card title="District composition" chip="REAL">
            <DataTable
              columns={[
                { key: "district", label: "District" },
                { key: "n", label: "# Youth", align: "right", render: (v) => fmtNum(v) },
              ]}
              rows={data?.by_district || []}
              stickyHeader
            />
          </Card>
        </div>
      </State>
    </div>
  );
}

// Theme breakdown (chart + table) plus the full verbatim quote list below it —
// shared by the three keyword-classified free-text sections on the Call
// Centre Insights page (gatekeeper interactions / questions / support asks).
// Each backend field driving this is `{n, themes, quotes}` — `themes` counts
// every match (not deduped, so the frequency read is honest) while `quotes`
// is deduped for display; "keep a wide range of verbatims" means quotes is
// intentionally NOT trimmed down to match the theme chart's top rows.
function ThemedQuotesCard({ title, subtitle, data, color, loading, error, chartHeight = 180 }) {
  const themes = data?.themes || [];
  const quotes = data?.quotes || [];
  return (
    <Card title={`${title} (n=${data?.n || 0})`} subtitle={subtitle} chip="SAMPLE" chipTone="sim">
      <State loading={loading} error={error} empty={!loading && themes.length === 0}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: 18 }}>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <BarChart data={themes} layout="vertical" margin={{ left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
              <YAxis type="category" dataKey="theme" tick={{ fontSize: 9.5 }} width={190} />
              <Tooltip />
              <Bar dataKey="count" fill={color} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <DataTable
            columns={[{ key: "theme", label: "Theme" }, { key: "count", label: "#", align: "right", render: (v) => fmtNum(v) }, { key: "pct", label: "%", align: "right", render: (v) => fmtPct(v) }]}
            rows={themes}
            stickyHeader
          />
        </div>
        <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 8 }}>
            Verbatim — all {quotes.length}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: C.text, lineHeight: 1.8, columns: "2 300px", columnGap: 24 }}>
            {quotes.map((q, i) => <li key={i} style={{ breakInside: "avoid" }}>{q}</li>)}
          </ul>
        </div>
      </State>
    </Card>
  );
}

function MobCallCentreInsightsPage({ dateFrom, dateTo }) {
  // 5 minutes matches the backend's own BigQuery cache TTL (app/core/cache.py)
  // — polling faster wouldn't surface anything newer, just re-run the same
  // cached query. Every classification here re-runs live over whatever call-log
  // rows exist at fetch time, so this keeps the page current without a reload.
  const cc = useApi(`/api/recruitment/call-centre-insights${withDateRange({}, dateFrom, dateTo)}`, { pollMs: 5 * 60 * 1000 });
  const data = cc.data;
  const outcomes = data?.call_outcomes || [];
  const gk = data?.gatekeepers;
  const gkBreakdown = gk?.breakdown || [];
  const gkRelationship = gk?.relationship;
  const declineNo = data?.decline_reasons_no;
  const declineMaybe = data?.decline_reasons_maybe;
  const attendanceSupportNeeded = data?.attendance_support_needed;
  const genuineQuestions = data?.genuine_questions || {};
  const topQuestionTheme = genuineQuestions.themes?.[0];
  const topSupportCategory = attendanceSupportNeeded?.categories?.[0];
  const interestByLabel = Object.fromEntries((data?.interest || []).map((i) => [i.label, i.count]));
  const gkByWho = Object.fromEntries(gkBreakdown.map((g) => [g.who, g.count]));
  const pctColumns = [
    { key: "count", label: "#", align: "right", render: (v) => fmtNum(v) },
    { key: "pct", label: "%", align: "right", render: (v) => fmtPct(v) },
  ];

  return (
    <div>
      <p style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
        BOOTCAMP_5 acquisition call log ({fmtNum(data?.calls_analysed)} calls) — call outcomes,
        who actually answers for the youth ("gatekeepers"), why declined/hesitant youth said
        no vs. maybe, what support they need, and a categorised read of every agent's
        free-text call note for the genuine questions youth asked. Refreshes automatically
        every 5 minutes against live BigQuery — no need to reload the page to see new calls
        land.
      </p>

      <Grid cols={4}>
        <KpiTile label="Calls analysed" value={fmtNum(data?.calls_analysed)} sub="BOOTCAMP_5 acquisition call log" tag="REAL" />
        <KpiTile label="Reach rate" value={fmtPct(data?.reach_rate)} sub={`${fmtNum(data?.reached)} reached of ${fmtNum(data?.calls_analysed)}`} tag="REAL" />
        <KpiTile label="Positive intent" value={fmtPct(data?.positive_intent_rate)} sub={`of ${fmtNum(data?.interest_answered)} who stated an opinion`} tag="REAL" />
        <KpiTile label="Gatekeeper rate" value={fmtPct(gk?.gatekeeper_rate)} sub={`of ${fmtNum(gk?.n_with_decision)} calls with a captured decision-maker`} tag="REAL" />
      </Grid>

      <ExecBand num="◆" title="Call status breakdown" />
      <Card title="Call outcomes" subtitle="What happened when the call was placed" chip="REAL">
        <State loading={cc.loading} error={cc.error} empty={!cc.loading && outcomes.length === 0}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={outcomes} layout="vertical" margin={{ left: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="status" tick={{ fontSize: 11 }} width={100} />
                <Tooltip />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {outcomes.map((o, i) => <Cell key={i} fill={o.status === "Reached" ? C.green : CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <DataTable
              columns={[{ key: "status", label: "Status" }, { key: "count", label: "# Calls", align: "right", render: (v) => fmtNum(v) }, { key: "pct", label: "% of calls", align: "right", render: (v) => fmtPct(v) }]}
              rows={outcomes}
              stickyHeader
            />
          </div>
        </State>
      </Card>

      <ExecBand num="◆" title="Gatekeepers — who actually answers for the youth" />
      <Card
        title="Decision-maker on the call"
        subtitle={`Among the ${fmtNum(gk?.n_with_decision)} calls that captured who decides — anyone other than the youth (parent, spouse, relative, friend, community leader) is a gatekeeper standing between the call centre and the youth`}
        chip="REAL"
      >
        <State loading={cc.loading} error={cc.error} empty={!cc.loading && gkBreakdown.length === 0}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={gkBreakdown} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="who" tick={{ fontSize: 10 }} width={165} />
                <Tooltip />
                <Bar dataKey="count" fill={C.gold} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <DataTable columns={[{ key: "who", label: "Who" }, { key: "count", label: "# Calls", align: "right", render: (v) => fmtNum(v) }, { key: "pct", label: "% of captured", align: "right", render: (v) => fmtPct(v) }]} rows={gkBreakdown} stickyHeader />
          </div>
        </State>
      </Card>
      <Card
        title="Gatekeeper relationship — proxy contact reached"
        subtitle={`A second, independent structured field — populated whenever a proxy contact was actually reached (${fmtNum(gkRelationship?.n)} calls), regardless of whether the decision-maker above was also captured`}
        chip="REAL"
      >
        <State loading={cc.loading} error={cc.error} empty={!cc.loading && !(gkRelationship?.breakdown?.length)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={gkRelationship?.breakdown || []} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="who" tick={{ fontSize: 10 }} width={90} />
                <Tooltip />
                <Bar dataKey="count" fill={C.gold} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <DataTable columns={[{ key: "who", label: "Relationship" }, { key: "count", label: "# Calls", align: "right", render: (v) => fmtNum(v) }, { key: "pct", label: "% of captured", align: "right", render: (v) => fmtPct(v) }]} rows={gkRelationship?.breakdown || []} stickyHeader />
          </div>
        </State>
      </Card>
      <ThemedQuotesCard
        title="Gatekeeper interactions — verbatim"
        subtitle="Agent call notes mentioning who actually picked up, grouped into themes — smaller-sample qualitative texture (real telemarketer wording) alongside the two structured breakdowns above"
        data={gk?.interactions}
        color={C.gold}
        loading={cc.loading}
        error={cc.error}
      />

      <ExecBand num="◆" title="Interest & decline reasons" />
      <Grid cols={3}>
        <KpiTile label="Yes" value={fmtNum(interestByLabel.Yes)} sub="of calls that stated an opinion" tag="REAL" />
        <KpiTile label="Maybe" value={fmtNum(interestByLabel.Maybe)} sub="of calls that stated an opinion" tag="REAL" />
        <KpiTile label="No" value={fmtNum(interestByLabel.No)} sub="of calls that stated an opinion" tag="REAL" />
      </Grid>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <Card title={`Why "No" (n=${declineNo?.n || 0})`} subtitle="Reasons given by youth who declined, categorised" chip="SAMPLE" chipTone="sim">
          <State loading={cc.loading} error={cc.error} empty={!cc.loading && !(declineNo?.categories?.length)}>
            <DataTable columns={[{ key: "category", label: "Reason" }, ...pctColumns]} rows={declineNo?.categories || []} stickyHeader />
          </State>
        </Card>
        <Card title={`Why "Maybe" (n=${declineMaybe?.n || 0})`} subtitle="Reasons given by youth who are unsure, categorised" chip="SAMPLE" chipTone="sim">
          <State loading={cc.loading} error={cc.error} empty={!cc.loading && !(declineMaybe?.categories?.length)}>
            <DataTable columns={[{ key: "category", label: "Reason" }, ...pctColumns]} rows={declineMaybe?.categories || []} stickyHeader />
          </State>
        </Card>
      </div>

      <ExecBand num="◆" title="Attendance support needed" />
      <Card
        title={`What support youth need (n=${fmtNum(attendanceSupportNeeded?.n)})`}
        subtitle='A dedicated coded field on every call, not something mined out of general notes — the "support needed" column on the acquisition mart is empty for BC5, but this one carries the real signal'
        chip="REAL"
      >
        <State loading={cc.loading} error={cc.error} empty={!cc.loading && !(attendanceSupportNeeded?.categories?.length)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <ResponsiveContainer width="100%" height={Math.max(260, (attendanceSupportNeeded?.categories?.length || 0) * 28 + 40)}>
              <BarChart data={attendanceSupportNeeded?.categories || []} layout="vertical" margin={{ left: 10 }} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="category" tick={{ fontSize: 9.5 }} width={185} interval={0} />
                <Tooltip />
                <Bar dataKey="count" fill={C.coral} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <DataTable columns={[{ key: "category", label: "Support needed" }, ...pctColumns]} rows={attendanceSupportNeeded?.categories || []} stickyHeader />
          </div>
        </State>
      </Card>

      <ExecBand num="◆" title="Qualitative call-notes analysis — deep read" />
      <p style={{ fontSize: 11.5, color: C.muted, margin: "-6px 0 14px" }}>
        Every one of the {fmtNum(data?.feedback_n)} agent call notes was scanned and classified
        by a keyword ruleset tuned by reading each one — not a live model call, but the same
        analysis a human coder would produce. The most actionable theme it surfaces is below,
        broken into its own sub-themes with a full verbatim list — not just a handful of
        examples.
      </p>
      <ThemedQuotesCard
        title="Questions youth ask"
        subtitle="Genuine questions extracted from call notes, grouped into themes"
        data={genuineQuestions}
        color={C.teal}
        loading={cc.loading}
        error={cc.error}
      />

      <ExecBand num="!" title="The story" />
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
        <Insight tone="pos">
          <b>Intent is not the problem.</b> {fmtPct(data?.positive_intent_rate)} of youth who stated an opinion are positive — the {fmtNum(declineNo?.n)} "no"s are overwhelmingly practical and involuntary (already employed, pregnancy/childcare, relocation, already in school), not persuasion failures.
        </Insight>
        <Insight tone="warn">
          <b>Most captured decisions don't come from the youth.</b> Among the {fmtNum(gk?.n_with_decision)} calls that recorded who decides, {fmtPct(gk?.gatekeeper_rate)} went through a gatekeeper — mostly parents ({fmtNum(gkByWho.Parents)}) and spouses ({fmtNum(gkByWho.Spouse)}). A second, independent field confirms the same pattern at even larger scale: of {fmtNum(gkRelationship?.n)} calls where a proxy contact was actually reached, {fmtPct(gkRelationship?.breakdown?.[0]?.pct)} were a {(gkRelationship?.breakdown?.[0]?.who || "").toLowerCase()}. Call scripts and identity verification need to treat a proxy respondent as the norm, not the exception.
        </Insight>
        <Insight tone="neutral">
          <b>Youth are asking about the payoff, not the programme.</b> "{topQuestionTheme?.theme}" is the top theme in the genuine questions ({fmtNum(topQuestionTheme?.count)} of {fmtNum(genuineQuestions.n)}) — a short scripted FAQ at first contact would answer most of these upfront.
        </Insight>
        <Insight tone="warn">
          <b>Support needs are overwhelmingly one thing: transport.</b> "{topSupportCategory?.category}" alone accounts for {fmtPct(topSupportCategory?.pct)} of the {fmtNum(attendanceSupportNeeded?.n)} calls where a support need was logged — a concrete, fixable logistics gap, not a new benefit to design. {fmtPct(attendanceSupportNeeded?.categories?.find((c) => c.category === "No support needed")?.pct)} said they need no support at all.
        </Insight>
      </div>
    </div>
  );
}

function MobQualityAssuranceCallsPage() {
  // No date range here (unlike every other Mobilisation sub-page) — the
  // source table (gold rollup, venue x mobilizer x cycle grain) has no date
  // column at all to filter on. Same 5-minute poll as Call Centre Insights.
  const qa = useApi("/api/recruitment/qa-calls", { pollMs: 5 * 60 * 1000 });
  const data = qa.data;
  const outcomes = data?.call_outcomes || [];
  const confirmationOutcome = data?.confirmation_outcome || [];
  const nameBreakdown = data?.name_breakdown || [];
  const supportQuotes = data?.support_needed?.quotes || [];
  const byDistrict = data?.by_district || [];
  const byVenue = data?.by_venue || [];
  const byGender = data?.by_gender || [];
  const daily = data?.daily || [];
  const pctColumns = [
    { key: "count", label: "# Youth", align: "right", render: (v) => fmtNum(v) },
    { key: "pct", label: "%", align: "right", render: (v) => fmtPct(v) },
  ];
  // Flags a gap worth a second look — same 5pp convention Executive
  // Summary's gender table uses for female-vs-male retention.
  function renderGapFlaggedPct(v, gapAbs) {
    const flagged = gapAbs != null && gapAbs > 5;
    return <span style={{ color: flagged ? C.coral : "inherit", fontWeight: flagged ? 700 : 400 }}>{fmtPct(v)}</span>;
  }
  const genderConfirmedGap = byGender.length === 2 ? Math.abs((byGender[0].identity_confirmed_rate || 0) - (byGender[1].identity_confirmed_rate || 0)) : null;
  const genderNameGap = byGender.length === 2 ? Math.abs((byGender[0].name_match_rate || 0) - (byGender[1].name_match_rate || 0)) : null;

  // Defaults to "High mismatch" — the table exists to surface a follow-up
  // list, not to show every venue at once.
  const [venueMismatchFilter, setVenueMismatchFilter] = useState("High mismatch");
  const byVenueCategorized = byVenue.map((v) => ({ ...v, category: categorizeVenueMismatch(v.name_mismatch_rate) }));
  const venueMismatchCounts = Object.fromEntries(
    VENUE_MISMATCH_ORDER.map((c) => [c, byVenueCategorized.filter((v) => v.category === c).length]),
  );
  const filteredByVenue = venueMismatchFilter === "All" ? byVenueCategorized : byVenueCategorized.filter((v) => v.category === venueMismatchFilter);

  return (
    <div>
      <p style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
        BOOTCAMP_5 quality-assurance calls, {data?.since || "—"} onward — the call-centre team
        switched from acquisition calling to re-confirming identity and name details on
        already-registered youth on this date. A separate call log from Call Centre Insights, so
        there's no shared date range to filter by. Refreshes automatically every 5 minutes against
        live BigQuery.
      </p>

      <Grid cols={4}>
        <KpiTile label="Youth called" value={fmtNum(data?.youth_called)} sub={`${fmtNum(data?.calls_analysed)} call attempts`} tag="REAL" />
        <KpiTile label="Reach rate" value={fmtPct(data?.reach_rate)} sub={`${fmtNum(data?.unique_reached)} of ${fmtNum(data?.youth_called)} youth reached`} tag="REAL" />
        <KpiTile label="Confirmation rate" value={fmtPct(data?.identity_confirmed_rate)} sub={`${fmtNum(data?.confirmed)} confirmed of ${fmtNum(data?.unique_reached)} reached & surveyed`} tag="REAL" />
        <KpiTile label="Name match rate" value={fmtPct(data?.name_match_rate)} sub={`of ${fmtNum(data?.reached)} reached calls`} tag="REAL" />
      </Grid>

      <ExecBand num="◆" title="Call status breakdown" />
      <Card title="Call outcomes" subtitle="What happened when the call was placed" chip="REAL">
        <State loading={qa.loading} error={qa.error} empty={!qa.loading && outcomes.length === 0}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={outcomes} layout="vertical" margin={{ left: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="status" tick={{ fontSize: 11 }} width={100} />
                <Tooltip />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {outcomes.map((o, i) => <Cell key={i} fill={o.status === "Reached" ? C.green : CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <DataTable
              columns={[{ key: "status", label: "Status" }, { key: "count", label: "# Attempts", align: "right", render: (v) => fmtNum(v) }, { key: "pct", label: "% of attempts", align: "right", render: (v) => fmtPct(v) }]}
              rows={outcomes}
            />
          </div>
        </State>
      </Card>

      <Card title="Daily call volume" subtitle="Unique youth called vs. uniquely reached, per day — one QA pilot week, so shown as daily bars rather than a trend line" chip="REAL">
        <State loading={qa.loading} error={qa.error} empty={!qa.loading && daily.length === 0}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={daily} margin={{ left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="called" name="Youth called" fill={C.ink} radius={[3, 3, 0, 0]} />
              <Bar dataKey="reached" name="Youth reached" fill={C.green} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </State>
      </Card>

      <ExecBand num="◆" title="Identity & name verification" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <Card title={`Confirmation outcome (n=${fmtNum(data?.unique_reached)})`} subtitle="Did the youth reached confirm their identity — Confirmed / No / Maybe" chip="REAL">
          <State loading={qa.loading} error={qa.error} empty={!qa.loading && confirmationOutcome.length === 0}>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={confirmationOutcome} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="status" tick={{ fontSize: 11 }} width={80} />
                <Tooltip />
                <Bar dataKey="count" fill={C.teal} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <DataTable columns={[{ key: "status", label: "Status" }, ...pctColumns]} rows={confirmationOutcome} />
          </State>
        </Card>
        <Card title={`Name verification (n=${fmtNum(data?.reached)})`} subtitle="Does the name on file match what the person gave — a second, independent check" chip="REAL">
          <State loading={qa.loading} error={qa.error} empty={!qa.loading && nameBreakdown.length === 0}>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={nameBreakdown} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="status" tick={{ fontSize: 10 }} width={90} />
                <Tooltip />
                <Bar dataKey="count" fill={C.gold} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <DataTable columns={[{ key: "status", label: "Status" }, ...pctColumns]} rows={nameBreakdown} />
          </State>
        </Card>
      </div>

      <ExecBand num="◆" title="Gender differences" />
      <Card title="Female vs male — confirmation and name-match rates" subtitle="Gaps over 5pp between the two genders are flagged" chip="REAL">
        <State loading={qa.loading} error={qa.error} empty={!qa.loading && byGender.length === 0}>
          <DataTable
            columns={[
              { key: "gender", label: "Gender" },
              { key: "reached", label: "Reached", align: "right", render: (v) => fmtNum(v) },
              { key: "identity_confirmed_rate", label: "Confirmation rate", align: "right", render: (v) => renderGapFlaggedPct(v, genderConfirmedGap) },
              { key: "name_match_rate", label: "Name match rate", align: "right", render: (v) => renderGapFlaggedPct(v, genderNameGap) },
            ]}
            rows={byGender}
          />
        </State>
      </Card>

      <ExecBand num="◆" title="District comparison" />
      <Card title="Reach, confirmation and name-match rate by district" chip="REAL">
        <State loading={qa.loading} error={qa.error} empty={!qa.loading && byDistrict.length === 0}>
          <DataTable
            columns={[
              { key: "district", label: "District" },
              { key: "attempts", label: "Attempts", align: "right", render: (v) => fmtNum(v) },
              { key: "reach_rate", label: "Reach rate", align: "right", render: (v) => fmtPct(v) },
              { key: "identity_confirmed_rate", label: "Confirmation rate", align: "right", render: (v) => fmtPct(v) },
              { key: "name_match_rate", label: "Name match rate", align: "right", render: (v) => fmtPct(v) },
            ]}
            rows={byDistrict}
          />
        </State>
      </Card>

      <ExecBand num="◆" title="Venue name mismatches" />
      <Card title="Which venues have the most name mismatches" subtitle="Sorted worst-first by name mismatch rate — the venue-level follow-up list, not a leaderboard" chip="REAL">
        <State loading={qa.loading} error={qa.error} empty={!qa.loading && byVenue.length === 0}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
            {["All", ...VENUE_MISMATCH_ORDER].map((c) => {
              const isActive = venueMismatchFilter === c;
              const dotColor = c === "All" ? C.muted : VENUE_MISMATCH_COLOR[c];
              const count = c === "All" ? byVenueCategorized.length : venueMismatchCounts[c];
              return (
                <span
                  key={c}
                  onClick={() => setVenueMismatchFilter(isActive && c !== "All" ? "All" : c)}
                  style={{
                    border: `1px solid ${isActive ? C.ink : C.line}`,
                    background: isActive ? C.ink : C.white,
                    color: isActive ? C.white : C.inkSoft,
                    borderRadius: 20, padding: "6px 13px", fontSize: 12, fontWeight: 600,
                    cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7,
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, display: "inline-block" }} />
                  {c} <b>{count}</b>
                </span>
              );
            })}
          </div>
          <DataTable
            columns={[
              { key: "venue", label: "Venue" },
              { key: "district", label: "District" },
              { key: "reached", label: "Reached", align: "right", render: (v) => fmtNum(v) },
              { key: "name_mismatches", label: "Mismatches", align: "right", render: (v) => fmtNum(v) },
              {
                key: "name_mismatch_rate", label: "Mismatch rate", align: "right",
                render: (v, r) => <span style={{ color: VENUE_MISMATCH_COLOR[r.category], fontWeight: 700 }}>{fmtPct(v)}</span>,
              },
            ]}
            rows={filteredByVenue}
          />
          {byVenue.length > 0 && filteredByVenue.length === 0 && (
            <p style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>No venues in this category.</p>
          )}
        </State>
      </Card>

      <ExecBand num="◆" title="Support needed — verbatim" />
      <Card title={`What support youth mentioned (n=${fmtNum(data?.support_needed?.n)})`} subtitle="A sparse free-text field on the QA call record — shown verbatim rather than themed, the sample is too small to categorise meaningfully" chip="SAMPLE" chipTone="sim">
        <State loading={qa.loading} error={qa.error} empty={!qa.loading && supportQuotes.length === 0}>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: C.text, lineHeight: 1.7 }}>
            {supportQuotes.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </State>
      </Card>
    </div>
  );
}

function MobilisersTab({ filters }) {
  const { data, loading, error } = useApi(`/api/recruitment/mobilisers${buildParams(filters)}`);
  const rows = data?.mobilisers || [];
  return (
    <Card title="Mobiliser leaderboard" subtitle="Names shown to staff only" chip="SAMPLE" chipTone="sim">
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <DataTable
          columns={[
            { key: "mobiliser_name", label: "Mobiliser" },
            { key: "district", label: "District" },
            { key: "reached", label: "Reached", align: "right" },
            { key: "confirmed", label: "Confirmed", align: "right" },
          ]}
          rows={rows}
          stickyHeader
        />
      </State>
    </Card>
  );
}

function TamTab({ filters }) {
  const { data, loading, error } = useApi(`/api/recruitment/tam${buildParams(filters)}`);
  const rows = data?.parishes || [];
  return (
    <Card title="TAM / Market share" subtitle="Parish-level predicted vs actual & validation rate" chip="SAMPLE" chipTone="sim">
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <DataTable
          columns={[
            { key: "district", label: "District" },
            { key: "parish", label: "Parish" },
            { key: "predicted", label: "Predicted", align: "right" },
            { key: "actual", label: "Actual", align: "right" },
            { key: "validation_rate", label: "Validation %", align: "right", render: (v) => fmtPct(v) },
            { key: "status", label: "Status" },
          ]}
          rows={rows}
        />
      </State>
    </Card>
  );
}

// ─── Implementation tabs ─────────────────────────────────────────────────────
// Groups already-loaded venue-grain rows by district, re-deriving rate fields
// from the summed counts (rather than averaging the per-venue rates) so a
// district's rate is consistent with its own acquired/activated/retained
// totals. Shared by Retention and Trainer Quality's district-rollup drills.
function groupByDistrict(rows, countKeys, rateFns) {
  const byDistrict = {};
  rows.forEach((r) => {
    const d = byDistrict[r.district] || (byDistrict[r.district] = { district: r.district });
    countKeys.forEach((k) => { d[k] = (d[k] || 0) + (Number(r[k]) || 0); });
  });
  return Object.values(byDistrict).map((d) => {
    const withRates = { ...d };
    Object.entries(rateFns || {}).forEach(([k, fn]) => { withRates[k] = fn(d); });
    return withRates;
  });
}

function RetentionTab({ filters }) {
  const drill = useDrill();
  const { data, loading, error } = useApi(`/api/implementation/retention${buildParams(filters)}`);
  const rowsRaw = data?.by_venue || [];

  // Free-text search (matches venue or district) + Venues multi-select --
  // same "as is on Milestones tab" local-filter pattern (fetch once, slice
  // client-side). No date range here -- SITE_FUNNEL_METRICS is a cumulative-
  // to-date snapshot with no date column at all (confirmed against the live
  // schema), unlike Attendance's ATTENDANCE_SUMMARY/LESSON_ATTENDANCE.
  const [venueSearch, setVenueSearch] = useState("");
  const [selectedVenues, setSelectedVenues] = useState([]);
  const q = venueSearch.trim().toLowerCase();
  const matchesVenue = (r) =>
    (!q || (r.venue || "").toLowerCase().includes(q) || (r.district || "").toLowerCase().includes(q)) &&
    (selectedVenues.length === 0 || selectedVenues.includes(r.venue));
  const venueOptions = distinctValues(rowsRaw, "venue");
  const rows = rowsRaw.filter(matchesVenue);

  const targetActivation = data?.targets?.activation ?? 90;
  const targetRetention = data?.targets?.retention ?? 85;
  const targetAllSessions = data?.targets?.all_sessions ?? 75;
  const rateFns = {
    activation_rate: (d) => (d.acquired ? capRate(Math.round((1000 * d.activated) / d.acquired) / 10) : null),
    retention_rate: (d) => (d.activated ? capRate(Math.round((1000 * d.retained) / d.activated) / 10) : null),
  };

  const totalAcquired = sumBy(rows, "acquired");
  const totalActivated = sumBy(rows, "activated");
  const totalRetained = sumBy(rows, "retained");
  const totalRetainedFemale = sumBy(rows, "retained_female");
  // capRate: confirmed live (2026-08-08) that at least one venue has
  // activated_youth slightly exceed acquired_youth (a snapshot-timing gap
  // within SITE_FUNNEL_METRICS itself, not a query bug -- see capRate's
  // definition). Real counts stay as reported; only the ratio is capped.
  const overallActivationRate = totalAcquired ? capRate(Math.round((1000 * totalActivated) / totalAcquired) / 10) : null;
  const overallRetentionRate = totalActivated ? capRate(Math.round((1000 * totalRetained) / totalActivated) / 10) : null;
  const pctFemaleOfRetained = totalRetained ? Math.round((1000 * totalRetainedFemale) / totalRetained) / 10 : null;

  // Session completion — real per-youth lesson-completion counts from
  // SITE_FUNNEL_METRICS (youth_100pct_lessons/youth_80pct_lessons), the same
  // mart this whole tab already reads. retained/retention_rate above IS the
  // >=80%-of-lessons metric; all_sessions_count/all_sessions_rate is the
  // >=100%-of-lessons metric alongside it -- moved here from the Attendance
  // tab since both live on this mart, not a daily-attendance one.
  const totalAllSessions = sumBy(rows, "all_sessions_count");
  const overallAllSessionsRate = totalActivated ? capRate(Math.round((1000 * totalAllSessions) / totalActivated) / 10) : null;

  // One click on either gauge opens a single drill comparing BOTH metrics
  // side by side, gendered, by district then venue -- rather than six
  // separate single-metric gauges each needing their own click to compare.
  function openSessionCompletionDrill() {
    const rate = (n, d) => (d ? capRate(Math.round((1000 * (n || 0)) / d) / 10) : null);
    const byDistrict = {};
    rows.forEach((v) => {
      const d = byDistrict[v.district] || (byDistrict[v.district] = {
        district: v.district, activated: 0, activated_female: 0, activated_male: 0,
        all_sessions_count: 0, all_sessions_count_female: 0, all_sessions_count_male: 0,
        retained: 0, retained_female: 0, retained_male: 0,
      });
      d.activated += v.activated || 0;
      d.activated_female += v.activated_female || 0;
      d.activated_male += v.activated_male || 0;
      d.all_sessions_count += v.all_sessions_count || 0;
      d.all_sessions_count_female += v.all_sessions_count_female || 0;
      d.all_sessions_count_male += v.all_sessions_count_male || 0;
      d.retained += v.retained || 0;
      d.retained_female += v.retained_female || 0;
      d.retained_male += v.retained_male || 0;
    });
    const rollUp = (d) => ({
      activated: d.activated,
      all_sessions_rate: rate(d.all_sessions_count, d.activated),
      all_sessions_rate_female: rate(d.all_sessions_count_female, d.activated_female),
      all_sessions_rate_male: rate(d.all_sessions_count_male, d.activated_male),
      retention_rate: rate(d.retained, d.activated),
      retention_rate_female: rate(d.retained_female, d.activated_female),
      retention_rate_male: rate(d.retained_male, d.activated_male),
    });
    const rootRows = Object.entries(byDistrict)
      .map(([district, d]) => ({ district, ...rollUp(d) }))
      .sort((a, b) => (b.retention_rate ?? -1) - (a.retention_rate ?? -1));
    const columns = [
      { key: "activated", label: "Activated", align: "right", render: fmtNum },
      { key: "all_sessions_rate", label: "≥100% sessions", align: "right", render: renderRateCell("all_sessions_rate") },
      { key: "all_sessions_rate_female", label: "≥100% (F)", align: "right", render: renderRateCell("all_sessions_rate") },
      { key: "all_sessions_rate_male", label: "≥100% (M)", align: "right", render: renderRateCell("all_sessions_rate") },
      { key: "retention_rate", label: "≥80% sessions", align: "right", render: renderRateCell("retention_rate") },
      { key: "retention_rate_female", label: "≥80% (F)", align: "right", render: renderRateCell("retention_rate") },
      { key: "retention_rate_male", label: "≥80% (M)", align: "right", render: renderRateCell("retention_rate") },
    ];
    drill.open({
      title: "Session completion — all vs ≥80% of lessons, by gender — by district",
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns,
      rootRows,
      childKey: "venue", childLabel: "Venue",
      getChildRows: (root) => rows
        .filter((v) => v.district === root.district)
        .map((v) => ({ venue: v.venue, ...rollUp(v) }))
        .sort((a, b) => (b.retention_rate ?? -1) - (a.retention_rate ?? -1)),
    });
  }

  const districtRows = groupByDistrict(rows, ["acquired", "activated", "retained"], rateFns);
  // Lowest-first — the venues needing retention support surface at the top,
  // not buried under the ones already clearing target.
  const venueRowsSorted = [...rows].sort((a, b) => (a.retention_rate ?? Infinity) - (b.retention_rate ?? Infinity));
  const belowTargetVenues = venueRowsSorted.filter((v) => v.retention_rate != null && v.retention_rate < targetRetention);

  function openMetricDrill(metricKey, label, formatter = fmtNum) {
    const rootRows = groupByDistrict(rows, ["acquired", "activated", "retained"], rateFns)
      .sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0));
    drill.open({
      title: `${label} — by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [{ key: metricKey, label, align: "right", render: formatter }],
      rootRows,
      childKey: "venue", childLabel: "Venue",
      getChildRows: (root) => rows.filter((r) => r.district === root.district).sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0)),
    });
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <input
          type="text"
          value={venueSearch}
          onChange={(e) => setVenueSearch(e.target.value)}
          placeholder="Search district or venue…"
          style={{ flex: "1 1 240px", fontSize: 12, padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 5 }}
        />
        <MultiSelectDropdown label="Venues" options={venueOptions} selected={selectedVenues} onChange={setSelectedVenues} />
      </div>
      <Grid cols={4}>
        <KpiTile label="Acquired" value={fmtNum(totalAcquired)} sub="waiver signed" tag="REAL" onClick={() => openMetricDrill("acquired", "Acquired")} />
        <KpiTile
          label="Activated" value={fmtNum(totalActivated)}
          sub={<span style={{ color: rateColor(overallActivationRate, "activation_rate"), fontWeight: 700 }}>{fmtPct(overallActivationRate)} · target {targetActivation}%</span>}
          tag="REAL" onClick={() => openMetricDrill("activation_rate", "Activation rate", fmtPct)}
        />
        <KpiTile
          label="Retained" value={fmtNum(totalRetained)}
          sub={<span style={{ color: rateColor(overallRetentionRate, "retention_rate"), fontWeight: 700 }}>{fmtPct(overallRetentionRate)} · target {targetRetention}%</span>}
          tag="REAL" onClick={() => openMetricDrill("retention_rate", "Retention rate", fmtPct)}
        />
        <KpiTile
          label="Female retained" value={fmtNum(totalRetainedFemale)}
          sub={<span style={{ color: femaleShareStatus(pctFemaleOfRetained)?.color, fontWeight: 700 }}>{fmtPct(pctFemaleOfRetained)} of retained</span>}
          tag="REAL"
        />
      </Grid>

      <ExecBand num="◆" title="Session completion" />
      <Card
        title="Youth attending sessions"
        subtitle="Real per-youth lesson-completion counts from SITE_FUNNEL_METRICS (youth_100pct_lessons / youth_80pct_lessons), against activated — not a fabricated pace projection. Click either gauge to compare both metrics, by gender, district then venue in one drill."
        chip="REAL"
      >
        <State loading={loading} error={error} empty={!loading && rows.length === 0}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <Gauge label="% who attended all sessions" pct={overallAllSessionsRate} target={targetAllSessions} onClick={openSessionCompletionDrill} />
            <Gauge label="% who attended ≥80% of sessions" pct={overallRetentionRate} target={targetRetention} onClick={openSessionCompletionDrill} />
          </div>
        </State>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <Card title="Funnel by district" chip="REAL">
          <State loading={loading} error={error} empty={!loading && districtRows.length === 0}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={districtRows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis dataKey="district" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip /><Legend />
                <Bar dataKey="acquired" name="Acquired" fill={C.line} radius={[4, 4, 0, 0]} />
                <Bar dataKey="activated" name="Activated" fill={C.teal} radius={[4, 4, 0, 0]} />
                <Bar dataKey="retained" name="Retained" fill={C.green} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </State>
        </Card>
        <Card title="Activation & retention vs target" chip="REAL">
          <State loading={loading} error={error} empty={!loading && !data}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart
                data={[
                  { metric: "Activation", target: targetActivation, actual: overallActivationRate },
                  { metric: "Retention", target: targetRetention, actual: overallRetentionRate },
                ]}
                margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis dataKey="metric" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                <Tooltip /><Legend />
                <Bar dataKey="target" name="Target" fill={C.line} radius={[4, 4, 0, 0]} />
                <Bar dataKey="actual" name="Actual" fill={C.green} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </State>
        </Card>
      </div>

      <Card
        title="Venue retention (lowest first)"
        subtitle={`Retention rate = retained ÷ activated. Showing the 5 lowest-retention venues first — scroll to see all ${fmtNum(rows.length)}. Red flags venues below the ${targetRetention}% target.`}
        chip="REAL"
      >
        <State loading={loading} error={error} empty={!loading && rows.length === 0}>
          <div style={{ maxHeight: 236, overflowY: "auto" }}>
            <DataTable
              columns={[
                { key: "venue", label: "Venue" },
                { key: "district", label: "District" },
                { key: "acquired", label: "Acquired", align: "right", render: (v) => fmtNum(v) },
                { key: "activated", label: "Activated", align: "right", render: (v) => fmtNum(v) },
                { key: "retained", label: "Retained", align: "right", render: (v) => fmtNum(v) },
                { key: "retention_rate", label: "Retention rate", align: "right", render: renderRateCell("retention_rate") },
              ]}
              rows={venueRowsSorted}
            />
          </div>
        </State>
      </Card>

      {overallActivationRate != null && overallRetentionRate != null && (
        <Insight tone={overallActivationRate >= targetActivation && overallRetentionRate >= targetRetention ? "pos" : "warn"}>
          <b>Activation ({fmtPct(overallActivationRate)}) and retention ({fmtPct(overallRetentionRate)})</b> {overallActivationRate >= targetActivation && overallRetentionRate >= targetRetention ? "both clear target" : "are below one or both targets"} —
          {belowTargetVenues.length > 0
            ? <> the story is the tail: <b>{fmtNum(belowTargetVenues.length)} venue{belowTargetVenues.length === 1 ? "" : "s"}</b> sit below the {targetRetention}% retention target, so effort is best aimed there rather than across the board.</>
            : <> no venue currently sits below the {targetRetention}% retention target.</>}
        </Insight>
      )}
    </div>
  );
}

function AttendanceTab({ filters }) {
  const [page, setPage] = useState("overview");
  // One shared date range for every sub-page on this tab (report_date, real
  // on both ATTENDANCE_SUMMARY and LESSON_ATTENDANCE) -- same "kept at this
  // level so switching sub-tabs doesn't reset it" convention as Mobilisation.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Attendance</h2>
      <p style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>
        Daily and per-venue attendance against activation, session-completion gauges, and a
        lesson-by-lesson breakdown with report timeliness.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <span style={{ fontSize: 11, color: C.muted, fontWeight: 700, textTransform: "uppercase" }}>Date range (all Attendance pages)</span>
        <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} style={{ fontSize: 12, padding: "6px 8px", border: `1px solid ${C.line}`, borderRadius: 5, color: C.text }} />
        <span style={{ fontSize: 11, color: C.muted }}>to</span>
        <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} style={{ fontSize: 12, padding: "6px 8px", border: `1px solid ${C.line}`, borderRadius: 5, color: C.text }} />
        {(dateFrom || dateTo) && (
          <button onClick={() => { setDateFrom(""); setDateTo(""); }} style={PAGER_BTN}>Clear dates</button>
        )}
      </div>
      <PageNav
        active={page}
        onChange={setPage}
        pages={[
          { key: "overview", label: "Attendance Overview" },
          { key: "lessons", label: "Lesson Attendance" },
        ]}
      />
      {page === "overview" && <AttendanceOverviewPage filters={filters} dateFrom={dateFrom} dateTo={dateTo} />}
      {page === "lessons" && <AttendanceLessonsPage filters={filters} dateFrom={dateFrom} dateTo={dateTo} />}
    </div>
  );
}

function AttendanceOverviewPage({ filters, dateFrom, dateTo }) {
  const drill = useDrill();
  const { data, loading, error } = useApi(`/api/implementation/attendance${withDateRange(filters, dateFrom, dateTo)}`);
  const venueRowsRaw = data?.by_venue || [];
  const venueDayRowsRaw = data?.by_venue_day || [];

  // Free-text search (matches venue or district) + Venues multi-select --
  // same "as is on Milestones tab" local-filter pattern (fetch once, slice
  // client-side, no refetch per keystroke/selection).
  const [venueSearch, setVenueSearch] = useState("");
  const [selectedVenues, setSelectedVenues] = useState([]);
  const q = venueSearch.trim().toLowerCase();
  const matchesVenue = (r) =>
    (!q || (r.venue || "").toLowerCase().includes(q) || (r.district || "").toLowerCase().includes(q)) &&
    (selectedVenues.length === 0 || selectedVenues.includes(r.venue));
  const venueOptions = distinctValues(venueRowsRaw, "venue");
  const filtering = Boolean(q) || selectedVenues.length > 0;
  const venueRows = venueRowsRaw.filter(matchesVenue);
  const venueDayRows = venueDayRowsRaw.filter(matchesVenue);

  // Daily attendance/net-churn (present/absent/net_churn, programme-wide by
  // default) are re-derived from the filtered venueDayRows when a search/
  // venue filter is active, so those two charts and every KPI built from
  // them respond to the filter too -- not just the venue-grain tables below.
  // venueDayRows only carries venues with a real SITE_FUNNEL_METRICS
  // activated match (see backend), so this is only used while filtering,
  // never as the unfiltered default (which would silently undercount venues
  // with attendance but no activation match).
  const dailyFromVenues = (() => {
    const byDate = {};
    venueDayRows.forEach((v) => {
      const d = byDate[v.event_date] || (byDate[v.event_date] = {
        event_date: v.event_date, present: 0, absent: 0, present_female: 0, present_male: 0, net_churn: 0,
      });
      d.present += v.present || 0;
      d.absent += v.absent || 0;
      d.present_female += v.present_female || 0;
      d.present_male += v.present_male || 0;
      d.net_churn += v.net_churn || 0;
    });
    return Object.values(byDate).sort((a, b) => (a.event_date < b.event_date ? -1 : 1));
  })();
  const daily = filtering ? dailyFromVenues : (data?.daily || []);

  const totalActivated = sumBy(venueRows, "activated");
  const avgPresent = daily.length ? sumBy(daily, "present") / daily.length : null;
  const avgChurn = daily.length ? sumBy(daily, "net_churn") / daily.length : null;
  const avgChurnRate = avgPresent ? Math.round((1000 * avgChurn) / avgPresent) / 10 : null;
  const latestDay = daily[daily.length - 1];
  const latestAttendanceRate = latestDay && totalActivated ? capRate(Math.round((1000 * latestDay.present) / totalActivated) / 10) : null;

  // Mean of each day's own present÷activated (and absent÷activated) —
  // "average attendance"/"absenteeism rate" across every day reported, using
  // the same total-activated denominator as Latest attendance rate above, not
  // a raw headcount average (which wouldn't be a %). Each day's own rate is
  // capped before averaging (see capRate) so one over-100% day can't skew the
  // mean upward.
  const mean = (arr) => (arr.length ? Math.round((10 * arr.reduce((s, v) => s + v, 0)) / arr.length) / 10 : null);
  const dailyRates = daily.map((d) => (totalActivated ? capRate((100 * (d.present || 0)) / totalActivated) : null)).filter((v) => v != null);
  const avgAttendanceRate = mean(dailyRates);
  const dailyAbsentRates = daily.map((d) => (totalActivated ? (100 * (d.absent || 0)) / totalActivated : null)).filter((v) => v != null);
  const avgAbsenteeismRate = mean(dailyAbsentRates);

  const rateFns = { attendance_rate: (d) => (d.activated ? capRate(Math.round((1000 * d.present) / d.activated) / 10) : null) };
  const districtRows = groupByDistrict(venueRows, ["activated", "present"], rateFns);
  // Every venue, worst-first — same priority read as the previous bottom-5
  // cut, just paginated instead of hard-limited to 5.
  const sortedVenues = [...venueRows].filter((v) => v.attendance_rate != null).sort((a, b) => a.attendance_rate - b.attendance_rate);
  const [venuePage, setVenuePage] = useState(0);
  const venuePageSize = 10;
  const venueMaxPage = Math.max(0, Math.ceil(sortedVenues.length / venuePageSize) - 1);
  const venuePageClamped = Math.min(venuePage, venueMaxPage);
  const pagedVenues = sortedVenues.slice(venuePageClamped * venuePageSize, venuePageClamped * venuePageSize + venuePageSize);

  function openMetricDrill(metricKey, label, formatter = fmtNum) {
    const rootRows = groupByDistrict(venueRows, ["activated", "present"], rateFns)
      .sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0));
    drill.open({
      title: `${label} — by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [{ key: metricKey, label, align: "right", render: formatter }],
      rootRows,
      childKey: "venue", childLabel: "Venue",
      getChildRows: (root) => venueRows.filter((v) => v.district === root.district).sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0)),
    });
  }

  // Click a point on the Daily attendance chart -> that day's district
  // rollup (root, ranked by attendance rate), then drill into a district for
  // its venues that same day. District rows are summed from that day's own
  // venue rows (weighted), not an average of per-venue rates.
  const dayDrillColumns = [
    { key: "activated", label: "Activated", align: "right", render: (v) => fmtNum(v) },
    { key: "present", label: "Present", align: "right", render: (v) => fmtNum(v) },
    { key: "attendance_rate", label: "Attendance rate", align: "right", render: renderRateCell("attendance_rate") },
    { key: "present_female", label: "Present (F)", align: "right", render: (v) => fmtNum(v) },
    { key: "attendance_rate_female", label: "Attendance rate (F)", align: "right", render: renderRateCell("attendance_rate") },
    { key: "present_male", label: "Present (M)", align: "right", render: (v) => fmtNum(v) },
    { key: "attendance_rate_male", label: "Attendance rate (M)", align: "right", render: renderRateCell("attendance_rate") },
  ];
  function openDayDrill(date) {
    const rowsForDay = venueDayRows.filter((v) => v.event_date === date);
    const byDistrict = {};
    rowsForDay.forEach((v) => {
      const d = byDistrict[v.district] || (byDistrict[v.district] = {
        district: v.district, activated: 0, present: 0, present_female: 0, present_male: 0,
        activated_female: 0, activated_male: 0,
      });
      d.activated += v.activated || 0;
      d.present += v.present || 0;
      d.activated_female += v.activated_female || 0;
      d.present_female += v.present_female || 0;
      d.activated_male += v.activated_male || 0;
      d.present_male += v.present_male || 0;
    });
    const rootRows = Object.values(byDistrict).map((d) => ({
      district: d.district,
      activated: d.activated,
      present: d.present,
      attendance_rate: d.activated ? capRate(Math.round((1000 * d.present) / d.activated) / 10) : null,
      present_female: d.present_female,
      attendance_rate_female: d.activated_female ? capRate(Math.round((1000 * d.present_female) / d.activated_female) / 10) : null,
      present_male: d.present_male,
      attendance_rate_male: d.activated_male ? capRate(Math.round((1000 * d.present_male) / d.activated_male) / 10) : null,
    })).sort((a, b) => (b.attendance_rate ?? -1) - (a.attendance_rate ?? -1));
    drill.open({
      title: `Attendance — ${date}`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: dayDrillColumns,
      rootRows,
      childKey: "venue", childLabel: "Venue",
      getChildRows: (root) => rowsForDay.filter((v) => v.district === root.district).sort((a, b) => (b.attendance_rate ?? -1) - (a.attendance_rate ?? -1)),
    });
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <input
          type="text"
          value={venueSearch}
          onChange={(e) => setVenueSearch(e.target.value)}
          placeholder="Search district or venue…"
          style={{ flex: "1 1 240px", fontSize: 12, padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 5 }}
        />
        <MultiSelectDropdown label="Venues" options={venueOptions} selected={selectedVenues} onChange={setSelectedVenues} />
      </div>
      <Grid cols={4}>
        <KpiTile label="Venues reporting" value={String(venueRows.length)} sub="attendance × activation joined" tag="REAL" />
        <KpiTile
          label="Avg daily churn rate" value={fmtPct(avgChurnRate)}
          sub={daily.length ? `net ~${fmtNum(Math.round(avgChurn || 0))} youth/day over ${fmtNum(daily.length)} days` : undefined}
          tag="REAL"
        />
        <KpiTile
          label="Attendance rate today" value={fmtPct(latestAttendanceRate)}
          sub={latestDay?.event_date} tag="REAL"
          onClick={() => openMetricDrill("attendance_rate", "Attendance rate", fmtPct)}
        />
        <KpiTile label="Youth present today" value={fmtNum(latestDay?.present)} sub={latestDay?.event_date} tag="REAL" onClick={() => openMetricDrill("present", "Present")} />
        <KpiTile label="Average attendance" value={fmtPct(avgAttendanceRate)} sub={daily.length ? `mean of ${fmtNum(daily.length)} days reported, present ÷ activated` : undefined} tag="REAL" />
        <KpiTile label="Absenteeism rate" value={fmtPct(avgAbsenteeismRate)} sub={daily.length ? `mean of ${fmtNum(daily.length)} days reported, absent ÷ activated` : undefined} tag="REAL" />
        <KpiTile label="Females present today" value={fmtNum(latestDay?.present_female)} sub={latestDay?.event_date} tag="REAL" />
        <KpiTile label="Males present today" value={fmtNum(latestDay?.present_male)} sub={latestDay?.event_date} tag="REAL" />
      </Grid>

      <ExecBand num="◆" title="Attendance by district" />
      <State loading={loading} error={error} empty={!loading && districtRows.length === 0}>
        <DataTable
          columns={[
            { key: "district", label: "District" },
            { key: "activated", label: "Activated", align: "right", render: (v) => fmtNum(v), onHeaderClick: () => openMetricDrill("activated", "Activated") },
            { key: "present", label: "Present (avg)", align: "right", render: (v) => fmtNum(v), onHeaderClick: () => openMetricDrill("present", "Present") },
            { key: "attendance_rate", label: "Attendance rate", align: "right", render: renderRateCell("attendance_rate"), onHeaderClick: () => openMetricDrill("attendance_rate", "Attendance rate", fmtPct) },
          ]}
          rows={districtRows}
        />
      </State>
      <Insight tone="neutral">
        <b>Present ÷ activated,</b> not a fabricated pace projection — activated comes from SITE_FUNNEL_METRICS (same source as the Retention tab), joined against ATTENDANCE_SUMMARY's real per-venue present counts.
      </Insight>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <Card title="Daily attendance" subtitle={filtering ? `Scoped to ${fmtNum(venueRows.length)} filtered venue${venueRows.length === 1 ? "" : "s"}. Click a point to drill into that day by district, then venue.` : "Programme-wide youth present by day. Click a point to drill into that day by district, then venue."} chip="REAL">
          <State loading={loading} error={error} empty={!loading && daily.length === 0}>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart
                data={daily} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
                onClick={(e) => { if (e?.activeLabel) openDayDrill(e.activeLabel); }}
                style={{ cursor: "pointer" }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis dataKey="event_date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line type="monotone" dataKey="present" name="Present" stroke={C.teal} strokeWidth={2} dot={false} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </State>
        </Card>
        <Card title="Daily net churn" subtitle="Negative bars = net growth (returns > drop-offs)" chip="REAL">
          <State loading={loading} error={error} empty={!loading && daily.length === 0}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={daily} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis dataKey="event_date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="net_churn" name="Net churn" radius={[4, 4, 0, 0]}>
                  {daily.map((d, i) => <Cell key={i} fill={(d.net_churn ?? 0) <= 0 ? C.green : C.coral} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </State>
        </Card>
      </div>

      <Card title={`Attendance rate — all ${fmtNum(sortedVenues.length)} venues`} subtitle="Every reporting venue, lowest-attendance first: present ÷ activated, overall and by gender." chip="REAL">
        <State loading={loading} error={error} empty={!loading && sortedVenues.length === 0}>
          <DataTable
            columns={[
              { key: "venue", label: "Venue" },
              { key: "district", label: "District" },
              { key: "activated", label: "Activated", align: "right", render: (v) => fmtNum(v) },
              { key: "attendance_rate", label: "Attendance rate", align: "right", render: renderRateCell("attendance_rate") },
              { key: "attendance_rate_female", label: "Attendance rate (F)", align: "right", render: renderRateCell("attendance_rate") },
              { key: "attendance_rate_male", label: "Attendance rate (M)", align: "right", render: renderRateCell("attendance_rate") },
            ]}
            rows={pagedVenues}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9, fontSize: 11, color: C.muted }}>
            <span>{sortedVenues.length === 0 ? "0" : venuePageClamped * venuePageSize + 1}–{Math.min(sortedVenues.length, venuePageClamped * venuePageSize + venuePageSize)} of {sortedVenues.length} venues</span>
            <span style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setVenuePage(Math.max(0, venuePageClamped - 1))} disabled={venuePageClamped === 0} style={{ ...PAGER_BTN, opacity: venuePageClamped === 0 ? 0.5 : 1 }}>‹ Prev</button>
              <button onClick={() => setVenuePage(Math.min(venueMaxPage, venuePageClamped + 1))} disabled={venuePageClamped === venueMaxPage} style={{ ...PAGER_BTN, opacity: venuePageClamped === venueMaxPage ? 0.5 : 1 }}>Next ›</button>
            </span>
          </div>
        </State>
      </Card>

      {avgChurnRate != null && latestAttendanceRate != null && (
        <Insight tone={latestAttendanceRate >= 95 && avgChurnRate <= 1 ? "pos" : "warn"}>
          <b>Attendance holds at {fmtPct(latestAttendanceRate)}</b> as of {latestDay?.event_date}, with average daily churn at <b>{fmtPct(avgChurnRate)}</b>
          {sortedVenues[0] ? <> — <b>{sortedVenues[0].venue}</b> ({sortedVenues[0].district}) is the lowest-attendance venue at {fmtPct(sortedVenues[0].attendance_rate)}.</> : "."}
        </Insight>
      )}
    </div>
  );
}

// Per-lesson, per-session attendance + report timeliness -- a genuinely
// finer grain than AttendanceOverviewPage's daily venue-level view (that
// mart has no per-lesson breakdown). "Timely" here is the recruitment
// team's own cutoff: a Morning lesson's report is on time if submitted
// before 12:00 noon local (Africa/Kampala) time; an Afternoon report is on
// time at/before 17:00 local -- see LESSON_TIMELY_REPORT_SQL in tables.py.
// Sums total/present/total_reports/timely_reports across matching by_lesson_
// venue rows, grouped by the given key fields, and recomputes attendance_
// rate/timely_rate from those sums -- used when a venue search/multi-select
// is active, so by_lesson/by_session reflect only the matching venues rather
// than the backend's unfiltered programme-wide aggregates.
function aggregateLessonVenue(rows, keys) {
  const groups = {};
  rows.forEach((r) => {
    const k = keys.map((key) => r[key]).join("||");
    const g = groups[k] || (groups[k] = { total: 0, present: 0, total_reports: 0, timely_reports: 0 });
    keys.forEach((key) => { g[key] = r[key]; });
    g.total += r.total || 0;
    g.present += r.present || 0;
    g.total_reports += r.total_reports || 0;
    g.timely_reports += r.timely_reports || 0;
  });
  return Object.values(groups).map((g) => ({
    ...g,
    attendance_rate: g.total ? Math.round((1000 * g.present) / g.total) / 10 : null,
    timely_rate: g.total_reports ? Math.round((1000 * g.timely_reports) / g.total_reports) / 10 : null,
  }));
}

function AttendanceLessonsPage({ filters, dateFrom, dateTo }) {
  const drill = useDrill();
  const { data, loading, error } = useApi(`/api/implementation/attendance-lessons${withDateRange(filters, dateFrom, dateTo)}`);
  const byLessonVenueRaw = data?.by_lesson_venue || [];
  const byReporter = data?.by_reporter || [];

  // Free-text search (matches venue or district) + Venues multi-select --
  // same local-filter pattern as Attendance Overview/Milestones. by_lesson
  // and by_session have no venue of their own, so a filter re-aggregates
  // them from the matching by_lesson_venue rows instead of just narrowing a
  // list; by_reporter has no venue dimension at all in the backend response,
  // so it stays unfiltered regardless.
  const [venueSearch, setVenueSearch] = useState("");
  const [selectedVenues, setSelectedVenues] = useState([]);
  const q = venueSearch.trim().toLowerCase();
  const matchesVenue = (r) =>
    (!q || (r.venue || "").toLowerCase().includes(q) || (r.district || "").toLowerCase().includes(q)) &&
    (selectedVenues.length === 0 || selectedVenues.includes(r.venue));
  const venueOptions = distinctValues(byLessonVenueRaw, "venue");
  const filtering = Boolean(q) || selectedVenues.length > 0;
  const byLessonVenue = filtering ? byLessonVenueRaw.filter(matchesVenue) : byLessonVenueRaw;

  const byLesson = filtering
    ? aggregateLessonVenue(byLessonVenue, ["lesson_id", "lesson_name", "lesson_time"])
    : data?.by_lesson || [];
  const bySession = filtering
    ? aggregateLessonVenue(byLessonVenue, ["lesson_time"])
    : data?.by_session || [];

  const morning = bySession.find((s) => s.lesson_time === "Morning");
  const afternoon = bySession.find((s) => s.lesson_time === "Afternoon");
  const totalReports = sumBy(bySession, "total_reports");
  const timelyReports = sumBy(bySession, "timely_reports");
  const totalRecords = sumBy(bySession, "total");
  const presentRecords = sumBy(bySession, "present");
  const overallAttendanceRate = totalRecords ? Math.round((1000 * presentRecords) / totalRecords) / 10 : null;
  const overallTimelyRate = totalReports ? Math.round((1000 * timelyReports) / totalReports) / 10 : null;
  const lessonsTracked = new Set(byLesson.map((l) => l.lesson_id)).size;

  // Worst-attendance-first, same priority read as the Overview tab's venue
  // table -- paginated instead of hard-limited.
  const sortedLessons = [...byLesson].filter((l) => l.attendance_rate != null).sort((a, b) => a.attendance_rate - b.attendance_rate);
  const [lessonPage, setLessonPage] = useState(0);
  const lessonPageSize = 10;
  const lessonMaxPage = Math.max(0, Math.ceil(sortedLessons.length / lessonPageSize) - 1);
  const lessonPageClamped = Math.min(lessonPage, lessonMaxPage);
  const pagedLessons = sortedLessons.slice(lessonPageClamped * lessonPageSize, lessonPageClamped * lessonPageSize + lessonPageSize);

  function openLessonDrill(lesson) {
    // Sourced from the (possibly venue-filtered) byLessonVenue, not the raw
    // fetch -- so the drill only ever shows venues consistent with whatever
    // the page's own search/multi-select currently narrows to.
    const rowsForLesson = byLessonVenue.filter((v) => v.lesson_id === lesson.lesson_id);
    const byDistrict = {};
    rowsForLesson.forEach((v) => {
      const d = byDistrict[v.district] || (byDistrict[v.district] = { district: v.district, total: 0, present: 0, total_reports: 0, timely_reports: 0 });
      d.total += v.total || 0;
      d.present += v.present || 0;
      d.total_reports += v.total_reports || 0;
      d.timely_reports += v.timely_reports || 0;
    });
    const rate = (present, total) => (total ? Math.round((1000 * present) / total) / 10 : null);
    const rootRows = Object.values(byDistrict)
      .map((d) => ({ ...d, attendance_rate: rate(d.present, d.total), timely_rate: rate(d.timely_reports, d.total_reports) }))
      .sort((a, b) => (a.attendance_rate ?? 101) - (b.attendance_rate ?? 101));
    const columns = [
      { key: "total_reports", label: "Reports", align: "right", render: fmtNum },
      { key: "attendance_rate", label: "Attendance rate", align: "right", render: renderRateCell("attendance_rate") },
      { key: "timely_rate", label: "Timely reporting", align: "right", render: renderRateCell("timely_rate") },
    ];
    drill.open({
      title: `${lesson.lesson_name} (${lesson.lesson_time}) — by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns,
      rootRows,
      childKey: "venue", childLabel: "Venue",
      getChildRows: (root) => rowsForLesson
        .filter((v) => v.district === root.district)
        .map((v) => ({ venue: v.venue, total_reports: v.total_reports, attendance_rate: v.attendance_rate, timely_rate: v.timely_rate }))
        .sort((a, b) => (a.attendance_rate ?? 101) - (b.attendance_rate ?? 101)),
    });
  }

  // Worst-timeliness-first -- a data-quality/coverage read, not a ranking of
  // named staff (reporter is an opaque auth-system ID, never a real name).
  const sortedReporters = [...byReporter].filter((r) => r.timely_rate != null).sort((a, b) => a.timely_rate - b.timely_rate);
  const [reporterPage, setReporterPage] = useState(0);
  const reporterPageSize = 10;
  const reporterMaxPage = Math.max(0, Math.ceil(sortedReporters.length / reporterPageSize) - 1);
  const reporterPageClamped = Math.min(reporterPage, reporterMaxPage);
  const pagedReporters = sortedReporters.slice(reporterPageClamped * reporterPageSize, reporterPageClamped * reporterPageSize + reporterPageSize);

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <input
          type="text"
          value={venueSearch}
          onChange={(e) => setVenueSearch(e.target.value)}
          placeholder="Search district or venue…"
          style={{ flex: "1 1 240px", fontSize: 12, padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 5 }}
        />
        <MultiSelectDropdown label="Venues" options={venueOptions} selected={selectedVenues} onChange={setSelectedVenues} />
      </div>
      <Grid cols={4}>
        <KpiTile label="Lessons tracked" value={String(lessonsTracked)} sub="silver_eba.eba_bootcamp_attendance" tag="REAL" />
        <KpiTile label="Reports analyzed" value={fmtNum(totalReports)} sub="distinct report_id" tag="REAL" />
        <KpiTile label="Overall attendance rate" value={fmtPct(overallAttendanceRate)} sub="present ÷ lesson records" tag="REAL" />
        <KpiTile label="Overall timely-reporting rate" value={fmtPct(overallTimelyRate)} sub="Morning < 12:00, Afternoon ≤ 17:00 (EAT)" tag="REAL" />
        <KpiTile label="Morning attendance rate" value={fmtPct(morning?.attendance_rate)} sub={morning ? `${fmtNum(morning.total_reports)} reports` : undefined} tag="REAL" />
        <KpiTile label="Morning timely rate" value={fmtPct(morning?.timely_rate)} sub="reports submitted before 12:00 EAT" tag="REAL" />
        <KpiTile label="Afternoon attendance rate" value={fmtPct(afternoon?.attendance_rate)} sub={afternoon ? `${fmtNum(afternoon.total_reports)} reports` : undefined} tag="REAL" />
        <KpiTile label="Afternoon timely rate" value={fmtPct(afternoon?.timely_rate)} sub="reports submitted by 17:00 EAT" tag="REAL" />
      </Grid>

      <ExecBand num="◆" title="Attendance rate by lesson" />
      <Card
        title={`Attendance rate by lesson — ${fmtNum(sortedLessons.length)} lessons`}
        subtitle="Lowest-attendance first. Click a row to drill into that lesson by district, then venue."
        chip="REAL"
      >
        <State loading={loading} error={error} empty={!loading && sortedLessons.length === 0}>
          <DataTable
            columns={[
              { key: "lesson_name", label: "Lesson" },
              { key: "lesson_time", label: "Session" },
              { key: "total_reports", label: "Reports", align: "right", render: fmtNum },
              { key: "attendance_rate", label: "Attendance rate", align: "right", render: renderRateCell("attendance_rate") },
              { key: "timely_rate", label: "Timely reporting", align: "right", render: renderRateCell("timely_rate") },
            ]}
            rows={pagedLessons}
            onRowClick={openLessonDrill}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9, fontSize: 11, color: C.muted }}>
            <span>{sortedLessons.length === 0 ? "0" : lessonPageClamped * lessonPageSize + 1}–{Math.min(sortedLessons.length, lessonPageClamped * lessonPageSize + lessonPageSize)} of {sortedLessons.length} lessons</span>
            <span style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setLessonPage(Math.max(0, lessonPageClamped - 1))} disabled={lessonPageClamped === 0} style={{ ...PAGER_BTN, opacity: lessonPageClamped === 0 ? 0.5 : 1 }}>‹ Prev</button>
              <button onClick={() => setLessonPage(Math.min(lessonMaxPage, lessonPageClamped + 1))} disabled={lessonPageClamped === lessonMaxPage} style={{ ...PAGER_BTN, opacity: lessonPageClamped === lessonMaxPage ? 0.5 : 1 }}>Next ›</button>
            </span>
          </div>
        </State>
      </Card>

      <ExecBand num="◆" title="Morning vs afternoon" />
      <Card title="Session attendance & timeliness" subtitle="Morning reports are timely before 12:00 noon local time; Afternoon reports are timely at/before 17:00 local time." chip="REAL">
        <State loading={loading} error={error} empty={!loading && bySession.length === 0}>
          <DataTable
            columns={[
              { key: "lesson_time", label: "Session" },
              { key: "total_reports", label: "Reports", align: "right", render: fmtNum },
              { key: "attendance_rate", label: "Attendance rate", align: "right", render: renderRateCell("attendance_rate") },
              { key: "timely_rate", label: "Timely reporting", align: "right", render: renderRateCell("timely_rate") },
            ]}
            rows={bySession}
          />
        </State>
      </Card>

      <ExecBand num="◆" title="Reported by" />
      <Card
        title={`Report timeliness by reporter — ${fmtNum(sortedReporters.length)} reporters`}
        subtitle="Lowest timely-reporting rate first. reporter is an opaque, already-de-identified auth-system ID (not a name) — this is a data-quality/coverage signal, not a performance ranking of named staff."
        chip="REAL"
      >
        {filtering && (
          <p style={{ fontSize: 11, color: C.muted, marginTop: -6, marginBottom: 10 }}>
            The venue search/filter above doesn't apply here — reports aren't tied to a single venue in this breakdown.
          </p>
        )}
        <State loading={loading} error={error} empty={!loading && sortedReporters.length === 0}>
          <DataTable
            columns={[
              { key: "reporter", label: "Reporter ID" },
              { key: "total_reports", label: "Reports", align: "right", render: fmtNum },
              { key: "timely_rate", label: "Timely reporting", align: "right", render: renderRateCell("timely_rate") },
            ]}
            rows={pagedReporters}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9, fontSize: 11, color: C.muted }}>
            <span>{sortedReporters.length === 0 ? "0" : reporterPageClamped * reporterPageSize + 1}–{Math.min(sortedReporters.length, reporterPageClamped * reporterPageSize + reporterPageSize)} of {sortedReporters.length} reporters</span>
            <span style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setReporterPage(Math.max(0, reporterPageClamped - 1))} disabled={reporterPageClamped === 0} style={{ ...PAGER_BTN, opacity: reporterPageClamped === 0 ? 0.5 : 1 }}>‹ Prev</button>
              <button onClick={() => setReporterPage(Math.min(reporterMaxPage, reporterPageClamped + 1))} disabled={reporterPageClamped === reporterMaxPage} style={{ ...PAGER_BTN, opacity: reporterPageClamped === reporterMaxPage ? 0.5 : 1 }}>Next ›</button>
            </span>
          </div>
        </State>
      </Card>

      {overallAttendanceRate != null && overallTimelyRate != null && (
        <Insight tone={overallTimelyRate >= 90 ? "pos" : "warn"}>
          <b>Lesson attendance runs at {fmtPct(overallAttendanceRate)}</b>, with <b>{fmtPct(overallTimelyRate)}</b> of reports filed on time
          {morning && afternoon ? <> — {morning.timely_rate < afternoon.timely_rate ? "Morning" : "Afternoon"} sessions report less on time ({fmtPct(Math.min(morning.timely_rate ?? 100, afternoon.timely_rate ?? 100))}).</> : "."}
          {sortedLessons[0] ? <> <b>{sortedLessons[0].lesson_name}</b> ({sortedLessons[0].lesson_time}) has the lowest attendance at {fmtPct(sortedLessons[0].attendance_rate)}.</> : null}
        </Insight>
      )}
      {sortedReporters[0] && sortedReporters[0].timely_rate < 75 && (
        <Insight tone="warn">
          Reporter <b>{sortedReporters[0].reporter}</b> has the lowest report-timeliness rate at {fmtPct(sortedReporters[0].timely_rate)} across {fmtNum(sortedReporters[0].total_reports)} reports — worth a coaching check on submission time, not attendance itself.
        </Insight>
      )}
    </div>
  );
}

// Reach rate (calls reached ÷ calls made) is a call-quality metric distinct
// from the funnel-stage rates in RATE_TARGETS — same 60/45 bands the
// reference design uses for this specific figure, kept local rather than
// added to that shared, broader-purpose object.
function callReachColor(pct) {
  if (pct == null) return C.muted;
  if (pct >= 60) return C.green;
  if (pct >= 45) return C.gold;
  return C.coral;
}

function RetentionCallsTab({ filters }) {
  const drill = useDrill();
  const { data, loading, error } = useApi(`/api/implementation/retention-calls${buildParams(filters)}`);
  const dailyAll = data?.daily || [];
  const dailyByVenue = data?.daily_by_venue || [];
  const venueRows = data?.by_venue || [];

  // Search by venue — narrows every component on this page (score cards,
  // chart, story, by-venue table), same "search filters everything" pattern
  // as the Awareness Overview page.
  const [venueSearch, setVenueSearch] = useState("");
  const q = venueSearch.trim().toLowerCase();
  const matchedVenueRows = q ? venueRows.filter((v) => (v.venue || "").toLowerCase().includes(q)) : venueRows;

  // The programme-wide daily series has no venue dimension, so a search
  // re-derives it from the venue-grain rows instead — sum just the matched
  // venue(s) per date, client-side, no extra request per keystroke.
  const daily = q
    ? Object.values(
        dailyByVenue.filter((r) => (r.venue || "").toLowerCase().includes(q)).reduce((acc, r) => {
          const d = acc[r.event_date] || (acc[r.event_date] = { event_date: r.event_date, called: 0, reached: 0, promised: 0, returned: 0 });
          d.called += r.called || 0; d.reached += r.reached || 0; d.promised += r.promised || 0; d.returned += r.returned || 0;
          return acc;
        }, {})
      ).sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : 0))
    : dailyAll;

  const totalCalled = sumBy(matchedVenueRows, "called");
  const totalReached = sumBy(matchedVenueRows, "reached");
  const totalPromised = sumBy(matchedVenueRows, "promised");
  const totalReturned = sumBy(matchedVenueRows, "returned");
  const reachRate = totalCalled ? Math.round((1000 * totalReached) / totalCalled) / 10 : null;
  const promiseRate = totalReached ? Math.round((1000 * totalPromised) / totalReached) / 10 : null;
  const recoveryRate = totalCalled ? Math.round((1000 * totalReturned) / totalCalled) / 10 : null;

  // Bottom-performing (lowest reach rate) first, same read as the rest of
  // this app's "worst first" tables — scroll for the rest.
  const venueRowsSorted = [...matchedVenueRows].filter((v) => v.reach_rate != null).sort((a, b) => a.reach_rate - b.reach_rate);

  // Absences on record but zero follow-up calls logged — a call-center
  // coverage gap, not a reach-quality problem (that's reach_rate's job).
  const noCallVenues = [...matchedVenueRows]
    .filter((v) => (v.absent || 0) > 0 && (v.called || 0) === 0)
    .sort((a, b) => (b.absent || 0) - (a.absent || 0));

  function openNoCallsDrill() {
    drill.open({
      title: "Sites with absences but no follow-up calls",
      tone: "risk", tagLabel: "REAL",
      rootKey: "venue", rootLabel: "Site",
      columns: [
        { key: "district", label: "District" },
        { key: "absent", label: "Absent", align: "right", render: (v) => fmtNum(v) },
      ],
      rootRows: noCallVenues,
    });
  }

  // Click-to-toggle legend: click a series name to hide/show it — same
  // pattern as the Awareness Forecast chart.
  const [hiddenSeries, setHiddenSeries] = useState({});
  function toggleSeries(dataKey) {
    setHiddenSeries((h) => ({ ...h, [dataKey]: !h[dataKey] }));
  }
  function legendFormatter(value, entry) {
    const isHidden = !!hiddenSeries[entry.dataKey];
    return <span style={{ textDecoration: isHidden ? "line-through" : "none", opacity: isHidden ? 0.5 : 1 }}>{value}</span>;
  }

  // Every score card drills district -> site (venue), off matchedVenueRows
  // so the drill reflects whatever the venue search currently narrows to.
  function openMetricDrill(metricKey, label, formatter = fmtNum) {
    const rootRows = groupByDistrict(matchedVenueRows, [metricKey], {})
      .sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0));
    drill.open({
      title: `${label} — by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [{ key: metricKey, label, align: "right", render: formatter }],
      rootRows,
      childKey: "venue", childLabel: "Site",
      getChildRows: (root) => matchedVenueRows.filter((v) => v.district === root.district).sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0)),
    });
  }

  return (
    <div>
      <input
        type="text"
        value={venueSearch}
        onChange={(e) => setVenueSearch(e.target.value)}
        placeholder="Search by venue…"
        style={{ width: "100%", fontSize: 12, padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 5, marginBottom: 4 }}
      />
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 14 }}>
        Filters every metric on this page to the matching venue(s) — score cards, the daily funnel chart, the story, and the by-venue table below.
      </div>

      <Grid cols={4}>
        <KpiTile label="Unique youth called" value={fmtNum(totalCalled)} sub="absent youth followed up" tag="REAL" onClick={() => openMetricDrill("called", "Called")} />
        <KpiTile label="Reached" value={fmtNum(totalReached)} sub={<span style={{ color: callReachColor(reachRate), fontWeight: 700 }}>{fmtPct(reachRate)} reach rate</span>} tag="REAL" onClick={() => openMetricDrill("reached", "Reached")} />
        <KpiTile label="Promised to return" value={fmtNum(totalPromised)} sub={`${fmtPct(promiseRate)} of reached`} tag="REAL" onClick={() => openMetricDrill("promised", "Promised to return")} />
        <KpiTile label="Youth returned" value={fmtNum(totalReturned)} sub={<span style={{ color: C.green, fontWeight: 700 }}>{fmtPct(recoveryRate)} recovery of called</span>} tag="REAL" onClick={() => openMetricDrill("returned", "Returned")} />
        <KpiTile
          label="Sites with no follow-up calls" value={fmtNum(noCallVenues.length)}
          sub={noCallVenues.length > 0 ? <span style={{ color: C.coral, fontWeight: 700 }}>absences on record, zero calls made</span> : "every site with an absence got at least one call"}
          tone={noCallVenues.length > 0 ? "sim" : "real"} tag="REAL"
          onClick={noCallVenues.length > 0 ? openNoCallsDrill : undefined}
        />
      </Grid>

      <Card title="Daily follow-up funnel — called → reached → promised → returned" subtitle={`Each line is unique youth per call day. "Returned" is logged on the next attendance day, so it reads zero on days before a weekend or holiday. Click a legend item to hide/show that line.${q ? ` Showing venues matching "${venueSearch.trim()}".` : ""}`} chip="REAL">
        <State loading={loading} error={error} empty={!loading && daily.length === 0}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={daily} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="event_date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend onClick={(e) => toggleSeries(e.dataKey)} formatter={legendFormatter} wrapperStyle={{ cursor: "pointer" }} />
              <Line type="monotone" dataKey="called" name="Called" stroke={C.inkSoft} strokeWidth={2} dot={false} hide={!!hiddenSeries.called} />
              <Line type="monotone" dataKey="reached" name="Reached" stroke={C.teal} strokeWidth={2} dot={false} hide={!!hiddenSeries.reached} />
              <Line type="monotone" dataKey="promised" name="Promised to return" stroke={C.gold} strokeWidth={2} dot={false} hide={!!hiddenSeries.promised} />
              <Line type="monotone" dataKey="returned" name="Returned" stroke={C.green} strokeWidth={2} strokeDasharray="5 3" dot={false} hide={!!hiddenSeries.returned} />
            </LineChart>
          </ResponsiveContainer>
        </State>
      </Card>

      <ExecBand num="!" title="The story" />
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
        {totalCalled > 0 && (
          <Insight tone="pos">
            <b>Calls work.</b> {fmtNum(totalReturned)} of {fmtNum(totalCalled)} absent youth (<b>{fmtPct(recoveryRate)}</b>) came back after follow-up.
          </Insight>
        )}
        {reachRate != null && promiseRate != null && (
          <Insight tone={reachRate < 60 ? "warn" : "neutral"}>
            <b>{reachRate < 60 ? "Reach, not persuasion, is the bottleneck." : "Reach is solid."}</b> Only <b>{fmtPct(reachRate)}</b> of absentees are reached on the day ({fmtNum(totalReached)}/{fmtNum(totalCalled)}), but of those reached <b>{fmtPct(promiseRate)}</b> promise to return.
          </Insight>
        )}
      </div>
      <Insight tone="neutral">
        Reasons for absence aren't shown yet — the reference design breaks this out by reason (sickness, family emergency, home responsibilities, ...), but that column hasn't been confirmed against live BigQuery in this codebase yet.
      </Insight>

      <Card
        title="Retention calls by venue — absent, called, reached, returned"
        subtitle={`Lowest reach rate first. Showing ${Math.min(5, venueRowsSorted.length)} of ${fmtNum(venueRowsSorted.length)} — scroll for the rest.`}
        chip="REAL"
      >
        <State loading={loading} error={error} empty={!loading && venueRowsSorted.length === 0}>
          <div style={{ maxHeight: 236, overflowY: "auto" }}>
            <DataTable
              columns={[
                { key: "venue", label: "Venue" },
                { key: "district", label: "District" },
                { key: "absent", label: "Absent", align: "right", render: (v) => fmtNum(v) },
                { key: "called", label: "Calls made", align: "right", render: (v) => fmtNum(v) },
                { key: "reached", label: "Reached", align: "right", render: (v) => fmtNum(v) },
                { key: "returned", label: "Returned", align: "right", render: (v) => <span style={{ color: C.green, fontWeight: 700 }}>{fmtNum(v)}</span> },
                { key: "reach_rate", label: "Reach %", align: "right", render: (v) => <span style={{ color: callReachColor(v), fontWeight: 700 }}>{fmtPct(v)}</span> },
              ]}
              rows={venueRowsSorted}
            />
          </div>
        </State>
      </Card>
    </div>
  );
}

// One categorisation for every observation score on the page — the overall
// register column, the phase rollup and all seven teaching domains. Bands and
// thresholds come straight from the recruitment team's reference query's
// performance_category CASE (>=4 EXCEEDS, >=3 MEETS, else BELOW). The
// table's percentage_* columns are deliberately not reported, so nothing here
// bands a 0-100 value; distinct from RATE_CATEGORY_*'s 95/85/75 percentage
// bands used elsewhere.
//
// The underlying observation scale is 0-5, not 0-4: four domains
// (facilitation, mindset, gender-responsiveness, language) return an exact
// 5.00 in the live BC5 TOT data. Only the bar fill depends on this — the
// >=4/>=3 cutoffs are the reference query's own and land at 80%/60% of the
// scale. Getting the max wrong flattens every score >=4 to a full bar.
const TRAINER_SCORE_MAX = 5;
const TRAINER_RATING_STYLE = {
  EXCEEDS: { bg: "#E4EEE3", color: C.green, label: "Exceeds" },
  MEETS:   { bg: "#FBF3E3", color: "#A87A1E", label: "Meets" },
  BELOW:   { bg: "#F5E2DA", color: C.coral, label: "Below" },
};
function trainerRating(score) {
  if (score == null) return null;
  if (score >= 4) return "EXCEEDS";
  if (score >= 3) return "MEETS";
  return "BELOW";
}
function trainerScoreColor(score) {
  return TRAINER_RATING_STYLE[trainerRating(score)]?.color || C.muted;
}
// 0-4 scores print to 2dp — a percentage formatter here would imply the
// wrong scale, and 1dp hides the gaps that matter between 2.9 and 3.0.
function fmtScore(v) {
  return v == null ? "—" : Number(v).toFixed(2);
}
function TrainerRatingBadge({ rating }) {
  const s = TRAINER_RATING_STYLE[rating];
  if (!s) return "—";
  return <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: 9, background: s.bg, color: s.color }}>{s.label}</span>;
}

// Same bar look as Gauge, but the value is a 0-4 observation score, not a
// percentage — the fill is score/TRAINER_SCORE_MAX, and the band comes from
// the shared Exceeds/Meets/Below categorisation rather than Gauge's binary
// target/no-target coloring.
function DomainBar({ label, score }) {
  const filled = score == null ? 0 : Math.max(0, Math.min(100, (score / TRAINER_SCORE_MAX) * 100));
  const color = trainerScoreColor(score);
  const rating = trainerRating(score);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: C.text, fontWeight: 600 }}>{label}</span>
        <span style={{ color, fontWeight: 700 }}>{fmtScore(score)} · {rating ? TRAINER_RATING_STYLE[rating].label : "—"}</span>
      </div>
      <div style={{ background: C.line, borderRadius: 6, height: 10 }}>
        <div style={{ width: `${filled}%`, background: color, height: "100%", borderRadius: 6 }} />
      </div>
    </div>
  );
}

// Cohort isn't one of the global filter bar's dimensions (district/gender/
// cohort) — it's page-local to Trainer Quality, since TRAINER_OBSERVATIONS has
// no bootcamp_cycle column at all (a cohort IS a submission-date window) and no
// other live table has a "BC5 TOT" value to filter on. Appends it to whatever
// buildParams(filters) already produced instead of threading it through the
// shared global-filter helpers.
//
// Must stay in lockstep with the backend's TRAINER_COHORTS — the endpoint types
// `phase` as a Literal over exactly these values and 422s on anything else.
const TRAINER_COHORTS = ["BOOTCAMP_4", "BC5 TOT", "BOOTCAMP_5"];

// Register columns the page search matches against. Cohort is deliberately not
// one of them — it already has its own selector above, and including it would
// make a stray "b" quietly narrow by cohort as well as by name.
const TRAINER_SEARCH_FIELDS = ["trainer_name", "venue", "district"];

function withPhaseParam(baseQuery, phase) {
  if (!phase) return baseQuery;
  return `${baseQuery}${baseQuery ? "&" : "?"}phase=${encodeURIComponent(phase)}`;
}

function TrainersTab({ filters }) {
  const [page, setPage] = useState("all");
  return (
    <div>
      <PageNav
        active={page}
        onChange={setPage}
        pages={[{ key: "all", label: "All cohorts" }, ...TRAINER_COHORTS.map((c) => ({ key: c, label: c }))]}
      />
      {/* key forces a remount per cohort so the page's own state (drills) doesn't
          carry across a cohort switch. */}
      <TrainerQualityPage key={page} filters={filters} phase={page === "all" ? undefined : page} />
    </div>
  );
}

function TrainerQualityPage({ filters, phase }) {
  const drill = useDrill();
  const [search, setSearch] = useState("");
  const [openTrainerKey, setOpenTrainerKey] = useState(null);
  const { data, loading, error } = useApi(withPhaseParam(`/api/implementation/trainers${buildParams(filters)}`, phase));
  const allRows = data?.trainers || [];
  const byPhase = data?.by_phase || [];
  const domainDefs = data?.domains || [];

  // Universal filter, the same approach as Awareness Overview: match once here
  // and every metric below is computed from the matched rows, so the tiles, the
  // register, the domain bars, the insights and the district drill all narrow
  // together instead of the table disagreeing with the totals above it.
  //
  // Trainer names arrive already masked for the guest role (initials), so a
  // guest searches exactly the text they can see — matching happens on what was
  // served, never on an unmasked value.
  const q = search.trim().toLowerCase();
  const rows = q
    ? allRows.filter((r) => TRAINER_SEARCH_FIELDS.some((k) => (r[k] || "").toLowerCase().includes(q)))
    : allRows;

  // Register rows are one per trainer x venue x district x cohort, so on a
  // single-cohort view rows == distinct trainers (verified: 79 rows / 79
  // trainers for BOOTCAMP_4), but "All cohorts" sums cohorts and a trainer
  // observed in two of them contributes a row to each. The tile labels below
  // say "records" rather than "trainers" in that case instead of overstating a
  // headcount; the exact per-cohort distinct counts live in the rollup card.
  const nObs = rows.length;
  const nExceeds = rows.filter((r) => r.rating === "EXCEEDS").length;
  const nMeets = rows.filter((r) => r.rating === "MEETS").length;
  const nBelow = rows.filter((r) => r.rating === "BELOW").length;
  const recordNoun = phase ? "trainers" : "records";

  // Cohorts are listed by the backend but only appear in the rollup once they
  // have observations — BOOTCAMP_5's window opens after BOOTCAMP_4's and BC5
  // TOT's, so it is legitimately absent rather than broken. Naming the empty
  // ones is more useful than silently showing a shorter table.
  const cohortList = data?.cohorts || TRAINER_COHORTS;
  const cohortsWithData = byPhase.length;
  const missingCohorts = cohortList.filter((c) => !byPhase.some((p) => p.phase === c));

  // Lowest-first — same read as the reference design: trainers needing
  // support surface at the top of the register, not buried under the stars.
  const sortedRows = [...rows].sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity));

  // Mean of each trainer's own per-domain average score — same aggregation
  // the backend already does per trainer (see trainer_quality_summary_sql.sql),
  // just rolled up one more level here instead of in SQL. Stays on the 0-4
  // scale, so it bands with the same Exceeds/Meets/Below CASE as the overall.
  const domainAverages = domainDefs
    .map((d) => {
      const key = `avg_${d.key}`;
      const vals = rows.map((r) => r[key]).filter((v) => v != null);
      return { key: d.key, label: d.label, avg: vals.length ? Math.round((vals.reduce((a, v) => a + Number(v), 0) / vals.length) * 100) / 100 : null };
    })
    .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));
  const strongestDomain = domainAverages[0];
  const weakestDomains = [...domainAverages].filter((d) => d.avg != null).sort((a, b) => a.avg - b.avg).slice(0, 2);

  function openScoreDrill() {
    const byDistrict = {};
    rows.forEach((r) => {
      const d = byDistrict[r.district] || (byDistrict[r.district] = { district: r.district, _sum: 0, _n: 0 });
      if (r.score != null) { d._sum += Number(r.score) || 0; d._n += 1; }
    });
    const rootRows = Object.values(byDistrict)
      .map((d) => ({ district: d.district, score: d._n ? Math.round((d._sum / d._n) * 100) / 100 : null }))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    drill.open({
      // Districts don't overlap between cohorts in the live data (BOOTCAMP_4 is
      // BUGIRI/BUGWERI, BC5 TOT is JINJA), but the title names the scope anyway
      // so an All-cohorts drill is never mistaken for a single cohort's.
      title: `Avg observation score (0–${TRAINER_SCORE_MAX}) — by district${phase ? ` · ${phase}` : " · all cohorts"}${q ? ` · "${search.trim()}"` : ""}`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [{ key: "score", label: "Avg score", align: "right", render: (v) => <span style={{ color: trainerScoreColor(v), fontWeight: 700 }}>{fmtScore(v)}</span> }],
      rootRows,
      childKey: "trainer_name", childLabel: "Trainer",
      getChildRows: (root) => rows.filter((r) => r.district === root.district).sort((a, b) => (b.score || 0) - (a.score || 0)),
    });
  }

  // Site (venue)-level drill for the four score cards below — stops at
  // site, deliberately no further trainer-level child: the register table
  // already has the richer per-trainer drill (trend, comparisons, insights),
  // so this only needs to answer "which sites".
  function openSiteDrill(cardLabel, matchRow) {
    const byVenue = {};
    rows.forEach((r) => {
      const v = byVenue[r.venue] || (byVenue[r.venue] = { venue: r.venue, _count: 0, _sum: 0, _n: 0 });
      if (matchRow(r)) v._count += 1;
      if (r.score != null) { v._sum += Number(r.score) || 0; v._n += 1; }
    });
    const rootRows = Object.values(byVenue)
      .map((v) => ({ venue: v.venue, count: v._count, avg_score: v._n ? Math.round((v._sum / v._n) * 100) / 100 : null }))
      .filter((v) => v.count > 0)
      .sort((a, b) => b.count - a.count);
    drill.open({
      title: `${cardLabel} — by site${phase ? ` · ${phase}` : " · all cohorts"}${q ? ` · "${search.trim()}"` : ""}`,
      tone: "real", tagLabel: "REAL",
      rootKey: "venue", rootLabel: "Site",
      columns: [
        { key: "count", label: cardLabel, align: "right", render: (v) => fmtNum(v) },
        { key: "avg_score", label: "Avg score", align: "right", render: (v) => (v == null ? "—" : fmtScore(v)) },
      ],
      rootRows,
    });
  }

  // One column per teaching domain on the register itself — colored by the
  // same EXCEEDS/MEETS/BELOW bands as Overall, so a trainer's weak domain(s)
  // are visible at a glance in the row, not just in the per-trainer drill's
  // Comparisons tab. Full domain names, not abbreviations.
  const domainColumns = domainDefs.map((d) => ({
    key: `avg_${d.key}`,
    label: d.label,
    align: "right",
    render: (v) => {
      const rating = trainerRating(v);
      const style = rating ? TRAINER_RATING_STYLE[rating] : null;
      return (
        <span style={{ display: "inline-block", minWidth: 30, textAlign: "center", padding: "2px 6px", borderRadius: 4, fontWeight: 700, background: style?.bg, color: style?.color || C.muted }}>
          {fmtScore(v)}
        </span>
      );
    },
  }));

  // Gender performance — # trainers, avg score, and the Exceeds/Meets/Below
  // split per gender, straight from the already-filtered register rows.
  const genderStats = Object.values(
    rows.reduce((acc, r) => {
      const g = r.trainer_gender || "Unknown";
      const e = acc[g] || (acc[g] = { gender: g, n: 0, sumScore: 0, nScore: 0, exceeds: 0, meets: 0, below: 0 });
      e.n += 1;
      if (r.score != null) { e.sumScore += Number(r.score) || 0; e.nScore += 1; }
      if (r.rating === "EXCEEDS") e.exceeds += 1;
      else if (r.rating === "MEETS") e.meets += 1;
      else if (r.rating === "BELOW") e.below += 1;
      return acc;
    }, {})
  )
    .map((g) => ({ ...g, avg_score: g.nScore ? Math.round((g.sumScore / g.nScore) * 100) / 100 : null }))
    .sort((a, b) => b.n - a.n);

  // District performance by rating category — same three bands as the score
  // cards and the register's Rating column, broken out per district so it's
  // visible where the Below-rated trainers are concentrated.
  const districtCategoryStats = Object.values(
    rows.reduce((acc, r) => {
      const d = r.district || "Unknown";
      const e = acc[d] || (acc[d] = { district: d, n: 0, sumScore: 0, nScore: 0, exceeds: 0, meets: 0, below: 0 });
      e.n += 1;
      if (r.score != null) { e.sumScore += Number(r.score) || 0; e.nScore += 1; }
      if (r.rating === "EXCEEDS") e.exceeds += 1;
      else if (r.rating === "MEETS") e.meets += 1;
      else if (r.rating === "BELOW") e.below += 1;
      return acc;
    }, {})
  )
    .map((d) => ({ ...d, avg_score: d.nScore ? Math.round((d.sumScore / d.nScore) * 100) / 100 : null }))
    .sort((a, b) => b.below - a.below || (b.n - a.n));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
        <button onClick={openLessonObservationForm} style={{ fontSize: 12, fontWeight: 700, padding: "8px 16px", border: "none", borderRadius: 6, background: C.green, color: C.white, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
          📝 Lesson Observation Form
        </button>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search trainer, venue or district…"
        style={{ width: "100%", fontSize: 12, padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 5, marginBottom: 4 }}
      />
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 14 }}>
        {q
          ? <>Matched <b>{fmtNum(nObs)}</b> of {fmtNum(allRows.length)} {allRows.length === 1 ? "record" : "records"} — score cards, the register, the domain summary and the insights below all reflect this filter. The cohort comparison always spans every cohort.{nObs === 0 ? " Nothing matched — check the spelling, or clear the box." : ""}</>
          : "Filters every metric on this page to the trainers, venues or districts you search for — score cards, the register, the domain summary and the insights below."}
      </div>

      <Grid cols={4}>
        <KpiTile
          label={phase ? "Trainers observed" : "Trainer records"}
          value={String(nObs)}
          sub={phase || `across ${cohortsWithData || TRAINER_COHORTS.length} cohorts — a trainer observed in two counts once per cohort`}
          tag="REAL"
          onClick={() => openSiteDrill(phase ? "Trainers observed" : "Trainer records", () => true)}
        />
        <KpiTile label="Exceeds expectations" value={String(nExceeds)} sub={nObs ? `${Math.round((nExceeds / nObs) * 100)}% of ${recordNoun}` : undefined} tag="REAL" onClick={() => openSiteDrill("Exceeds expectations", (r) => r.rating === "EXCEEDS")} />
        <KpiTile label="Meets expectations" value={String(nMeets)} sub={nObs ? `${Math.round((nMeets / nObs) * 100)}% of ${recordNoun}` : undefined} tag="REAL" onClick={() => openSiteDrill("Meets expectations", (r) => r.rating === "MEETS")} />
        <KpiTile label="Below expectations" value={String(nBelow)} sub={nObs ? (nBelow === 0 ? "none flagged" : `${Math.round((nBelow / nObs) * 100)}% of ${recordNoun}`) : undefined} tone={nBelow > 0 ? "sim" : "real"} tag="REAL" onClick={() => openSiteDrill("Below expectations", (r) => r.rating === "BELOW")} />
      </Grid>
      <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 20 }}>
        Cards above drill by site. Trainer rows below drill to trend, comparisons & insights.
      </div>

      {/* Always shown, even on a single-cohort view: the rollup deliberately
          spans every cohort server-side, so this stays the one place to compare
          the selected cohort against the others. Distinct-trainer counts here
          are exact (COUNT(DISTINCT trainer_name)), unlike the register-row
          count in the tile above. */}
      <Card
        title="Cohort comparison"
        subtitle={`Distinct trainers observed and mean observation score per cohort. Rolled up server-side, so this always spans every cohort with data regardless of the cohort selected or the search above${phase ? ` — the register below is narrowed to ${phase}` : ""}.`}
        chip="REAL"
      >
        <State loading={loading} error={error} empty={!loading && byPhase.length === 0}>
          <DataTable
            columns={[
              { key: "phase", label: "Cohort", render: (v) => <span style={{ fontWeight: v === phase ? 800 : 400 }}>{v}{v === phase ? " ·" : ""}</span> },
              { key: "trainers_observed", label: "Trainers observed", align: "right", render: (v) => fmtNum(v) },
              { key: "score", label: "Avg score", align: "right", render: (v) => <span style={{ color: trainerScoreColor(v), fontWeight: 700 }}>{fmtScore(v)}</span> },
            ]}
            rows={byPhase}
          />
          {missingCohorts.length > 0 && (
            <p style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
              No observations yet for {missingCohorts.join(", ")} — {missingCohorts.length === 1 ? "its window" : "their windows"} either hasn&apos;t opened or hasn&apos;t reported. {missingCohorts.length === 1 ? "It" : "They"} will appear here automatically once data lands.
            </p>
          )}
        </State>
      </Card>

      <Card
        title="Trainer observation register — who was observed & how they rated"
        subtitle={`Mean observation score on the 0–${TRAINER_SCORE_MAX} scale, sorted lowest-first. Domain columns colored by band. Click a trainer for their profile, or Overall for a district breakdown.${phase ? ` Showing ${phase} only.` : ""}${q ? ` Filtered to "${search.trim()}".` : ""}`}
        chip="PII" chipTone="pii"
      >
        <State loading={loading} error={error} empty={!loading && rows.length === 0}>
          <DataTable
            columns={[
              {
                key: "trainer_name", label: "Trainer",
                render: (v) => <span><span style={{ color: C.teal, marginRight: 4 }}>›</span>{v}</span>,
              },
              { key: "venue", label: "Venue" },
              { key: "district", label: "District" },
              // Redundant when a single cohort is selected — every row would
              // carry the same value — so it only earns a column on All cohorts.
              ...(phase ? [] : [{ key: "cohort", label: "Cohort" }]),
              { key: "observation_count", label: "# Observations", align: "right", render: (v) => fmtNum(v) },
              { key: "score", label: "Overall", align: "right", onHeaderClick: openScoreDrill, render: (v) => <span style={{ color: trainerScoreColor(v), fontWeight: 700 }}>{fmtScore(v)}</span> },
              { key: "rating", label: "Rating", render: (v) => <TrainerRatingBadge rating={v} /> },
              ...domainColumns,
            ]}
            rows={sortedRows}
            onRowClick={(r) => setOpenTrainerKey(r.trainer_key)}
            maxBodyHeight={380}
            stickyHeader
          />
        </State>
      </Card>

      {openTrainerKey && (
        <TrainerProfilePanel trainerKey={openTrainerKey} registerRows={rows} onClose={() => setOpenTrainerKey(null)} />
      )}

      <Card title="Domain summary" subtitle={`Mean observation score across all observed trainers by teaching domain, on the 0–${TRAINER_SCORE_MAX} scale. Same bands as the overall rating — green Exceeds ≥4 · amber Meets ≥3 · red Below <3.`} chip="REAL">
        <State loading={loading} error={error} empty={!loading && domainAverages.length === 0}>
          <div style={{ paddingTop: 4 }}>
            {domainAverages.map((d) => <DomainBar key={d.key} label={d.label} score={d.avg} />)}
          </div>
        </State>
      </Card>

      <Card title="Gender performance" subtitle="# trainers, average score and rating split by gender." chip="REAL">
        <State loading={loading} error={error} empty={!loading && genderStats.length === 0}>
          <DataTable
            columns={[
              { key: "gender", label: "Gender" },
              { key: "n", label: "# Trainers", align: "right", render: (v) => fmtNum(v) },
              { key: "avg_score", label: "Avg score", align: "right", render: (v) => <span style={{ color: trainerScoreColor(v), fontWeight: 700 }}>{fmtScore(v)}</span> },
              { key: "exceeds", label: "Exceeds", align: "right", render: (v) => fmtNum(v) },
              { key: "meets", label: "Meets", align: "right", render: (v) => fmtNum(v) },
              { key: "below", label: "Below", align: "right", render: (v) => <span style={{ color: v > 0 ? C.coral : C.muted, fontWeight: v > 0 ? 700 : 400 }}>{fmtNum(v)}</span> },
            ]}
            rows={genderStats}
          />
        </State>
      </Card>

      <Card title="District performance — Exceeds / Meets / Below" subtitle="Same three rating bands as the register, broken out by district — sorted so districts with the most Below-rated trainers surface first." chip="REAL">
        <State loading={loading} error={error} empty={!loading && districtCategoryStats.length === 0}>
          <DataTable
            columns={[
              { key: "district", label: "District" },
              { key: "n", label: "# Trainers", align: "right", render: (v) => fmtNum(v) },
              { key: "avg_score", label: "Avg score", align: "right", render: (v) => <span style={{ color: trainerScoreColor(v), fontWeight: 700 }}>{fmtScore(v)}</span> },
              { key: "exceeds", label: "Exceeds", align: "right", render: (v) => fmtNum(v) },
              { key: "meets", label: "Meets", align: "right", render: (v) => fmtNum(v) },
              { key: "below", label: "Below", align: "right", render: (v) => <span style={{ color: v > 0 ? C.coral : C.muted, fontWeight: v > 0 ? 700 : 400 }}>{fmtNum(v)}</span> },
            ]}
            rows={districtCategoryStats}
          />
        </State>
      </Card>

      <ExecBand num="!" title="The story" />
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
        {nObs > 0 && (
          <Insight tone={nBelow === 0 ? "pos" : nBelow / nObs > 0.1 ? "risk" : "warn"}>
            <b>{Math.round(((nExceeds + nMeets) / nObs) * 100)}% of observed trainers meet or exceed expectations</b> ({fmtNum(nExceeds)} exceeds, {fmtNum(nMeets)} meets, out of {fmtNum(nObs)}) — {nBelow === 0 ? "none rated Below." : `${fmtNum(nBelow)} rated Below and need follow-up.`}
          </Insight>
        )}
        {weakestDomains.length > 0 && (
          <Insight tone="warn">
            <b>{weakestDomains.map((d) => d.label).join(" and ")} score{weakestDomains.length === 1 ? "s" : ""} lowest</b> ({weakestDomains.map((d) => fmtScore(d.avg)).join(", ")} out of {TRAINER_SCORE_MAX}) across the observed cohort — worth targeting trainer support here specifically rather than delivery mechanics generally.
          </Insight>
        )}
        {strongestDomain && (
          <Insight tone="neutral">
            <b>{strongestDomain.label}</b> is the strongest domain cohort-wide at <b>{fmtScore(strongestDomain.avg)}</b> out of {TRAINER_SCORE_MAX}.
          </Insight>
        )}
        {/* Best vs worst across however many cohorts have reported, rather than
            assuming exactly two — BOOTCAMP_5 has no observations yet, and a
            hardcoded pair would have silently stopped comparing once it lands
            and made three. 0.2 on the 5-point scale is the gap worth remarking
            on; below that the cohorts are effectively level. */}
        {(() => {
          const scored = byPhase.filter((p) => p.score != null);
          if (scored.length < 2) return null;
          const higher = scored.reduce((a, b) => (b.score > a.score ? b : a));
          const lower = scored.reduce((a, b) => (b.score < a.score ? b : a));
          const gap = Math.round((higher.score - lower.score) * 100) / 100;
          if (gap < 0.2) {
            return (
              <Insight tone="pos">
                All {scored.length} reporting cohorts score within <b>{gap}</b> of each other ({scored.map((p) => `${p.phase} ${fmtScore(p.score)}`).join(", ")}) — observation quality is holding steady across cohorts.
              </Insight>
            );
          }
          return (
            <Insight tone="neutral">
              <b>{higher.phase}</b> scores higher on average ({fmtScore(higher.score)}) than <b>{lower.phase}</b> ({fmtScore(lower.score)}) — a {gap}-point gap. Worth checking whether that's a genuine delivery difference or just which trainers have been observed so far in each cohort.
            </Insight>
          );
        })()}
      </div>
    </div>
  );
}

// ─── Trainer Quality: per-trainer drill (trend / comparisons / insights) ───
// Reuses this page's own fmtScore/trainerRating/trainerScoreColor/DomainBar —
// the 1-5 scale, bands and colors are already shared with the register and
// the Domain summary card above, so this panel doesn't introduce a second
// scoring system.

// Same SurveyCTO form that feeds TRAINER_OBSERVATIONS
// (raw_eba_2025_monitoring_tool_v2_ug — "monitoring_tool_v2" matches the
// survey id below) — linked here the same way the reference trainer
// dashboard ("Trainer Quality Toolkit.html") did, opened as a sized popup
// with a fresh per-click case id, falling back to a normal tab if the
// popup is blocked.
function openLessonObservationForm() {
  const surveyUrl = `https://expeducate.surveycto.com/collect/eba_2025_monitoring_tool_v2?caseid=case_${Date.now()}`;
  const width = 1200, height = 800;
  const left = Math.max(0, (window.screen.width - width) / 2);
  const top = Math.max(0, (window.screen.height - height) / 2);
  const win = window.open(surveyUrl, "LessonObservationForm", `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,toolbar=no,menubar=no,location=no,status=yes`);
  if (!win) window.open(surveyUrl, "_blank");
}

// Raw values from the form export are shouty ("WEEK2", "BOOTCAMP_5") —
// first-letter-capitalize instead of leaving them all-caps.
function titleCaseWord(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

function avgOf(rows, key) {
  const vals = rows.map((r) => r[key]).filter((v) => v != null);
  return vals.length ? Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 100) / 100 : null;
}

// Chronological split-half comparison of this trainer's own score history.
// Needs >=2 observations. 0.3 (on the 1-5 scale) is deliberately small — a
// full rating-band shift (BELOW->MEETS->EXCEEDS) is 1.0 apart, so 0.3 flags
// meaningful movement within a band without reacting to a single noisy
// observation. Revisit this threshold if it proves too twitchy in practice.
function computeTrainerTrend(observations) {
  if (!observations || observations.length < 2) return null;
  const mid = Math.floor(observations.length / 2);
  const avg = (arr) => arr.reduce((s, o) => s + (o.score || 0), 0) / arr.length;
  const diff = avg(observations.slice(mid)) - avg(observations.slice(0, mid));
  if (diff >= 0.3) return "improving";
  if (diff <= -0.3) return "declining";
  return "stable";
}

const TREND_DISPLAY = {
  improving: { icon: "📈", label: "Improving", color: C.green },
  stable: { icon: "➡️", label: "Stable", color: C.muted },
  declining: { icon: "📉", label: "Declining", color: C.coral },
};

function ScoreCircle({ score }) {
  const color = trainerScoreColor(score);
  return (
    <div style={{ width: 78, height: 78, borderRadius: "50%", background: C.cream, border: `4px solid ${color}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <div style={{ fontSize: 21, fontWeight: 800, color }}>{fmtScore(score)}</div>
      <div style={{ fontSize: 8.5, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3 }}>Avg score</div>
    </div>
  );
}

function ComparisonCard({ icon, label, mine, other, otherCount }) {
  const delta = mine != null && other != null ? Math.round((mine - other) * 100) / 100 : null;
  const deltaColor = delta == null ? C.muted : delta >= 0 ? C.green : C.coral;
  return (
    <div style={{ background: C.white, border: `1px solid ${C.line}`, borderRadius: 6, padding: 14, borderLeft: `4px solid ${C.gold}` }}>
      <div style={{ fontSize: 10.5, color: C.muted, textTransform: "uppercase", fontWeight: 700, marginBottom: 8 }}>{icon} {label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 24, fontWeight: 800, color: trainerScoreColor(mine) }}>{fmtScore(mine)}</span>
        <span style={{ fontSize: 12, color: C.muted }}>vs</span>
        <span style={{ fontSize: 16, color: C.text }}>{fmtScore(other)}</span>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, fontWeight: 700, color: deltaColor }}>
        {delta == null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`}
        {otherCount != null && <span style={{ color: C.muted, fontWeight: 400, marginLeft: 6 }}>({otherCount} peers)</span>}
      </div>
    </div>
  );
}

function TrainerOverviewSection({ observations, domainAverages, avgScore, observationCount }) {
  const chartData = observations.map((o) => ({ date: o.observation_date, score: o.score }));
  return (
    <div>
      <Grid cols={4}>
        <KpiTile label="Observations" value={String(observationCount)} />
        <KpiTile label="Average score" value={fmtScore(avgScore)} />
        <KpiTile label="Rating" value={<TrainerRatingBadge rating={trainerRating(avgScore)} />} />
        <KpiTile label="Domains tracked" value={String(domainAverages.filter((d) => d.avg != null).length)} />
      </Grid>

      <Card title="Score trend" subtitle={`Overall observation score (1–${TRAINER_SCORE_MAX}) across every recorded classroom visit, in order.`}>
        {observations.length ? (
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} />
              <YAxis domain={[1, TRAINER_SCORE_MAX]} tick={{ fontSize: 10 }} />
              <Tooltip formatter={(v) => fmtScore(v)} />
              <Line type="monotone" dataKey="score" stroke={C.teal} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ padding: 20, textAlign: "center", color: C.muted, fontSize: 13 }}>No observations recorded yet.</div>
        )}
      </Card>

      <Card title="Observation history">
        <DataTable
          columns={[
            { key: "observation_date", label: "Date" },
            { key: "training_week", label: "Week", render: (v, r) => [titleCaseWord(v), titleCaseWord(r.training_day)].filter(Boolean).join(" · ") || "—" },
            { key: "observer_name", label: "Observer" },
            { key: "score", label: "Score", align: "right", render: (v) => <span style={{ color: trainerScoreColor(v), fontWeight: 700 }}>{fmtScore(v)}</span> },
          ]}
          rows={observations}
        />
      </Card>

      <Card title="Domain breakdown" subtitle={`This trainer's own average per teaching domain (1–${TRAINER_SCORE_MAX} scale).`}>
        {domainAverages.map((d) => <DomainBar key={d.key} label={d.label} score={d.avg} />)}
      </Card>
    </div>
  );
}

function TrainerComparisonsSection({ avgScore, domainAverages, selfRow, registerRows, trainerKey }) {
  const programAvg = avgOf(registerRows, "score");
  const districtRows = selfRow ? registerRows.filter((r) => r.district === selfRow.district) : [];
  const venueRows = selfRow ? registerRows.filter((r) => r.venue === selfRow.venue) : [];
  const genderRows = selfRow?.trainer_gender ? registerRows.filter((r) => r.trainer_gender === selfRow.trainer_gender) : [];

  const sortedByScore = [...registerRows].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  const rank = registerRows.length ? sortedByScore.findIndex((r) => r.trainer_key === trainerKey) + 1 : null;
  const percentile = rank && registerRows.length ? Math.round(((registerRows.length - rank) / registerRows.length) * 100) : null;

  return (
    <div>
      <Card title="Performance comparisons" subtitle={`This trainer's average score vs peers, same 1–${TRAINER_SCORE_MAX} scale.`}>
        <Grid cols={2}>
          <ComparisonCard icon="🌍" label="vs Program average" mine={avgScore} other={programAvg} otherCount={registerRows.length} />
          <ComparisonCard icon="📍" label="vs District average" mine={avgScore} other={avgOf(districtRows, "score")} otherCount={districtRows.length} />
          <ComparisonCard icon="🏫" label="vs Venue average" mine={avgScore} other={avgOf(venueRows, "score")} otherCount={venueRows.length} />
          <ComparisonCard icon="👤" label={`vs ${selfRow?.trainer_gender || "Gender"} peers`} mine={avgScore} other={avgOf(genderRows, "score")} otherCount={genderRows.length} />
        </Grid>
      </Card>

      <Card title="Domain scores vs program average">
        {domainAverages.map((d) => {
          const programDomainAvg = avgOf(registerRows, `avg_${d.key}`);
          const diff = d.avg != null && programDomainAvg != null ? Math.round((d.avg - programDomainAvg) * 100) / 100 : null;
          return (
            <div key={d.key} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: C.text, fontWeight: 600 }}>{d.label}</span>
                <span style={{ color: diff == null ? C.muted : diff >= 0 ? C.green : C.coral, fontWeight: 700 }}>
                  {diff == null ? "—" : `${diff >= 0 ? "+" : ""}${diff.toFixed(2)} vs program`}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ flex: 1, height: 8, background: C.line, borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${d.avg == null ? 0 : Math.max(0, Math.min(100, (d.avg / TRAINER_SCORE_MAX) * 100))}%`, background: trainerScoreColor(d.avg) }} />
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, minWidth: 32, textAlign: "right", color: trainerScoreColor(d.avg) }}>{fmtScore(d.avg)}</span>
              </div>
            </div>
          );
        })}
      </Card>

      <Card title="Ranking">
        <Grid cols={2}>
          <KpiTile label="Program rank" value={rank ? `#${rank}` : "—"} sub={registerRows.length ? `out of ${registerRows.length}` : undefined} />
          <KpiTile label="Percentile" value={percentile != null ? `${percentile}%` : "—"} sub={percentile != null ? `top ${100 - percentile}%` : undefined} />
        </Grid>
      </Card>
    </div>
  );
}

// Deterministic, rule-based read on this trainer's own numbers — NOT a real
// AI/LLM call. Threshold checks against the same EXCEEDS/MEETS/BELOW bands
// used across Trainer Quality, mirrored per domain.
function buildTrainerInsights({ avgScore, rating, trend, domainAverages, observationCount }) {
  const strengths = [];
  domainAverages.forEach((d) => { if (d.avg != null && d.avg >= 4) strengths.push(`Strong ${d.label} (${fmtScore(d.avg)}/${TRAINER_SCORE_MAX}).`); });
  if (trend === "improving") strengths.push("Scores are trending upward across recent observations.");
  if (observationCount >= 8) strengths.push(`Consistently observed (${observationCount} classroom visits).`);
  if (strengths.length === 0) strengths.push("Regular participation in observed sessions.");

  const concerns = [];
  domainAverages.forEach((d) => {
    if (d.avg == null) return;
    if (d.avg < 3) concerns.push({ tone: "risk", text: `${d.label} needs significant improvement (${fmtScore(d.avg)}/${TRAINER_SCORE_MAX}) — high priority.` });
    else if (d.avg < 4) concerns.push({ tone: "warn", text: `${d.label} has room to grow (${fmtScore(d.avg)}/${TRAINER_SCORE_MAX}).` });
  });
  if (trend === "declining") concerns.push({ tone: "risk", text: "Scores have been trending downward across recent observations — worth a closer look." });
  if (avgScore != null && avgScore < 4) concerns.push({ tone: "warn", text: `Overall average (${fmtScore(avgScore)}/${TRAINER_SCORE_MAX}) is below the Exceeds threshold.` });

  const actions = [];
  if (rating === "BELOW") {
    actions.push("Schedule an intensive one-on-one coaching session soon.");
    actions.push("Pair with a trainer currently rated Exceeds for job shadowing.");
    actions.push("Review lesson plans together before upcoming sessions.");
  } else if (rating === "MEETS") {
    actions.push("Set up weekly coaching check-ins over the next few weeks.");
    actions.push("Target practice specifically on the lowest-scoring domain below.");
  } else if (rating === "EXCEEDS") {
    actions.push("Maintain current performance and keep refining technique.");
    actions.push("Consider for peer mentoring or trainer-of-trainers opportunities.");
  }
  const lowestDomain = [...domainAverages].filter((d) => d.avg != null).sort((a, b) => a.avg - b.avg)[0];
  if (lowestDomain && lowestDomain.avg < 4) actions.push(`Targeted development on ${lowestDomain.label}, this trainer's lowest-scoring domain.`);

  return { strengths, concerns, actions };
}

function TrainerInsightsSection({ avgScore, rating, trend, domainAverages, observationCount }) {
  const { strengths, concerns, actions } = buildTrainerInsights({ avgScore, rating, trend, domainAverages, observationCount });
  return (
    <div>
      <Card title="Strengths">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {strengths.map((s, i) => <Insight key={i} tone="pos">{s}</Insight>)}
        </div>
      </Card>
      <Card title="Concerns">
        {concerns.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 13 }}>No concerns flagged against the current bands.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {concerns.map((c, i) => <Insight key={i} tone={c.tone}>{c.text}</Insight>)}
          </div>
        )}
      </Card>
      <Card title="Recommended next steps">
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.8, color: C.text }}>
          {actions.map((a, i) => <li key={i}>{a}</li>)}
        </ol>
      </Card>
    </div>
  );
}

function TrainerProfilePanel({ trainerKey, registerRows, onClose }) {
  const [page, setPage] = useState("overview");
  const { data, loading, error } = useApi(`/api/implementation/trainer-detail?trainer_key=${encodeURIComponent(trainerKey)}`);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const observations = data?.observations || [];
  const domainDefs = data?.domains || [];
  const trainerName = data?.trainer_name;
  const avgScore = avgOf(observations, "score");
  const rating = trainerRating(avgScore);
  const trend = computeTrainerTrend(observations);
  const trendInfo = trend ? TREND_DISPLAY[trend] : null;
  const selfRow = registerRows.find((r) => r.trainer_key === trainerKey);
  const domainAverages = domainDefs.map((d) => ({ key: d.key, label: d.label, avg: avgOf(observations, `avg_${d.key}`) }));

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,34,56,.40)", zIndex: 80 }} />
      <aside role="dialog" aria-label="Trainer profile" style={{
        position: "fixed", top: 0, right: 0, height: "100%", width: 640, maxWidth: "94vw",
        background: C.cream, zIndex: 90, display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 28px rgba(0,0,0,.14)",
      }}>
        <div style={{ padding: "20px 24px 14px", borderBottom: `1px solid ${C.line}`, background: C.white, flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <ScoreCircle score={avgScore} />
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: C.ink }}>{trainerName || "—"}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{selfRow ? `${selfRow.venue} • ${selfRow.district}` : "—"}</div>
                <div style={{ marginTop: 6, display: "flex", gap: 10, alignItems: "center" }}>
                  <TrainerRatingBadge rating={rating} />
                  {trendInfo && <span style={{ fontSize: 12, fontWeight: 700, color: trendInfo.color }}>{trendInfo.icon} {trendInfo.label}</span>}
                </div>
              </div>
            </div>
            <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", fontSize: 22, color: C.muted, cursor: "pointer", padding: "0 6px", lineHeight: 1 }}>&times;</button>
          </div>
        </div>
        <div style={{ padding: "18px 24px 30px", overflowY: "auto", flex: 1 }}>
          <PageNav
            active={page}
            onChange={setPage}
            pages={[{ key: "overview", label: "Overview" }, { key: "comparisons", label: "Comparisons" }, { key: "insights", label: "Insights" }]}
          />
          <State loading={loading} error={error} empty={!loading && !error && observations.length === 0}>
            {page === "overview" && (
              <TrainerOverviewSection observations={observations} domainAverages={domainAverages} avgScore={avgScore} observationCount={observations.length} />
            )}
            {page === "comparisons" && (
              <TrainerComparisonsSection avgScore={avgScore} domainAverages={domainAverages} selfRow={selfRow} registerRows={registerRows} trainerKey={trainerKey} />
            )}
            {page === "insights" && (
              <TrainerInsightsSection avgScore={avgScore} rating={rating} trend={trend} domainAverages={domainAverages} observationCount={observations.length} />
            )}
          </State>
        </div>
      </aside>
    </>
  );
}

// Same read as the reference design's RAGc(v,50,30) for "% exceeding
// expectations" — distinct from RATE_TARGETS' funnel-stage bands, since a
// milestone quality score isn't a funnel conversion rate.
function milestoneColor(pct) {
  if (pct == null) return C.muted;
  return pct >= 50 ? C.green : pct >= 30 ? C.gold : C.coral;
}

const MILESTONE_METRIC_LABEL = { exceed_pct: "% Exceeding expectations", completion_pct: "% Completed" };

// District rollup for Milestones — a straight average of each venue's own
// exceed_pct/completion_pct (not volume-weighted by youth count). Feeds the
// full venue table's per-metric drill, the District x Week header drill,
// and the district comparison drill.
function milestoneDistrictRollup(venueRows) {
  const byDistrict = {};
  venueRows.forEach((v) => {
    const d = byDistrict[v.district] || (byDistrict[v.district] = { district: v.district, venues: 0, youth: 0, exceedSum: 0, completionSum: 0 });
    d.venues += 1;
    d.youth += v.avg_youth_per_week || 0;
    d.exceedSum += v.exceed_pct || 0;
    d.completionSum += v.completion_pct || 0;
  });
  return Object.values(byDistrict).map((d) => ({
    district: d.district,
    venues: d.venues,
    youth: Math.round(d.youth),
    avg_exceed_pct: d.venues ? Math.round((10 * d.exceedSum) / d.venues) / 10 : null,
    avg_completion_pct: d.venues ? Math.round((10 * d.completionSum) / d.venues) / 10 : null,
  }));
}

// Pivots long-format (entity, week_number, metrics...) rows into one row per
// entity with w{N}_ prefixed fields, for the District x Week / Venue x Week
// matrix tables (GroupedDataTable, one column group per week).
function pivotByWeek(rows, entityKey, extraKeys = []) {
  const byEntity = {};
  rows.forEach((r) => {
    const key = r[entityKey];
    if (!byEntity[key]) {
      byEntity[key] = { [entityKey]: key };
      extraKeys.forEach((k) => { byEntity[key][k] = r[k]; });
    }
    const e = byEntity[key];
    const w = r.week_number;
    e[`w${w}_total_youth`] = r.total_youth;
    e[`w${w}_completed`] = r.completed;
    e[`w${w}_completion_pct`] = r.completion_pct;
    e[`w${w}_exceed_pct`] = r.exceed_pct;
    e[`w${w}_meet_pct`] = r.meet_pct;
    e[`w${w}_below_pct`] = r.below_pct;
  });
  return Object.values(byEntity);
}

// Distinct, sorted week numbers actually present -- drives both the pivot
// column groups above and the variance drill below, rather than assuming a
// fixed 4 weeks (a cohort/filter could report fewer).
function weekNumbersIn(rows) {
  return [...new Set(rows.map((r) => r.week_number))].sort((a, b) => a - b);
}

// Distinct, sorted values of a field actually present -- used to build the
// district column-groups for the transposed District x Week matrix (weeks as
// rows, districts as column-groups) below.
function distinctValues(rows, key) {
  return [...new Set(rows.map((r) => r[key]).filter((v) => v != null))].sort();
}

const WEEK_GROUP_COLORS = [C.teal, C.gold, C.green, C.coral];
const ENTITY_GROUP_COLORS = [C.teal, C.gold, C.green, C.coral, C.muted];

// One GroupedDataTable column-group per week for the Venue x Week matrix --
// activated (raw count) plus the full below/meets/exceeds split, now that
// the standalone "Venue milestone performance" table (which used to carry
// avg_youth_per_week/exceed/completion on their own) is gone and this is
// the only per-venue view left.
function weekColumnGroupsCompact(weekNumbers) {
  return weekNumbers.map((w, i) => ({
    label: `Week ${w}`,
    color: WEEK_GROUP_COLORS[i % WEEK_GROUP_COLORS.length],
    columns: [
      { key: `w${w}_total_youth`, label: "Activated", align: "right", render: fmtNum },
      { key: `w${w}_completion_pct`, label: "% Complete", align: "right", render: fmtPct },
      { key: `w${w}_exceed_pct`, label: "% Exceed", align: "right", render: (v) => <span style={{ color: milestoneColor(v), fontWeight: 700 }}>{fmtPct(v)}</span> },
      { key: `w${w}_meet_pct`, label: "% Meet", align: "right", render: fmtPct },
      { key: `w${w}_below_pct`, label: "% Below", align: "right", render: (v) => <span style={{ color: v <= 5 ? C.green : v <= 10 ? C.gold : C.coral, fontWeight: 700 }}>{fmtPct(v)}</span> },
    ],
  }));
}

// Transposed pivot for District x Week -- one row per WEEK (rows), with
// entity (district) name double-underscore-prefixed fields for each column
// group, the mirror image of pivotByWeek above (which puts entity on rows
// and week on column-groups). Kept as its own function rather than a shared
// "pivot in either direction" helper -- the key-naming scheme differs
// (w{N}_metric vs {entity}__metric) and each caller only ever needs one
// direction.
function pivotWeeksByEntity(rows, entityKey) {
  const byWeek = {};
  rows.forEach((r) => {
    const w = r.week_number;
    if (!byWeek[w]) byWeek[w] = { week_number: w };
    const e = byWeek[w];
    const name = r[entityKey];
    e[`${name}__total_youth`] = r.total_youth;
    e[`${name}__completed`] = r.completed;
    e[`${name}__completion_pct`] = r.completion_pct;
    e[`${name}__exceed_pct`] = r.exceed_pct;
    e[`${name}__meet_pct`] = r.meet_pct;
    e[`${name}__below_pct`] = r.below_pct;
  });
  return Object.values(byWeek).sort((a, b) => a.week_number - b.week_number);
}

// One GroupedDataTable column-group per entity (district), for the
// transposed District x Week matrix -- the group HEADER is the drill
// trigger here (not the row, since a row is now a week, not a district),
// via GroupedDataTable's onHeaderClick support.
function entityColumnGroups(entityNames, onHeaderClick) {
  return entityNames.map((name, i) => ({
    label: name,
    color: ENTITY_GROUP_COLORS[i % ENTITY_GROUP_COLORS.length],
    onHeaderClick,
    columns: [
      { key: `${name}__total_youth`, label: "Activated", align: "right", render: fmtNum },
      { key: `${name}__completed`, label: "Completed", align: "right", render: fmtNum },
      { key: `${name}__completion_pct`, label: "% Complete", align: "right", render: fmtPct },
      { key: `${name}__exceed_pct`, label: "% Exceed", align: "right", render: (v) => <span style={{ color: milestoneColor(v), fontWeight: 700 }}>{fmtPct(v)}</span> },
      { key: `${name}__meet_pct`, label: "% Meet", align: "right", render: fmtPct },
      { key: `${name}__below_pct`, label: "% Below", align: "right", render: (v) => <span style={{ color: v <= 5 ? C.green : v <= 10 ? C.gold : C.coral, fontWeight: 700 }}>{fmtPct(v)}</span> },
    ],
  }));
}

function renderMilestoneDelta(v) {
  if (v == null) return "—";
  return <span style={{ color: v >= 0 ? C.green : C.coral, fontWeight: 700 }}>{v > 0 ? "+" : ""}{v}pp</span>;
}

// That one district/venue's own week-by-week trend, with the change vs the
// prior week for both completion and quality (% exceeding) -- "are youths
// improving or not", the child level of the comparison drill below.
function weekVariance(rows, entityKey, entityValue) {
  const filtered = rows.filter((r) => r[entityKey] === entityValue).sort((a, b) => a.week_number - b.week_number);
  return filtered.map((r, i) => {
    const prev = filtered[i - 1];
    const delta = (curr, prior) => (curr != null && prior != null ? Math.round((curr - prior) * 10) / 10 : null);
    return {
      week: `Week ${r.week_number}`,
      completion_pct: r.completion_pct,
      completion_delta: prev ? delta(r.completion_pct, prev.completion_pct) : null,
      exceed_pct: r.exceed_pct,
      exceed_delta: prev ? delta(r.exceed_pct, prev.exceed_pct) : null,
    };
  });
}

// One GroupedDataTable column-group per week, % Meet + % Exceed only -- for
// the Cohort comparison table, where the read is specifically "is quality
// (meeting/exceeding) rising or falling week on week", not the full
// activated/completed/below breakdown.
function weekColumnGroupsMeetExceed(weekNumbers) {
  return weekNumbers.map((w, i) => ({
    label: `Week ${w}`,
    color: WEEK_GROUP_COLORS[i % WEEK_GROUP_COLORS.length],
    columns: [
      { key: `w${w}_meet_pct`, label: "% Meet", align: "right", render: fmtPct },
      { key: `w${w}_exceed_pct`, label: "% Exceed", align: "right", render: (v) => <span style={{ color: milestoneColor(v), fontWeight: 700 }}>{fmtPct(v)}</span> },
    ],
  }));
}

// Per-cohort trend: change in % exceeding expectations from that cohort's
// first reported week to its latest -- the "does quality improve or drop"
// read the Cohort comparison table's trailing column shows.
function cohortQualityTrend(rows) {
  return distinctValues(rows, "cohort").map((cohort) => {
    const weeks = rows.filter((r) => r.cohort === cohort).sort((a, b) => a.week_number - b.week_number);
    const first = weeks[0], last = weeks[weeks.length - 1];
    const trend = first && last && first !== last && first.exceed_pct != null && last.exceed_pct != null
      ? Math.round((last.exceed_pct - first.exceed_pct) * 10) / 10
      : null;
    return { cohort, weeks_reported: weeks.length, trend };
  });
}

// Inside-segment percentage label for the Weekly Overall Performance
// horizontal stacked bar -- hidden below a minimum pixel width so thin
// slices (e.g. a near-zero "Not completed" share) don't render clipped,
// overlapping text.
function stackedPctLabel(props) {
  const { x, y, width, height, value } = props;
  if (value == null || width < 26) return null;
  return (
    <text x={x + width / 2} y={y + height / 2} dy={4} textAnchor="middle" fontSize={10.5} fontWeight={700} fill={C.ink}>
      {fmtPct(value)}
    </text>
  );
}

// Checkbox-popover multi-select -- e.g. "3 venues selected" -- for filters
// where the user needs to pick several specific values (venue/district) at
// once rather than one at a time via a native <select>. Closes on an
// outside click, same convention as the drill panel's Escape/backdrop close.
function MultiSelectDropdown({ label, options, selected, onChange, width = 160 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const toggle = (v) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const summary = selected.length === 0 ? `All ${label.toLowerCase()}` : selected.length === 1 ? selected[0] : `${selected.length} ${label.toLowerCase()} selected`;

  return (
    <div ref={ref} style={{ position: "relative", minWidth: width }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", textAlign: "left", fontSize: 12, padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 5, background: C.white, color: selected.length ? C.ink : C.muted, cursor: "pointer", display: "flex", justifyContent: "space-between", gap: 6 }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</span>
        <span style={{ color: C.muted }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: C.white, border: `1px solid ${C.line}`, borderRadius: 5, boxShadow: "0 4px 14px rgba(0,0,0,.14)", zIndex: 45, maxHeight: 240, overflowY: "auto", minWidth: Math.max(width, 200) }}>
          {selected.length > 0 && (
            <div onClick={() => onChange([])} style={{ padding: "7px 10px", fontSize: 11.5, color: C.teal, fontWeight: 700, cursor: "pointer", borderBottom: `1px solid ${C.line}` }}>Clear</div>
          )}
          {options.length === 0 && <div style={{ padding: "8px 10px", fontSize: 12, color: C.muted }}>No options</div>}
          {options.map((opt) => (
            <label key={opt} style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 10px", fontSize: 12.5, cursor: "pointer" }}>
              <input type="checkbox" checked={selected.includes(opt)} onChange={() => toggle(opt)} />
              {opt}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// Query-string suffix for the milestones fetch's own date-range filter --
// separate from buildParams(filters), which only knows district/gender/
// cohort (the global filter bar's fields) and shouldn't grow a
// Milestones-specific concept every other tab's fetch would then also carry.
function withMilestoneDateRange(filters, startDate, endDate) {
  const base = buildParams(filters);
  const extra = [];
  if (startDate) extra.push(`start_date=${encodeURIComponent(startDate)}`);
  if (endDate) extra.push(`end_date=${encodeURIComponent(endDate)}`);
  if (!extra.length) return base;
  return base ? `${base}&${extra.join("&")}` : `?${extra.join("&")}`;
}

function MilestonesTab({ filters }) {
  const drill = useDrill();
  const [venueSearch, setVenueSearch] = useState("");
  const [selectedVenues, setSelectedVenues] = useState([]);
  const [selectedDistricts, setSelectedDistricts] = useState([]);
  const [selectedWeeks, setSelectedWeeks] = useState([]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [venueWeekPage, setVenueWeekPage] = useState(0);

  const { data, loading, error } = useApi(`/api/implementation/milestones${withMilestoneDateRange(filters, startDate, endDate)}`);
  const weekly = data?.weekly || [];
  const byVenue = data?.by_venue || [];

  const latest = weekly[weekly.length - 1];
  const prior = weekly.length > 1 ? weekly[weekly.length - 2] : null;
  const weekOverWeek = latest && prior && latest.exceed_pct != null && prior.exceed_pct != null
    ? Math.round((latest.exceed_pct - prior.exceed_pct) * 10) / 10
    : null;
  const peakWeek = weekly.reduce((best, w) => (w.exceed_pct != null && (best == null || w.exceed_pct > best.exceed_pct) ? w : best), null);
  const youthTracked = weekly[0]?.total_youth ?? null;

  // Free-text search matches venue name, district, or week (e.g. "bugiri",
  // "kirongo", or "week 2"/"2"); the Venues/Districts/Weeks multi-selects
  // narrow further on top of it (AND, not OR) -- all four combine to scope
  // the district rollup, Venue x Week, and the drills opened from either,
  // same "one filter panel scopes everything on the page" convention as
  // Awareness Overview/Mobilisers.
  const q = venueSearch.trim().toLowerCase();
  const matchesText = (venue, district, weekNumber) => {
    if (!q) return true;
    if ((venue || "").toLowerCase().includes(q)) return true;
    if ((district || "").toLowerCase().includes(q)) return true;
    if (weekNumber != null && (`week ${weekNumber}` === q || `week${weekNumber}` === q || String(weekNumber) === q)) return true;
    return false;
  };
  const matchesVenueDistrict = (venue, district) =>
    (selectedVenues.length === 0 || selectedVenues.includes(venue)) &&
    (selectedDistricts.length === 0 || selectedDistricts.includes(district));

  const venueOptions = distinctValues(byVenue, "venue");
  const districtOptions = distinctValues(byVenue, "district");

  const matchedVenues = byVenue.filter((v) => matchesText(v.venue, v.district, null) && matchesVenueDistrict(v.venue, v.district));

  // Single-week grain (unlike byVenue's cumulative-across-weeks rollup) —
  // feeds the District x Week / Venue x Week matrices and the week-over-week
  // variance drill. Districts aren't venues, so the search/multi-selects
  // only narrow the venue-week grain, same as matchedVenues above; the week
  // multi-select only applies here (by_venue is already summed across every
  // week, so there's no single week_number to filter on).
  const districtWeekRows = data?.by_district_week || [];
  const weekOptions = weekNumbersIn(data?.by_venue_week || []);
  const matchedVenueWeek = (data?.by_venue_week || []).filter((v) =>
    matchesText(v.venue, v.district, v.week_number) &&
    matchesVenueDistrict(v.venue, v.district) &&
    (selectedWeeks.length === 0 || selectedWeeks.includes(v.week_number))
  );
  const districtNames = distinctValues(districtWeekRows, "district");

  // Cohort x week -- deliberately NOT scoped by the venue search (cohorts
  // aren't venues) and ignores the page's own cohort filter server-side (see
  // _milestones_where's include_cohort=False), so every cohort with data in
  // this table shows up side by side regardless of which one is selected.
  const cohortWeekRows = data?.by_cohort_week || [];
  const cohortPivot = pivotByWeek(cohortWeekRows, "cohort");
  const cohortTrends = cohortQualityTrend(cohortWeekRows);
  const cohortComparisonRows = cohortPivot.map((r) => ({ ...r, trend: cohortTrends.find((t) => t.cohort === r.cohort)?.trend ?? null }));

  // Venue x Week is paginated 10 venues at a time (one row per venue, not
  // per venue-week) rather than a scroll-all-rows container, so pivot first
  // then page the pivoted, one-row-per-venue result.
  const pivotedVenueWeek = pivotByWeek(matchedVenueWeek, "venue", ["district"]);
  const venueWeekPageSize = 5;
  const venueWeekMaxPage = Math.max(0, Math.ceil(pivotedVenueWeek.length / venueWeekPageSize) - 1);
  const venueWeekPageClamped = Math.min(venueWeekPage, venueWeekMaxPage);
  const pagedVenueWeekRows = pivotedVenueWeek.slice(venueWeekPageClamped * venueWeekPageSize, venueWeekPageClamped * venueWeekPageSize + venueWeekPageSize);

  const venuesRanked = [...matchedVenues].filter((v) => v.exceed_pct != null).sort((a, b) => b.exceed_pct - a.exceed_pct);
  const top5 = venuesRanked.slice(0, 5);
  const bottom5 = venuesRanked.slice(-5).reverse();
  const spread = top5[0] && bottom5[0] ? Math.round((top5[0].exceed_pct - bottom5[0].exceed_pct) * 10) / 10 : null;

  // The 3 lowest-exceeding venues, flagged as a coaching-priority list
  // distinct from the top/bottom-5 read below — no per-venue "below
  // expectations" figure exists on its own, so lowest-%-exceeding is the
  // closest real proxy for that risk, same read as the reference design.
  const riskVenues = [...venuesRanked].sort((a, b) => (a.exceed_pct ?? 0) - (b.exceed_pct ?? 0)).slice(0, 3);

  // District skew across the top/bottom 5 — mirrors the reference design's
  // "the bottom skews Bugweri" read, but computed from whatever the live
  // ranking actually shows rather than a hardcoded district name.
  const districtTally = {};
  top5.forEach((v) => { const d = districtTally[v.district] || (districtTally[v.district] = { top: 0, bottom: 0 }); d.top += 1; });
  bottom5.forEach((v) => { const d = districtTally[v.district] || (districtTally[v.district] = { top: 0, bottom: 0 }); d.bottom += 1; });
  const worstDistrict = Object.entries(districtTally).sort((a, b) => b[1].bottom - a[1].bottom)[0];

  const bottom5AvgCompletion = bottom5.length ? Math.round((10 * sumBy(bottom5, "completion_pct")) / bottom5.length) / 10 : null;

  // Climb-then-reverse narrative — same read as the reference design's "Wk1
  // 35% -> Wk3 59% -> Wk4 26%", but built off whichever week actually peaks
  // and whichever week is latest, not a hardcoded "Week 3"/"Week 4".
  const firstWeek = weekly[0];
  const climbed = firstWeek && peakWeek && peakWeek !== firstWeek && peakWeek.exceed_pct != null && firstWeek.exceed_pct != null
    ? Math.round((peakWeek.exceed_pct - firstWeek.exceed_pct) * 10) / 10
    : null;

  // Weekly Overall Performance chart data -- adds not_completed_pct (the
  // complement of completion_pct) so the four stacked segments (Not
  // Completed / Below / Meet / Exceed) always sum to 100%.
  const weeklyChart = weekly.map((w) => ({
    ...w,
    not_completed_pct: w.completion_pct != null ? Math.round((100 - w.completion_pct) * 10) / 10 : null,
  }));

  // First reported week vs latest -- "does quality improve or drop by week"
  // read for the insight under the Weekly Overall Performance chart (a
  // straight endpoints comparison, distinct from `climbed`'s peak-vs-first
  // read used in the story section further down).
  const overallQualityTrend = firstWeek && latest && firstWeek !== latest && firstWeek.exceed_pct != null && latest.exceed_pct != null
    ? Math.round((latest.exceed_pct - firstWeek.exceed_pct) * 10) / 10
    : null;

  // District rollup off the search/filter-matched venues — feeds the
  // District x Week header drill's root (peer ranking across districts).
  const districtRollup = milestoneDistrictRollup(matchedVenues).sort((a, b) => (b.avg_exceed_pct ?? -1) - (a.avg_exceed_pct ?? -1));

  // Click a week's bar in the Weekly Overall Performance chart -> pick a
  // grain (District / Venue / Gender), then see that week's completion &
  // quality broken down that way. Root rows carry no metrics of their own
  // (just the grain picker) -- shared `columns` with the child level means
  // they render as "—", same tradeoff as the comparison drills' root-level
  // delta columns below.
  function openWeekBreakdownDrill(weekNumber) {
    const toRows = (rows, nameKey) => rows
      .filter((r) => r.week_number === weekNumber)
      .map((r) => ({ name: r[nameKey], completion_pct: r.completion_pct, exceed_pct: r.exceed_pct, meet_pct: r.meet_pct, below_pct: r.below_pct }))
      .sort((a, b) => (b.exceed_pct ?? -1) - (a.exceed_pct ?? -1));
    const byGrain = {
      District: toRows(districtWeekRows, "district"),
      Venue: toRows(data?.by_venue_week || [], "venue"),
      Gender: toRows(data?.by_gender_week || [], "gender"),
    };
    drill.open({
      title: `Week ${weekNumber} — completion & quality`,
      tone: "real", tagLabel: "REAL",
      rootKey: "grain", rootLabel: "Breakdown",
      columns: [
        { key: "completion_pct", label: "% Completed", align: "right", render: fmtPct },
        { key: "exceed_pct", label: "% Exceeds", align: "right", render: (v) => <span style={{ color: milestoneColor(v), fontWeight: 700 }}>{fmtPct(v)}</span> },
        { key: "meet_pct", label: "% Meets", align: "right", render: fmtPct },
        { key: "below_pct", label: "% Below", align: "right", render: (v) => <span style={{ color: v <= 5 ? C.green : v <= 10 ? C.gold : C.coral, fontWeight: 700 }}>{fmtPct(v)}</span> },
      ],
      rootRows: [{ grain: "District" }, { grain: "Venue" }, { grain: "Gender" }],
      childKey: "name", childLabel: "Group",
      getChildRows: (root) => byGrain[root.grain] || [],
    });
  }

  // Row click on the District x Week / Venue x Week matrices -> how does
  // this one compare with its peers (root, ranked by % exceeding), then
  // drill into it for its own week-over-week variance (child) -- "is it
  // improving or not". Two asks, one drill: peer comparison is the first
  // thing shown (matches "click a venue -> see how it compares"), its own
  // trend is one click deeper (matches "a table of variances between
  // weeks"). Root rows carry no delta (that's a week-over-week concept, not
  // a cross-entity one) -- renderMilestoneDelta shows "—" for null.
  function openDistrictComparisonDrill() {
    const rootRows = districtRollup
      .map((d) => ({ district: d.district, completion_pct: d.avg_completion_pct, exceed_pct: d.avg_exceed_pct, completion_delta: null, exceed_delta: null }))
      .sort((a, b) => (b.exceed_pct ?? -1) - (a.exceed_pct ?? -1));
    drill.open({
      title: "District comparison — completion & quality",
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [
        { key: "completion_pct", label: "% Completed", align: "right", render: fmtPct },
        { key: "exceed_pct", label: "% Exceeds", align: "right", render: (v) => <span style={{ color: milestoneColor(v), fontWeight: 700 }}>{fmtPct(v)}</span> },
        { key: "completion_delta", label: "Δ Completion (wk/wk)", align: "right", render: renderMilestoneDelta },
        { key: "exceed_delta", label: "Δ Quality (wk/wk)", align: "right", render: renderMilestoneDelta },
      ],
      rootRows,
      childKey: "week", childLabel: "Week",
      getChildRows: (root) => weekVariance(districtWeekRows, "district", root.district),
    });
  }

  function openVenueComparisonDrill() {
    const rootRows = venuesRanked.map((v) => ({ venue: v.venue, completion_pct: v.completion_pct, exceed_pct: v.exceed_pct, completion_delta: null, exceed_delta: null }));
    drill.open({
      title: "Venue comparison — completion & quality",
      tone: "real", tagLabel: "REAL",
      rootKey: "venue", rootLabel: "Venue",
      columns: [
        { key: "completion_pct", label: "% Completed", align: "right", render: fmtPct },
        { key: "exceed_pct", label: "% Exceeds", align: "right", render: (v) => <span style={{ color: milestoneColor(v), fontWeight: 700 }}>{fmtPct(v)}</span> },
        { key: "completion_delta", label: "Δ Completion (wk/wk)", align: "right", render: renderMilestoneDelta },
        { key: "exceed_delta", label: "Δ Quality (wk/wk)", align: "right", render: renderMilestoneDelta },
      ],
      rootRows,
      childKey: "week", childLabel: "Week",
      getChildRows: (root) => weekVariance(matchedVenueWeek, "venue", root.venue),
    });
  }

  return (
    <div>
      {!loading && !error && weekly.length === 0 && (
        <div style={{ marginBottom: 18 }}>
          <Insight tone="neutral">
            <b>No milestone reports for this filter.</b> The live business-plan-report table only has BOOTCAMP_3, BOOTCAMP_4, and MINI_BOOTCAMP_3 data so far — no BOOTCAMP_5 rows yet. {filters.cohort ? `Switch the cohort filter off "${filters.cohort}"` : "Try narrowing the cohort filter"} to see it.
          </Insight>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
        <input
          type="text"
          value={venueSearch}
          onChange={(e) => setVenueSearch(e.target.value)}
          placeholder="Search venue, district, or week…"
          style={{ flex: "1 1 240px", fontSize: 12, padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 5 }}
        />
        <MultiSelectDropdown label="Venues" options={venueOptions} selected={selectedVenues} onChange={setSelectedVenues} />
        <MultiSelectDropdown label="Districts" options={districtOptions} selected={selectedDistricts} onChange={setSelectedDistricts} />
        <MultiSelectDropdown
          label="Weeks"
          options={weekOptions.map((w) => `Week ${w}`)}
          selected={selectedWeeks.map((w) => `Week ${w}`)}
          onChange={(vals) => setSelectedWeeks(vals.map((v) => Number(v.replace("Week ", ""))))}
          width={130}
        />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: C.muted, fontWeight: 700, textTransform: "uppercase" }}>Report date range</span>
        <input type="date" value={startDate} max={endDate || undefined} onChange={(e) => setStartDate(e.target.value)} style={{ fontSize: 12, padding: "6px 8px", border: `1px solid ${C.line}`, borderRadius: 5, color: C.text }} />
        <span style={{ fontSize: 11, color: C.muted }}>to</span>
        <input type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} style={{ fontSize: 12, padding: "6px 8px", border: `1px solid ${C.line}`, borderRadius: 5, color: C.text }} />
        {(startDate || endDate) && (
          <button onClick={() => { setStartDate(""); setEndDate(""); }} style={PAGER_BTN}>Clear dates</button>
        )}
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 14 }}>
        Narrows the district rollup, Venue × Week, and the drills opened from either. The date range refetches by each report's own submission date, not the week it was captured for.
      </div>

      <Grid cols={5}>
        <KpiTile label="Youth tracked" value={fmtNum(youthTracked)} sub={firstWeek ? `Week ${firstWeek.week_number}, this filter` : undefined} tag="REAL" tone="real" />
        <KpiTile label="Weeks reported" value={String(weekly.length)} sub="Friday milestone captures, this cohort" tag="REAL" tone="real" />
        <KpiTile label="Latest completion" value={fmtPct(latest?.completion_pct)} sub={latest ? `Week ${latest.week_number}` : undefined} tag="REAL" tone="real" />
        <KpiTile label="Peak quality week" value={peakWeek ? `Week ${peakWeek.week_number}` : "—"} sub={peakWeek ? `${fmtPct(peakWeek.exceed_pct)} exceeding expectations` : undefined} tag="REAL" tone="real" />
        <KpiTile
          label="Latest vs prior week"
          value={weekOverWeek == null ? "—" : <span style={{ color: weekOverWeek >= 0 ? C.green : C.coral }}>{weekOverWeek > 0 ? "+" : ""}{weekOverWeek}pp</span>}
          sub="share exceeding expectations, week-on-week"
          tag="REAL" tone="real"
        />
      </Grid>

      <ExecBand num="◆" title="Cohort comparison" />
      <Card
        title="Cohort comparison — quality by week"
        subtitle={`% meeting and % exceeding expectations, every week reported, side by side across cohorts — regardless of the cohort filter above, so the "does quality rise or fall" read isn't collapsed to a single cohort. "${MILESTONE_METRIC_LABEL.exceed_pct}" trend column compares each cohort's first reported week to its latest.`}
        chip="REAL"
      >
        <State loading={loading} error={error} empty={!loading && cohortComparisonRows.length === 0}>
          <GroupedDataTable
            leading={[{ key: "cohort", label: "Cohort" }]}
            groups={weekColumnGroupsMeetExceed(weekNumbersIn(cohortWeekRows))}
            trailing={[{ key: "trend", label: "Δ Quality (1st→latest wk)", align: "right", render: renderMilestoneDelta }]}
            rows={cohortComparisonRows}
          />
        </State>
      </Card>

      <Card
        title="District × Week"
        subtitle="Every week, side by side across districts — activated, completed, and the below/meets/exceeds split, each week's own denominator (not cumulative). Click a district's header to see how it compares with the others, then drill into its own week-over-week change."
        chip="REAL"
      >
        <State loading={loading} error={error} empty={!loading && districtWeekRows.length === 0}>
          <GroupedDataTable
            leading={[{ key: "week_number", label: "Week", render: (v) => `Week ${v}` }]}
            groups={entityColumnGroups(districtNames, () => openDistrictComparisonDrill())}
            rows={pivotWeeksByEntity(districtWeekRows, "district")}
          />
        </State>
      </Card>

      <Card
        title="Weekly Overall Performance"
        subtitle="Every week's completion and quality split, all youth reported that week. Click a bar to drill into that week by district, venue, or gender."
        chip="REAL"
      >
        <State loading={loading} error={error} empty={!loading && weekly.length === 0}>
          <ResponsiveContainer width="100%" height={Math.max(180, weeklyChart.length * 70)}>
            <BarChart data={weeklyChart} layout="vertical" margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="week_number" tickFormatter={(v) => `Week ${v}`} tick={{ fontSize: 12 }} width={70} />
              <Tooltip formatter={(v, name) => [fmtPct(v), name]} labelFormatter={(v) => `Week ${v}`} />
              <Legend />
              <Bar dataKey="not_completed_pct" name="Not Completed" stackId="w" fill={C.muted} cursor="pointer" onClick={(_, i) => openWeekBreakdownDrill(weeklyChart[i].week_number)}>
                <LabelList dataKey="not_completed_pct" content={stackedPctLabel} />
              </Bar>
              <Bar dataKey="below_pct" name="Below" stackId="w" fill={C.coral} cursor="pointer" onClick={(_, i) => openWeekBreakdownDrill(weeklyChart[i].week_number)}>
                <LabelList dataKey="below_pct" content={stackedPctLabel} />
              </Bar>
              <Bar dataKey="meet_pct" name="Meets" stackId="w" fill={C.gold} cursor="pointer" onClick={(_, i) => openWeekBreakdownDrill(weeklyChart[i].week_number)}>
                <LabelList dataKey="meet_pct" content={stackedPctLabel} />
              </Bar>
              <Bar dataKey="exceed_pct" name="Exceeds" stackId="w" fill={C.green} radius={[0, 4, 4, 0]} cursor="pointer" onClick={(_, i) => openWeekBreakdownDrill(weeklyChart[i].week_number)}>
                <LabelList dataKey="exceed_pct" content={stackedPctLabel} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          {overallQualityTrend != null && (
            <div style={{ marginTop: 10 }}>
              <Insight tone={overallQualityTrend > 0 ? "pos" : overallQualityTrend < 0 ? "risk" : "neutral"}>
                <b>{overallQualityTrend > 0 ? "Quality improves" : overallQualityTrend < 0 ? "Quality drops" : "Quality is flat"} across the {weekly.length} weeks reported.</b> Share exceeding expectations moves from {fmtPct(firstWeek.exceed_pct)} (Week {firstWeek.week_number}) to {fmtPct(latest.exceed_pct)} (Week {latest.week_number}) — a {overallQualityTrend > 0 ? "+" : ""}{overallQualityTrend}pp {overallQualityTrend >= 0 ? "improvement" : "decline"}{weekOverWeek != null && weekOverWeek < 0 && overallQualityTrend > 0 ? `, though the most recent week (Week ${latest.week_number}) dipped ${Math.abs(weekOverWeek)}pp from the week before` : ""}.
              </Insight>
            </div>
          )}

          <div style={{ overflowX: "auto", marginTop: 14 }}>
            <DataTable
              columns={[
                { key: "week_number", label: "Week", render: (v) => `Week ${v}` },
                { key: "total_youth", label: "Reported", align: "right", render: fmtNum },
                { key: "completed", label: "# Completed", align: "right", render: fmtNum },
                { key: "completion_pct", label: "% Completed", align: "right", render: fmtPct },
                { key: "below", label: "# Below", align: "right", render: fmtNum },
                { key: "below_pct", label: "% Below", align: "right", render: (v) => <span style={{ color: v <= 5 ? C.green : v <= 10 ? C.gold : C.coral, fontWeight: 700 }}>{fmtPct(v)}</span> },
                { key: "meet", label: "# Meet", align: "right", render: fmtNum },
                { key: "meet_pct", label: "% Meet", align: "right", render: fmtPct },
                { key: "exceed", label: "# Exceeds", align: "right", render: fmtNum },
                { key: "exceed_pct", label: "% Exceeds", align: "right", render: (v) => <span style={{ color: milestoneColor(v), fontWeight: 700 }}>{fmtPct(v)}</span> },
              ]}
              rows={weekly}
            />
          </div>
        </State>
      </Card>

      {riskVenues.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <Insight tone="warn">
            <b>{riskVenues.length} venues flagged for lowest pitch quality:</b> {riskVenues.map((v) => `${v.venue} (${v.district}, ${fmtPct(v.exceed_pct)} exceeding)`).join(", ")}. No per-venue "below expectations" figure alone is tracked — this flag uses each venue's lowest share exceeding expectations as the coaching-priority signal, so read it as a priority list rather than an exact below-expectations count.
          </Insight>
        </div>
      )}

      <Card
        title="Venue Performance — Weekly Milestone Completion and Quality"
        subtitle={`Activated and the below/meets/exceeds split, every week reported, side by side (each week's own denominator, not cumulative). ${venueWeekPageSize} venues per page. Click a venue to see how it compares with the others, then drill into its own week-over-week change.`}
        chip="REAL"
      >
        <State loading={loading} error={error} empty={!loading && matchedVenueWeek.length === 0}>
          <GroupedDataTable
            leading={[{
              key: "venue",
              label: "Venue",
              render: (v, r) => (
                <div>
                  <div>{v}</div>
                  <div style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>{r.district}</div>
                </div>
              ),
            }]}
            groups={weekColumnGroupsCompact(weekNumbersIn(matchedVenueWeek))}
            rows={pagedVenueWeekRows}
            onRowClick={() => openVenueComparisonDrill()}
            stickyLeading
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9, fontSize: 11, color: C.muted }}>
            <span>{pivotedVenueWeek.length === 0 ? "0" : venueWeekPageClamped * venueWeekPageSize + 1}–{Math.min(pivotedVenueWeek.length, venueWeekPageClamped * venueWeekPageSize + venueWeekPageSize)} of {pivotedVenueWeek.length} venues</span>
            <span style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setVenueWeekPage(Math.max(0, venueWeekPageClamped - 1))} disabled={venueWeekPageClamped === 0} style={{ ...PAGER_BTN, opacity: venueWeekPageClamped === 0 ? 0.5 : 1 }}>‹ Prev</button>
              <button onClick={() => setVenueWeekPage(Math.min(venueWeekMaxPage, venueWeekPageClamped + 1))} disabled={venueWeekPageClamped === venueWeekMaxPage} style={{ ...PAGER_BTN, opacity: venueWeekPageClamped === venueWeekMaxPage ? 0.5 : 1 }}>Next ›</button>
            </span>
          </div>
        </State>
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
        {spread != null && top5[0] && bottom5[0] && (
          <Insight tone="warn">
            <b>A {spread}pp spread on the identical milestone.</b> {top5[0].venue} leads at {fmtPct(top5[0].exceed_pct)} exceeding while {bottom5[0].venue} trails at {fmtPct(bottom5[0].exceed_pct)} — every venue runs the same curriculum, so the gap points to venue- and trainer-level execution, not the programme design. Peer-pairing and targeted coaching at the weakest venues should close this fastest.
          </Insight>
        )}
        {worstDistrict && worstDistrict[1].bottom >= 2 && (
          <Insight tone="neutral">
            <b>{worstDistrict[0]} skews the bottom.</b> {worstDistrict[1].bottom} of the 5 weakest venues are in {worstDistrict[0]}{worstDistrict[1].top ? `, while it also holds ${worstDistrict[1].top} of the top 5 — so it isn't a blanket district problem` : ""} — worth a focused coaching push there before the next milestone cycle.
          </Insight>
        )}
        {bottom5AvgCompletion != null && bottom5.length > 0 && (
          <Insight tone={bottom5AvgCompletion >= 85 ? "pos" : "neutral"}>
            <b>{bottom5AvgCompletion >= 85 ? "Weak pitch quality, not weak attendance." : "Completion is soft too at the bottom venues."}</b> The bottom-5 venues still average {fmtPct(bottom5AvgCompletion)} completion{bottom5AvgCompletion >= 85 ? " — youth turn up and finish; the gap is pitch quality, which coaching can lift directly." : " — attendance itself needs attention alongside pitch coaching."}
          </Insight>
        )}
      </div>

      <ExecBand num="!" title="The story" />
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
        {climbed != null && climbed > 0 && (
          <Insight tone="pos">
            <b>Youth get sharper every week — until they don't.</b> The share exceeding expectations climbs from <b>{fmtPct(firstWeek.exceed_pct)} (Week {firstWeek.week_number})</b> to <b>{fmtPct(peakWeek.exceed_pct)} (Week {peakWeek.week_number})</b> — the weekly milestone rhythm is doing exactly what it should.
          </Insight>
        )}
        {weekOverWeek != null && weekOverWeek < -10 && prior && latest && (
          <Insight tone="risk">
            <b>Then week {latest.week_number} reverses it.</b> Exceeding expectations falls to <b>{fmtPct(latest.exceed_pct)}</b>, down {Math.abs(weekOverWeek)}pp from week {prior.week_number}, even as completion holds at {fmtPct(latest.completion_pct)} — this is the moment to concentrate coaching, before graduation rather than after.
          </Insight>
        )}
      </div>
    </div>
  );
}

// Parental engagement lives on the same MILESTONES table as pitch quality
// (parent_engagement is captured alongside business_plan_score on the same
// weekly Friday record) but is its own Implementation tab rather than a
// section of Milestones — a separate stakeholder concern (parent buy-in,
// not pitch coaching), even though it shares a fetch.
function ParentalEngagementTab({ filters }) {
  const { data, loading, error } = useApi(`/api/implementation/milestones${buildParams(filters)}`);
  const weekly = data?.weekly || [];
  const parentVals = weekly.map((w) => w.parent_present_pct).filter((v) => v != null);
  const parentGapWide = parentVals.length >= 2 && (Math.max(...parentVals) - Math.min(...parentVals) > 40);
  const avgParentNoReportPct = weekly.length ? Math.round((10 * sumBy(weekly, "parent_no_report_pct")) / weekly.length) / 10 : null;

  return (
    <div>
      {!loading && !error && weekly.length === 0 && (
        <div style={{ marginBottom: 18 }}>
          <Insight tone="neutral">
            <b>No milestone reports for this filter.</b> The live business-plan-report table only has BOOTCAMP_3, BOOTCAMP_4, and MINI_BOOTCAMP_3 data so far — no BOOTCAMP_5 rows yet. {filters.cohort ? `Switch the cohort filter off "${filters.cohort}"` : "Try narrowing the cohort filter"} to see it.
          </Insight>
        </div>
      )}
      <Card
        title="Parents present, by week"
        subtitle="Number of parents recorded as present that Friday, against everyone who reported a pitch score that week. parent_engagement is unreported for a large share of rows in every cohort — shown as its own share below, not folded into 'absent'."
        chip="REAL"
      >
        <State loading={loading} error={error} empty={!loading && weekly.length === 0}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={weekly} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="week_number" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
              <Tooltip /><Legend />
              <Bar dataKey="parent_present_pct" name="Present %" radius={[4, 4, 0, 0]}>
                {weekly.map((w, i) => <Cell key={i} fill={(w.parent_present_pct ?? 0) < 10 ? "#D8CFB8" : C.gold} />)}
              </Bar>
              <Bar dataKey="parent_no_report_pct" name="Not reported %" fill={C.muted} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <div style={{ overflowX: "auto", marginTop: 14 }}>
            <DataTable
              columns={[
                { key: "week_number", label: "Week", render: (v) => `Week ${v}` },
                { key: "total_youth", label: "Reported that week", align: "right", render: fmtNum },
                { key: "parent_present", label: "# Parents present", align: "right", render: fmtNum },
                { key: "parent_present_pct", label: "% Present", align: "right", render: fmtPct },
                { key: "parent_no_report", label: "# Not reported", align: "right", render: fmtNum },
                { key: "parent_no_report_pct", label: "% Not reported", align: "right", render: fmtPct },
              ]}
              rows={weekly}
            />
          </div>
        </State>
      </Card>
      {parentGapWide && (
        <div style={{ marginTop: 14 }}>
          <Insight tone="warn">
            <b>Standardise the Friday capture.</b> Present-share swings from {fmtPct(Math.min(...parentVals))} to {fmtPct(Math.max(...parentVals))} week to week{avgParentNoReportPct != null ? `, while an average ${fmtPct(avgParentNoReportPct)} of youth each week have no parent-engagement answer recorded at all` : ""} — a real behavioural shift that large, that fast, is unlikely; whoever records this on Fridays needs a consistent process before the metric is trustworthy.
          </Insight>
        </div>
      )}
    </div>
  );
}

function NpsTab({ filters }) {
  const { data, loading, error } = useApi(`/api/implementation/youth-experience${buildParams(filters)}`);
  const rows = data?.weekly || [];
  return (
    <Card title="Youth experience (NPS)" subtitle={`Programme / Venue / Meals NPS by week — target ${data?.target ?? 50}+`} chip="SAMPLE" chipTone="sim">
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
            <XAxis dataKey="week_number" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip /><Legend />
            <Line type="monotone" dataKey="nps" stroke={C.teal} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </State>
    </Card>
  );
}

// ─── Field Operations tabs ───────────────────────────────────────────────────
function VenueTab({ filters }) {
  const { data, loading, error } = useApi(`/api/operations/venue${buildParams(filters)}`);
  const rows = data?.by_venue || [];
  return (
    <Card title="Venue compliance" subtitle="Reports filed, compliant, and rate" chip="SAMPLE" chipTone="sim">
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <DataTable
          columns={[
            { key: "district", label: "District" },
            { key: "venue", label: "Venue" },
            { key: "reports", label: "Reports", align: "right" },
            { key: "compliant", label: "Compliant", align: "right" },
            { key: "compliance_rate", label: "Rate", align: "right", render: (v) => fmtPct(v) },
          ]}
          rows={rows}
        />
      </State>
    </Card>
  );
}

function TransportTab({ filters }) {
  const { data, loading, error } = useApi(`/api/operations/transport${buildParams(filters)}`);
  const rows = data?.by_site || [];
  return (
    <Card title="Transport timeliness" subtitle="Per-site timeliness score (0–100)" chip="SAMPLE" chipTone="sim">
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
            <XAxis dataKey="venue" tick={{ fontSize: 11 }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="timeliness_score" fill={C.gold} radius={[4, 4, 0, 0]}>
              {rows.map((r, i) => <Cell key={i} fill={(r.timeliness_score ?? 0) >= 80 ? C.green : C.coral} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </State>
    </Card>
  );
}

// ─── Formatting helpers ─────────────────────────────────────────────────────────
function fmtPct(v) { return v == null ? "—" : `${v}%`; }
function fmtNum(v) { return v == null ? "—" : Number(v).toLocaleString(); }

// ─── Guide ────────────────────────────────────────────────────────────────────
// Static reference page — no live data, doesn't react to the global filter bar.
// Keep this in sync with NAV below when tabs are added/renamed/re-wired to live
// data (chip tone flips from "sim" to "real" the day a placeholder is wired up).
const GUIDE_PAGES = [
  { group: "Executive Summary", page: "Summary", tone: "real", navGroup: "es", navTab: "es-main",
    summary: "Full funnel, gender split, cohort comparison, OKRs.",
    what: "Registered → Interested → Eligible → Randomised → Reached → Confirmed → Verified → Acquired funnel; gender split vs the 60% female target; eligibility-barrier breakdown; cohort comparison (BC2–BC4); an editable OKR tracker (saved in your browser only)." },
  { group: "Recruitment", page: "Awareness", tone: "real", navGroup: "rec", navTab: "aware",
    summary: "Registered → interested → eligible by district/parish/mobiliser.",
    what: "4 sub-pages — Awareness Overview, Mobilisers, KYC / Youth Profile, Forecast. Registered → interested → eligible by district, parish and mobiliser; youth demographics; registration-pace forecast." },
  { group: "Recruitment", page: "Mobilisation", tone: "real", navGroup: "rec", navTab: "mob",
    summary: "Assigned → reached → confirmed, BC3 Control List vs Newly registered.",
    what: "6 sub-pages — Mobilisation Overview, Mobilisation Forecasts, Mobiliser Performance, Control Mobilisation Calls, Call Centre Insights, Quality Assurance Calls. Assigned → reached → confirmed, split BC3 Control List vs Newly registered pilot cycles; day×venue heat map; the randomised control arm; barriers youth raise on calls; identity/name verification on QA calls." },
  { group: "Recruitment", page: "Acquisition", tone: "real", navGroup: "rec", navTab: "acq",
    summary: "Verified → acquired by district; venue risk categories.",
    what: "2 sub-pages — Overview, Arrival & Verification. Verified → acquired by district; venue risk categories (Target Achieved / On Track / Low Risk / High Risk)." },
  { group: "Recruitment", page: "Mobilisers", tone: "sample", navGroup: "rec", navTab: "mobs",
    summary: "Leaderboard of reach/confirmed by mobiliser.",
    what: "Leaderboard of reach/confirmed by mobiliser. Still placeholder data — no live table yet carries both a named mobiliser and reach/confirm counts together." },
  { group: "Recruitment", page: "TAM Analysis", tone: "sample", navGroup: "rec", navTab: "tam",
    summary: "Parish-level predicted vs. actual market coverage.",
    what: "Parish-level predicted vs. actual market coverage. Still placeholder data." },
  { group: "Implementation", page: "Retention", tone: "real", navGroup: "impl", navTab: "ret",
    summary: "Acquired → activated → retained by venue vs targets.",
    what: "Acquired → activated → retained by venue, against activation/retention targets, plus the female share of retained youth. Venues below target are surfaced lowest-first." },
  { group: "Implementation", page: "Attendance", tone: "real", navGroup: "impl", navTab: "attendance",
    summary: "Daily present & net churn, plus per-venue attendance rate.",
    what: "Daily attendance and net churn (present minus newly absent), plus per-venue attendance rate (present ÷ activated, joined against the Retention tab's activation counts) with a district roll-up, a bottom-5-venues table, and district→venue drills. Per-lesson attendance-% still isn't available — that needs a table that isn't confirmed against live BigQuery." },
  { group: "Implementation", page: "Retention Calls", tone: "real", navGroup: "impl", navTab: "retcalls",
    summary: "Follow-up funnel for absent youth, searchable by venue.",
    what: "Daily follow-up funnel for absent youth: called → reached → promised to return → returned. Search by venue to filter every component on the page; click a legend item to hide/show that line; a 'sites with absences but no follow-up calls' scorecard flags call-center coverage gaps; every score card drills district → site. Reasons for absence aren't broken out yet — that column hasn't been confirmed against live BigQuery." },
  { group: "Implementation", page: "Trainer Quality", tone: "real", navGroup: "impl", navTab: "train",
    summary: "Per-lesson scores by teaching domain, filterable by cohort.",
    what: "Per-lesson classroom observation scores across the seven E! teaching domains, banded Exceeds / Meets / Below expectations on the 0–5 observation scale. Filter by cohort: All cohorts, BOOTCAMP_4 (2026-05-04–2026-05-29), BC5 TOT (certification phase, 2026-07-29–2026-08-16) or BOOTCAMP_5 (in-classroom delivery, 2026-08-17–2026-09-11). The cohort comparison card always spans every cohort with data; each view has a district→trainer drill. Trainer names are staff-only (PII)." },
  { group: "Implementation", page: "Youth Experience", tone: "sample", navGroup: "impl", navTab: "nps",
    summary: "Weekly NPS trend (Programme / Venue / Meals).",
    what: "Programme / Venue / Meals NPS weekly trend. Still placeholder data." },
  { group: "Implementation", page: "Parental Engagement", tone: "real", navGroup: "impl", navTab: "parental",
    summary: "Parents present by week, vs. an unreported share.",
    what: "Number of parents recorded as present each Friday, against every youth who reported a pitch score that week — and the share with no parent-engagement answer recorded at all, shown separately rather than folded into 'absent'. Shares the same live business-plan-report table as Milestones (BOOTCAMP_3/4 and MINI_BOOTCAMP_3 only, no BOOTCAMP_5 rows yet), but broken out as its own tab since it's a distinct stakeholder concern from pitch quality." },
  { group: "Product Design", page: "Milestones", tone: "real", navGroup: "product", navTab: "milestones",
    summary: "Weekly pitch quality, below/meets/exceeds, by venue.",
    what: "Weekly business-pitch milestone distribution (below / meets / exceeds expectations), completion rate, and a district rollup plus a full ranked venue list (cumulative % exceeding, drillable by district then venue). Backed by the live silver business-plan-report table — BOOTCAMP_3/4 and MINI_BOOTCAMP_3 only, no BOOTCAMP_5 rows yet. Parental engagement moved to its own Implementation tab." },
  { group: "Field Operations", page: "Venue", tone: "sample", navGroup: "fops", navTab: "venue",
    summary: "Compliance rate by venue.",
    what: "Compliance rate by venue. Still placeholder data." },
  { group: "Field Operations", page: "Transport", tone: "sample", navGroup: "fops", navTab: "transport",
    summary: "Per-site timeliness score.",
    what: "Per-site timeliness score. Still placeholder data." },
];

// Row-expands-in-place table for GUIDE_PAGES — keeps the page-by-page summary
// brief by default (one-line `summary`), click a row to drill into the full
// `what` description without leaving the Guide.
// navigate, when given, adds an "Open ›" link on the page name that jumps
// straight to that tab (matches the reference design's guideGo() cross-link)
// — a separate click target from the row itself, which toggles the
// description, via stopPropagation.
function GuidePageTable({ rows, navigate }) {
  const [openKey, setOpenKey] = useState(null);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {["Group", "Page", "What it shows", "Status"].map((h, i) => (
              <th key={h} style={{ textAlign: i === 3 ? "right" : "left", padding: "8px 10px", borderBottom: `2px solid ${C.line}`, color: C.muted, fontWeight: 600, textTransform: "uppercase", fontSize: 11 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = `${r.group}|${r.page}`;
            const open = openKey === key;
            return (
              <Fragment key={key}>
                <tr onClick={() => setOpenKey(open ? null : key)} style={{ cursor: "pointer" }}>
                  <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.line}`, color: C.text }}>{r.group}</td>
                  <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.line}`, color: C.text, fontWeight: 600 }}>
                    <span style={{ display: "inline-block", width: 14, color: C.muted }}>{open ? "▾" : "▸"}</span>{r.page}
                    {navigate && r.navGroup && (
                      <span
                        onClick={(e) => { e.stopPropagation(); navigate(r.navGroup, r.navTab); }}
                        style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: C.teal }}
                      >
                        Open ›
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px", borderBottom: `1px solid ${C.line}`, color: C.text }}>{r.summary}</td>
                  <td style={{ textAlign: "right", padding: "8px 10px", borderBottom: `1px solid ${C.line}` }}>
                    <Chip tone={r.tone === "real" ? "real" : "sim"}>{r.tone === "real" ? "LIVE" : "SAMPLE"}</Chip>
                  </td>
                </tr>
                {open && (
                  <tr>
                    <td colSpan={4} style={{ padding: "4px 10px 14px 32px", borderBottom: `1px solid ${C.line}`, color: C.muted, fontSize: 12.5, lineHeight: 1.5, background: C.cream }}>
                      {r.what}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GuideTab({ navigate }) {
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Dashboard Guide</h2>
      <p style={{ fontSize: 12.5, color: C.muted, marginBottom: 14, maxWidth: 720 }}>
        Start here — what this dashboard covers, and how to find your way around: filters,
        navigation, and what each data-status tag means. This page doesn't use live data and
        doesn't change with the filter bar above.
      </p>

      <ExecBand num="1" title="What's in this dashboard" />
      <Grid cols={4}>
        <KpiTile label="Guide" value="You are here" sub="No live data — a reference page." tone="pii" />
        <KpiTile label="Executive Summary" value="1 page" sub="The whole funnel at a glance, plus gender split and recommendations." onClick={navigate ? () => navigate("es", "es-main") : undefined} />
        <KpiTile label="Recruitment" value="5 pages" sub="Awareness, Mobilisation, Acquisition, Mobilisers, TAM Analysis." onClick={navigate ? () => navigate("rec") : undefined} />
        <KpiTile label="Implementation" value="6 pages" sub="Retention, Attendance, Retention Calls, Trainer Quality, Youth Experience, Parental Engagement." onClick={navigate ? () => navigate("impl") : undefined} />
        <KpiTile label="Product Design" value="1 page" sub="Milestones." onClick={navigate ? () => navigate("product") : undefined} />
        <KpiTile label="Field Operations" value="2 pages" sub="Venue, Transport." onClick={navigate ? () => navigate("fops") : undefined} />
      </Grid>

      <Card title="Page-by-page summary" subtitle="What each tab covers, grouped the same way as the tabs above — click a row to drill into the full description, or Open › to jump straight there.">
        <GuidePageTable rows={GUIDE_PAGES} navigate={navigate} />
      </Card>

      <ExecBand num="2" title="Key definitions" />
      <p style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>
        What each funnel stage means, precisely — the eligibility rule and the pass/fail bar for every
        stage from recruitment through graduation.
      </p>
      <Grid cols={2}>
        <Insight tone="neutral"><b>Awareness / Recruitment.</b> Youth recruited that are eligible per criteria: aged 18–30, P5–S3 education, income 0–30k UGX/2wks, no past E! training, expressed interest. Target: 70% female, 30% male.</Insight>
        <Insight tone="neutral"><b>Acquisition.</b> Youth who were verified AND signed the consent waiver by Day 2. Measured as the acquisition rate.</Insight>
        <Insight tone="neutral"><b>Randomisation.</b> Stratified random assignment of eligible youth to Treatment (active programme) or Control (comparison group).</Insight>
        <Insight tone="neutral"><b>Activation.</b> Youth who were acquired AND attended at least one lesson on Day 1 or Day 2.</Insight>
        <Insight tone="neutral"><b>Mobilisation — Confirmed.</b> Treatment youth who confirmed interest during the mobilisation call after hearing programme details.</Insight>
        <Insight tone="neutral"><b>Retention.</b> Youth who attended at least 80% of all scheduled sessions (≥20 out of 25 lessons). Target: 80% of activated.</Insight>
        <Insight tone="neutral"><b>Arrival — Verified.</b> Youth who showed up to the venue by Day 2 and completed identity verification.</Insight>
        <Insight tone="neutral"><b>Graduation.</b> Youth who attended 50% or more of sessions (≥13 out of 25 lessons). Threshold for programme certificate eligibility.</Insight>
        <Insight tone="neutral"><b>Karibu Day.</b> Day 2 of bootcamp — introduction day. Youth marked PRESENT on Karibu Day are those who attended the orientation session.</Insight>
      </Grid>

      <ExecBand num="3" title="Global filters — district, gender, cohort" />
      <div style={{ marginBottom: 20 }}>
        <Insight tone="neutral">
          The filter bar at the top of the screen is sticky — it stays visible as you scroll and switch
          pages. Set a district, gender and/or cohort there and <b>every page recalculates</b>, not just
          the one you're looking at. Use <b>Reset</b> to clear all three.
        </Insight>
      </div>

      <ExecBand num="4" title="Navigating the dashboard" />
      <div style={{ marginBottom: 20 }}>
        <Insight tone="neutral">
          Navigation has two levels. The <b>bold tabs</b> along the top (Executive Summary,
          Recruitment, Implementation, Product Design, Field Operations, Guide) switch between
          groups. Below them, a
          second row switches between the pages inside that group. Awareness, Mobilisation,
          Acquisition and Trainer Quality have a third level — a row of pill-shaped buttons just
          under the page title — click those to switch sub-pages without leaving the tab.
        </Insight>
      </div>

      <ExecBand num="5" title="Reading the data-status tags" />
      <p style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>
        Every card is tagged with where its numbers come from — never mix these up when reporting out:
      </p>
      <Card>
        <DataTable
          columns={[
            { key: "tag", label: "Tag", render: (_, r) => <Chip tone={r.chipTone}>{r.tag}</Chip> },
            { key: "meaning", label: "What it means" },
          ]}
          rows={[
            { tag: "REAL", chipTone: "real", meaning: "Queried directly from the live BigQuery feed." },
            { tag: "DERIVED", chipTone: "sim", meaning: "Calculated from real data using a stated formula (e.g. share-of-stage, cumulative attrition against Registered) — directionally sound, not a direct raw count." },
            { tag: "PII", chipTone: "pii", meaning: "Contains names or other personal data — shown to staff accounts only; guest sign-in sees initials, never a raw phone/ID." },
            { tag: "EDITABLE", chipTone: "sim", meaning: "Leader-entered, not from BigQuery at all (the OKR tracker) — saved only in your own browser." },
            { tag: "SAMPLE", chipTone: "sim", meaning: "That page's underlying BigQuery table isn't wired up yet — the numbers are illustrative placeholders, not real counts." },
          ]}
        />
      </Card>
      <div style={{ marginTop: 16 }}>
        <Insight tone="warn">
          A red <b>"Demo data"</b> banner across the whole dashboard (with a matching badge on every
          card) means something different from a per-card <b>SAMPLE</b> tag above: it means the BC5
          BigQuery feed itself is unreachable right now, so <i>every</i> panel — including the normally
          live ones — is temporarily showing illustrative dummy data. It clears automatically once the
          feed is reachable again.
        </Insight>
      </div>
    </div>
  );
}

// ─── Navigation model ─────────────────────────────────────────────────────────
const NAV = [
  { key: "guide", group: "Guide", tabs: [
    { key: "guide-main", label: "Guide", render: (_f, navigate) => <GuideTab navigate={navigate} /> },
  ]},
  { key: "es", group: "Executive Summary", tabs: [
    { key: "es-main", label: "Summary", render: (f) => <ExecutiveSummaryTab filters={f} /> },
  ]},
  { key: "rec", group: "Recruitment", tabs: [
    { key: "aware", label: "Awareness", render: (f) => <AwarenessTab filters={f} /> },
    { key: "mob", label: "Mobilisation", render: (f) => <MobilisationTab filters={f} /> },
    { key: "acq", label: "Acquisition", render: (f) => <AcquisitionTab filters={f} /> },
    { key: "mobs", label: "Mobilisers", render: (f) => <MobilisersTab filters={f} /> },
    { key: "tam", label: "TAM Analysis", render: (f) => <TamTab filters={f} /> },
  ]},
  { key: "impl", group: "Implementation", tabs: [
    { key: "ret", label: "Retention", render: (f) => <RetentionTab filters={f} /> },
    { key: "attendance", label: "Attendance", render: (f) => <AttendanceTab filters={f} /> },
    { key: "retcalls", label: "Retention Calls", render: (f) => <RetentionCallsTab filters={f} /> },
    { key: "train", label: "Trainer Quality", render: (f) => <TrainersTab filters={f} /> },
    { key: "nps", label: "Youth Experience", render: (f) => <NpsTab filters={f} /> },
    { key: "parental", label: "Parental Engagement", render: (f) => <ParentalEngagementTab filters={f} /> },
  ]},
  { key: "product", group: "Product Design", tabs: [
    { key: "milestones", label: "Milestones", render: (f) => <MilestonesTab filters={f} /> },
  ]},
  { key: "fops", group: "Field Operations", tabs: [
    { key: "venue", label: "Venue", render: (f) => <VenueTab filters={f} /> },
    { key: "transport", label: "Transport", render: (f) => <TransportTab filters={f} /> },
  ]},
];

// ─── Export report ────────────────────────────────────────────────────────────
// Builds a printable HTML report for whichever NAV tabs the user selects,
// with every district/parish/venue breakdown each tab exposes interactively —
// not just whatever happens to be clicked open — so the export always matches
// what a user could see by clicking all the way through the live dashboard.
// Runs entirely outside the React tree via apiGet()/fetchPerDistrict(Fields)(),
// reusing the exact same pure transforms (groupParishRowsByDistrict,
// groupByDistrict, categorizeRate, daysToTargetFor, ...) the interactive tabs
// use, so export numbers never drift from the live UI. No new npm dependency:
// the "PDF" is produced by opening a new tab and calling the browser's own
// print dialog (Save as PDF), per this project's inline-styles-only,
// minimal-dependency frontend convention.

function xCol(key, label, opts = {}) {
  return { key, label, align: opts.align ?? "right", format: opts.format ?? fmtNum };
}
function xTextCol(key, label) {
  return { key, label, align: "left", format: (v) => (v == null || v === "" ? "—" : String(v)) };
}
function xSection(heading, nameKey, nameLabel, columns, rows, note) {
  return { heading, nameKey, nameLabel, columns, rows: rows || [], note };
}

async function buildExecutiveSummaryExport(filters) {
  const q = buildParams(filters);
  const [funnel, stageProgress, gender, barriers, cohortComparison, filterMeta] = await Promise.all([
    apiGet(`/api/overview/funnel${q}`),
    apiGet(`/api/overview/stage-progress${q}`),
    apiGet(`/api/overview/gender${q}`),
    apiGet(`/api/overview/eligibility-barriers${q}`),
    apiGet(`/api/overview/cohort-comparison`),
    apiGet(`/api/filters`),
  ]);
  const stages = funnel.stages || [];
  const allDistricts = filterMeta.districts || [];
  const rateKeys = Object.keys(RATE_TARGETS);

  const [byDistrictRates, byDistrictStages] = await Promise.all([
    fetchPerDistrictFields("/api/overview/kpis", filters, allDistricts,
      Object.fromEntries(rateKeys.map((k) => [k, (json) => json?.rates?.[k] ?? null]))),
    stages.length
      ? fetchPerDistrictFields("/api/overview/funnel", filters, allDistricts,
          Object.fromEntries(stages.map((s) => [s.stage, (json) => (json?.stages || []).find((x) => x.stage === s.stage)?.count ?? null])))
      : Promise.resolve([]),
  ]);

  return {
    label: "Executive Summary",
    sections: [
      xSection("Conversion rates, by district", "district", "District",
        rateKeys.map((k) => xCol(k, `${RATE_TARGETS[k].label} rate`, { format: fmtPct })),
        byDistrictRates),
      xSection("Funnel stage counts, by district", "district", "District",
        stages.map((s) => xCol(s.stage, s.stage)),
        byDistrictStages),
      xSection("Progress on target, by stage", "stage", "Stage", [
        xCol("count", "Count"), xCol("target", "Target"), xCol("pct_of_target", "% of target", { format: fmtPct }),
      ], stageProgress.stages || []),
      xSection("Eligibility barriers", "barrier", "Barrier", [xCol("count", "Count")], barriers.barriers || []),
      xSection("Gender performance, by stage", "stage", "Stage", [
        xCol("female", "Female"), xCol("male", "Male"), xCol("pct_female", "% Female", { format: fmtPct }), xCol("target_female", "Target", { format: fmtPct }),
      ], gender.stages || []),
      xSection("Cohort comparison — Awareness", "cohort", "Cohort", [
        xCol("eligible", "Eligible"), xCol("eligibility_rate", "Eligibility rate", { format: fmtPct }),
        xCol("pct_female", "% Female", { format: fmtPct }), xCol("progress_pct", "Progress on target", { format: fmtPct }), xCol("parishes", "# Parishes"),
      ], cohortComparison.awareness || []),
      xSection("Cohort comparison — Mobilisation", "cohort", "Cohort", [
        xCol("assigned", "# Assigned"), xCol("reach_rate", "Reach rate", { format: fmtPct }),
        xCol("mobilisation_rate", "Mobilisation rate", { format: fmtPct }), xCol("progress_pct", "Progress on target", { format: fmtPct }), xCol("pct_female", "% Female", { format: fmtPct }),
      ], cohortComparison.mobilisation || []),
      xSection("Cohort comparison — Acquisition", "cohort", "Cohort", [
        xCol("acquired", "# Acquired"), xCol("acquisition_rate", "Acquisition rate", { format: fmtPct }),
        xCol("overall_conversion", "Overall conversion", { format: fmtPct }), xCol("progress_pct", "Progress on target", { format: fmtPct }), xCol("pct_female", "% Female", { format: fmtPct }),
      ], cohortComparison.acquisition || []),
    ],
  };
}

async function buildAwarenessExport(filters) {
  const q = buildParams(filters);
  const [parish, mobilisers, mobiliserDetail, kyc, eligTarget, forecast, filterMeta] = await Promise.all([
    apiGet(`/api/recruitment/awareness-parish${q}`),
    apiGet(`/api/recruitment/awareness-mobilisers${q}`),
    apiGet(`/api/recruitment/awareness-mobiliser-detail${q}`),
    apiGet(`/api/recruitment/awareness-kyc${q}`),
    apiGet(`/api/recruitment/awareness-eligible-target${q}`),
    apiGet(`/api/recruitment/awareness-forecast${q}`),
    apiGet(`/api/filters`),
  ]);
  const parishRows = parish.parishes || [];
  const districtRows = groupParishRowsByDistrict(parishRows);
  const demo = kyc.demographics || {};
  const allDistricts = filterMeta.districts || [];

  const personaKeys = ["pct_p5_p7", "pct_age_18_25", "pct_owns_phone", "pct_owns_business", "pct_female", "duplicate_rate"];
  const byDistrictPersona = await fetchPerDistrictFields("/api/recruitment/awareness-kyc", filters, allDistricts,
    Object.fromEntries(personaKeys.map((k) => [k, (json) => json?.demographics?.[k] ?? null])));

  const stageStats = [
    { key: "registered", label: "Reached" }, { key: "interested", label: "Interested" }, { key: "eligible", label: "Eligible" },
  ].map(({ key, label }) => {
    const prefix = GENDER_FIELD_PREFIX[key];
    const f = sumBy(parishRows, `${prefix}_female`);
    const m = sumBy(parishRows, `${prefix}_male`);
    const t = f + m;
    return { stage: label, female: f, male: m, pct_female: t ? Math.round((1000 * f) / t) / 10 : null };
  });

  // Target is an eligible-youth quota (AWARENESS_ELIGIBLE_TARGET_BC5, the
  // only target source now that Awareness is off the gold summary mart) —
  // matches awareness_forecast's by_district and AwarenessForecastPage's
  // parishRows.
  const nDays = forecast.n_days;
  const forecastByDistrict = (forecast.by_district || []);
  const forecastByParish = parishRows.map((p) => {
    const registered = p.reached || 0, eligible = p.eligible || 0;
    const target = p.target || 0, gap = Math.max(target - eligible, 0);
    const rate = nDays ? eligible / nDays : null;
    return {
      district: p.district, parish: p.parish, registered, eligible, target, gap,
      pct_of_target: target ? Math.round((1000 * eligible) / target) / 10 : null,
      days_to_target: rate ? Math.round(gap / rate) : null,
    };
  });

  return {
    label: "Awareness",
    sections: [
      xSection("District comparison", "district", "District", [
        xCol("registered", "Reached"), xCol("interested", "Interested"), xCol("eligible", "Eligible"),
        xCol("eligible_treatment", "Treatment"), xCol("eligible_control", "Control"),
        xCol("target", "Target"), xCol("pct_female", "% Female", { format: fmtPct }),
      ], districtRows),
      xSection("Parish detail", "parish", "Parish", [
        xTextCol("district", "District"), xCol("reached", "Reached"), xCol("interested", "Interested"),
        xCol("eligible", "Eligible"), xCol("eligible_female", "Eligible (F)"),
        xCol("eligible_treatment", "Treatment"), xCol("eligible_control", "Control"),
        xCol("target", "Target"), xCol("pct_female", "% Female", { format: fmtPct }),
      ], parishRows),
      xSection("Gender by funnel stage", "stage", "Stage", [
        xCol("female", "Female"), xCol("male", "Male"), xCol("pct_female", "% Female", { format: fmtPct }),
      ], stageStats),
      xSection("Eligible youth profile — program summary", "label", "Metric", [
        xCol("value", "Value", { format: (v) => (typeof v === "number" ? fmtPct(v) : (v ?? "—")) }),
      ], KYC_PERSONA_CARDS.map((c) => ({ label: c.label, value: demo[c.key] }))),
      xSection("Eligible youth profile, by district", "district", "District",
        personaKeys.map((k) => xCol(k, k, { format: fmtPct })), byDistrictPersona),
      xSection("New recruits — eligible vs target, by district", "district", "District", [
        xCol("actual", "Eligible"), xCol("target", "Target"), xCol("pct_of_target", "% of target", { format: fmtPct }),
      ], eligTarget.by_district || []),
      xSection("New recruits — eligible vs target, by parish", "parish", "Parish", [
        xTextCol("district", "District"), xCol("actual", "Eligible"), xCol("target", "Target"), xCol("pct_of_target", "% of target", { format: fmtPct }),
      ], eligTarget.by_parish || []),
      xSection("New recruits — target, by venue", "venue", "Venue", [
        xTextCol("district", "District"), xTextCol("parish", "Parish"), xCol("target", "Target"),
      ], eligTarget.by_venue || [], "Venue grain is target-only — no live per-venue actual exists at the eligibility stage."),
      xSection("What youth are currently doing", "activity", "Activity", [xCol("count", "Youth")], kyc.activity || []),
      xSection("Why youth are enrolling", "reason", "Reason", [xCol("count", "Youth")], kyc.reasons || []),
      xSection("Who youth consult for decisions", "consultant", "Consulted", [xCol("count", "Youth")], kyc.consultation || []),
      xSection("Support youth say they need", "support", "Support", [xCol("count", "Youth")], kyc.support_required || []),
      xSection("Parental relationship", "relationship", "Relationship", [xCol("count", "Youth")], kyc.parental_relationship || []),
      xSection("Business ownership, by gender & district", "district", "District", [
        xTextCol("gender", "Gender"), xCol("owners", "Owners"), xCol("total", "Eligible"), xCol("pct_owns_business", "% Owning", { format: fmtPct }),
      ], kyc.business?.by_gender_district || []),
      xSection("Recruitment channels", "channel", "Channel", [xCol("eligible", "Eligible"), xCol("ineligible", "Ineligible")], kyc.channels || []),
      xSection("Open questions raised before joining, by theme", "theme", "Theme", [
        xCol("count", "Youth"), xTextCol("example", "Representative example"),
      ], kyc.questions || []),
      xSection("Mobiliser performance", "mobiliser_name", "Mobiliser", [
        xTextCol("district", "District"), xCol("reached", "Reached"), xCol("eligible", "Eligible"), xCol("eligible_female", "Eligible (F)"),
      ], mobilisers.mobilisers || []),
      xSection("Mobiliser detail, by district", "mobiliser_name", "Mobiliser", [
        xTextCol("district", "District"), xCol("reached", "Reached"), xCol("eligible", "Eligible"), xCol("eligible_female", "Eligible (F)"),
      ], mobiliserDetail.detail || []),
      xSection("Daily registration trend", "event_date", "Date", [xCol("eligible", "Eligible")], forecast.daily || []),
      xSection("Days to target, by district", "district", "District", [
        xCol("registered", "Registered"), xCol("eligible", "Eligible"), xCol("target", "Target"), xCol("gap", "Gap"), xCol("days_to_target", "Days to target"), xCol("pct_of_target", "% of target", { format: fmtPct }),
      ], forecastByDistrict),
      xSection("Days to target, by parish", "parish", "Parish", [
        xTextCol("district", "District"), xCol("registered", "Registered"), xCol("eligible", "Eligible"), xCol("target", "Target"), xCol("gap", "Gap"), xCol("days_to_target", "Days to target"), xCol("pct_of_target", "% of target", { format: fmtPct }),
      ], forecastByParish),
    ],
  };
}

async function buildMobilisationExport(filters) {
  const q = buildParams(filters);
  const [mob, heatmap, forecast, controlCalls, callCentre, filterMeta] = await Promise.all([
    apiGet(`/api/recruitment/mobilisation${q}`),
    apiGet(`/api/recruitment/mobilisation-heatmap${q}`),
    apiGet(`/api/recruitment/mobilisation-forecast${q}`),
    apiGet(`/api/recruitment/control-calls`),
    apiGet(`/api/recruitment/call-centre-insights${q}`),
    apiGet(`/api/filters`),
  ]);
  const allDistricts = filterMeta.districts || [];
  const mobMetricKeys = ["assigned", "called", "reached", "reach_rate", "confirmed", "confirmed_female", "mobilisation_rate", "progress_pct"];
  const byDistrictMob = await fetchPerDistrictFields("/api/recruitment/mobilisation", filters, allDistricts,
    Object.fromEntries(mobMetricKeys.map((k) => [k, (json) => json?.[k] ?? null])));

  const nDays = (forecast.daily || []).length;
  const byDistrict = (heatmap.by_district || []).map((d) => {
    const assigned = d.assigned || 0, target = d.target || 0, reached = d.reached || 0, confirmed = d.confirmed || 0;
    return {
      district: d.district, assigned, target, reached, confirmed,
      reachRate: assigned ? Math.round((1000 * reached) / assigned) / 10 : null,
      mobilisationRate: reached ? Math.round((1000 * confirmed) / reached) / 10 : null,
      pctFemale: confirmed ? Math.round((1000 * (d.confirmed_female || 0)) / confirmed) / 10 : null,
      progressPct: target ? Math.round((1000 * confirmed) / target) / 10 : null,
      daysToTarget: daysToTargetFor(confirmed, target, nDays),
    };
  });
  const byParish = (heatmap.by_parish || []).map((p) => {
    const assigned = p.assigned || 0, target = p.target || 0, reached = p.reached || 0, confirmed = p.confirmed || 0;
    return {
      district: p.district, parish: p.parish, assigned, target, reached, confirmed,
      reachRate: assigned ? Math.round((1000 * reached) / assigned) / 10 : null,
      mobilisationRate: reached ? Math.round((1000 * confirmed) / reached) / 10 : null,
      pctFemale: confirmed ? Math.round((1000 * (p.confirmed_female || 0)) / confirmed) / 10 : null,
      progressPct: target ? Math.round((1000 * confirmed) / target) / 10 : null,
    };
  });
  const byVenue = (heatmap.by_venue || []).map((v) => {
    const reached = v.reached || 0, confirmed = v.confirmed || 0, target = v.target ?? null;
    return {
      district: v.district, venue: v.venue, reached, confirmed, target,
      rate: reached ? Math.round((1000 * confirmed) / reached) / 10 : null,
      pctFemale: confirmed ? Math.round((1000 * (v.confirmed_female || 0)) / confirmed) / 10 : null,
      progressPct: target ? Math.round((1000 * confirmed) / target) / 10 : null,
      daysToTarget: daysToTargetFor(confirmed, target, nDays),
    };
  }).sort((a, b) => b.confirmed - a.confirmed);

  return {
    label: "Mobilisation",
    sections: [
      xSection("Mobilisation KPIs, by district", "district", "District",
        mobMetricKeys.map((k) => xCol(k, k, { format: k.includes("rate") || k === "progress_pct" ? fmtPct : fmtNum })), byDistrictMob),
      xSection("BC3 Control List vs Newly registered", "label", "Cycle", [
        xCol("assigned", "Assigned"), xCol("reached", "Reached"), xCol("confirmed", "Confirmed"),
        xCol("reach_rate", "Reach rate", { format: fmtPct }), xCol("mobilisation_rate", "Mobilisation rate", { format: fmtPct }), xCol("pct_female", "% Female", { format: fmtPct }),
      ], [
        { label: "BC3 Control List", ...mob.four_week },
        { label: "Newly registered", ...mob.two_half_week },
      ], "Deliberately not blended into one row — see \"Combined progress\" below for the two pathways added together."),
      ...(mob.combined ? [
        xSection("Combined progress — call-center + auto-confirm", "label", "Component", [
          xCol("value", "Value"),
        ], [
          { label: "Auto-confirmed (awareness)", value: mob.combined.auto_confirmed },
          { label: "Confirmed (call-center)", value: mob.combined.call_centre_confirmed },
          { label: "Total so far", value: mob.combined.total_so_far },
          { label: "Mobilisation target (acquisition)", value: mob.combined.mobilisation_target },
          { label: "Eligible target (awareness)", value: mob.combined.eligible_target },
          { label: "Combined target", value: mob.combined.target },
          { label: "Progress on combined target (%)", value: mob.combined.progress_pct },
          { label: "Treatment target (RCT split)", value: mob.combined.treatment_target },
          { label: "Control target (RCT split)", value: mob.combined.control_target },
        ]),
      ] : []),
      xSection("District performance vs target", "district", "District", [
        xCol("assigned", "Assigned"), xCol("target", "Target"), xCol("reached", "Reached"), xCol("confirmed", "Confirmed"),
        xCol("reachRate", "Reach rate", { format: fmtPct }), xCol("mobilisationRate", "Mobilisation rate", { format: fmtPct }),
        xCol("pctFemale", "% Female", { format: fmtPct }), xCol("progressPct", "Progress on target", { format: fmtPct }), xCol("daysToTarget", "Days to target"),
      ], byDistrict),
      xSection("Parish performance vs target", "parish", "Parish", [
        xTextCol("district", "District"), xCol("assigned", "Assigned"), xCol("target", "Target"), xCol("reached", "Reached"), xCol("confirmed", "Confirmed"),
        xCol("reachRate", "Reach rate", { format: fmtPct }), xCol("mobilisationRate", "Mobilisation rate", { format: fmtPct }),
        xCol("pctFemale", "% Female", { format: fmtPct }), xCol("progressPct", "Progress on target", { format: fmtPct }),
      ], byParish, "Assigned/target and reached/confirmed come from data sources that don't share districts live for every parish — a parish can show 0 on one side and real numbers on the other."),
      xSection("Venue performance", "venue", "Venue", [
        xTextCol("district", "District"), xCol("target", "Target"), xCol("reached", "Reached"), xCol("confirmed", "Confirmed"),
        xCol("rate", "Confirmed ÷ reached", { format: fmtPct }), xCol("pctFemale", "% Female", { format: fmtPct }),
        xCol("progressPct", "Progress on target", { format: fmtPct }), xCol("daysToTarget", "Days to target"),
      ], byVenue),
      xSection("Daily trend — reached vs confirmed", "event_date", "Date", [xCol("reached", "Reached"), xCol("confirmed", "Confirmed")], forecast.daily || []),
      xSection("Control arm — call status", "status", "Status", [xCol("n", "# Youth")], controlCalls.by_status || []),
      xSection("Control arm — district composition", "district", "District", [xCol("n", "# Youth")], controlCalls.by_district || []),
      xSection("Call centre — call outcomes", "status", "Status", [xCol("count", "# Calls"), xCol("pct", "% of calls", { format: fmtPct })], callCentre.call_outcomes || []),
      xSection("Call centre — gatekeepers (decision-maker on the call)", "who", "Who", [xCol("count", "# Calls"), xCol("pct", "% of captured", { format: fmtPct })], callCentre.gatekeepers?.breakdown || [],
        `Gatekeeper rate: ${fmtPct(callCentre.gatekeepers?.gatekeeper_rate)} of ${fmtNum(callCentre.gatekeepers?.n_with_decision)} calls with a captured decision-maker.`),
      xSection("Call centre — gatekeeper relationship (proxy contact reached)", "who", "Relationship", [xCol("count", "# Calls"), xCol("pct", "% of captured", { format: fmtPct })], callCentre.gatekeepers?.relationship?.breakdown || []),
      xSection("Call centre — gatekeeper interactions, by theme", "theme", "Theme", [xCol("count", "#"), xCol("pct", "%", { format: fmtPct })], callCentre.gatekeepers?.interactions?.themes || []),
      xSection("Call centre — gatekeeper interactions, verbatim", "quote", "Quote", [], (callCentre.gatekeepers?.interactions?.quotes || []).map((q) => ({ quote: q }))),
      xSection(`Call centre — decline reasons, "No" (n=${callCentre.decline_reasons_no?.n || 0})`, "category", "Reason", [xCol("count", "#"), xCol("pct", "%", { format: fmtPct })], callCentre.decline_reasons_no?.categories || []),
      xSection(`Call centre — decline reasons, "Maybe" (n=${callCentre.decline_reasons_maybe?.n || 0})`, "category", "Reason", [xCol("count", "#"), xCol("pct", "%", { format: fmtPct })], callCentre.decline_reasons_maybe?.categories || []),
      xSection(`Call centre — attendance support needed (n=${callCentre.attendance_support_needed?.n || 0})`, "category", "Support needed", [xCol("count", "#"), xCol("pct", "%", { format: fmtPct })], callCentre.attendance_support_needed?.categories || []),
      xSection("Call centre — call-note themes (all)", "theme", "Theme", [xCol("count", "#"), xCol("pct", "%", { format: fmtPct })], callCentre.feedback_themes || []),
      xSection("Call centre — questions youth ask, by theme", "theme", "Theme", [xCol("count", "#"), xCol("pct", "%", { format: fmtPct })], callCentre.genuine_questions?.themes || []),
      xSection("Call centre — questions youth ask, verbatim", "quote", "Quote", [], (callCentre.genuine_questions?.quotes || []).map((q) => ({ quote: q }))),
    ],
  };
}

async function buildAcquisitionExport(filters) {
  const q = buildParams(filters);
  const [acq, arrival] = await Promise.all([
    apiGet(`/api/recruitment/acquisition${q}`),
    apiGet(`/api/recruitment/acquisition-arrival${q}`),
  ]);
  const totals = acq.totals || {};
  const venueRows = (arrival.by_venue || []).map((r) => ({
    venue: r.venue, district: r.district, verified: r.verified, acquired: r.acquired,
    acquired_female: r.acquired_female, rate: r.acquisition_rate, category: categorizeRate(r.acquisition_rate),
  }));
  return {
    label: "Acquisition",
    sections: [
      xSection("Totals", "metric", "Metric", [xCol("value", "Value", { format: (v) => (typeof v === "number" ? String(v) : (v ?? "—")) })],
        Object.entries(totals).map(([k, v]) => ({ metric: k, value: v }))),
      xSection("Acquisition by district", "district", "District", [xCol("verified", "Verified"), xCol("acquired", "Acquired")], acq.by_district || []),
      xSection("Arrival & verification, by venue", "venue", "Venue", [
        xTextCol("district", "District"), xCol("verified", "Verified"), xCol("acquired", "Acquired"),
        xCol("acquired_female", "Acquired (F)"), xCol("rate", "Acquisition rate", { format: fmtPct }), xTextCol("category", "Status"),
      ], venueRows),
    ],
  };
}

async function buildMobilisersExport(filters) {
  const data = await apiGet(`/api/recruitment/mobilisers${buildParams(filters)}`);
  return {
    label: "Mobilisers",
    sections: [
      xSection("Mobiliser leaderboard", "mobiliser_name", "Mobiliser", [
        xTextCol("district", "District"), xCol("reached", "Reached"), xCol("confirmed", "Confirmed"),
      ], data.mobilisers || []),
    ],
  };
}

async function buildTamExport(filters) {
  const data = await apiGet(`/api/recruitment/tam${buildParams(filters)}`);
  return {
    label: "TAM Analysis",
    sections: [
      xSection("TAM / market share, by parish", "parish", "Parish", [
        xTextCol("district", "District"), xCol("predicted", "Predicted"), xCol("actual", "Actual"),
        xCol("validation_rate", "Validation %", { format: fmtPct }), xTextCol("status", "Status"),
      ], data.parishes || []),
    ],
  };
}

async function buildRetentionExport(filters) {
  const data = await apiGet(`/api/implementation/retention${buildParams(filters)}`);
  const rows = data.by_venue || [];
  const rateFns = {
    activation_rate: (d) => (d.acquired ? Math.round((1000 * d.activated) / d.acquired) / 10 : null),
    retention_rate: (d) => (d.activated ? Math.round((1000 * d.retained) / d.activated) / 10 : null),
  };
  const districtRows = groupByDistrict(rows, ["acquired", "activated", "retained"], rateFns);
  return {
    label: "Retention",
    sections: [
      xSection("Retention by district", "district", "District", [
        xCol("acquired", "Acquired"), xCol("activated", "Activated"), xCol("retained", "Retained"),
        xCol("activation_rate", "Activation rate", { format: fmtPct }), xCol("retention_rate", "Retention rate", { format: fmtPct }),
      ], districtRows),
      xSection("Retention by venue", "venue", "Venue", [
        xTextCol("district", "District"), xCol("acquired", "Acquired"), xCol("activated", "Activated"),
        xCol("retained", "Retained"), xCol("retention_rate", "Retention rate", { format: fmtPct }),
      ], rows),
    ],
  };
}

async function buildAttendanceExport(filters) {
  const data = await apiGet(`/api/implementation/attendance${buildParams(filters)}`);
  const venueRows = data.by_venue || [];
  const rateFns = { attendance_rate: (d) => (d.activated ? Math.round((1000 * d.present) / d.activated) / 10 : null) };
  const districtRows = groupByDistrict(venueRows, ["activated", "present"], rateFns);
  return {
    label: "Attendance",
    sections: [
      xSection("Attendance by district", "district", "District", [
        xCol("activated", "Activated"), xCol("present", "Present (avg)"), xCol("attendance_rate", "Attendance rate", { format: fmtPct }),
      ], districtRows),
      xSection("Attendance by venue", "venue", "Venue", [
        xTextCol("district", "District"), xCol("activated", "Activated"), xCol("present", "Present (avg)"), xCol("attendance_rate", "Attendance rate", { format: fmtPct }),
      ], venueRows),
      xSection("Daily attendance & churn", "event_date", "Date", [xCol("present", "Present"), xCol("net_churn", "Net churn")], data.daily || []),
    ],
  };
}

async function buildRetentionCallsExport(filters) {
  const data = await apiGet(`/api/implementation/retention-calls${buildParams(filters)}`);
  const venueRows = data.by_venue || [];
  const districtRows = groupByDistrict(venueRows, ["called", "reached", "promised", "returned"], {});
  return {
    label: "Retention Calls",
    sections: [
      xSection("Retention calls by district", "district", "District", [
        xCol("called", "Called"), xCol("reached", "Reached"), xCol("promised", "Promised"), xCol("returned", "Returned"),
      ], districtRows),
      xSection("Retention calls by venue", "venue", "Venue", [
        xTextCol("district", "District"), xCol("absent", "Absent"), xCol("called", "Called"), xCol("reached", "Reached"),
        xCol("returned", "Returned"), xCol("reach_rate", "Reach %", { format: fmtPct }),
      ], venueRows),
      xSection("Daily follow-up funnel", "event_date", "Date", [
        xCol("called", "Called"), xCol("reached", "Reached"), xCol("promised", "Promised"), xCol("returned", "Returned"),
      ], data.daily || []),
    ],
  };
}

// Adapted to the current /api/implementation/trainers shape (three cohorts —
// BOOTCAMP_4, BC5 TOT, BOOTCAMP_5 — each register row carries its own
// `cohort`, and every score is the raw 1-5 average via avg_<domain>/score,
// not a percentage). One fetch with no phase param returns every cohort at
// once, so this groups client-side by `cohort` instead of firing one request
// per phase the way the old two-cohort version did.
async function buildTrainerQualityExport(filters) {
  const data = await apiGet(`/api/implementation/trainers${buildParams(filters)}`);
  const rows = data.trainers || [];
  const domainDefs = data.domains || [];
  const byPhase = data.by_phase || [];
  const cohorts = data.cohorts || [];

  function domainAveragesFor(rowsSubset) {
    return domainDefs.map((d) => {
      const key = `avg_${d.key}`;
      const vals = rowsSubset.map((r) => r[key]).filter((v) => v != null);
      return { domain: d.label, avg: vals.length ? Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 100) / 100 : null };
    });
  }
  function avgScoreByDistrict(rowsSubset) {
    const byDistrict = {};
    rowsSubset.forEach((r) => {
      const d = byDistrict[r.district] || (byDistrict[r.district] = { district: r.district, _sum: 0, _n: 0 });
      if (r.score != null) { d._sum += Number(r.score) || 0; d._n += 1; }
    });
    return Object.values(byDistrict).map((d) => ({ district: d.district, score: d._n ? Math.round((d._sum / d._n) * 100) / 100 : null }));
  }

  const scoreCol = xCol("score", "Overall score", { format: fmtScore });
  const cohortSections = cohorts.flatMap((cohort) => {
    const cohortRows = rows.filter((r) => r.cohort === cohort);
    if (!cohortRows.length) return [];
    return [
      xSection(`Trainer observation register — ${cohort}`, "trainer_name", "Trainer", [
        xTextCol("venue", "Venue"), xTextCol("district", "District"), scoreCol, xTextCol("rating", "Rating"),
      ], cohortRows),
      xSection(`Domain summary — ${cohort}`, "domain", "Domain", [xCol("avg", "Avg score", { format: fmtScore })], domainAveragesFor(cohortRows)),
    ];
  });

  return {
    label: "Trainer Quality",
    sections: [
      xSection("Cohort comparison", "phase", "Cohort", [
        xCol("trainers_observed", "Trainers observed"), xCol("score", "Avg score", { format: fmtScore }),
      ], byPhase),
      xSection("Trainer observation register — all cohorts", "trainer_name", "Trainer", [
        xTextCol("venue", "Venue"), xTextCol("district", "District"), xTextCol("cohort", "Cohort"), scoreCol, xTextCol("rating", "Rating"),
      ], rows),
      xSection("Domain summary — all cohorts", "domain", "Domain", [xCol("avg", "Avg score", { format: fmtScore })], domainAveragesFor(rows)),
      xSection("Avg observation score, by district — all cohorts", "district", "District", [xCol("score", "Avg score", { format: fmtScore })], avgScoreByDistrict(rows)),
      ...cohortSections,
    ],
  };
}

async function buildMilestonesExport(filters) {
  const data = await apiGet(`/api/implementation/milestones${buildParams(filters)}`);
  const byVenue = data.by_venue || [];
  const districtRows = groupByDistrict(byVenue, ["below", "meet", "exceed"], {
    exceed_pct: (d) => { const t = (d.below || 0) + (d.meet || 0) + (d.exceed || 0); return t ? Math.round((1000 * d.exceed) / t) / 10 : null; },
  });
  return {
    label: "Milestones",
    sections: [
      xSection("Pitch quality by week", "week_number", "Week", [
        xCol("completion_pct", "Completion %", { format: fmtPct }), xCol("below_pct", "Below %", { format: fmtPct }),
        xCol("meet_pct", "Meets %", { format: fmtPct }), xCol("exceed_pct", "Exceeds %", { format: fmtPct }),
      ], data.weekly || []),
      xSection("Milestone quality, by district", "district", "District", [xCol("exceed_pct", "% exceeding", { format: fmtPct })], districtRows),
      xSection("Venue milestone performance", "venue", "Venue", [
        xTextCol("district", "District"), xCol("avg_youth_per_week", "Youth/wk"), xCol("completion_pct", "Completion %", { format: fmtPct }), xCol("exceed_pct", "% Exceeds", { format: fmtPct }),
      ], byVenue),
    ],
  };
}

// Same MILESTONES-backed weekly fetch as buildMilestonesExport (parent
// engagement lives on the same table), kept as its own export builder since
// Parental Engagement is now its own Implementation tab, not a Milestones
// section.
async function buildParentalEngagementExport(filters) {
  const data = await apiGet(`/api/implementation/milestones${buildParams(filters)}`);
  return {
    label: "Parental Engagement",
    sections: [
      xSection("Parents present, by week", "week_number", "Week", [
        xCol("total_youth", "Reported that week"), xCol("parent_present", "# Parents present"), xCol("parent_present_pct", "% Present", { format: fmtPct }),
        xCol("parent_no_report", "# Not reported"), xCol("parent_no_report_pct", "% Not reported", { format: fmtPct }),
      ], data.weekly || []),
    ],
  };
}

async function buildNpsExport(filters) {
  const data = await apiGet(`/api/implementation/youth-experience${buildParams(filters)}`);
  return {
    label: "Youth Experience",
    sections: [
      xSection("NPS by week", "week_number", "Week", [xTextCol("dimension", "Dimension"), xCol("nps", "NPS")], data.weekly || []),
    ],
  };
}

async function buildVenueExport(filters) {
  const data = await apiGet(`/api/operations/venue${buildParams(filters)}`);
  return {
    label: "Venue",
    sections: [
      xSection("Venue compliance", "venue", "Venue", [
        xTextCol("district", "District"), xCol("reports", "Reports"), xCol("compliant", "Compliant"), xCol("compliance_rate", "Rate", { format: fmtPct }),
      ], data.by_venue || []),
    ],
  };
}

async function buildTransportExport(filters) {
  const data = await apiGet(`/api/operations/transport${buildParams(filters)}`);
  return {
    label: "Transport",
    sections: [
      xSection("Transport timeliness, by site", "venue", "Site", [xCol("timeliness_score", "Timeliness score")], data.by_site || []),
    ],
  };
}

// One builder per non-Guide NAV tab key — Guide is static content, not data,
// so it's excluded from the export dialog entirely.
const EXPORT_BUILDERS = {
  "es-main": buildExecutiveSummaryExport,
  aware: buildAwarenessExport,
  mob: buildMobilisationExport,
  acq: buildAcquisitionExport,
  mobs: buildMobilisersExport,
  tam: buildTamExport,
  ret: buildRetentionExport,
  attendance: buildAttendanceExport,
  retcalls: buildRetentionCallsExport,
  train: buildTrainerQualityExport,
  nps: buildNpsExport,
  parental: buildParentalEngagementExport,
  milestones: buildMilestonesExport,
  venue: buildVenueExport,
  transport: buildTransportExport,
};

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderExportSectionHtml(section) {
  const cols = [{ key: section.nameKey, label: section.nameLabel, align: "left", format: (v) => (v == null ? "—" : String(v)) }, ...section.columns];
  const rowsHtml = section.rows.length
    ? section.rows.map((r) => `<tr>${cols.map((c) => `<td style="text-align:${c.align}">${escHtml(c.format(r[c.key], r))}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${cols.length}" style="text-align:center;color:#888;padding:10px">No data</td></tr>`;
  return `
    <h3>${escHtml(section.heading)}</h3>
    ${section.note ? `<p class="note">${escHtml(section.note)}</p>` : ""}
    <table>
      <thead><tr>${cols.map((c) => `<th style="text-align:${c.align}">${escHtml(c.label)}</th>`).join("")}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

function buildExportReportHtml(tabResults, filters) {
  const filterBits = [];
  if (filters.cohort) filterBits.push(`Cohort: ${filters.cohort}`);
  if (filters.district) filterBits.push(`District: ${filters.district}`);
  if (filters.gender) filterBits.push(`Gender: ${filters.gender}`);
  const filterLabel = filterBits.length ? filterBits.join(" · ") : "All cohorts, districts, genders";

  const body = tabResults.map((t) => `
    <h2 class="tab-heading">${escHtml(t.label)}</h2>
    ${t.note ? `<p class="note">${escHtml(t.note)}</p>` : ""}
    ${t.sections.map(renderExportSectionHtml).join("")}
  `).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>E!BA Dashboard — Export Report</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; color: #241F18; margin: 24px; }
    h1 { font-size: 20px; margin-bottom: 2px; }
    .subtitle { font-size: 12px; color: #6B6358; margin-bottom: 20px; }
    h2.tab-heading { font-size: 17px; margin-top: 30px; border-bottom: 2px solid #D9A441; padding-bottom: 4px; }
    h3 { font-size: 13px; margin: 16px 0 6px; color: #2E6E73; }
    .note { font-size: 11px; color: #6B6358; margin: -4px 0 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-bottom: 6px; }
    th, td { border: 1px solid #E3DDCC; padding: 4px 7px; }
    th { background: #F7F4ED; text-transform: uppercase; font-size: 10px; color: #6B6358; }
    @media print {
      h2.tab-heading { page-break-before: always; }
      h2.tab-heading:first-of-type { page-break-before: avoid; }
      tr { page-break-inside: avoid; }
    }
  </style></head>
  <body>
    <h1>E!BA Dashboard — Export Report</h1>
    <div class="subtitle">Generated ${escHtml(new Date().toLocaleString())} · ${escHtml(filterLabel)}</div>
    ${body}
  </body></html>`;
}

function ExportDialog({ open, onClose, filters }) {
  const exportableGroups = NAV.filter((g) => g.key !== "guide");
  const allKeys = useMemo(() => exportableGroups.flatMap((g) => g.tabs.map((t) => t.key)), [exportableGroups]);
  const [selected, setSelected] = useState(() => new Set(allKeys));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState(null);

  if (!open) return null;

  function toggle(key) {
    setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }
  function toggleAll() {
    setSelected((s) => (s.size === allKeys.length ? new Set() : new Set(allKeys)));
  }

  async function generate() {
    setError(null);
    // Open the tab synchronously, in direct response to the click, so
    // popup blockers see it as a user-initiated navigation.
    const win = window.open("", "_blank");
    if (!win) { setError("Popups are blocked — please allow popups for this site and try again."); return; }
    win.document.write("<title>Generating report…</title><body style=\"font-family:sans-serif;padding:40px;color:#333\">Generating your E!BA Dashboard export…</body>");
    setBusy(true);
    try {
      const tabs = exportableGroups.flatMap((g) => g.tabs).filter((t) => selected.has(t.key));
      const inFlight = new Set();
      const done = new Set();
      const describeProgress = () => {
        const bits = [];
        if (inFlight.size) bits.push(`Fetching ${[...inFlight].join(", ")}…`);
        bits.push(`${done.size}/${tabs.length} tabs done`);
        setProgress(bits.join(" — "));
      };

      // One tab's data being unavailable (a 503, a table that isn't live
      // yet, etc.) shouldn't abort the whole report — every tab runs
      // independently and a failure becomes a visible note in ITS section
      // of the PDF rather than killing the other 13 tabs' worth of work.
      // Tabs run with limited concurrency (not fully sequential, not all at
      // once) — sequential was the slow path the user hit; unlimited
      // parallel would fire 100+ requests at the backend simultaneously.
      const CONCURRENCY = 4;
      const results = new Array(tabs.length);
      let nextIndex = 0;
      async function worker() {
        while (nextIndex < tabs.length) {
          const i = nextIndex++;
          const t = tabs[i];
          inFlight.add(t.label);
          describeProgress();
          const builder = EXPORT_BUILDERS[t.key];
          try {
            results[i] = builder
              ? await builder(filters)
              : { label: t.label, sections: [], note: "Export not available for this tab yet." };
          } catch (e) {
            results[i] = { label: t.label, sections: [], note: `Couldn't load this tab's data: ${e.message || "unknown error"}. It may not be connected to live data yet — try again, or check the tab directly.` };
          }
          inFlight.delete(t.label);
          done.add(t.label);
          describeProgress();
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tabs.length) }, worker));

      const html = buildExportReportHtml(results, filters);
      win.document.open();
      win.document.write(html);
      win.document.close();
      win.focus();
      win.print();
      onClose();
    } catch (e) {
      const message = e.message || "Export failed";
      setError(message);
      win.document.open();
      win.document.write(`<title>Export failed</title><body style="font-family:sans-serif;padding:40px;color:#900">Export failed: ${escHtml(message)}</body>`);
      win.document.close();
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  return (
    <>
      <div onClick={busy ? undefined : onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,34,56,.45)", zIndex: 100 }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 101, background: C.cream, borderRadius: 10, width: 480, maxWidth: "92vw", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 12px 40px rgba(0,0,0,.25)" }}>
        <div style={{ padding: "18px 22px 12px", borderBottom: `1px solid ${C.line}`, background: C.white, borderRadius: "10px 10px 0 0" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>Export report</div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>Pick which tabs to include — every district/parish/venue breakdown for each is fetched fresh, not just what's currently open.</div>
        </div>
        <div style={{ padding: "14px 22px", overflowY: "auto", flex: 1 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700, marginBottom: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={selected.size === allKeys.length} onChange={toggleAll} />
            Select all
          </label>
          {exportableGroups.map((g) => (
            <div key={g.key} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.teal, textTransform: "uppercase", marginBottom: 4 }}>{g.group}</div>
              {g.tabs.map((t) => (
                <label key={t.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "3px 0", cursor: "pointer" }}>
                  <input type="checkbox" checked={selected.has(t.key)} onChange={() => toggle(t.key)} />
                  {t.label}
                </label>
              ))}
            </div>
          ))}
        </div>
        {error && <div style={{ padding: "0 22px 10px", color: C.coral, fontSize: 12 }}>{error}</div>}
        {busy && <div style={{ padding: "0 22px 10px", color: C.muted, fontSize: 12 }}>{progress || "Generating…"}</div>}
        <div style={{ padding: "12px 22px 18px", borderTop: `1px solid ${C.line}`, display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose} disabled={busy} style={{ fontSize: 12, fontWeight: 700, padding: "8px 16px", border: `1px solid ${C.line}`, borderRadius: 5, background: C.white, color: C.inkSoft, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>Cancel</button>
          <button onClick={generate} disabled={busy || selected.size === 0} style={{ fontSize: 12, fontWeight: 700, padding: "8px 16px", border: "none", borderRadius: 5, background: C.gold, color: C.ink, cursor: busy || selected.size === 0 ? "default" : "pointer", opacity: busy || selected.size === 0 ? 0.6 : 1 }}>
            {busy ? "Generating…" : "Generate PDF"}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Filter bar ───────────────────────────────────────────────────────────────
function FilterBar({ filters, setFilters, options }) {
  const sel = { fontSize: 12, padding: "6px 8px", border: `1px solid #33526e`, borderRadius: 4, background: C.white, color: C.text };
  return (
    <div style={{ background: C.inkSoft, padding: "10px 24px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", position: "sticky", top: 0, zIndex: 60 }}>
      <span style={{ color: C.gold, fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Filters</span>
      <select style={sel} value={filters.district} onChange={(e) => setFilters({ ...filters, district: e.target.value })}>
        <option value="">All districts</option>
        {(options.districts || []).map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
      <select style={sel} value={filters.gender} onChange={(e) => setFilters({ ...filters, gender: e.target.value })}>
        <option value="">All genders</option>
        {(options.genders || []).map((g) => <option key={g} value={g}>{g}</option>)}
      </select>
      <select style={sel} value={filters.cohort} onChange={(e) => setFilters({ ...filters, cohort: e.target.value })}>
        <option value="">All cohorts</option>
        {(options.cohorts || []).map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <button style={{ fontSize: 11.5, fontWeight: 700, padding: "6px 12px", border: "none", borderRadius: 4, background: C.gold, color: C.ink, cursor: "pointer" }}
        onClick={() => setFilters({ district: "", gender: "", cohort: "BOOTCAMP_5" })}>Reset</button>
      <span style={{ color: "#9FB0BF", fontSize: 11, marginLeft: "auto" }}>Filters apply to every page</span>
    </div>
  );
}

// ─── Login ────────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...CLIENT_HEADER },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new Error("Incorrect password");
      const { token } = await res.json();
      saveToken(token);
      onLogin();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: C.ink }}>
      <div style={{ background: C.white, borderRadius: 12, padding: 36, width: 360 }}>
        <div style={{ fontWeight: 800, fontSize: 20, color: C.ink }}>EDUCATE<span style={{ color: C.gold }}>!</span></div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>E!BA Dashboard</div>
        <a href={`${API_BASE}/api/auth/google/login`} style={{ display: "block", textAlign: "center", padding: 10, background: C.gold, color: C.ink, borderRadius: 6, fontWeight: 700, textDecoration: "none" }}>
          Sign in with Google (staff)
        </a>
        <div style={{ fontSize: 11.5, color: C.muted, textAlign: "center", margin: "14px 0" }}>
          Having trouble with Google sign-in? Use the guest password below.
        </div>
        <form onSubmit={submit}>
          <input type="password" placeholder="Guest password" value={password} onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", padding: 10, border: `1px solid ${C.line}`, borderRadius: 6, marginBottom: 10 }} />
          {err && <div style={{ color: C.coral, fontSize: 12, marginBottom: 10 }}>{err}</div>}
          <button type="submit" disabled={busy} style={{ width: "100%", padding: 10, background: "transparent", color: C.ink, border: `1px solid ${C.line}`, borderRadius: 6, fontWeight: 700, cursor: "pointer" }}>
            {busy ? "Signing in…" : "Continue as guest"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [token, setToken] = useState(() => consumeOAuthHash() || getToken());
  const [user, setUser] = useState(null);
  const [userLoading, setUserLoading] = useState(!!token);
  const [groupIdx, setGroupIdx] = useState(() => Number(sessionStorage.getItem("eba_group") || 0));
  const [tabKey, setTabKey] = useState(() => sessionStorage.getItem("eba_tab") || "guide-main");
  // Defaults to BOOTCAMP_5 — the current cohort — so every page across the
  // dashboard opens on its performance first; "All cohorts" (or BOOTCAMP_4)
  // is still one dropdown selection away for anyone who wants it.
  const [filters, setFilters] = useState({ district: "", gender: "", cohort: "BOOTCAMP_5" });
  const [options, setOptions] = useState({});
  const [demoMode, setDemoMode] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  // Fetch current user whenever the token changes.
  useEffect(() => {
    if (!token) return;  // token only clears via logout(), which reloads the page
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setUserLoading(true);
    fetch(`${API_BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${token}`, ...CLIENT_HEADER } })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setUser)
      .catch(() => { clearToken(); setUser(null); })
      .finally(() => setUserLoading(false));
  }, [token]);

  // Load filter options once authenticated. This call also doubles as the global
  // "connected to live data?" probe: if it 503s (BC5 feed not live) or is
  // unreachable, fall back to demo filter options and flip the dashboard into
  // demo mode (banner + per-card "DEMO DATA" badges). Recovers automatically
  // once the feed lands and the call succeeds.
  useEffect(() => {
    if (!user) return;
    fetch(`${API_BASE}/api/filters`, { headers: { Authorization: `Bearer ${token}`, ...CLIENT_HEADER } })
      .then((r) => {
        if (r.ok) return r.json();
        if (r.status === 503) return null;  // not connected → demo
        throw new Error(`API ${r.status}`);
      })
      .then((json) => {
        if (json) { setOptions(json); setDemoMode(false); }
        else { setOptions(DEMO_FILTERS); setDemoMode(true); }
      })
      .catch(() => { setOptions(DEMO_FILTERS); setDemoMode(true); });
  }, [user, token]);

  const group = NAV[groupIdx] || NAV[0];
  const activeTab = useMemo(
    () => group.tabs.find((t) => t.key === tabKey) || group.tabs[0],
    [group, tabKey]
  );

  const selectGroup = useCallback((i) => {
    setGroupIdx(i); sessionStorage.setItem("eba_group", i);
    const first = NAV[i].tabs[0].key;
    setTabKey(first); sessionStorage.setItem("eba_tab", first);
  }, []);
  const selectTab = useCallback((k) => { setTabKey(k); sessionStorage.setItem("eba_tab", k); }, []);

  // Lets the Guide tab's cards/table rows jump straight to the tab they
  // describe (matches the reference design's guideGo() cross-links).
  const navigateTo = useCallback((groupKey, tabKey2) => {
    const gi = NAV.findIndex((g) => g.key === groupKey);
    if (gi === -1) return;
    setGroupIdx(gi); sessionStorage.setItem("eba_group", gi);
    const tk = tabKey2 || NAV[gi].tabs[0].key;
    setTabKey(tk); sessionStorage.setItem("eba_tab", tk);
  }, []);

  if (!token || (!userLoading && !user)) return <LoginScreen onLogin={() => setToken(getToken())} />;
  if (userLoading) return <div style={{ minHeight: "100vh", background: C.ink }} />;

  const gtab = (active) => ({ padding: "7px 16px", cursor: "pointer", fontSize: 13, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", borderRadius: "6px 6px 0 0", color: active ? C.ink : "#9FB0BF", background: active ? C.gold : "rgba(255,255,255,.06)" });
  const stab = (active) => ({ padding: "8px 12px", cursor: "pointer", fontSize: 11.5, fontWeight: 600, textTransform: "uppercase", color: active ? C.white : "#9FB0BF", borderBottom: `3px solid ${active ? C.gold : "transparent"}` });

  return (
    <DrillProvider>
    <div style={{ minHeight: "100vh", background: C.cream }}>
      <header style={{ background: C.ink, color: C.white, padding: "8px 24px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>EDUCATE<span style={{ color: C.gold }}>!</span> — E!BA Dashboard</div>
            <div style={{ color: "#B9C4D0", fontSize: 10 }}>Executive Dashboard · E!BA Recruitment · Busoga region</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 12, color: "#B9C4D0" }}>{user.email || "Guest view"}</span>
            <button onClick={() => setExportOpen(true)} style={{ fontSize: 11, fontWeight: 700, padding: "5px 10px", border: `1px solid ${C.gold}`, borderRadius: 4, background: "transparent", color: C.gold, cursor: "pointer" }}>Export</button>
            <button onClick={logout} style={{ fontSize: 11, fontWeight: 700, padding: "5px 10px", border: `1px solid ${C.gold}`, borderRadius: 4, background: "transparent", color: C.gold, cursor: "pointer" }}>Sign out</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {NAV.map((g, i) => <div key={g.key} style={gtab(i === groupIdx)} onClick={() => selectGroup(i)}>{g.group}</div>)}
        </div>
        <div style={{ display: "flex", gap: 2, marginTop: 0, borderTop: `2px solid ${C.gold}`, paddingTop: 2 }}>
          {group.tabs.map((t) => <div key={t.key} style={stab(t.key === activeTab.key)} onClick={() => selectTab(t.key)}>{t.label}</div>)}
        </div>
      </header>

      {demoMode && (
        <div style={{ background: "#FBEDEA", borderBottom: `2px solid ${C.coral}`, color: C.coral, padding: "10px 24px", fontSize: 12.5, fontWeight: 600, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ background: C.coral, color: C.white, fontSize: 9, fontWeight: 800, padding: "3px 8px", borderRadius: 3, textTransform: "uppercase", letterSpacing: 0.3 }}>Demo data</span>
          Not connected to live data — the BC5 BigQuery feed isn’t live yet, so every panel below shows illustrative dummy data to preview the dashboard. Figures are fabricated, not real.
        </div>
      )}

      <FilterBar filters={filters} setFilters={setFilters} options={options} />

      <DemoContext.Provider value={demoMode}>
        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "20px 24px 80px" }}>
          {activeTab.render(filters, navigateTo)}
        </div>
      </DemoContext.Provider>

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} filters={filters} />
    </div>
    </DrillProvider>
  );
}
