import type { Match } from "@/lib/types";
import { Panel } from "./ui";

function StatBar({
  label,
  home,
  away,
  format = (v: number) => `${v}`,
}: {
  label: string;
  home: number;
  away: number;
  format?: (value: number) => string;
}) {
  const total = home + away;
  const homePct = total === 0 ? 50 : (home / total) * 100;

  return (
    <div>
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="tabular-nums font-medium text-foreground">
          {format(home)}
        </span>
        <span>{label}</span>
        <span className="tabular-nums font-medium text-foreground">
          {format(away)}
        </span>
      </div>
      <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-border">
        <div className="h-full bg-accent" style={{ width: `${homePct}%` }} />
        <div className="h-full bg-muted/60" style={{ width: `${100 - homePct}%` }} />
      </div>
    </div>
  );
}

export function LiveStats({ match }: { match: Match }) {
  const { stats } = match;
  return (
    <Panel
      title="Match statistics"
      subtitle={`${match.home.shortName} vs ${match.away.shortName}`}
      className="flex flex-col gap-4"
    >
      <StatBar
        label="Possession"
        home={stats.possession[0]}
        away={stats.possession[1]}
        format={(v) => `${v}%`}
      />
      <StatBar label="Shots" home={stats.shots[0]} away={stats.shots[1]} />
      <StatBar
        label="Shots on target"
        home={stats.shotsOnTarget[0]}
        away={stats.shotsOnTarget[1]}
      />
      <StatBar
        label="Attacking pressure"
        home={stats.attackingPressure[0]}
        away={stats.attackingPressure[1]}
      />
      <StatBar label="Corners" home={stats.corners[0]} away={stats.corners[1]} />
      <StatBar
        label="Red cards"
        home={stats.redCards[0]}
        away={stats.redCards[1]}
      />
    </Panel>
  );
}
