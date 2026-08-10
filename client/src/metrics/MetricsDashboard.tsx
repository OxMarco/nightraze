import { Chart, type ChartConfiguration } from "chart.js/auto";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import "./dashboard.css";

interface MetricsSnapshot {
  currentPlaying: number;
  dailyActiveUsers: Array<{ date: string; users: number }>;
  sessions: { completed: number; meanPlaytimeSeconds: number };
  connection: { samples: number; meanPingMs: number; p95PingMs: number };
  locations: Array<{ location: string; users: number }>;
  bans: { last24Hours: number; last30Days: number; total: number };
  appCrashes: {
    last24Hours: number;
    last30Days: number;
    total: number;
    byKind: Array<{ kind: string; crashes: number }>;
  };
}

const TOKEN_KEY = "nightraze.metrics-token";
const REFRESH_MS = 30_000;
const mint = "#5affc8";
const coral = "#ff667f";
const gold = "#f3c969";
const grid = "rgba(138, 255, 223, 0.08)";
const tick = "rgba(203, 229, 222, 0.52)";

function storedToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; }
}

function saveToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* session-only convenience; the dashboard still works without it */ }
}

function chartOptions(showLegend = false) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 350 },
    plugins: {
      legend: {
        display: showLegend,
        position: "bottom" as const,
        labels: { color: tick, boxWidth: 10, boxHeight: 10, padding: 18, usePointStyle: true },
      },
      tooltip: {
        backgroundColor: "#0a1a1c",
        borderColor: "rgba(90,255,200,.2)",
        borderWidth: 1,
        titleColor: "#eafff8",
        bodyColor: "#b9d5ce",
        padding: 12,
      },
    },
    scales: showLegend ? undefined : {
      x: { grid: { display: false }, ticks: { color: tick, maxRotation: 0 } },
      y: { beginAtZero: true, grid: { color: grid }, ticks: { color: tick, precision: 0 } },
    },
  };
}

function useChart(config: ChartConfiguration | null) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!ref.current || !config) return;
    const chart = new Chart(ref.current, config);
    return () => chart.destroy();
  }, [config]);
  return ref;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function cleanLocation(value: string): string {
  if (value.startsWith("country:")) return value.slice(8);
  if (value.startsWith("timezone:")) return value.slice(9).replaceAll("_", " ");
  return "Unknown";
}

function thirtyDaySeries(entries: MetricsSnapshot["dailyActiveUsers"]) {
  const counts = new Map(entries.map((entry) => [entry.date, entry.users]));
  const today = new Date();
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(Date.UTC(
      today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (29 - index),
    )).toISOString().slice(0, 10);
    return { date, users: counts.get(date) ?? 0 };
  });
}

function MetricCard({ label, value, note, tone = "mint" }: {
  label: string; value: string | number; note: string; tone?: "mint" | "coral" | "gold";
}) {
  const tones = {
    mint: "text-mint-300 border-mint-400/15",
    coral: "text-coral-400 border-coral-400/15",
    gold: "text-gold-400 border-gold-400/15",
  };
  return (
    <article className={`metric-glow rounded-2xl border bg-abyss-900/80 p-5 ${tones[tone]}`}>
      <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-3 text-3xl font-medium tracking-tight sm:text-4xl">{value}</p>
      <p className="mt-3 text-xs leading-5 text-slate-500">{note}</p>
    </article>
  );
}

function Panel({ eyebrow, title, children, detail }: {
  eyebrow: string; title: string; children: React.ReactNode; detail?: string;
}) {
  return (
    <section className="metric-glow rounded-2xl border border-white/[0.06] bg-abyss-900/75 p-5 sm:p-6">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.22em] text-mint-400/55">{eyebrow}</p>
          <h2 className="mt-1 text-base font-medium text-slate-200">{title}</h2>
        </div>
        {detail && <p className="text-right text-[11px] text-slate-600">{detail}</p>}
      </div>
      {children}
    </section>
  );
}

