# DhanHQ v2 Options Bot (Layered Signal Scanner + Paper Trader)

A Node.js bot that scans **NIFTY, SENSEX and Stock F&O option chains** via the
[DhanHQ v2 API](https://docs.dhanhq.co/api/v2/) and paper-trades directional
option-buying signals, using a layered decision architecture:

```
DhanHQ data (REST candles + option chain, WebSocket ticks)
   |
   v
CandleAggregator  -- REST candles + live ticks merged into 5-min candles
   |
   v
MarketContextEngine  -- regime: TREND_UP / TREND_DOWN / RANGE / HIGH_VOLATILITY / TRANSITION
   |                     ADX, RSI14, ATR%, VWAP distance, EMA spread, chain bias
   v
[Layer 1] Strategy Registry  -- five deterministic, versioned strategy families
   |                            (eligibility: regime, params, chain confirmation)
   v
[Layer 2] Selector  -- deterministic (highest score) OR Tev1 via @nemesis-oss/ollama-sdk
   |                   (fail-closed: every failure mode is NO_TRADE)
   v
OptionSelector  -- ATM(+offset) leg, best-ask entry, spread/liquidity/IV/delta/freshness filters
   |
   v
[Layer 3] RiskManager  -- hard gate: position limits, daily loss cap, circuit breaker,
   |                      notional/per-trade loss caps, stop/target validity
   v
PaperBroker  -- simulated broker-side SL-M, target, trailing stop, 15:15 square-off,
   |            charges + slippage model, crash-safe position store
   v
DecisionJournal + signals/trades/decisions CSVs + Telegram + daily report
```

> **This bot never places real orders.** There is no order-placement code
> anywhere - the REST client exposes only data endpoints. It is a signal
> scanner and paper-trading simulator for studying a layered strategy design
> before going anywhere near live money.

## Design rules (from the reference architecture)

- **Layer 1 always comes first.** The model (when enabled) only ever sees
  candidates that already passed deterministic eligibility. It can never
  invent a contract, change risk parameters, or override a risk rejection.
- **Fail closed.** Timeout, unavailable model, unknown selection, low
  confidence, malformed answer - every failure is `NO_TRADE`, never a trade.
- **The risk gate is authoritative.** A valid signal never automatically
  becomes a position; `RiskManager` must pass it first.
- **Exits never depend on the model.** Stops, targets, trailing stops and the
  15:15 square-off run entirely in the paper broker off live ticks.
- **Every decision is journaled** - including NO_TRADE and its reason - so
  behaviour is auditable after the fact (`data/decisions.csv`).
- **An identical snapshot cannot re-decide** (no duplicate order intents).

## The five strategy families (`src/strategies/registry.ts`)

| Family | Idea | Allowed regimes |
| --- | --- | --- |
| `ema_cross` | EMA 9/21 cross with slope confirmation | TREND_UP, TREND_DOWN, TRANSITION |
| `trend_continuation` | Pullback inside an established trend that resumes | TREND_UP, TREND_DOWN |
| `range_break` | Opening-range breakout with volume confirmation | RANGE, TRANSITION |
| `momentum_break` | 3-candle momentum burst + volume surge | all except HIGH_VOLATILITY |
| `trend_flip` | RSI-exhaustion reversal, requires chain support | TREND_UP, TREND_DOWN, TRANSITION |

All families require **chain confirmation**: a strongly opposing option-chain
bias (PCR + ATM OI shift) kills the candidate; an agreeing chain boosts it.
`HIGH_VOLATILITY` (ATR-based) blocks every family - volatility shock days are
stand-aside days for this strategy set.

## Project layout

```
dhan-options-bot/
├── config.json                # instruments, strategies, decision, options, risk, charges
├── .env.example               # DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN / Telegram / OLLAMA_BASE_URL
├── src/
│   ├── index.ts               # CLI entrypoint
│   ├── config.ts csv.ts ist.ts logger.ts report.ts
│   ├── dhan/                  # rate-limited REST client, instrument master, market data, WS feed
│   ├── market/candleAggregator.ts
│   ├── context/marketContext.ts
│   ├── strategies/registry.ts
│   ├── decision/tev1.ts       # Tev1 selector (ollama-sdk) + deterministic fallback
│   ├── decision/journal.ts
│   ├── options/selector.ts
│   ├── risk/manager.ts
│   ├── paper/broker.ts
│   ├── notify/telegram.ts
│   └── modes/                 # scan, chain, backtest, report
└── test/selftest.ts           # offline checks - no credentials needed
```

## Prerequisites

1. **Node.js >= 20**
2. A **Dhan** trading account with **DhanHQ API access** (web.dhan.co → My
   Profile → DhanHQ APIs) and an active **Data API subscription** covering:
   Market Quote, Option Chain, Live Market Feed (WebSocket) and Historical Data.
3. **Access token** - valid for 24 hours; paste a fresh one into `.env` each
   morning. (A static IP is only required for *order* APIs, which this bot
   never calls.)
4. Optional - **Tev1 model selection** via [Ollama](https://ollama.com):
   ```bash
   ollama pull tev1:0.8b
   ```
   Then set `OLLAMA_BASE_URL=http://127.0.0.1:11434` in `.env` (or set
   `decision.selector` to `"tev1"` in config.json). Without it the bot runs
   the deterministic selector.

## Quick start

```bash
npm install
npm run build
cp .env.example .env        # fill DHAN_CLIENT_ID + DHAN_ACCESS_TOKEN (and Telegram / Ollama if wanted)

npm run selftest            # 173 offline checks - verifies all logic without credentials
npm run chain -- NIFTY      # sanity check: print today's NIFTY option chain
npm run backtest            # optional: replay the pipeline on the last 30 days
npm start                   # live scanner (waits for 09:15 IST if started early)
```

## Modes

| Command | Description |
| --- | --- |
| `npm start` (`npm run scan -- --once`) | Live scanner + paper trader. Runs until 15:15 square-off, writes the daily report, exits. `--force` ignores market-hours checks, `--once` runs a single cycle. |
| `npm run chain -- [SYMBOL]` | One-shot option-chain snapshot with PCR, IV, OI change per strike |
| `npm run backtest -- [--days N]` | Replays the deterministic pipeline (context → registry → risk → paper broker with charges) on expired-options data |
| `npm run report -- [DATE]` | Regenerate the daily paper report from the CSVs |
| `npm run selftest` | Offline unit + integration tests |

## Tev1 integration (Layer 2, optional)

When enabled, each decision cycle sends a **compact, versioned market state**
(regime, ADX/RSI/ATR/VWAP, chain summary, eligible candidates, portfolio
state) to the local Ollama `/v1/systemone` endpoint via
`@nemesis-oss/ollama-sdk` (installed as a dependency), with one `choice`
question: *select the most suitable strategy, or NO_TRADE*.

Guardrails implemented (all unit-tested):

| Scenario | Result |
| --- | --- |
| No eligible candidates | NO_TRADE, zero model calls |
| Model picks an eligible strategy + confidence OK | SELECTED |
| Model picks NO_TRADE | NO_TRADE |
| Model picks an unknown/invented strategy | NO_TRADE |
| Confidence below `minConfidence` | NO_TRADE |
| Malformed / missing answer | NO_TRADE |
| Timeout (`AbortSignal` deadline, no retries) | NO_TRADE |
| Ollama unreachable | NO_TRADE |
| Risk manager rejects the selected candidate | NO position |
| Position hits stop while model is down | Exit proceeds (broker is independent) |

Config (`decision.tev1`): `model` (default `tev1:0.8b`), `baseUrl`,
`timeoutMs` (3000), `minConfidence` (0.55), `keepAlive` (`10m`).

> Note: Tev1's `confidence` is the concentration of its probability
> distribution, **not** the probability that the trade is profitable. Position
> sizing never uses model output - only the deterministic risk rules.

## Paper-trading risk rules (per position)

| Rule | Default | Behaviour |
| --- | --- | --- |
| Stop-loss (SL-M simulation) | 30% below entry | Resting stop like a broker Super Order; fills at trigger-or-worse minus slippage ticks |
| Target | 60% above entry | Limit-style fill at the target price |
| Trailing stop | arms at +25%, trails 15% | Ratchets to `highWater x (1 - 15%)`, never moves down |
| Square-off | 15:15 IST | Everything closes at LTP minus slippage |
| Max concurrent positions | 3 | Risk gate |
| Daily loss cap | INR 5,000 (realized + unrealized) | Risk gate - no new entries for the day |
| Circuit breaker | 3 consecutive losses | Risk gate - paused for the day |
| Max notional / max loss per trade | INR 400,000 / 2,500 | Risk gate |
| Charges model | INR 20 brokerage per executed order + 1 slippage tick per fill | Applied to entries and stop/time exits |

Sizing: `lots` per instrument x live lot size from the instrument master
(NIFTY 65, SENSEX 20, RELIANCE 500, HDFCBANK 650, SBIN 750 as of Nov 2026 -
read fresh from Dhan's scrip master daily).

## Configuration reference (`config.json`)

| Section | Key settings |
| --- | --- |
| `instruments[]` | `symbol`, `kind` (index/stock), `lots`, `expiryPreference` (weekly/monthly) |
| `candles` | `interval` (5), `emaFast`/`emaSlow` (9/21), `refreshMs` |
| `context` | `adxTrend` (25), `adxRange` (18), `highVolAtrPct` (0.25), `minCandles` (20) |
| `strategies` | per-family `enabled` + params (`minSpreadPct`, `rangeCandles`, `rocPct`, `rsiOverbought/Oversold`, `volumeSurge`, `vwapMaxDistancePct`) |
| `chainConfirmation` | `enabled`, `opposeKill` (0.2), `agreeBoost` (0.15) |
| `decision` | `selector` (`auto` = tev1 when `OLLAMA_BASE_URL` is set, else deterministic), `minScore`, `cooldownMinutes`, `maxSignalsPerDay`, `signalWindow`, `tev1.*` |
| `options` | `strikeOffset`, `maxSpreadPct`, `minLegVolume`, `minLegOi`, `maxChainAgeMs`, `minDelta`/`maxDelta`, `ivMin`/`ivMax` |
| `risk` | all limits from the table above |
| `charges` | `brokeragePerOrder`, `slippageTicks` |
| `scanner` | `chainPollMs` (>= 3.5s, option-chain rate limit), `useWebSocket`, `wsFallbackPollMs` |
| `holidays[]` | extra NSE/BSE holidays (YYYY-MM-DD) |

## Files the bot produces

```
data/
├── instruments.csv          # cached scrip master (auto-refreshed daily)
├── positions.json           # paper positions (crash-safe; stale opens auto-squared)
├── decisions.csv            # EVERY decision incl. NO_TRADE + reasons + violations
├── signals.csv              # emitted signals with strategy, scores, spread, regime
├── trades.csv               # paper round-trips with strategy, charges, P&L
├── logs/bot.log
├── reports/report-YYYY-MM-DD.txt
└── backtests/backtest-YYYY-MM-DD.csv
```

## Automation example (cron, IST)

```cron
10 9 * * 1-5 cd /path/to/dhan-options-bot && /usr/bin/npm run scan >> data/logs/cron.log 2>&1
```

(The bot exits by itself after the 15:15 square-off + report.)

## Verify before you trust

1. `npm run selftest` - 173 checks green.
2. `npm run chain -- NIFTY` - real chain data matches your Dhan app.
3. Run it in paper mode for a few days; read `data/reports/*.txt` and
   `decisions.csv` (especially the NO_TRADE reasons - they tell you which
   filter is doing the work).
4. `npm run backtest -- --days 30` - deterministic replay with the
   charges model. Rolling-option data has no historical bid/ask book, so
   spread costs are modelled, not measured - treat it as a sanity check.

## Deliberate scope limits (and the upgrade path)

This bot is a **paper-only** signal scanner. The reference architecture's
live-trading machinery was intentionally NOT wired in:

- **No order APIs.** If you ever adapt this toward live trading, add a durable
  order-intent store, correlation IDs (max 30 chars), a single order manager,
  broker reconciliation, and the explicit `DRY_RUN=false + LIVE_TRADING=true`
  double gate - and comply with SEBI algo-trading rules and Dhan's static-IP
  requirement for order APIs.
- **CSV/JSON persistence instead of PostgreSQL/Redis.** The decision journal,
  trade ledger and position store are files; swap in a real database before
  scaling.
- **Tev1 selects strategies only** - not position sizing, not exits, not risk.

## Disclaimer

Educational software. Paper results model charges and slippage but not real
fills on live depth. Options trading carries substantial risk of loss. Nothing
here is investment advice.

## References

- DhanHQ v2 API docs: <https://docs.dhanhq.co/api/v2/>
- DhanHQ v2 docs mirror used while building: <https://dhanhq.co/docs/v2/>
- Instrument master: <https://images.dhan.co/api-data/api-scrip-master.csv>
- Ollama System One / Tev1: <https://ollama.com/>
- SDK used for Layer 2: `@nemesis-oss/ollama-sdk` (npm)
