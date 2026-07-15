import type { ReactNode } from "react";

export function Panel({
  title,
  subtitle,
  children,
  className = "",
  as: As = "section",
  id,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  as?: "section" | "div";
  id?: string;
}) {
  return (
    <As
      id={id}
      className={`rounded-xl border border-border bg-surface p-4 sm:p-5 ${className}`}
    >
      {title ? (
        <div className="mb-3">
          <h2 className="text-sm font-semibold tracking-wide text-foreground uppercase">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
          ) : null}
        </div>
      ) : null}
      {children}
    </As>
  );
}

type Tone = "buy" | "pass" | "negative" | "neutral" | "accent";

const TONE_CLASSES: Record<Tone, string> = {
  buy: "bg-buy-soft text-buy border-buy/30",
  pass: "bg-pass-soft text-pass border-pass/30",
  negative: "bg-negative-soft text-negative border-negative/30",
  neutral: "bg-surface-elevated text-muted border-border",
  accent: "bg-accent/10 text-accent border-accent/30",
};

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "buy" | "negative" | "neutral";
}) {
  const toneClass =
    tone === "buy" ? "text-buy" : tone === "negative" ? "text-negative" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-surface-elevated p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}

export function Pill({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