function TokenGate({ error, loading, onSubmit }: {
  error: string; loading: boolean; onSubmit: (token: string) => void;
}) {
  const [value, setValue] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };
  return (
    <main className="metrics-grid flex min-h-full items-center justify-center bg-abyss-950 px-5 py-12 font-sans text-slate-300">
      <section className="metric-glow w-full max-w-md rounded-3xl border border-mint-400/10 bg-abyss-900/90 p-7 sm:p-9">
        <div className="mb-8 flex items-center gap-3">
          <span className="h-2.5 w-2.5 rounded-full bg-mint-400 shadow-[0_0_18px_#5affc8]" />
          <p className="text-xs uppercase tracking-[0.28em] text-mint-300">nightraze telemetry</p>
        </div>
        <h1 className="text-2xl font-medium tracking-tight text-slate-100">Enter the metrics token</h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          The token stays in this browser tab and is sent only to the aggregate metrics endpoint.
        </p>
        <form className="mt-7" onSubmit={submit}>
          <label className="sr-only" htmlFor="metrics-token">Metrics token</label>
          <input
            id="metrics-token"
            type="password"
            autoComplete="off"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="metrics token"
            className="w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-slate-200 outline-none transition placeholder:text-slate-700 focus:border-mint-400/45 focus:ring-2 focus:ring-mint-400/10"
          />
          <button
            type="submit"
            disabled={loading || !value.trim()}
            className="mt-3 w-full rounded-xl bg-mint-400 px-4 py-3 text-sm font-semibold text-abyss-950 transition hover:bg-mint-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? "Connecting…" : "Open dashboard"}
          </button>
        </form>
        {error && <p role="alert" className="mt-4 text-sm leading-6 text-coral-400">{error}</p>}
      </section>
    </main>
  );
}

