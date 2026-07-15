export function SimulatedBanner() {
  return (
    <div
      role="status"
      className="rounded-lg border border-pass/40 bg-pass-soft px-4 py-3 text-center text-sm font-semibold text-pass"
    >
      Demo mode &mdash; matches, odds and trades are simulated using TxLINE-style data.
    </div>
  );
}
