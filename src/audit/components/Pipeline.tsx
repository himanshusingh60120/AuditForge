"use client";

export type Stage = "upload" | "parse" | "detect" | "verify" | "enrich" | "modules" | "analyze" | "report";
const STAGES: { id: Stage; label: string }[] = [
  { id: "parse", label: "Parse" },
  { id: "detect", label: "Detect" },
  { id: "verify", label: "Verify" },
  { id: "enrich", label: "Enrich" },
  { id: "modules", label: "Modules" },
  { id: "analyze", label: "Analyze" },
  { id: "report", label: "Report" },
];

interface Props {
  stage: Stage;
  detail: string;
  /** 0..1 for the active stage; -1 = indeterminate */
  progress: number;
}

export default function Pipeline({ stage, detail, progress }: Props) {
  const activeIdx = STAGES.findIndex((s) => s.id === stage);
  return (
    <div className="no-print rounded-lg border border-edge bg-panel/60 p-4">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {STAGES.map((s, i) => {
          const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "todo";
          return (
            <li key={s.id} className="flex items-center gap-1">
              <span
                className={`font-mono text-[11px] uppercase tracking-widest ${
                  state === "done" ? "text-verdant" : state === "active" ? "text-forge" : "text-steel/50"
                }`}
              >
                {state === "done" ? "▣" : state === "active" ? "▶" : "▢"} {s.label}
              </span>
              {i < STAGES.length - 1 && <span className="mx-1 h-px w-6 bg-edge" aria-hidden />}
            </li>
          );
        })}
      </ol>
      {stage !== "report" && stage !== "upload" && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded bg-ink">
            <div
              className={`h-full bg-forge transition-all ${progress < 0 ? "w-1/3 animate-pulse" : ""}`}
              style={progress >= 0 ? { width: `${Math.round(progress * 100)}%` } : undefined}
            />
          </div>
          <p aria-live="polite" className="mt-2 font-mono text-xs text-steel">
            {detail}
          </p>
        </div>
      )}
    </div>
  );
}
