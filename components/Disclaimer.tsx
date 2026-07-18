export function Disclaimer() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-5 text-xs leading-relaxed text-muted sm:px-6">
        <p className="mb-2 font-medium text-foreground/80">
          TxODDS World Cup Hackathon &middot; Trading Tools &amp; Agents track
        </p>
        <p>
          <span className="font-semibold text-foreground">Real live data, paper trading only.</span>{" "}
          Matches, odds and probabilities shown here are read from the live
          TxLINE feed (or, in historical-analysis mode, from real downloaded
          TxLINE match data — clearly labelled as such). Every trade
          recorded here is simulated &mdash; no real money or wallet is
          involved. Nothing on this page is financial advice or a
          recommendation to bet. No real funds are placed, held, or settled
          by this application. The trained model is experimental and has not
          been proven profitable.
        </p>
      </div>
    </footer>
  );
}
