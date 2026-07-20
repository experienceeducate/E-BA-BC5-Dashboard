/*
 * Take Off Recruitment Dashboard — single-file SPA (by design until >=5 real
 * content tabs justify a split; see docs/DECISION.md).
 *
 * Auth shell -> group/sub-tab nav (state in React + sessionStorage, no router)
 * -> one component per tab, each fetching its /api/* endpoint through useApi,
 * which always sends the JWT + the X-EBA-Client header. Charts via recharts.
 * Inline styles only — no CSS framework.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
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
function Card({ title, subtitle, children, chip }) {
  const demo = useContext(DemoContext);
  return (
    <div style={{ background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, padding: 18, marginBottom: 18 }}>
      {(title || chip || demo) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            {title && <h3 style={{ fontSize: 15, color: C.ink, fontWeight: 700 }}>{title}</h3>}
            {subtitle && <p style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>{subtitle}</p>}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
            {demo && <span style={{ background: C.coral, color: C.white, fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 3, textTransform: "uppercase", letterSpacing: 0.3 }}>Demo data</span>}
            {chip && <span style={{ background: C.gold, color: C.ink, fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 3, textTransform: "uppercase" }}>{chip}</span>}
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

function KpiTile({ label, value, sub }) {
  return (
    <div style={{ background: C.white, border: `1px solid ${C.line}`, borderRadius: 8, padding: 16, flex: "1 1 160px" }}>
      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, color: C.ink, marginTop: 4 }}>{value ?? "—"}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{sub}</div>}
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

function DataTable({ columns, rows }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>{columns.map((c) => (
            <th key={c.key} style={{ textAlign: c.align || "left", padding: "8px 10px", borderBottom: `2px solid ${C.line}`, color: C.muted, fontWeight: 600, textTransform: "uppercase", fontSize: 11 }}>{c.label}</th>
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

// ─── Executive Summary ───────────────────────────────────────────────────────
function ExecutiveSummary({ filters }) {
  const q = buildParams(filters);
  const kpis = useApi(`/api/overview/kpis${q}`);
  const funnel = useApi(`/api/overview/funnel${q}`);
  const gender = useApi(`/api/overview/gender${q}`);
  const barriers = useApi(`/api/overview/eligibility-barriers${q}`);
  const cohorts = useApi(`/api/overview/cohort-comparison`);

  const rates = kpis.data?.rates || {};
  const stages = funnel.data?.stages || [];

  return (
    <div>
      <Card title="Executive conversion metrics" subtitle="Headline rates across the Take Off recruitment funnel">
        <State loading={kpis.loading} error={kpis.error} empty={!kpis.loading && !kpis.error && Object.keys(rates).length === 0}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <KpiTile label="Eligibility" value={fmtPct(rates.eligibility_rate)} sub="Eligible / Interested" />
            <KpiTile label="Mobilisation" value={fmtPct(rates.mobilisation_rate)} sub="Confirmed / Reached" />
            <KpiTile label="Acquisition" value={fmtPct(rates.acquisition_rate)} sub="Acquired / Confirmed" />
            <KpiTile label="Activation" value={fmtPct(rates.activation_rate)} sub="Activated / Acquired" />
            <KpiTile label="Retention" value={fmtPct(rates.retention_rate)} sub="Retained / Activated" />
          </div>
        </State>
      </Card>

      <Card title="Overall recruitment funnel" subtitle="Registered → … → Retained. % is of the previous stage." chip="Funnel">
        <State loading={funnel.loading} error={funnel.error} empty={!funnel.loading && stages.length === 0}>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={stages} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="stage" tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={60} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="count" fill={C.teal} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </State>
      </Card>

      <Card title="Gender performance by stage" subtitle="Female share of each stage vs the 60% target">
        <State loading={gender.loading} error={gender.error} empty={!gender.loading && (gender.data?.stages || []).length === 0}>
          <DataTable
            columns={[
              { key: "stage", label: "Stage" },
              { key: "female", label: "Female", align: "right" },
              { key: "male", label: "Male", align: "right" },
              { key: "pct_female", label: "% Female", align: "right", render: (v) => fmtPct(v) },
              { key: "target_female", label: "Target", align: "right", render: (v) => fmtPct(v) },
            ]}
            rows={gender.data?.stages || []}
          />
        </State>
      </Card>

      <Card title="Why reached youth do not qualify" subtitle="Eligibility barriers (a youth can fail more than one)">
        <State loading={barriers.loading} error={barriers.error} empty={!barriers.loading && (barriers.data?.barriers || []).length === 0}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={barriers.data?.barriers || []} layout="vertical" margin={{ left: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="barrier" tick={{ fontSize: 11 }} width={140} />
              <Tooltip />
              <Bar dataKey="count" fill={C.coral} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </State>
      </Card>

      <Card title="Cohort comparison" subtitle="BC2 → BC5 side by side">
        <State loading={cohorts.loading} error={cohorts.error} empty={!cohorts.loading && (cohorts.data?.cohorts || []).length === 0}>
          <DataTable
            columns={[
              { key: "cohort", label: "Cohort" },
              { key: "eligible", label: "Eligible", align: "right" },
              { key: "acquired", label: "Acquired", align: "right" },
              { key: "pct_female", label: "% Female", align: "right", render: (v) => fmtPct(v) },
              { key: "overall_conversion", label: "Conversion", align: "right", render: (v) => fmtPct(v) },
            ]}
            rows={cohorts.data?.cohorts || []}
          />
        </State>
      </Card>
    </div>
  );
}

// ─── Recruitment tabs ──────────────────────────────────────────────────────────
function DistrictBarTab({ endpoint, filters, title, subtitle, bars }) {
  const { data, loading, error } = useApi(`${endpoint}${buildParams(filters)}`);
  const rows = data?.by_district || [];
  return (
    <Card title={title} subtitle={subtitle}>
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
            <XAxis dataKey="district" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip /><Legend />
            {bars.map((b, i) => <Bar key={b.key} dataKey={b.key} name={b.label} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[4, 4, 0, 0]} />)}
          </BarChart>
        </ResponsiveContainer>
      </State>
    </Card>
  );
}

function MobilisationTab({ filters }) {
  const { data, loading, error } = useApi(`/api/recruitment/mobilisation${buildParams(filters)}`);
  return (
    <Card title="Mobilisation" subtitle="Assigned → Reached → Confirmed">
      <State loading={loading} error={error} empty={!loading && !data}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <KpiTile label="Assigned" value={fmtNum(data?.assigned)} />
          <KpiTile label="Reached" value={fmtNum(data?.reached)} />
          <KpiTile label="Confirmed" value={fmtNum(data?.confirmed)} />
          <KpiTile label="Reach rate" value={fmtPct(data?.reach_rate)} />
          <KpiTile label="Mobilisation rate" value={fmtPct(data?.mobilisation_rate)} />
        </div>
      </State>
    </Card>
  );
}

function MobilisersTab({ filters }) {
  const { data, loading, error } = useApi(`/api/recruitment/mobilisers${buildParams(filters)}`);
  const rows = data?.mobilisers || [];
  return (
    <Card title="Mobiliser leaderboard" subtitle="Names shown to staff only" chip="PII">
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

function TamTab({ filters }) {
  const { data, loading, error } = useApi(`/api/recruitment/tam${buildParams(filters)}`);
  const rows = data?.parishes || [];
  return (
    <Card title="TAM / Market share" subtitle="Parish-level predicted vs actual & validation rate">
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
function RetentionTab({ filters }) {
  const { data, loading, error } = useApi(`/api/implementation/retention${buildParams(filters)}`);
  const rows = data?.by_venue || [];
  return (
    <Card title="Retention by venue" subtitle={`Targets — activation ${data?.targets?.activation ?? 90}%, retention ${data?.targets?.retention ?? 85}%`}>
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <DataTable
          columns={[
            { key: "district", label: "District" },
            { key: "venue", label: "Venue" },
            { key: "acquired", label: "Acquired", align: "right" },
            { key: "activated", label: "Activated", align: "right" },
            { key: "retained", label: "Retained", align: "right" },
            { key: "activation_rate", label: "Activation %", align: "right", render: (v) => fmtPct(v) },
            { key: "retention_rate", label: "Retention %", align: "right", render: (v) => fmtPct(v) },
          ]}
          rows={rows}
        />
      </State>
    </Card>
  );
}

function TrainersTab({ filters }) {
  const { data, loading, error } = useApi(`/api/implementation/trainers${buildParams(filters)}`);
  const rows = data?.trainers || [];
  return (
    <Card title="Trainer quality" subtitle="Observation scores — names shown to staff only" chip="PII">
      <State loading={loading} error={error} empty={!loading && rows.length === 0}>
        <DataTable
          columns={[
            { key: "trainer_name", label: "Trainer" },
            { key: "venue", label: "Venue" },
            { key: "district", label: "District" },
            { key: "rating", label: "Rating" },
            { key: "score", label: "Score", align: "right" },
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
    <Card title="Youth experience (NPS)" subtitle={`Programme / Venue / Meals NPS by week — target ${data?.target ?? 50}+`}>
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
    <Card title="Venue compliance" subtitle="Reports filed, compliant, and rate">
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
    <Card title="Transport timeliness" subtitle="Per-site timeliness score (0–100)">
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

// ─── Navigation model ─────────────────────────────────────────────────────────
const NAV = [
  { key: "es", group: "Executive Summary", tabs: [
    { key: "es-main", label: "Summary", render: (f) => <ExecutiveSummary filters={f} /> },
  ]},
  { key: "rec", group: "Recruitment", tabs: [
    { key: "aware", label: "Awareness", render: (f) => <DistrictBarTab endpoint="/api/recruitment/awareness" filters={f} title="Awareness" subtitle="Registered → Interested → Eligible by district" bars={[{ key: "registered", label: "Registered" }, { key: "interested", label: "Interested" }, { key: "eligible", label: "Eligible" }]} /> },
    { key: "mob", label: "Mobilisation", render: (f) => <MobilisationTab filters={f} /> },
    { key: "acq", label: "Acquisition", render: (f) => <DistrictBarTab endpoint="/api/recruitment/acquisition" filters={f} title="Acquisition" subtitle="Verified → Acquired by district" bars={[{ key: "verified", label: "Verified" }, { key: "acquired", label: "Acquired" }]} /> },
    { key: "mobs", label: "Mobilisers", render: (f) => <MobilisersTab filters={f} /> },
    { key: "tam", label: "TAM Analysis", render: (f) => <TamTab filters={f} /> },
  ]},
  { key: "impl", group: "Implementation", tabs: [
    { key: "ret", label: "Retention", render: (f) => <RetentionTab filters={f} /> },
    { key: "train", label: "Trainer Quality", render: (f) => <TrainersTab filters={f} /> },
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
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>Take Off Recruitment Dashboard</div>
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
  const [tabKey, setTabKey] = useState(() => sessionStorage.getItem("eba_tab") || "es-main");
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

  if (!token || (!userLoading && !user)) return <LoginScreen onLogin={() => setToken(getToken())} />;
  if (userLoading) return <div style={{ minHeight: "100vh", background: C.ink }} />;

  const gtab = (active) => ({ padding: "7px 16px", cursor: "pointer", fontSize: 13, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", borderRadius: "6px 6px 0 0", color: active ? C.ink : "#9FB0BF", background: active ? C.gold : "rgba(255,255,255,.06)" });
  const stab = (active) => ({ padding: "8px 12px", cursor: "pointer", fontSize: 11.5, fontWeight: 600, textTransform: "uppercase", color: active ? C.white : "#9FB0BF", borderBottom: `3px solid ${active ? C.gold : "transparent"}` });

  return (
    <div style={{ minHeight: "100vh", background: C.cream }}>
      <header style={{ background: C.ink, color: C.white, padding: "8px 24px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>EDUCATE<span style={{ color: C.gold }}>!</span> — Take Off Recruitment Funnel</div>
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
          {activeTab.render(filters)}
        </div>
      </DemoContext.Provider>
    </div>
  );
}
