"use client";

import type { ReplayPhase, ReplaySpeed } from "@/lib/replay/reducer";

const SPEEDS: ReplaySpeed[] = [1, 2, 4];

export function ReplayControls({
  phase,
  speed,
  canFastForward,
  onSetSpeed,
  onPause,
  onResume,
  onRestart,
  onFastForward,
}: {
  phase: ReplayPhase;
  speed: ReplaySpeed;
  canFastForward: boolean;
  onSetSpeed: (speed: ReplaySpeed) => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onFastForward: () => void;
}) {
  const buttonBase =
    "rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
  const neutralButton = `${buttonBase} border-border bg-surface-elevated text-foreground hover:border-accent/50`;
  const activeButton = `${buttonBase} border-accent bg-accent/10 text-accent`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 rounded-md border border-border bg-surface p-1" role="group" aria-label="Replay speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSetSpeed(s)}
            aria-pressed={speed === s}
            className={`rounded px-3 py-1.5 text-sm font-bold transition-all ${
              speed === s
                ? "scale-105 bg-accent text-white shadow-sm ring-2 ring-accent/40"
                : "text-muted hover:text-foreground"
            }`}
          >
            {s}&times;
          </button>
        ))}
      </div>

      {phase === "running" ? (
        <button type="button" onClick={onPause} className={neutralButton}>
          Pause
        </button>
      ) : phase === "paused" ? (
        <button type="button" onClick={onResume} className={activeButton}>
          Resume
        </button>
      ) : null}

      <button type="button" onClick={onRestart} className={neutralButton}>
        Restart replay
      </button>

      {canFastForward ? (
        <button type="button" onClick={onFastForward} className={neutralButton}>
          Fast-forward to settlement
        </button>
      ) : null}
    </div>
  );
}
