export function Disclaimer() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto max-w-3xl px-4 py-5 text-xs leading-relaxed text-muted sm:px-6">
        <p className="mb-2 font-medium text-foreground/80">
          TxODDS World Cup Hackathon &middot; Trading Tools &amp; Agents track
        </p>
        <p>
          <span className="font-semibold text-foreground">Demo &amp; simulated data.</span>{" "}
          All matches, odds, statistics and probabilities on this page are
          simulated for demonstration purposes and are not sourced from a
          live TxLINE feed. Paper trading only &mdash; every trade recorded
          here is simulated, no real money or wallet is involved. Nothing on
          this page is financial advice or a recommendation to bet. No real
          funds are placed, held, or settled by this application.
        </p>
      </div>
    </footer>
  );
}
