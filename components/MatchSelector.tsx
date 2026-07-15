import type { Match } from "@/lib/types";

const STATUS_LABEL = {
  live: "LIVE",
  upcoming: "UPCOMING",
  finished: "FULL TIME",
} as const;

const STATUS_CLASS = {
  live: "text-buy",
  upcoming: "text-accent",
  finished: "text-muted",
} as const;

export function MatchSelector({
  matches,
  onSelect,
}: {
  matches: Match[];
  onSelect: (matchId: string) => void;
}) {
  return (
    <div>
      <h2 className="mb-3 text-center text-lg font-semibold text-foreground">
        Choose a match for PitchEdge to analyse
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {matches.map((match) => (
          <button
            key={match.id}
            type="button"
            onClick={() => onSelect(match.id)}
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 text-left transition-colors hover:border-accent hover:bg-surface-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <div className="flex items-center justify-between">
              <span className={`text-xs font-semibold tracking-wide ${STATUS_CLASS[match.status]}`}>
                {match.status === "live"
                  ? `${STATUS_LABEL.live} · ${match.minute}'`
                  : STATUS_LABEL[match.status]}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-lg font-semibold text-foreground">
              <span className="truncate">{match.home.name}</span>
              <span className="shrink-0 tabular-nums text-muted">
                {match.homeScore}&ndash;{match.awayScore}
              </span>
              <span className="truncate text-right">{match.away.name}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
