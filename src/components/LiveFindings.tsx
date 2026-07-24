"use client";
import { Issue, Severity } from "@/lib/schema";

export interface LiveStats {
  confirmed: number;
  resolved: number;
  unverifiable: number;
  bySeverity: Record<Severity, number>;
  recent: Issue[];
  startedAt: number;
  done: number;
  total: number;
}

export const emptyLiveStats = (): LiveStats => ({
  confirmed: 0,
  resolved: 0,
  unverifiable: 0,
  bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0 },
  recent: [],
  startedAt: Date.now(),
  done: 0,
  total: 0,
});

const sevColor: Record<Severity, string> = {
  Critical: "text-ember",
  High: "text-forge",
  Medium: "text-cobalt",
  Low: "text-steel",
};

function eta(stats: LiveStats): string {
  if (stats.done < 20) return "estimating…";
  const elapsed = Date.now() - stats.startedAt;
  const perCheck = elapsed / stats.done;
  const remaining = Math.max(0, stats.total - stats.done) * perCheck;
  const mins = Math.round(remaining / 60000);
  if (mins < 1) return "under a minute left";
  if (mins < 60) return `~${mins} min left`;
  const h = Math.floor(mins / 60);
  return `~${h}h ${mins % 60}m left`;
}

export default function LiveFindings({ stats }: { stats: LiveStats }) {
  const rate =
    stats.done > 0 ? ((stats.done / ((Date.now() - stats.startedAt) / 1000)) || 0).toFixed(1) : "0";

  return (
    <div className="no-print space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded border border-edge bg-panel/60 px-4 py-3">
          <div className="text-2xl font-semibold text-ember">{stats.confirmed.toLocaleString()}</div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-steel">Confirmed live</div>
        </div>
        <div className="rounded border border-edge bg-panel/60 px-4 py-3">
          <div className="text-2xl font-semibold text-verdant">{stats.resolved.toLocaleString()}</div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-steel">Already fixed</div>
        </div>
        <div className="rounded border border-edge bg-panel/60 px-4 py-3">
          <div className="text-2xl font-semibold text-steel">{stats.unverifiable.toLocaleString()}</div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-steel">Unverifiable</div>
        </div>
        <div className="rounded border border-edge bg-panel/60 px-4 py-3">
          <div className="text-2xl font-semibold text-slate-200">{rate}/s</div>
          <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-steel">{eta(stats)}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 rounded border border-edge bg-panel/40 px-4 py-2 font-mono text-xs">
        <span className="text-steel">Confirmed by severity:</span>
        {(["Critical", "High", "Medium", "Low"] as Severity[]).map((s) => (
          <span key={s} className={sevColor[s]}>
            {s} {stats.bySeverity[s].toLocaleString()}
          </span>
        ))}
      </div>

      <div className="rounded border border-edge bg-panel/40">
        <div className="border-b border-edge px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-steel">
          Live feed — issues confirmed against the live site
        </div>
        <ul aria-live="polite" className="max-h-80 divide-y divide-edge/50 overflow-auto">
          {stats.recent.length === 0 && (
            <li className="px-4 py-3 text-sm text-steel">Waiting for the first confirmation…</li>
          )}
          {stats.recent.map((i) => (
            <li key={i.id} className="px-4 py-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className={`font-mono text-[10px] uppercase ${sevColor[i.severity]}`}>{i.severity}</span>
                <span className="text-sm text-slate-200">{i.ruleLabel}</span>
              </div>
              <div className="break-all font-mono text-[11px] text-steel">{i.url}</div>
              {i.liveEvidence && (
                <div className="mt-1 break-all font-mono text-[11px] text-forge/80">{i.liveEvidence}</div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
