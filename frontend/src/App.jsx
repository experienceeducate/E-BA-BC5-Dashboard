/*
 * E!BA Dashboard — single-file SPA (by design until >=5 real
 * content tabs justify a split; see docs/DECISION.md).
 *
 * Auth shell -> group/sub-tab nav (state in React + sessionStorage, no router)
 * -> one component per tab, each fetching its /api/* endpoint through useApi,
 * which always sends the JWT + the X-EBA-Client header. Charts via recharts.
 * Inline styles only — no CSS framework.
 */

import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, Cell,
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
function useApi(endpoint) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isDemo, setIsDemo] = useState(false);

  useEffect(() => {
    let alive = true;
    // Resetting load/error state at the start of a (re)fetch is the intended
    // React<->network sync point; the strict rule flags it as a false positive.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    setIsDemo(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    const token = getToken();
    fetch(`${API_BASE}${endpoint}`, {
      headers: { Authorization: `Bearer ${token}`, ...CLIENT_HEADER },
    })
      .then((res) => {
        if (res.status === 401) { logout(); return null; }
        if (!res.ok) { const err = new Error(`API ${res.status}`); err.status = res.status; throw err; }
        return res.json();
      })
      .then((json) => { if (alive && json !== null) setData(json); })
      .catch((e) => {
        if (!alive) return;
        // "Not connected to live data" cases — a 503 (upstream BigQuery table
        // missing, i.e. the BC5 feed isn't live) or an unreachable API — fall
        // back to bundled demo data so the panel still shows how it will look.
        // A genuine server error (500, etc.) still surfaces as an error card.
        const demo = DEMO[endpoint.split("?")[0]];
        const disconnected = e.status === 503 || e.status === undefined;
        if (demo && disconnected) { setData(demo); setIsDemo(true); }
        else { setError(e.message); }
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [endpoint]);

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
function KpiTile({ label, value, sub, tone = "real", tag, onClick }) {
  const t = CHIP_TONE[tone] || CHIP_TONE.real;
  return (
    <div onClick={onClick} style={{ background: C.white, border: `1px solid ${C.line}`, borderRadius: 6, padding: "11px 13px 10px", borderTop: `3px solid ${t.color}`, position: "relative", cursor: onClick ? "pointer" : undefined }}>
      {tag && <span style={{ position: "absolute", top: 8, right: 9, fontSize: 8, fontWeight: 700, letterSpacing: 0.4, color: t.color }}>{tag}</span>}
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.3, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: C.ink, lineHeight: 1.1 }}>{value ?? "—"}{onClick && <span style={{ fontSize: 12, color: C.muted, marginLeft: 6 }}>›</span>}</div>
      {sub && <div style={{ fontSize: 10.5, color: C.muted, marginTop: 3, lineHeight: 1.35 }}>{sub}</div>}
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
// Awareness's Funnel Overview / Mobilisers / KYC / Forecast) — matches the
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
function Gauge({ label, pct, target }) {
  const filled = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const belowTarget = target != null && pct != null && pct < target;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: C.text, fontWeight: 600 }}>{label}</span>
        <span style={{ color: belowTarget ? C.coral : C.green, fontWeight: 700 }}>{fmtPct(pct)}</span>
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

// Day × category heatmap — cell background intensity scales with value. Caps
// to the top N categories by total value to keep the table readable; the
// caller should surface how many were dropped rather than hiding it silently.
function Heatmap({ data, xKey, yKey, valueKey, topN = 15 }) {
  const totalsByY = {};
  data.forEach((d) => { totalsByY[d[yKey]] = (totalsByY[d[yKey]] || 0) + (d[valueKey] || 0); });
  const yValues = Object.keys(totalsByY).sort((a, b) => totalsByY[b] - totalsByY[a]).slice(0, topN);
  const droppedCount = Object.keys(totalsByY).length - yValues.length;
  const xValues = [...new Set(data.map((d) => d[xKey]))].sort();
  const cellMap = {};
  data.forEach((d) => { cellMap[`${d[yKey]}|${d[xKey]}`] = d[valueKey]; });
  const max = Math.max(1, ...data.map((d) => d[valueKey] || 0));
  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ padding: 6 }}></th>
              {xValues.map((x) => <th key={x} style={{ padding: 6, fontSize: 9.5, color: C.muted, whiteSpace: "nowrap", fontWeight: 600 }}>{x}</th>)}
            </tr>
          </thead>
          <tbody>
            {yValues.map((y) => (
              <tr key={y}>
                <td style={{ padding: 6, fontSize: 10.5, color: C.ink, fontWeight: 600, whiteSpace: "nowrap" }}>{y}</td>
                {xValues.map((x) => {
                  const v = cellMap[`${y}|${x}`] || 0;
                  const intensity = max ? v / max : 0;
                  return (
                    <td key={x} title={`${y} · ${x}: ${v}`} style={{
                      padding: "6px 8px", textAlign: "center", minWidth: 30,
                      background: v ? `rgba(46,110,115,${0.15 + 0.85 * intensity})` : C.cream,
                      color: intensity > 0.5 ? C.white : C.text,
                    }}>{v || ""}</td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {droppedCount > 0 && (
        <p style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
          Showing the top {topN} by volume — {droppedCount} more not shown.
        </p>
      )}
    </div>
  );
}

// Numbered section divider, matching the reference design's "exec-band" style.
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

function DrillPanelUI({ open, spec, rootRows, rootLoading, rootError, child, onClose, onDrillInto, onBack }) {
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
                {child ? `${spec.title} — ${child.rootRow[spec.rootKey]}` : spec.title}
              </div>
              {child && (
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
              {child && (
                <State loading={child.loading} error={child.error} empty={!child.loading && !child.error && (child.rows || []).length === 0}>
                  <DrillTable nameKey={spec.childKey} nameLabel={spec.childLabel} columns={spec.columns} rows={child.rows || []} />
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

  // Opens showing the root (e.g. district) table.
  const openDrill = useCallback((newSpec) => {
    setSpec(newSpec);
    setOpen(true);
    setChild(null);
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
    setChild({ rootRow, rows: null, loading: true, error: null });
    Promise.resolve(newSpec.getChildRows(rootRow))
      .then((rows) => setChild({ rootRow, rows, loading: false, error: null }))
      .catch((e) => setChild({ rootRow, rows: null, loading: false, error: e.message || "Failed to load" }));
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const drillInto = useCallback((row) => {
    if (!spec?.getChildRows) return;
    setChild({ rootRow: row, rows: null, loading: true, error: null });
    Promise.resolve(spec.getChildRows(row))
      .then((rows) => setChild({ rootRow: row, rows, loading: false, error: null }))
      .catch((e) => setChild({ rootRow: row, rows: null, loading: false, error: e.message || "Failed to load" }));
  }, [spec]);

  const backToRoot = useCallback(() => setChild(null), []);

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
        child={child} onClose={close} onDrillInto={drillInto} onBack={backToRoot} />
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
function DataTable({ columns, rows }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>{columns.map((c) => (
            <th key={c.key} onClick={c.onHeaderClick} style={{ textAlign: c.align || "left", padding: "8px 10px", borderBottom: `2px solid ${C.line}`, color: C.muted, fontWeight: 600, textTransform: "uppercase", fontSize: 11, cursor: c.onHeaderClick ? "pointer" : undefined }}>
              {c.label}{c.onHeaderClick && " ›"}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{columns.map((c) => (
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

// Stage-by-stage female/male/target table — shared by the Executive Summary's
// "Gender performance summary" band and Recruitment's dedicated Gender tab so
// the two never drift apart.
function GenderStageTable({ stages }) {
  return (
    <DataTable
      columns={[
        { key: "stage", label: "Stage" },
        { key: "female", label: "Female", align: "right", render: (v) => fmtNum(v) },
        { key: "male", label: "Male", align: "right", render: (v) => fmtNum(v) },
        {
          key: "pct_female", label: "% Female", align: "right",
          render: (v) => <span style={{ color: v != null && Math.abs(v - 60) > 5 ? C.coral : "inherit", fontWeight: v != null && Math.abs(v - 60) > 5 ? 700 : 400 }}>{fmtPct(v)}</span>,
        },
        { key: "target_female", label: "Target", align: "right", render: (v) => fmtPct(v) },
      ]}
      rows={stages}
    />
  );
}

// ─── Executive Summary ───────────────────────────────────────────────────────
const RATE_TARGETS = {
  eligibility_rate:  { good: 80, warn: 70, label: "Eligibility" },
  mobilisation_rate: { good: 85, warn: 75, label: "Mobilisation" },
  acquisition_rate:  { good: 80, warn: 70, label: "Acquisition" },
  activation_rate:   { good: 90, warn: 80, label: "Activation" },
  retention_rate:    { good: 85, warn: 75, label: "Retention" },
};

// Headline funnel visual scope matches the reference design: Registered
// through Acquired (Activation/Retention get their own dedicated treatment
// elsewhere), with "Assigned" relabelled "Randomised" (RCT terminology) —
// display-only, the underlying data key is unchanged.
function headlineFunnelStages(stages) {
  return stages
    .filter((s) => s.stage !== "Activated" && s.stage !== "Retained")
    .map((s) => (s.stage === "Assigned" ? { ...s, stage: "Randomised", apiStage: "Assigned" } : { ...s, apiStage: s.stage }));
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

function ExecutiveSummaryPage({ filters }) {
  const drill = useDrill();
  const q = buildParams(filters);
  const kpis = useApi(`/api/overview/kpis${q}`);
  const funnel = useApi(`/api/overview/funnel${q}`);
  const stageProgress = useApi(`/api/overview/stage-progress${q}`);
  const gender = useApi(`/api/overview/gender${q}`);
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

  function openStageDrill(stage) {
    drill.open({
      title: `${stage.stage} — by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [{ key: "value", label: "Count", align: "right", render: fmtNum }],
      rootRows: () => fetchPerDistrict("/api/overview/funnel", filters, allDistricts,
        (json) => (json?.stages || []).find((s) => s.stage === stage.apiStage)?.count ?? null),
    });
  }
  const stages = funnel.data?.stages || [];
  const genderStages = gender.data?.stages || [];
  const headlineStages = headlineFunnelStages(stages);
  const registeredBase = stages[0]?.count || 0;

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
          <KpiTile label="Eligibility" value={fmtPct(rates.eligibility_rate)} sub="Eligible / Interested" onClick={() => openRateDrill("eligibility_rate", "Eligibility")} />
          <KpiTile label="Mobilisation" value={fmtPct(rates.mobilisation_rate)} sub="Confirmed / Reached" onClick={() => openRateDrill("mobilisation_rate", "Mobilisation")} />
          <KpiTile label="Acquisition" value={fmtPct(rates.acquisition_rate)} sub="Acquired / Confirmed" onClick={() => openRateDrill("acquisition_rate", "Acquisition")} />
          <KpiTile label="Activation" value={fmtPct(rates.activation_rate)} sub="Activated / Acquired" onClick={() => openRateDrill("activation_rate", "Activation")} />
          <KpiTile label="Retention" value={fmtPct(rates.retention_rate)} sub="Retained / Activated" onClick={() => openRateDrill("retention_rate", "Retention")} />
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

      <ExecBand num={4} title="Overall recruitment funnel" />
      <Card title="Registered → Interested → Eligible → Randomised → Reached → Confirmed → Verified → Acquired" subtitle="Each stage shows count and % of the previous stage. The largest single drop-off is outlined. Click a stage to drill by district." chip="REAL">
        <State loading={funnel.loading} error={funnel.error} empty={!funnel.loading && stages.length === 0}>
          <FunnelViz stages={headlineStages} onStageClick={openStageDrill} />
        </State>
      </Card>

      <ExecBand num="4b" title="Attrition through the funnel" />
      <Card title="Retention against Registered" subtitle="Every stage measured against the same denominator — total Registered — so cumulative attrition reads at a glance" chip="DERIVED">
        <State loading={funnel.loading} error={funnel.error} empty={!funnel.loading && stages.length === 0}>
          <DataTable
            columns={[
              { key: "stage", label: "Stage" },
              { key: "count", label: "Count", align: "right", render: (v) => fmtNum(v) },
              { key: "pct_of_base", label: "% of Registered", align: "right", render: (v) => fmtPct(v) },
            ]}
            rows={stages.map((s) => ({ stage: s.stage, count: s.count, pct_of_base: registeredBase ? Math.round((1000 * s.count) / registeredBase) / 10 : null }))}
          />
          <p style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>
            A true treatment-vs-control split isn't reliably trackable across every stage in the
            live data yet (RCT assignment is only captured for a small subset at registration) —
            this uses total Registered as the fixed denominator instead.
          </p>
        </State>
      </Card>

      <ExecBand num={5} title="Gender performance summary" />
      <Card title="Male vs female across the funnel" subtitle="Share of each stage that is female against the 60% target. Gaps over 5pp are flagged." chip="REAL">
        <State loading={gender.loading} error={gender.error} empty={!gender.loading && genderStages.length === 0}>
          <GenderStageTable stages={genderStages} />
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
              { key: "eligibility_rate", label: "Eligibility rate", align: "right", render: (v) => fmtPct(v) },
              { key: "pct_female", label: "% Female", align: "right", render: (v) => fmtPct(v) },
              { key: "progress_pct", label: "Progress on target", align: "right", render: (v) => fmtPct(v) },
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
              { key: "reach_rate", label: "Reach rate", align: "right", render: (v) => fmtPct(v) },
              { key: "mobilisation_rate", label: "Mobilisation rate", align: "right", render: (v) => fmtPct(v) },
              { key: "progress_pct", label: "Progress on target", align: "right", render: (v) => fmtPct(v) },
              { key: "pct_female", label: "% Female", align: "right", render: (v) => fmtPct(v) },
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
              { key: "acquisition_rate", label: "Acquisition rate", align: "right", render: (v) => fmtPct(v) },
              { key: "overall_conversion", label: "Overall conversion", align: "right", render: (v) => fmtPct(v) },
              { key: "progress_pct", label: "Progress on target", align: "right", render: (v) => fmtPct(v) },
              { key: "pct_female", label: "% Female", align: "right", render: (v) => fmtPct(v) },
            ]}
            rows={acquisition}
          />
        </Card>
      </State>
    </div>
  );
}

// ─── Recruitment tabs ──────────────────────────────────────────────────────────

// Awareness — the top of the funnel: 4 sub-pages (Funnel Overview, Mobilisers,
// KYC/Youth Profile, Forecast), matching the design's multi-page layout.
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
          { key: "overview", label: "Funnel Overview" },
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

function AwarenessOverviewPage({ filters }) {
  const drill = useDrill();
  const total = useApi(`/api/recruitment/awareness${buildParams(filters)}`);
  const female = useApi(`/api/recruitment/awareness${buildParamsOverride(filters, { gender: "Female" })}`);
  const male = useApi(`/api/recruitment/awareness${buildParamsOverride(filters, { gender: "Male" })}`);
  const parish = useApi(`/api/recruitment/awareness-parish${buildParams(filters)}`);

  const rows = total.data?.by_district || [];
  const reached = sumBy(rows, "registered");
  const interested = sumBy(rows, "interested");
  const eligible = sumBy(rows, "eligible");
  const target = sumBy(rows, "target");
  const eligibilityRate = interested ? Math.round((1000 * eligible) / interested) / 10 : null;

  function openMetricDrill(metricKey, label, formatter = fmtNum) {
    const rootRows = rows.map(withEligibilityRate).sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0));
    drill.open({
      title: `${label} — by district`,
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [{ key: metricKey, label, align: "right", render: formatter }],
      rootRows,
      childKey: "parish", childLabel: "Parish",
      getChildRows: (root) => (parish.data?.parishes || [])
        .filter((p) => p.district === root.district)
        .map((p) => withEligibilityRate({ ...p, registered: p.reached }))
        .sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0)),
    });
  }

  const fRows = female.data?.by_district || [];
  const mRows = male.data?.by_district || [];
  const stageStats = [
    { key: "registered", label: "Reached" },
    { key: "interested", label: "Interested" },
    { key: "eligible", label: "Eligible" },
  ].map(({ key, label }) => {
    const f = sumBy(fRows, key), m = sumBy(mRows, key);
    const t = f + m;
    return { stage: label, female: f, male: m, pct_female: t ? Math.round((1000 * f) / t) / 10 : null };
  });
  const genderLoading = total.loading || female.loading || male.loading;
  const genderError = total.error || female.error || male.error;

  return (
    <div>
      <Grid cols={4}>
        <KpiTile label="Reached" value={fmtNum(reached)} onClick={() => openMetricDrill("registered", "Reached")} />
        <KpiTile label="Interested" value={fmtNum(interested)} onClick={() => openMetricDrill("interested", "Interested")} />
        <KpiTile label="Eligible" value={fmtNum(eligible)} onClick={() => openMetricDrill("eligible", "Eligible")} />
        <KpiTile label="Registration target" value={fmtNum(target)} onClick={() => openMetricDrill("target", "Registration target")} />
        <KpiTile label="Eligibility rate" value={fmtPct(eligibilityRate)} sub="Eligible / Interested" onClick={() => openMetricDrill("eligibility_rate", "Eligibility rate", fmtPct)} />
      </Grid>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <Card title="Awareness funnel — Reached → Interested → Eligible" subtitle="Female vs male at each stage" chip="REAL">
          <State loading={genderLoading} error={genderError} empty={!genderLoading && stageStats.every((s) => !s.female && !s.male)}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={stageStats} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis dataKey="stage" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip /><Legend />
                <Bar dataKey="female" name="Female" fill={C.coral} radius={[4, 4, 0, 0]} />
                <Bar dataKey="male" name="Male" fill={C.teal} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </State>
        </Card>
        <Card title="Female representation vs 60% target" subtitle="Share of each funnel stage that is female" chip="DERIVED">
          <State loading={genderLoading} error={genderError} empty={!genderLoading && stageStats.every((s) => s.pct_female == null)}>
            <div style={{ paddingTop: 8 }}>
              {stageStats.map((s) => <Gauge key={s.stage} label={s.stage} pct={s.pct_female} target={60} />)}
            </div>
          </State>
        </Card>
      </div>

      <Card title="District comparison" subtitle="Reached, interested, eligible, target and female share by district" chip="REAL">
        <State loading={total.loading} error={total.error} empty={!total.loading && rows.length === 0}>
          <DataTable
            columns={[
              { key: "district", label: "District" },
              { key: "registered", label: "Reached", align: "right", render: (v) => fmtNum(v) },
              { key: "interested", label: "Interested", align: "right", render: (v) => fmtNum(v) },
              { key: "eligible", label: "Eligible", align: "right", render: (v) => fmtNum(v) },
              { key: "target", label: "Target", align: "right", render: (v) => fmtNum(v) },
              { key: "pct_female", label: "% Female", align: "right", render: (v) => fmtPct(v) },
            ]}
            rows={rows}
          />
        </State>
      </Card>

      <Card title="Category detail — by parish" subtitle="Reached, interested, target, eligible and % female per parish" chip="REAL">
        <State loading={parish.loading} error={parish.error} empty={!parish.loading && (parish.data?.parishes || []).length === 0}>
          <DataTable
            columns={[
              { key: "district", label: "District" },
              { key: "parish", label: "Parish" },
              { key: "reached", label: "Reached", align: "right", render: (v) => fmtNum(v) },
              { key: "interested", label: "Interested", align: "right", render: (v) => fmtNum(v) },
              { key: "eligible", label: "Eligible", align: "right", render: (v) => fmtNum(v) },
              { key: "target", label: "Target", align: "right", render: (v) => fmtNum(v) },
              { key: "pct_female", label: "% Female", align: "right", render: (v) => fmtPct(v) },
            ]}
            rows={parish.data?.parishes || []}
          />
        </State>
      </Card>
    </div>
  );
}

function AwarenessMobilisersPage({ filters }) {
  const { data, loading, error } = useApi(`/api/recruitment/awareness-mobilisers${buildParams(filters)}`);
  const rows = data?.mobilisers || [];
  return (
    <Card title="Performance by mobiliser" subtitle="Who is reaching youth, and whether their reach converts to eligible — and to eligible female" chip="PII" chipTone="pii">
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <DataTable
          columns={[
            { key: "mobiliser_name", label: "Mobiliser" },
            { key: "district", label: "District" },
            { key: "reached", label: "Reached", align: "right", render: (v) => fmtNum(v) },
            { key: "eligible", label: "Eligible", align: "right", render: (v) => fmtNum(v) },
            { key: "eligible_female", label: "Eligible (F)", align: "right", render: (v) => fmtNum(v) },
            { key: "pct_eligible_female", label: "% Eligible Female", align: "right", render: (v) => fmtPct(v) },
          ]}
          rows={rows}
        />
      </State>
    </Card>
  );
}

function AwarenessKycPage({ filters }) {
  const { data, loading, error } = useApi(`/api/recruitment/awareness-kyc${buildParams(filters)}`);
  const demo = data?.demographics || {};
  const bizByGenderDistrict = data?.business?.by_gender_district || [];

  return (
    <div>
      <p style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
        Who the eligible youth are and what locks others out — persona of the eligible pool,
        current activity, why they enrol, and how they heard about us. Eligibility rule:
        interested AND age 18–30 AND education P5–S3 AND income ≤ UGX 30,000.
      </p>

      <Card title="Eligible youth profile" subtitle="Persona snapshot of the eligible pool" chip="REAL">
        <State loading={loading} error={error} empty={!loading && !demo.eligible_count}>
          <Grid cols={5}>
            <KpiTile label="Eligible youth" value={fmtNum(demo.eligible_count)} />
            <KpiTile label="% Female" value={fmtPct(demo.pct_female)} />
            <KpiTile label="Average age" value={demo.avg_age ?? "—"} />
            <KpiTile label="Already own a business" value={fmtNum(demo.owns_business_count)} />
            <KpiTile label="Duplicate records" value={fmtNum(demo.duplicate_count)} sub={fmtPct(demo.duplicate_rate)} />
          </Grid>
        </State>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <Card title="What youth are currently doing" chip="REAL">
          <State loading={loading} error={error} empty={!loading && (data?.activity || []).length === 0}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={data?.activity || []} layout="vertical" margin={{ left: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="activity" tick={{ fontSize: 10 }} width={110} />
                <Tooltip />
                <Bar dataKey="count" fill={C.teal} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </State>
        </Card>
        <Card title="Why youth are enrolling" subtitle="Value-proposition alignment" chip="REAL">
          <State loading={loading} error={error} empty={!loading && (data?.reasons || []).length === 0}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={data?.reasons || []} layout="vertical" margin={{ left: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="reason" tick={{ fontSize: 9.5 }} width={150} />
                <Tooltip />
                <Bar dataKey="count" fill={C.gold} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </State>
        </Card>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
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
        <Card title="Why they're enrolling — owners vs non-owners" subtitle="Top reasons given, split by business ownership" chip="REAL">
          <State loading={loading} error={error} empty={!loading && (data?.business?.reasons_by_ownership || []).length === 0}>
            <DataTable
              columns={[
                { key: "owns_business", label: "Owns business", render: (v) => (v ? "Yes" : "No") },
                { key: "reason", label: "Reason" },
                { key: "count", label: "Count", align: "right", render: (v) => fmtNum(v) },
              ]}
              rows={data?.business?.reasons_by_ownership || []}
            />
          </State>
        </Card>
      </div>

      <Card title="Recruitment channels — how they heard about us" subtitle="Eligible vs ineligible split by channel" chip="REAL">
        <State loading={loading} error={error} empty={!loading && (data?.channels || []).length === 0}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data?.channels || []} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="channel" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={70} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip /><Legend />
              <Bar dataKey="eligible" name="Eligible" fill={C.green} radius={[4, 4, 0, 0]} />
              <Bar dataKey="ineligible" name="Ineligible" fill={C.coral} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </State>
      </Card>
    </div>
  );
}

function AwarenessForecastPage({ filters }) {
  const { data, loading, error } = useApi(`/api/recruitment/awareness-forecast${buildParams(filters)}`);
  const daily = data?.daily || [];
  return (
    <div>
      <Grid cols={4}>
        <KpiTile label="Registered to date" value={fmtNum(data?.registered_to_date)} />
        <KpiTile label="Registration target" value={fmtNum(data?.target)} />
        <KpiTile label="Avg daily rate" value={fmtNum(data?.avg_daily_rate)} />
        <KpiTile label="Days to target" value={data?.days_to_target ?? "—"} sub="At current pace" />
      </Grid>
      <Card title="Daily registration trend" subtitle="Registered youth per day" chip="REAL">
        <State loading={loading} error={error} empty={!loading && daily.length === 0}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={daily} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="event_date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="registered" stroke={C.teal} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
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
      <PageNav
        active={page}
        onChange={setPage}
        pages={[
          { key: "overview", label: "Overview" },
          { key: "arrival", label: "Arrival & Verification" },
        ]}
      />
      {page === "overview" && (
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
      )}
      {page === "arrival" && <AcquisitionArrivalPage filters={filters} />}
    </div>
  );
}

function AcquisitionArrivalPage({ filters }) {
  const { data, loading, error } = useApi(`/api/recruitment/acquisition-arrival${buildParams(filters)}`);
  const rows = data?.by_venue || [];
  const venueRows = rows.map((r) => ({
    venue: r.venue, district: r.district, verified: r.verified, acquired: r.acquired,
    rate: r.acquisition_rate, category: categorizeVenue(r.acquisition_rate),
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
          <KpiTile label="Acquisition rate" value={fmtPct(acqRate)} sub="acquired ÷ verified" tag="REAL" />
          <KpiTile label="Acquired female" value={fmtNum(totalAcquiredFemale)} sub={`${fmtPct(pctFemaleAcquired)} of acquired · target 60% (verified has no gender split in the live feed)`} tag="REAL" />
        </Grid>
        <ExecBand num="◆" title="Performance categorisation — venues vs target (filters)" />
        <VenueCategorisation
          venueRows={venueRows}
          metricA={{ key: "verified", label: "Verified" }}
          metricB={{ key: "acquired", label: "Acquired" }}
          rateFraction="acquired ÷ verified"
        />
      </State>
    </div>
  );
}

function MobilisationTab({ filters }) {
  const [page, setPage] = useState("funnel");
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Mobilisation</h2>
      <p style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>
        Treatment assigned → reached at mobilisation → attendance confirmed. Reach rate and
        mobilisation rate, the funnel by day and venue, daily pace against target, and the
        randomised control arm.
      </p>
      <PageNav
        active={page}
        onChange={setPage}
        pages={[
          { key: "funnel", label: "Recruitment Funnel" },
          { key: "forecast", label: "Mobilisation Forecasts" },
          { key: "mobilisers", label: "Mobiliser Performance" },
          { key: "control", label: "Control Mobilisation Calls" },
          { key: "insights", label: "Call Centre Insights" },
        ]}
      />
      {page === "funnel" && <MobRecruitmentFunnelPage filters={filters} />}
      {page === "forecast" && <MobForecastsPage filters={filters} />}
      {page === "mobilisers" && <MobPerformancePage filters={filters} />}
      {page === "control" && <MobControlCallsPage />}
      {page === "insights" && <MobCallCentreInsightsPage />}
    </div>
  );
}

function MobRecruitmentFunnelPage({ filters }) {
  const drill = useDrill();
  const mob = useApi(`/api/recruitment/mobilisation${buildParams(filters)}`);
  const heatmap = useApi(`/api/recruitment/mobilisation-heatmap${buildParams(filters)}`);
  const filterMeta = useApi("/api/filters");
  const allDistricts = filterMeta.data?.districts || [];
  const data = mob.data;
  const cells = heatmap.data?.cells || [];

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

  const venueTotals = {};
  cells.forEach((c) => {
    const v = venueTotals[c.venue] || { reached: 0, confirmed: 0 };
    v.reached += c.reached || 0;
    v.confirmed += c.confirmed || 0;
    venueTotals[c.venue] = v;
  });
  const venueRows = Object.entries(venueTotals).map(([venue, v]) => {
    const rate = v.reached ? Math.round((1000 * v.confirmed) / v.reached) / 10 : null;
    const category = categorizeVenue(rate);
    return { venue, ...v, rate, category };
  }).sort((a, b) => b.confirmed - a.confirmed);

  const busiestDay = cells.reduce((best, c) => {
    const day = best[c.event_date] || 0;
    best[c.event_date] = day + (c.confirmed || 0);
    return best;
  }, {});
  const busiestDayEntry = Object.entries(busiestDay).sort((a, b) => b[1] - a[1])[0];
  const topVenue = venueRows[0];

  return (
    <div>
      <ExecBand num="◆" title="Progress on target" />
      <State loading={mob.loading} error={mob.error} empty={!mob.loading && !data}>
        <Grid cols={4}>
          <KpiTile label="Assigned to treatment" value={fmtNum(data?.assigned)} tag="REAL" onClick={() => openMobDrill("assigned", "Assigned to treatment")} />
          <KpiTile label="Youth reached" value={fmtNum(data?.reached)} sub={`of ${fmtNum(data?.four_week?.assigned)} assigned (4-week cycle)`} tag="REAL" onClick={() => openMobDrill("reached", "Youth reached")} />
          <KpiTile label="Reach rate" value={fmtPct(data?.reach_rate)} sub="reached ÷ assigned (4-week cycle)" tag="REAL" onClick={() => openMobDrill("reach_rate", "Reach rate", fmtPct)} />
          <KpiTile label="Youth confirmed" value={fmtNum(data?.confirmed)} sub={`of ${fmtNum(data?.assigned)} assigned`} tag="REAL" onClick={() => openMobDrill("confirmed", "Youth confirmed")} />
          <KpiTile label="Confirmed female" value={fmtNum(data?.confirmed_female)} sub={`${fmtPct(data?.confirmed_female_pct)} of confirmed · target 60%`} tag="REAL" onClick={() => openMobDrill("confirmed_female", "Confirmed female")} />
          <KpiTile label="Mobilisation rate" value={fmtPct(data?.mobilisation_rate)} sub="confirmed ÷ assigned to treatment" tag="REAL" onClick={() => openMobDrill("mobilisation_rate", "Mobilisation rate", fmtPct)} />
          <KpiTile label="Progress on target" value={fmtPct(data?.progress_pct)} sub={`confirmed ÷ target (${fmtNum(data?.target)})`} tag="REAL" onClick={() => openMobDrill("progress_pct", "Progress on target", fmtPct)} />
        </Grid>
        <Card title="4-week vs 2.5-week cycle" subtitle="The 2.5-week pilot subcounties are auto-confirmed by policy — blending them into one rate hides the real call-center conversion" chip="REAL">
          <DataTable
            columns={[
              { key: "label", label: "Cycle" },
              { key: "assigned", label: "Assigned", align: "right", render: (v) => fmtNum(v) },
              { key: "reached", label: "Reached", align: "right", render: (v) => fmtNum(v) },
              { key: "confirmed", label: "Confirmed", align: "right", render: (v) => fmtNum(v) },
              { key: "reach_rate", label: "Reach rate", align: "right", render: (v) => fmtPct(v) },
              { key: "mobilisation_rate", label: "Mobilisation rate", align: "right", render: (v) => fmtPct(v) },
            ]}
            rows={[
              { label: "4-week cycle", ...data?.four_week },
              { label: "2.5-week cycle (auto-confirm)", ...data?.two_half_week },
              { label: "Overall (blended)", assigned: data?.assigned, reached: data?.reached, confirmed: data?.confirmed, reach_rate: data?.reach_rate, mobilisation_rate: data?.mobilisation_rate },
            ]}
          />
        </Card>
      </State>

      <Card title="Heat map — unique calls & confirmed youth, by day" subtitle="Colour intensity = confirmed youth that day. Read across each row to spot high-effort / low-yield venues." chip="REAL">
        <State loading={heatmap.loading} error={heatmap.error} empty={!heatmap.loading && cells.length === 0}>
          <Heatmap data={cells} xKey="event_date" yKey="venue" valueKey="confirmed" />
        </State>
      </Card>

      <ExecBand num="!" title="Insights" />
      <State loading={heatmap.loading} error={heatmap.error} empty={!heatmap.loading && cells.length === 0}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
          {busiestDayEntry && (
            <Insight tone="neutral"><b>{busiestDayEntry[0]}</b> was the highest-yield day, with {fmtNum(busiestDayEntry[1])} youth confirmed across all venues.</Insight>
          )}
          {topVenue && (
            <Insight tone="pos"><b>{topVenue.venue}</b> confirmed the most youth overall ({fmtNum(topVenue.confirmed)}, {fmtPct(topVenue.rate)} of reached).</Insight>
          )}
          {venueRows.filter((v) => v.category === "High Risk").length > 0 && (
            <Insight tone="risk"><b>{venueRows.filter((v) => v.category === "High Risk").length} venue(s)</b> are confirming fewer than 75% of reached youth — see the table below.</Insight>
          )}
        </div>
      </State>

      <ExecBand num="◆" title="Performance categorisation — venues vs target (filters)" />
      <State loading={heatmap.loading} error={heatmap.error} empty={!heatmap.loading && venueRows.length === 0}>
        <VenueCategorisation
          venueRows={venueRows}
          metricA={{ key: "reached", label: "Reached" }}
          metricB={{ key: "confirmed", label: "Confirmed" }}
          rateFraction="confirmed ÷ reached"
        />
      </State>
    </div>
  );
}

// Categories mirror the reference design's venue risk bands, but the rate is
// confirmed ÷ reached (call-center conversion) rather than confirmed ÷
// assigned — no live table carries a per-venue assigned/target figure (see
// tables.py's DAILY_ACQUISITION_SUMMARY note), so reached is the closest real
// per-venue denominator available.
const VENUE_CATEGORY_ORDER = ["Target Achieved", "On Track", "Low Risk", "High Risk", "Not Started"];
const VENUE_CATEGORY_COLOR = { "Target Achieved": C.green, "On Track": C.teal, "Low Risk": C.gold, "High Risk": C.coral, "Not Started": C.muted };
function categorizeVenue(rate) {
  if (rate == null) return "Not Started";
  if (rate >= 95) return "Target Achieved";
  if (rate >= 85) return "On Track";
  if (rate >= 75) return "Low Risk";
  return "High Risk";
}

const PAGER_BTN = { fontSize: 11, fontWeight: 700, padding: "5px 10px", border: `1px solid ${C.line}`, borderRadius: 4, background: C.white, color: C.inkSoft, cursor: "pointer" };

function VenuePagedTable({ title, subtitle, chip, chipTone, rows, metricA, metricB }) {
  const [page, setPage] = useState(0);
  const pageSize = 5;
  const maxPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const clamped = Math.min(page, maxPage);
  const slice = rows.slice(clamped * pageSize, clamped * pageSize + pageSize);
  return (
    <Card title={title} subtitle={subtitle} chip={chip} chipTone={chipTone}>
      <DataTable
        columns={[
          { key: "venue", label: "Venue" },
          { key: metricA.key, label: metricA.label, align: "right", render: (v) => fmtNum(v) },
          { key: metricB.key, label: metricB.label, align: "right", render: (v) => fmtNum(v) },
          { key: "rate", label: "Rate", align: "right", render: (v) => fmtPct(v) },
          { key: "category", label: "Status", render: (v) => <span style={{ color: VENUE_CATEGORY_COLOR[v], fontWeight: 700 }}>{v}</span> },
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

function VenueCategorisation({ venueRows, metricA, metricB, rateFraction }) {
  const [cat, setCat] = useState("All");
  const counts = { All: venueRows.length };
  VENUE_CATEGORY_ORDER.forEach((c) => { counts[c] = venueRows.filter((v) => v.category === c).length; });
  const filtered = cat === "All" ? venueRows : venueRows.filter((v) => v.category === cat);
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
        <b>How to use these filters.</b> Click a category to filter the score cards and venue tables below to just those venues. Click <b>All</b> to reset.
      </Insight>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0 16px" }}>
        {["All", ...VENUE_CATEGORY_ORDER].map((c) => {
          const active = cat === c;
          const color = c === "All" ? C.ink : VENUE_CATEGORY_COLOR[c];
          return (
            <div key={c} onClick={() => setCat(c)} style={{
              cursor: "pointer", flex: 1, minWidth: 110, textAlign: "center", padding: "10px 8px",
              borderRadius: 8, border: `2px solid ${active ? color : C.line}`,
              background: active ? "rgba(15,34,56,.04)" : C.white,
              boxShadow: active ? "0 1px 5px rgba(0,0,0,.10)" : "none",
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color }}>{c}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color }}>{counts[c] ?? 0}</div>
              <div style={{ fontSize: 10, color: C.muted }}>{c === "All" ? "all venues" : "venues"}</div>
            </div>
          );
        })}
      </div>
      <Grid cols={4}>
        <KpiTile label="Venues in view" value={String(filtered.length)} sub={cat} tag="REAL" />
        <KpiTile label={`${metricA.label} (sum)`} value={fmtNum(sumA)} sub="sum of these venues" tag="REAL" />
        <KpiTile label={`${metricB.label} (sum)`} value={fmtNum(sumB)} sub="sum of these venues" tag="REAL" />
        <KpiTile label="Rate" value={fmtPct(filteredRate)} sub={rateFraction} tag="DERIVED" tone="sim" />
      </Grid>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <VenuePagedTable title="Top venues" subtitle={`Highest rate (${rateFraction})`} chip="STRONGEST" chipTone="real" rows={sortedDesc} metricA={metricA} metricB={metricB} />
        <VenuePagedTable title="Bottom venues" subtitle="Lowest — priority for a closing follow-up round" chip="FOLLOW UP" chipTone="sim" rows={sortedAsc} metricA={metricA} metricB={metricB} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
        <Insight tone={counts["Target Achieved"] + counts["On Track"] >= filtered.length / 2 ? "pos" : "neutral"}>
          <b>{counts["Target Achieved"]}</b> venue(s) have hit Target Achieved and <b>{counts["On Track"]}</b> are On Track, out of {venueRows.length} reporting venues.
        </Insight>
        {closestToTarget && (
          <Insight tone="warn">
            <b>{closestToTarget.venue}</b> is the closest venue below target ({fmtPct(closestToTarget.rate)} {rateFraction}) — one follow-up round would likely tip it into On Track.
          </Insight>
        )}
      </div>
    </div>
  );
}

function MobForecastsPage({ filters }) {
  const { data, loading, error } = useApi(`/api/recruitment/mobilisation-forecast${buildParams(filters)}`);
  const daily = data?.daily || [];
  return (
    <div>
      <Grid cols={4}>
        <KpiTile label="Confirmed to date" value={fmtNum(data?.confirmed_to_date)} tag="REAL" />
        <KpiTile label="Mobilisation target" value={fmtNum(data?.target)} tag="REAL" />
        <KpiTile label="Avg daily rate" value={fmtNum(data?.avg_daily_rate)} tag="REAL" />
        <KpiTile label="Days to target" value={data?.days_to_target ?? "—"} sub="At current pace" tag="DERIVED" tone="sim" />
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
        columns are all 100% empty.
      </p>
      <MobilisersTab filters={filters} />
    </div>
  );
}

function MobControlCallsPage() {
  const { data, loading, error } = useApi(`/api/recruitment/control-calls`);
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
          <KpiTile label="Female share" value={fmtPct(data?.pct_female)} sub="target 60%" tag="REAL" />
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
            />
          </Card>
        </div>
      </State>
    </div>
  );
}

function MobCallCentreInsightsPage() {
  const barriers = useApi(`/api/recruitment/call-centre-insights`);
  const rows = barriers.data?.barriers || [];
  return (
    <div>
      <p style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
        What barriers youth raise on mobilisation/acquisition calls, from the call log
        (a call can raise more than one barrier). "Questions youth ask" has no structured
        source in the live data yet — a coded call-notes export would be needed to add it.
      </p>
      <Card title="Barriers youth raise" subtitle="Reasons given for not attending / hesitating (share of all barriers)" chip="REAL">
        <State loading={barriers.loading} error={barriers.error} empty={!barriers.loading && rows.length === 0}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={rows} layout="vertical" margin={{ left: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="barrier" tick={{ fontSize: 10 }} width={160} />
              <Tooltip />
              <Bar dataKey="count" fill={C.coral} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </State>
      </Card>
      <Card title="Barriers detail" chip="REAL">
        <State loading={barriers.loading} error={barriers.error} empty={!barriers.loading && rows.length === 0}>
          <DataTable
            columns={[
              { key: "barrier", label: "Barrier" },
              { key: "count", label: "# Youth", align: "right", render: (v) => fmtNum(v) },
              { key: "pct", label: "% of barriers", align: "right", render: (v) => fmtPct(v) },
            ]}
            rows={rows}
          />
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
        />
      </State>
    </Card>
  );
}

// Status bands come straight off TAM_PARISH.status — matches the reference
// design's Met Target / On Track / At Risk / Low-Critical coverage bands.
const TAM_STATUS_COLOR = { "Met Target": C.green, "On Track": C.teal, "At Risk": C.gold, "Low / Critical": C.coral };

function TamTab({ filters }) {
  const q = buildParams(filters);
  const tam = useApi(`/api/recruitment/tam${q}`);
  const coverage = useApi(`/api/recruitment/tam-coverage${q}`);
  const [page, setPage] = useState(0);
  const pageSize = 8;

  const parishes = tam.data?.parishes || [];
  const coverageRows = coverage.data?.coverage || [];
  const loading = tam.loading || coverage.loading;
  const error = tam.error || coverage.error;

  const totalPredicted = sumBy(parishes, "predicted");
  const totalActual = sumBy(parishes, "actual");
  const marketShare = totalPredicted ? Math.round((1000 * totalActual) / totalPredicted) / 10 : null;

  const femaleRows = parishes.filter((p) => p.pct_female != null);
  const avgFemale = femaleRows.length
    ? Math.round((10 * femaleRows.reduce((s, p) => s + p.pct_female, 0)) / femaleRows.length) / 10
    : null;

  const statusCounts = {};
  parishes.forEach((p) => { statusCounts[p.status] = (statusCounts[p.status] || 0) + 1; });
  const statusSummary = Object.entries(statusCounts).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(" · ");

  const totalParishUniverse = sumBy(coverageRows, "total_parishes");
  const totalCovered = sumBy(coverageRows, "covered_parishes");
  const coverageRate = totalParishUniverse ? Math.round((1000 * totalCovered) / totalParishUniverse) / 10 : null;

  // Merge each district's predicted/actual (summed off the parish rows) onto
  // its coverage record — the two endpoints share a district key but nothing
  // else, so this is a plain client-side join rather than new backend SQL.
  const byDistrict = {};
  parishes.forEach((p) => {
    const d = byDistrict[p.district] || (byDistrict[p.district] = { predicted: 0, actual: 0 });
    d.predicted += p.predicted || 0;
    d.actual += p.actual || 0;
  });
  const saturationRows = coverageRows
    .map((c) => {
      const agg = byDistrict[c.district] || { predicted: 0, actual: 0 };
      return {
        ...c,
        market_share: agg.predicted ? Math.round((1000 * agg.actual) / agg.predicted) / 10 : null,
        coverage_pct: c.total_parishes ? Math.round((1000 * c.covered_parishes) / c.total_parishes) / 10 : null,
      };
    })
    .sort((a, b) => (b.coverage_pct || 0) - (a.coverage_pct || 0));

  const maxPage = Math.max(0, Math.ceil(parishes.length / pageSize) - 1);
  const clampedPage = Math.min(page, maxPage);
  const parishSlice = parishes.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>TAM Analysis</h2>
      <p style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>
        Total addressable market and coverage across the operating districts and parishes —
        TAM validation, market share captured, and where coverage is thinnest.
      </p>

      <ExecBand num={1} title="TAM at a glance" />
      <State loading={loading} error={error} empty={!loading && !error && parishes.length === 0}>
        <Grid cols={4}>
          <KpiTile label="Parishes reported" value={fmtNum(parishes.length)} sub={statusSummary || "no status breakdown"} tag="REAL" />
          <KpiTile label="Market share captured" value={fmtPct(marketShare)} sub={`${fmtNum(totalActual)} actual ÷ ${fmtNum(totalPredicted)} predicted`} tag="REAL" />
          <KpiTile label="TAM coverage" value={fmtPct(coverageRate)} sub={`${fmtNum(totalCovered)} of ${fmtNum(totalParishUniverse)} parishes covered`} tag="REAL" />
          <KpiTile label="Female share (TAM parishes)" value={fmtPct(avgFemale)} sub="target 60%" tag="REAL" />
        </Grid>
      </State>

      <ExecBand num={2} title="District saturation status" />
      <Card title="Coverage &amp; market share by district" subtitle="Market share captured = actual youth reached ÷ TAM-predicted youth, summed per district. Coverage = parishes with a TAM record ÷ total parishes in that district." chip="REAL">
        <State loading={coverage.loading} error={coverage.error} empty={!coverage.loading && saturationRows.length === 0}>
          <DataTable
            columns={[
              { key: "district", label: "District" },
              { key: "cycles", label: "Cohorts covered" },
              { key: "total_parishes", label: "Total parishes", align: "right", render: (v) => fmtNum(v) },
              { key: "covered_parishes", label: "Covered", align: "right", render: (v) => fmtNum(v) },
              { key: "coverage_pct", label: "Coverage", align: "right", render: (v) => fmtPct(v) },
              { key: "market_share", label: "Market share captured", align: "right", render: (v) => fmtPct(v) },
            ]}
            rows={saturationRows}
          />
        </State>
      </Card>

      <ExecBand num={3} title="Parish-level detail" />
      <Card title="Predicted vs actual by parish" subtitle="Validation rate = actual ÷ predicted. Status bands: Met Target / On Track / At Risk / Low-Critical." chip="REAL">
        <State loading={tam.loading} error={tam.error} empty={!tam.loading && parishes.length === 0}>
          <DataTable
            columns={[
              { key: "district", label: "District" },
              { key: "parish", label: "Parish" },
              { key: "predicted", label: "Predicted", align: "right", render: (v) => fmtNum(v) },
              { key: "actual", label: "Actual", align: "right", render: (v) => fmtNum(v) },
              { key: "validation_rate", label: "Validation %", align: "right", render: (v) => fmtPct(v) },
              { key: "status", label: "Status", render: (v) => <span style={{ color: TAM_STATUS_COLOR[v] || C.muted, fontWeight: 700 }}>{v}</span> },
            ]}
            rows={parishSlice}
          />
          {parishes.length > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9, fontSize: 11, color: C.muted }}>
              <span>{clampedPage * pageSize + 1}–{Math.min(parishes.length, clampedPage * pageSize + pageSize)} of {parishes.length}</span>
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

// Recruitment's own Gender view — same /api/overview/gender data as the
// Executive Summary's "Gender performance summary" band, but with the full
// funnel-by-gender chart, per-stage target gauges, and a district comparison
// (female share of Acquired) that Executive Summary doesn't have room for.
function RecruitmentGenderTab({ filters }) {
  const q = buildParams(filters);
  const gender = useApi(`/api/overview/gender${q}`);
  const filterMeta = useApi("/api/filters");
  const allDistricts = filterMeta.data?.districts || [];
  const stages = gender.data?.stages || [];

  const [districtRows, setDistrictRows] = useState([]);
  const [districtLoading, setDistrictLoading] = useState(false);
  const [districtError, setDistrictError] = useState(null);

  // No single /api/overview/gender response carries a by-district breakdown
  // (same gap as the Executive Summary's rate drills) — fire one request per
  // district, pulling out just the Acquired stage's female/male split.
  useEffect(() => {
    if (!allDistricts.length) return;
    let alive = true;
    // Resetting load/error state at the start of a (re)fetch is the intended
    // React<->network sync point; the strict rule flags it as a false positive.
    /* eslint-disable react-hooks/set-state-in-effect */
    setDistrictLoading(true);
    setDistrictError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    Promise.all(
      allDistricts.map((d) =>
        apiGet(`/api/overview/gender${buildParamsOverride(filters, { district: d })}`)
          .then((json) => {
            const acquired = (json?.stages || []).find((s) => s.stage === "Acquired");
            return { district: d, female: acquired?.female ?? null, male: acquired?.male ?? null, pct_female: acquired?.pct_female ?? null };
          })
          .catch(() => ({ district: d, female: null, male: null, pct_female: null }))
      )
    ).then((rows) => {
      if (!alive) return;
      rows.sort((a, b) => (b.pct_female ?? -1) - (a.pct_female ?? -1));
      setDistrictRows(rows);
      setDistrictLoading(false);
    }).catch((e) => { if (alive) { setDistrictError(e.message); setDistrictLoading(false); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDistricts.join("|"), filters.district, filters.gender, filters.cohort]);

  const acquiredStage = stages.find((s) => s.stage === "Acquired");
  const registeredStage = stages.find((s) => s.stage === "Registered");
  const scoredStages = stages.filter((s) => s.pct_female != null);
  const flaggedStages = scoredStages.filter((s) => Math.abs(s.pct_female - 60) > 5);
  const worstStage = scoredStages.reduce((worst, s) => {
    const gap = Math.abs(s.pct_female - 60);
    return (!worst || gap > worst.gap) ? { stage: s.stage, pct_female: s.pct_female, gap } : worst;
  }, null);

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: C.ink, marginBottom: 4 }}>Gender</h2>
      <p style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>
        Male vs female across every funnel stage, measured against the 60% female target. Any
        stage more than 5pp off target is flagged automatically.
      </p>

      <ExecBand num={1} title="Gender at a glance" />
      <State loading={gender.loading} error={gender.error} empty={!gender.loading && stages.length === 0}>
        <Grid cols={4}>
          <KpiTile label="Female share — Acquired" value={fmtPct(acquiredStage?.pct_female)} sub="target 60%" tag="REAL" />
          <KpiTile label="Female share — Registered" value={fmtPct(registeredStage?.pct_female)} sub="funnel entry point" tag="REAL" />
          <KpiTile label="Stages within target" value={`${scoredStages.length - flaggedStages.length}/${scoredStages.length}`} sub="within 5pp of the 60% target" tag="DERIVED" />
          <KpiTile
            label="Largest gap"
            value={worstStage ? <span style={{ color: worstStage.gap > 5 ? C.coral : "inherit" }}>{fmtPct(worstStage.pct_female)}</span> : "—"}
            sub={worstStage ? `${worstStage.stage} — ${Math.round(worstStage.gap * 10) / 10}pp off target` : "no gap flagged"}
            tag="REAL"
          />
        </Grid>
      </State>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <div>
          <ExecBand num={2} title="Funnel by gender" />
          <Card title="Counts by stage" subtitle="Registered through Acquired. Click a legend entry to isolate a series." chip="REAL">
            <State loading={gender.loading} error={gender.error} empty={!gender.loading && stages.length === 0}>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={stages} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
                  <XAxis dataKey="stage" tick={{ fontSize: 10 }} interval={0} angle={-35} textAnchor="end" height={70} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip /><Legend />
                  <Bar dataKey="female" name="Female" fill={C.coral} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="male" name="Male" fill={C.teal} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </State>
          </Card>
        </div>
        <div>
          <ExecBand num={3} title="Female share vs 60% target" />
          <Card title="Share of each stage that is female" subtitle="Gaps over 5pp vs target are highlighted." chip="DERIVED">
            <State loading={gender.loading} error={gender.error} empty={!gender.loading && stages.length === 0}>
              <div style={{ paddingTop: 8, maxHeight: 300, overflowY: "auto" }}>
                {stages.map((s) => <Gauge key={s.stage} label={s.stage} pct={s.pct_female} target={60} />)}
              </div>
            </State>
          </Card>
        </div>
      </div>

      <ExecBand num={4} title="Stage-by-stage comparison" />
      <Card title="Female and male counts vs the 60% target" chip="REAL">
        <State loading={gender.loading} error={gender.error} empty={!gender.loading && stages.length === 0}>
          <GenderStageTable stages={stages} />
        </State>
      </Card>

      <ExecBand num={5} title="District comparison" />
      <Card title="Female share of Acquired, by district" subtitle="Same 60% target, one row per district." chip="REAL">
        <State loading={districtLoading} error={districtError} empty={!districtLoading && (districtRows || []).length === 0}>
          <DataTable
            columns={[
              { key: "district", label: "District" },
              { key: "female", label: "Female", align: "right", render: (v) => fmtNum(v) },
              { key: "male", label: "Male", align: "right", render: (v) => fmtNum(v) },
              {
                key: "pct_female", label: "% Female", align: "right",
                render: (v) => <span style={{ color: v != null && Math.abs(v - 60) > 5 ? C.coral : "inherit", fontWeight: v != null && Math.abs(v - 60) > 5 ? 700 : 400 }}>{fmtPct(v)}</span>,
              },
            ]}
            rows={districtRows || []}
          />
        </State>
      </Card>
    </div>
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
  const rows = data?.by_venue || [];
  const rateFns = {
    activation_rate: (d) => (d.acquired ? Math.round((1000 * d.activated) / d.acquired) / 10 : null),
    retention_rate: (d) => (d.activated ? Math.round((1000 * d.retained) / d.activated) / 10 : null),
  };

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
    <Card title="Retention by venue" subtitle={`Targets — activation ${data?.targets?.activation ?? 90}%, retention ${data?.targets?.retention ?? 85}%`} chip="REAL">
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <DataTable
          columns={[
            { key: "district", label: "District" },
            { key: "venue", label: "Venue" },
            { key: "acquired", label: "Acquired", align: "right", onHeaderClick: () => openMetricDrill("acquired", "Acquired") },
            { key: "activated", label: "Activated", align: "right", onHeaderClick: () => openMetricDrill("activated", "Activated") },
            { key: "retained", label: "Retained", align: "right", onHeaderClick: () => openMetricDrill("retained", "Retained") },
            { key: "activation_rate", label: "Activation %", align: "right", render: (v) => fmtPct(v), onHeaderClick: () => openMetricDrill("activation_rate", "Activation rate", fmtPct) },
            { key: "retention_rate", label: "Retention %", align: "right", render: (v) => fmtPct(v), onHeaderClick: () => openMetricDrill("retention_rate", "Retention rate", fmtPct) },
          ]}
          rows={rows}
        />
      </State>
    </Card>
  );
}

function AttendanceTab({ filters }) {
  const { data, loading, error } = useApi(`/api/implementation/attendance${buildParams(filters)}`);
  const rows = data?.daily || [];
  return (
    <div>
      <Card title="Daily attendance & churn" subtitle="Youth present per day, and net churn (present minus newly absent) — programme-wide, not yet broken out by venue" chip="REAL">
        <State loading={loading} error={error} empty={!loading && rows.length === 0}>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="event_date" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip /><Legend />
              <Line type="monotone" dataKey="present" name="Present" stroke={C.teal} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="net_churn" name="Net churn" stroke={C.coral} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </State>
      </Card>
      <Insight tone="neutral">
        Per-lesson attendance isn't shown yet — no per-lesson attendance-% table has been confirmed against
        live BigQuery. This page will grow a lesson-by-lesson breakdown once one is.
      </Insight>
    </div>
  );
}

function RetentionCallsTab({ filters }) {
  const { data, loading, error } = useApi(`/api/implementation/retention-calls${buildParams(filters)}`);
  const rows = data?.daily || [];
  return (
    <Card title="Retention follow-up calls" subtitle="Daily follow-up funnel for absent youth — called → reached → promised to return → returned" chip="SAMPLE" chipTone="sim">
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
            <XAxis dataKey="event_date" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip /><Legend />
            <Bar dataKey="called" name="Called" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
            <Bar dataKey="reached" name="Reached" fill={CHART_COLORS[1]} radius={[4, 4, 0, 0]} />
            <Bar dataKey="promised" name="Promised to return" fill={CHART_COLORS[2]} radius={[4, 4, 0, 0]} />
            <Bar dataKey="returned" name="Returned" fill={CHART_COLORS[3]} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </State>
    </Card>
  );
}

function TrainersTab({ filters }) {
  const drill = useDrill();
  const { data, loading, error } = useApi(`/api/implementation/trainers${buildParams(filters)}`);
  const rows = data?.trainers || [];

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
      title: "Avg observation score — by district",
      tone: "real", tagLabel: "REAL",
      rootKey: "district", rootLabel: "District",
      columns: [{ key: "score", label: "Avg score", align: "right", render: (v) => (v == null ? "—" : v.toFixed(2)) }],
      rootRows,
      childKey: "trainer_name", childLabel: "Trainer",
      getChildRows: (root) => rows.filter((r) => r.district === root.district).sort((a, b) => (b.score || 0) - (a.score || 0)),
    });
  }

  return (
    <Card title="Trainer quality" subtitle="Observation scores — names shown to staff only" chip="PII" chipTone="pii">
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <DataTable
          columns={[
            { key: "trainer_name", label: "Trainer" },
            { key: "venue", label: "Venue" },
            { key: "district", label: "District" },
            { key: "rating", label: "Rating" },
            { key: "score", label: "Score", align: "right", onHeaderClick: openScoreDrill },
          ]}
          rows={rows}
        />
      </State>
    </Card>
  );
}

function MilestonesTab({ filters }) {
  const { data, loading, error } = useApi(`/api/implementation/milestones${buildParams(filters)}`);
  const rows = data?.weekly || [];
  return (
    <Card title="Weekly business-pitch milestones" subtitle="Below / meets / exceeds expectations by week, plus completion and parental-attendance rate" chip="SAMPLE" chipTone="sim">
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
            <XAxis dataKey="week_number" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip /><Legend />
            <Bar dataKey="below" name="Below" stackId="w" fill={C.coral} />
            <Bar dataKey="meet" name="Meets" stackId="w" fill={C.gold} />
            <Bar dataKey="exceed" name="Exceeds" stackId="w" fill={C.green} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <DataTable
          columns={[
            { key: "week_number", label: "Week" },
            { key: "completion_pct", label: "Completion", align: "right", render: (v) => fmtPct(v) },
            { key: "parent_present_pct", label: "Parent present", align: "right", render: (v) => fmtPct(v) },
          ]}
          rows={rows}
        />
      </State>
    </Card>
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
    what: "4 sub-pages — Funnel Overview, Mobilisers, KYC / Youth Profile, Forecast. Registered → interested → eligible by district, parish and mobiliser; youth demographics; registration-pace forecast." },
  { group: "Recruitment", page: "Mobilisation", tone: "real", navGroup: "rec", navTab: "mob",
    summary: "Assigned → reached → confirmed, 4-week vs 2.5-week cycles.",
    what: "5 sub-pages — Recruitment Funnel, Mobilisation Forecasts, Mobiliser Performance, Control Mobilisation Calls, Call Centre Insights. Assigned → reached → confirmed, split 4-week vs 2.5-week pilot cycles; day×venue heat map; the randomised control arm; barriers youth raise on calls." },
  { group: "Recruitment", page: "Acquisition", tone: "real", navGroup: "rec", navTab: "acq",
    summary: "Verified → acquired by district; venue risk categories.",
    what: "2 sub-pages — Overview, Arrival & Verification. Verified → acquired by district; venue risk categories (Target Achieved / On Track / Low Risk / High Risk)." },
  { group: "Recruitment", page: "TAM Analysis", tone: "real", navGroup: "rec", navTab: "tam",
    summary: "Market share captured & coverage, by district and parish.",
    what: "TAM at a glance (parishes reported, market share captured, coverage, female share); district saturation status (total vs covered parishes, coverage %, market share); parish-level predicted vs. actual with a Met Target / On Track / At Risk / Low-Critical status band." },
  { group: "Recruitment", page: "Gender", tone: "real", navGroup: "rec", navTab: "gender",
    summary: "Funnel by gender, female-share gauges, district comparison.",
    what: "Funnel by gender (counts per stage); female share vs the 60% target per stage; stage-by-stage female/male table; district comparison of female share of Acquired." },
  { group: "Implementation", page: "Retention", tone: "real", navGroup: "impl", navTab: "ret",
    summary: "Acquired → activated → retained by venue vs targets.",
    what: "Acquired → activated → retained by venue, against activation/retention targets." },
  { group: "Implementation", page: "Attendance", tone: "real", navGroup: "impl", navTab: "attendance",
    summary: "Daily present & net churn, programme-wide.",
    what: "Daily attendance and net churn (present minus newly absent). Programme-wide only — no per-venue breakdown or per-lesson attendance-% yet; those need a table that isn't confirmed against live BigQuery." },
  { group: "Implementation", page: "Retention Calls", tone: "sample", navGroup: "impl", navTab: "retcalls",
    summary: "Follow-up funnel for absent youth.",
    what: "Daily follow-up funnel for absent youth: called → reached → promised to return → returned. Still placeholder data." },
  { group: "Implementation", page: "Trainer Quality", tone: "real", navGroup: "impl", navTab: "train",
    summary: "Per-lesson scores, banded Exceeds / Meets / Below.",
    what: "Per-lesson classroom observation scores, banded Exceeds / Meets / Below expectations. Trainer names are staff-only (PII)." },
  { group: "Implementation", page: "Milestones", tone: "sample", navGroup: "impl", navTab: "milestones",
    summary: "Weekly pitch quality, below/meets/exceeds.",
    what: "Weekly business-pitch milestone distribution (below / meets / exceeds expectations), completion rate, and parental-attendance rate. Still placeholder data." },
  { group: "Implementation", page: "Youth Experience", tone: "sample", navGroup: "impl", navTab: "nps",
    summary: "Weekly NPS trend (Programme / Venue / Meals).",
    what: "Programme / Venue / Meals NPS weekly trend. Still placeholder data." },
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
        <KpiTile label="Recruitment" value="5 pages" sub="Awareness, Mobilisation, Acquisition, TAM Analysis, Gender." onClick={navigate ? () => navigate("rec") : undefined} />
        <KpiTile label="Implementation" value="6 pages" sub="Retention, Attendance, Retention Calls, Trainer Quality, Milestones, Youth Experience." onClick={navigate ? () => navigate("impl") : undefined} />
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
          Recruitment, Implementation, Field Operations, Guide) switch between groups. Below them, a
          second row switches between the pages inside that group. Awareness, Mobilisation and
          Acquisition have a third level — a row of pill-shaped buttons just under the page title —
          click those to switch sub-pages without leaving the tab.
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
    { key: "tam", label: "TAM Analysis", render: (f) => <TamTab filters={f} /> },
    { key: "gender", label: "Gender", render: (f) => <RecruitmentGenderTab filters={f} /> },
  ]},
  { key: "impl", group: "Implementation", tabs: [
    { key: "ret", label: "Retention", render: (f) => <RetentionTab filters={f} /> },
    { key: "attendance", label: "Attendance", render: (f) => <AttendanceTab filters={f} /> },
    { key: "retcalls", label: "Retention Calls", render: (f) => <RetentionCallsTab filters={f} /> },
    { key: "train", label: "Trainer Quality", render: (f) => <TrainersTab filters={f} /> },
    { key: "milestones", label: "Milestones", render: (f) => <MilestonesTab filters={f} /> },
    { key: "nps", label: "Youth Experience", render: (f) => <NpsTab filters={f} /> },
  ]},
  { key: "fops", group: "Field Operations", tabs: [
    { key: "venue", label: "Venue", render: (f) => <VenueTab filters={f} /> },
    { key: "transport", label: "Transport", render: (f) => <TransportTab filters={f} /> },
  ]},
];

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
        {(options.cohorts || ["BC2", "BC3", "BC4", "BC5"]).map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <button style={{ fontSize: 11.5, fontWeight: 700, padding: "6px 12px", border: "none", borderRadius: 4, background: C.gold, color: C.ink, cursor: "pointer" }}
        onClick={() => setFilters({ district: "", gender: "", cohort: "" })}>Reset</button>
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
        <form onSubmit={submit}>
          <input type="password" placeholder="Guest password" value={password} onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", padding: 10, border: `1px solid ${C.line}`, borderRadius: 6, marginBottom: 10 }} />
          {err && <div style={{ color: C.coral, fontSize: 12, marginBottom: 10 }}>{err}</div>}
          <button type="submit" disabled={busy} style={{ width: "100%", padding: 10, background: C.gold, color: C.ink, border: "none", borderRadius: 6, fontWeight: 700, cursor: "pointer" }}>
            {busy ? "Signing in…" : "Continue as guest"}
          </button>
        </form>
        <a href={`${API_BASE}/api/auth/google/login`} style={{ display: "block", textAlign: "center", marginTop: 12, fontSize: 13, color: C.teal, textDecoration: "none", fontWeight: 600 }}>
          Sign in with Google (staff)
        </a>
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
  const [filters, setFilters] = useState({ district: "", gender: "", cohort: "" });
  const [options, setOptions] = useState({});
  const [demoMode, setDemoMode] = useState(false);

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
    </div>
    </DrillProvider>
  );
}
