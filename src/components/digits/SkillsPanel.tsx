import { memo } from "react";
import type { SkillOutput } from "@/lib/deriv/skills";

interface Props {
  skills: SkillOutput[];
  combined: number[];
  differDigit: number;
}

function SkillsPanelImpl({ skills, combined, differDigit }: Props) {
  const top = combined.reduce((m, v, i) => (v > combined[m] ? i : m), 0);
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-[11px]">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold">27 Skills · Meta Engine</span>
        <span className="rounded border border-input px-1.5 py-0.5 font-mono text-[10px] text-cyan">
          match→{top} · differ→{differDigit}
        </span>
      </div>
      <div className="max-h-56 overflow-auto rounded bg-background/60 p-1 font-mono text-[10px] leading-tight">
        <table className="w-full">
          <tbody>
            {skills.map((s) => {
              const bar = Math.round(s.score * 100);
              return (
                <tr key={s.key} className="border-b border-border/40 last:border-0">
                  <td className="py-0.5 pr-2 text-muted-foreground w-32 truncate">{s.label}</td>
                  <td className="py-0.5 pr-2">
                    <div className="h-1 w-full rounded bg-muted">
                      <div
                        className="h-1 rounded bg-cyan"
                        style={{ width: `${Math.min(100, bar)}%` }}
                      />
                    </div>
                  </td>
                  <td className="py-0.5 pl-1 text-right text-cyan tabular-nums w-10">{bar}%</td>
                  <td className="py-0.5 pl-2 text-muted-foreground w-40 truncate">{s.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const SkillsPanel = memo(SkillsPanelImpl);