function Dashboard({ data, updatedAt, refreshing, onRefresh, onLock }: {
  data: MetricsSnapshot; updatedAt: Date; refreshing: boolean; onRefresh: () => void; onLock: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const dauToday = data.dailyActiveUsers.find((entry) => entry.date === today)?.users ?? 0;
  const dauSeries = useMemo(() => thirtyDaySeries(data.dailyActiveUsers), [data.dailyActiveUsers]);

  const dauConfig = useMemo<ChartConfiguration>(() => ({
    type: "line",
    data: {
      labels: dauSeries.map((entry) => entry.date.slice(5)),
      datasets: [{
        label: "Active users",
        data: dauSeries.map((entry) => entry.users),
        borderColor: mint,
        backgroundColor: "rgba(90,255,200,.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 2,
        pointHoverRadius: 5,
      }],
    },
    options: chartOptions(),
  }), [dauSeries]);

  const pingConfig = useMemo<ChartConfiguration>(() => ({
    type: "bar",
    data: {
      labels: ["Mean", "p95"],
      datasets: [{
        label: "Milliseconds",
        data: [data.connection.meanPingMs, data.connection.p95PingMs],
        backgroundColor: ["rgba(90,255,200,.75)", "rgba(243,201,105,.75)"],
        borderRadius: 8,
        maxBarThickness: 52,
      }],
    },
    options: chartOptions(),
  }), [data.connection.meanPingMs, data.connection.p95PingMs]);

  const locationConfig = useMemo<ChartConfiguration>(() => ({
    type: "doughnut",
    data: {
      labels: data.locations.map((entry) => cleanLocation(entry.location)),
      datasets: [{
        data: data.locations.map((entry) => entry.users),
        backgroundColor: [mint, gold, coral, "#5eb6ff", "#a78bfa", "#94a3b8"],
        borderColor: "#061012",
        borderWidth: 3,
        hoverOffset: 5,
      }],
    },
    options: { ...chartOptions(true), cutout: "68%" },
  }), [data.locations]);

  const dauRef = useChart(dauConfig);
  const pingRef = useChart(pingConfig);
  const locationRef = useChart(data.locations.length ? locationConfig : null);

  return (
    <main className="metrics-grid h-full overflow-y-auto bg-abyss-950 font-sans text-slate-300 selection:bg-mint-400/20">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-9 lg:px-8">
        <header className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div>
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 rounded-full bg-mint-400 shadow-[0_0_18px_#5affc8]" />
              <p className="text-[11px] uppercase tracking-[0.28em] text-mint-300">nightraze telemetry</p>
            </div>
            <h1 className="mt-4 text-3xl font-medium tracking-[-0.04em] text-slate-100 sm:text-4xl">The abyss, measured.</h1>
            <p className="mt-2 text-sm text-slate-500">A private view of player activity, connection health, and reliability.</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="mr-2 hidden text-[11px] text-slate-600 md:inline">
              Updated {updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            <button onClick={onRefresh} disabled={refreshing} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-400 transition hover:border-mint-400/25 hover:text-mint-300 disabled:opacity-40">
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <button onClick={onLock} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-500 transition hover:border-coral-400/25 hover:text-coral-400">
              Lock
            </button>
          </div>
        </header>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="Playing now" value={data.currentPlaying} note="Living players in active runs" />
          <MetricCard label="Active today" value={dauToday} note="Anonymous unique browsers" />
          <MetricCard label="Mean playtime" value={formatDuration(data.sessions.meanPlaytimeSeconds)} note={`${data.sessions.completed.toLocaleString()} completed runs · 30 days`} tone="gold" />
          <MetricCard label="p95 ping" value={`${data.connection.p95PingMs.toFixed(0)}ms`} note={`${data.connection.samples.toLocaleString()} RTT samples · 30 days`} tone={data.connection.p95PingMs > 180 ? "coral" : "mint"} />
        </section>

        <section className="mt-4 grid gap-4 lg:grid-cols-[1.55fr_1fr]">
          <Panel eyebrow="Audience" title="Daily active users" detail="Last 30 days">
            <div className="h-64 sm:h-72"><canvas ref={dauRef} aria-label="Daily active users chart" /></div>
          </Panel>
          <Panel eyebrow="Network" title="Connection quality" detail={`Mean ${data.connection.meanPingMs.toFixed(0)} ms`}>
            <div className="h-64 sm:h-72"><canvas ref={pingRef} aria-label="Mean and p95 ping chart" /></div>
          </Panel>
        </section>

        <section className="mt-4 grid gap-4 lg:grid-cols-3">
          <Panel eyebrow="Audience" title="Player location" detail="Unique users · 30 days">
            {data.locations.length
              ? <div className="h-64"><canvas ref={locationRef} aria-label="Player location chart" /></div>
              : <EmptyState text="Location data will appear after the first identified session." />}
          </Panel>

          <Panel eyebrow="Safety" title="Bans issued" detail={`${data.bans.total.toLocaleString()} lifetime`}>
            <div className="space-y-3">
              <BreakdownRow label="Last 24 hours" value={data.bans.last24Hours} color="bg-coral-400" />
              <BreakdownRow label="Last 30 days" value={data.bans.last30Days} color="bg-gold-400" />
              <BreakdownRow label="Lifetime" value={data.bans.total} color="bg-slate-500" />
            </div>
          </Panel>

          <Panel eyebrow="Reliability" title="App crashes" detail={`${data.appCrashes.total.toLocaleString()} lifetime`}>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-white/[0.05] bg-black/15 p-4">
                <p className="text-[10px] uppercase tracking-widest text-slate-600">24 hours</p>
                <p className="mt-2 text-2xl text-coral-400">{data.appCrashes.last24Hours}</p>
              </div>
              <div className="rounded-xl border border-white/[0.05] bg-black/15 p-4">
                <p className="text-[10px] uppercase tracking-widest text-slate-600">30 days</p>
                <p className="mt-2 text-2xl text-gold-400">{data.appCrashes.last30Days}</p>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {data.appCrashes.byKind.length
                ? data.appCrashes.byKind.slice(0, 5).map((entry) => (
                    <div key={entry.kind} className="flex items-center justify-between border-b border-white/[0.05] py-2 text-xs">
                      <span className="text-slate-500">{entry.kind.replaceAll("-", " ")}</span>
                      <span className="text-slate-300">{entry.crashes}</span>
                    </div>
                  ))
                : <p className="py-5 text-center text-xs text-slate-600">No crashes recorded in 30 days.</p>}
            </div>
          </Panel>
        </section>

        <footer className="mt-7 flex flex-col gap-2 border-t border-white/[0.05] pt-5 text-[10px] uppercase tracking-[0.16em] text-slate-700 sm:flex-row sm:justify-between">
          <span>Auto-refreshes every 30 seconds</span>
          <span>No names or raw IP addresses stored</span>
        </footer>
      </div>
    </main>
  );
}

function BreakdownRow({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-white/[0.05] bg-black/15 px-4 py-4">
      <div className="flex items-center gap-3">
        <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
        <span className="text-xs text-slate-500">{label}</span>
      </div>
      <span className="text-lg text-slate-200">{value.toLocaleString()}</span>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-white/10 px-8 text-center text-xs leading-5 text-slate-600">{text}</div>;
}

export function MetricsDashboard() {
  const [token, setToken] = useState(storedToken);
  const [data, setData] = useState<MetricsSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(token));
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(new Date());
  const requestEpoch = useRef(0);

  const load = async (candidate = token, background = false) => {
    if (!candidate) return;
    const request = ++requestEpoch.current;
    if (background) setRefreshing(true); else setLoading(true);
    try {
      const response = await fetch("/metrics", {
        headers: { "x-metrics-token": candidate },
        cache: "no-store",
      });
      if (response.status === 403) throw new Error("That token was not accepted.");
      if (response.status === 404) throw new Error("Metrics access is not enabled on this server. Set METRICS_TOKEN and restart it.");
      if (!response.ok) throw new Error(`Metrics request failed (${response.status}).`);
      const next = await response.json() as MetricsSnapshot;
      if (request !== requestEpoch.current) return;
      saveToken(candidate);
      setToken(candidate);
      setData(next);
      setUpdatedAt(new Date());
      setError("");
    } catch (reason) {
      if (request === requestEpoch.current) {
        setError(reason instanceof Error ? reason.message : "Could not load metrics.");
      }
    } finally {
      if (request === requestEpoch.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  useEffect(() => {
    if (!token) return;
    // load() flips the loading flag before it awaits, which is a setState in
    // the effect body and normally a cascading-render smell. Here it is the
    // point: unlocking the dashboard must show that something is happening
    // before the first response lands, and there is no render-time source for
    // "a fetch is in flight" to derive it from instead.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(token);
    const timer = window.setInterval(() => { void load(token, true); }, REFRESH_MS);
    return () => window.clearInterval(timer);
    // The active token owns one polling loop; load is intentionally local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const lock = () => {
    requestEpoch.current++;
    saveToken("");
    setToken("");
    setData(null);
    setError("");
    setLoading(false);
    setRefreshing(false);
  };

  if (!token || (!data && error)) {
    return <TokenGate error={error} loading={loading} onSubmit={(next) => {
      setError("");
      void load(next);
    }} />;
  }

  if (!data) {
    return (
      <main className="metrics-grid flex min-h-full items-center justify-center bg-abyss-950 font-sans text-mint-300">
        <p className="animate-pulse text-xs uppercase tracking-[0.28em]">Reading the abyss…</p>
      </main>
    );
  }

  return <Dashboard data={data} updatedAt={updatedAt} refreshing={refreshing} onRefresh={() => void load(token, true)} onLock={lock} />;
}
