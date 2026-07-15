# PitchEdge

An explainable live football trading agent, built for the **TxODDS World Cup Hackathon** in the **Trading Tools & Agents** track.

PitchEdge behaves like an approval-based autonomous trading agent, not a trading dashboard: pick a match, and a focused modal scans every supported market and outcome, proposes the single strongest paper trade, and waits for you to approve or reject it — all without any real money changing hands.

## Concept

The whole product is legible in five seconds:

```
Select a match
  → automated recommendation appears (modal)
  → approve or reject
```

Under the hood, a match selection triggers a full scan through the existing engine:

```
User selects a match
  → PitchEdge scans every market & outcome  (existing probability engine)
  → ranks opportunities by BUY-qualified → edge → confidence
  → proposes the strongest one (or a disciplined NO TRADE)
  → user Approves or Rejects
  → approved trade is recorded automatically
```

Each opportunity goes through the same engine as always:

```
odds → implied market probability   (1 / decimal odds)
     → model fair probability       (weighted match factors)
     → edge = fair − implied
     → BUY / PASS signal            (edge + confidence thresholds)
```

## Current features

- **Minimal home screen**: PitchEdge's name and one-sentence explanation, a prominent "Simulated data — not live" warning, a "Select a match" heading with large match cards, and a small "View paper trades" link. Nothing else — no probabilities, controls, or history visible until you act.
- **Recommendation modal**: selecting a match opens a focused, centred, accessible dialog (Escape/backdrop to close, focus-trapped, keyboard operable) that briefly "scans" then shows one of three outcomes:
  - **Trade ready for approval** — the match, a plain-English trade name ("England to win"), odds, a one-sentence edge explanation, an adjustable simulated stake (default £10), potential return, and **Approve paper trade** / **Reject**. A collapsed **"Why this trade?"** link reveals market probability, model probability, edge, confidence and the top 3 reasons — never shown by default.
  - **No trade recommended** — states how many outcomes were scanned and why nothing qualified, with a **"View closest opportunity"** disclosure and the edge/confidence thresholds. Never encourages forcing a trade.
  - **Match complete — no new trade can be opened** — finished matches are always blocked from new trades, regardless of what the scan finds.
- **Approve/Reject behaviour**: approving records the trade immediately and replaces the modal with a "Paper trade recorded" confirmation plus **Choose another match** / **View paper trades**. Rejecting records nothing, closes the modal, and shows a brief non-intrusive "Trade rejected" toast.
- **View paper trades**: a modal with the trade summary (total / open / settled / simulated P&L) and full history table — reachable from the home screen link or from a successful approval, never shown unprompted.
- **Advanced analysis** (collapsed, muted disclosure at the bottom of the home screen): manual match/market/outcome selection, the full probability breakdown, every scanned opportunity, match statistics, the complete model-factor list, and a manual paper-trade form — the same engine, for judges who want to inspect it directly. Never appears during the normal demo.
- **Paper trading**: stake validation, potential return, a trade log with pre-populated simulated trades, and a running P/L summary. All returns and P/L are explicitly labelled simulated.
- **Dark, professional, responsive UI** built with Tailwind CSS — no additional UI library.

## Architecture

```
app/
  layout.tsx        Root layout, metadata
  page.tsx           Thin page component: home screen + modal state
  globals.css         Dark trading-dashboard theme tokens (Tailwind v4 @theme)
components/
  Header, SimulatedBanner, MatchSelector (large match cards)
  Modal (dependency-free accessible dialog primitive)
  RecommendationModal (scan → proposal | no-trade | closed | approved)
  TradeHistoryModal, AdvancedAnalysisSection (collapsed, own match picker)
  AdvancedAnalysis (manual MarketSelector, VerdictPanel, OpportunityTable, LiveStats, PaperTradeForm)
  ExplainabilityPanel, TradeHistory, Disclaimer, ui (Panel/Pill/Stat primitives)
lib/
  types.ts          Shared domain types, incl. the MatchDataProvider interface
  demoData.ts        Simulated matches, odds and market/selection definitions
  engine.ts          Transparent probability model, edge/confidence/signal logic
  scanner.ts          Scans every market/outcome for a match and ranks the opportunities
  trade.ts             Builds a PaperTrade record from an opportunity + stake
  narrative.ts          Turns an analysis result / opportunity into plain-English sentences
  seedTrades.ts           Pre-populated paper trade history
  format.ts                Small display-formatting helpers
```

**How opportunities are scanned and ranked** (`lib/scanner.ts`): for the selected match, `scanMatch` calls the existing `computeAnalysis` engine once per outcome across all 3 markets (8 outcomes total), then sorts the results primarily by whether they clear the BUY threshold, then by edge (descending), then by confidence (descending). The top qualifying result becomes the proposed trade; if none qualify, the top overall result is kept as the "closest opportunity" shown in the NO TRADE explanation.

The demo data source implements a `MatchDataProvider` interface (`getMatches`, `getOdds`, `getSelections`). A future live integration only needs to implement that same interface against the real feed — the probability engine and every component are written against the interface, not the demo data directly.

**All data in this MVP is simulated.** No connection to TxLINE or any live feed currently exists — this is explicitly a demo-data build.

## Planned TxLINE integration

Replace `lib/demoData.ts` with a `TxLineProvider` that implements `MatchDataProvider` by polling or subscribing to the real TxLINE live-odds and match-events feed, mapping its payloads onto the existing `Match` / odds shapes. Because `lib/engine.ts` and all components consume the provider interface (not the demo module directly), this should be a contained, additive change.

## Local setup

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Other scripts: `npm run lint`, `npm run build`, `npm run start`.

## Safety disclaimer

This application is a hackathon demo. All matches, odds, statistics and probabilities are **simulated**. Paper trading only — no real money, wallet, or exchange is involved anywhere in this app. Nothing here is financial advice or a betting recommendation.

## Current limitations

- No real data connection — all matches, odds and stats are static demo fixtures, not live TxLINE data.
- The fair-probability model is an intentionally transparent, hand-weighted demo heuristic, not a trained or backtested model.
- No persistence: paper trades live in React state and reset on page reload.
- No settlement engine — seeded trades have fixed illustrative outcomes; new trades stay "open" and are never auto-settled.
- No authentication, database, or multi-user support.
