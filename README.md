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

- **Minimal home screen**: PitchEdge's name and one-sentence explanation, a prominent "Demo mode — matches, odds and trades are simulated using TxLINE-style data" warning, a "Choose a match for PitchEdge to analyse" heading with large match cards, and a small "View paper trades" link. Nothing else — no probabilities, controls, or history visible until you act.
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
  Header, SourceBanner, MatchSelector (large match cards)
  Modal (dependency-free accessible dialog primitive)
  RecommendationModal (scan → proposal | no-trade | closed | approved)
  TradeHistoryModal, AdvancedAnalysisSection (collapsed, own match picker)
  AdvancedAnalysis (manual MarketSelector, VerdictPanel, OpportunityTable, LiveStats, PaperTradeForm)
  ExplainabilityPanel, TradeHistory, Disclaimer, ui (Panel/Pill/Stat primitives)
lib/
  types.ts          Shared domain types, incl. the MatchDataProvider interface
  demoData.ts        Simulated matches, odds and market/selection definitions (wraps demoProvider)
  dataSource.ts       Reads TXLINE_DATA_SOURCE / TXLINE_API_TOKEN; never touches the network
  engine.ts          Transparent probability model, edge/confidence/signal logic
  scanner.ts          Scans every market/outcome for a match and ranks the opportunities
  trade.ts             Builds a PaperTrade record from an opportunity + stake
  narrative.ts          Turns an analysis result / opportunity into plain-English sentences
  seedTrades.ts           Pre-populated paper trade history
  format.ts                Small display-formatting helpers
  txline/
    types.ts               Raw TxLINE DTOs (Fixture, OddsPayload, Scores, ...)
    client.ts               Server-only, dormant fetch client for the 4 documented endpoints
    normalize.ts             Raw TxLINE responses -> Match / MarketDefinition / MatchStats
    provider.ts               Dormant async MatchDataProvider factory (never called yet)
```

**How opportunities are scanned and ranked** (`lib/scanner.ts`, unchanged by this work): for the selected match, `scanMatch` calls the existing `computeAnalysis` engine once per outcome across whichever markets the active provider reports as supported, then sorts the results primarily by whether they clear the BUY threshold, then by edge (descending), then by confidence (descending). The top qualifying result becomes the proposed trade; if none qualify, the top overall result is kept as the "closest opportunity" shown in the NO TRADE explanation. It makes no assumption about which markets exist or how many outcomes each has — an empty market list produces a clean, non-crashing "0 outcomes scanned" result.

Every data source — demo or future live — implements the same `MatchDataProvider` interface (`getMatches`, `getOdds`, `getSelections`, `getSupportedMarkets`, `getMeta`). The scanner, probability engine and every component are written against that interface, never against a raw feed shape.

## TxLINE readiness

PitchEdge currently defaults to, and only operates in, **demo mode**. The codebase also contains a **dormant** TxLINE provider (`lib/txline/`) that is fully implemented and unit-tested but never invoked by the running app, and never makes a network request while demo mode is active.

- **No real credentials are committed.** `.env.example` only lists placeholder variable names; `TXLINE_API_TOKEN` is blank.
- **Switching to live data later** requires two changes: set `TXLINE_API_TOKEN` to an activated TxLINE API token, and set `TXLINE_DATA_SOURCE=txline`. If `txline` mode is selected without a token, `lib/dataSource.ts` raises a clear configuration error — it never silently pretends to be live.
- **Demo mode remains a reliable fallback.** Nothing about enabling the live path removes or weakens the demo provider; the three prepared demonstration paths (England v France BUY, Germany v Spain NO TRADE, Portugal v Netherlands CLOSED) are covered by `lib/scanner.test.ts` and are unaffected by this work.
- **Live data must never be represented as confirmed unless a real request has succeeded.** The home screen's source banner (`components/SourceBanner.tsx`) reflects `getConfiguredDataSource()` (server-side, via `app/page.tsx`) and, in `txline` mode, only claims the *connection* is active — it never claims data has been supplied. The monitoring panel's "Source: Live TxLINE data" label is the stronger claim, and it only appears once `TxLineProvider.getMeta()` has actually been constructed after a live fixtures/odds/scores round trip completes. No code path can show that stronger label speculatively.
- **The guest JWT is never stored.** Per the documented auth flow, the dormant client always requests a fresh guest JWT from `POST /auth/guest/start` at call time and pairs it with `TXLINE_API_TOKEN` as `Authorization: Bearer <jwt>` + `X-Api-Token: <token>` — only the long-lived API token lives in the environment.
- **On-chain activation is out of scope here.** Obtaining `TXLINE_API_TOKEN` itself requires TxLINE's separate `/api/token/activate` flow (a signed Solana transaction). This build does not implement, and must not implement, wallet creation or transaction signing — that token is expected to already exist, generated out-of-band, before `TXLINE_DATA_SOURCE=txline` is ever set.

### Exact future environment variables

```bash
TXLINE_DATA_SOURCE=txline                       # "demo" (default) | "txline"
TXLINE_BASE_URL=https://txline.txodds.com        # production TxLINE server
TXLINE_API_TOKEN=<activated-api-token>            # from the out-of-band activation flow
```

### Uncertain TxLINE fields (flagged in code, not guessed silently)

The endpoint shapes, headers and base URL below come from TxLINE's official OpenAPI spec (`https://txline.txodds.com/docs/docs.yaml`, v1.5.6) and are high-confidence. A few fields the spec doesn't document a concrete enum/example for are implemented as clearly-flagged placeholders that default to *skip, don't guess*:

- **`SuperOddsType` → market mapping.** The spec types this as a bare string with no enum or examples. `lib/txline/normalize.ts` ships a placeholder lookup (`1X2`, `MATCH_ODDS`, `NEXT_GOAL`, `OU`, `TOTAL_GOALS`) that must be verified against a real `/api/odds/snapshot` response before going live; any unrecognized value is safely skipped.
- **`Prices` integer scale.** The spec types odds as `integer` (int32), not a decimal — the scale factor isn't documented. `ASSUMED_PRICE_SCALE = 1000` is a placeholder pending confirmation.
- **`PriceNames` ordering.** Outcome labels' real text/order isn't documented, so normalization maps outcomes by *position* (given a recognized market and a matching outcome count) rather than by matching label text.
- **`statusSoccerId` period codes.** The spec's `SoccerFixtureStatus` enum gives each code only a 1-2 letter title (e.g. `NS`, `HT`, `END`) with no prose description. The mapping to upcoming/live/finished is a reasonable best-effort inference, not a confirmed spec fact.
- **Possession, shots on target, attacking pressure.** No confirmed TxLINE field maps to these; live-normalized matches default them neutrally (see `lib/txline/provider.ts`) until a real response is available to inspect.
- **Sport filtering on `/api/fixtures/snapshot`.** The `Fixture` schema carries no sport indicator — soccer vs. other sports can only be confirmed once scores data (`scoreSoccer`) is fetched per fixture.

## Local setup

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Other scripts: `npm run lint`, `npm run build`, `npm run start`, `npm test` (runs `lib/**/*.test.ts` via Node's built-in test runner — no network access or credentials required; demo mode and the TxLINE normalizers are covered, the live client itself is not, since it inherently cannot be tested without a real server).

## Safety disclaimer

This application is a hackathon demo. All matches, odds, statistics and probabilities are **simulated**. Paper trading only — no real money, wallet, or exchange is involved anywhere in this app. Nothing here is financial advice or a betting recommendation.

## Current limitations

- No real data connection — all matches, odds and stats are static demo fixtures, not live TxLINE data. This remains true even with the dormant TxLINE provider in place, since it is never invoked and no credentials are configured.
- The dormant TxLINE client and normalizers have never been exercised against a real TxLINE response — only against sanitized, spec-shaped fixtures in tests. Several field mappings are explicitly flagged as unconfirmed (see "Uncertain TxLINE fields" above) and need verification against a live response before the live path is trusted.
- The fair-probability model is an intentionally transparent, hand-weighted demo heuristic, not a trained or backtested model.
- No persistence: paper trades live in React state and reset on page reload.
- No settlement engine — seeded trades have fixed illustrative outcomes; new trades stay "open" and are never auto-settled.
- No authentication, database, or multi-user support.
- No on-chain activation flow (`/api/token/activate`) is implemented — obtaining `TXLINE_API_TOKEN` is out of scope for this app and must happen separately.
