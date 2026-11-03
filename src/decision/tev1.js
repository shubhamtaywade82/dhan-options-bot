/**
 * Tev1 Strategy Selector (Layer 2) via @nemesis-oss/ollama-sdk.
 *
 * A context-conditioned selector - NOT the trading brain, NOT the risk
 * manager. It can only choose among candidates that already passed the
 * deterministic Layer-1 eligibility checks, plus NO_TRADE.
 *
 * Fail-closed rules (every failure mode becomes NO_TRADE):
 *   - no eligible candidates             -> NO_TRADE (no model call at all)
 *   - model picks an unknown strategy    -> NO_TRADE
 *   - confidence below policy threshold  -> NO_TRADE
 *   - malformed / missing answer         -> NO_TRADE
 *   - timeout / model unavailable        -> NO_TRADE (AbortSignal deadline)
 *
 * The model can never: invent a contract, change risk parameters, override a
 * risk rejection, or re-open an evaluation the journal already decided.
 *
 * SDK surface used (verified against @nemesis-oss/ollama-sdk 1.25.0):
 *   new OllamaClient({ baseUrl, timeoutMs, retries })
 *   client.systemOne({ model, state, questions, keep_alive }, { signal })
 *   response.answers.<key> -> { type:'choice', choice, probabilities, confidence }
 */

export const NO_TRADE_KEY = 'NO_TRADE';

export class Tev1StrategySelector {
  /**
   * @param {object} clientLike an OllamaClient (or a stub with systemOne())
   * @param {object} policy { model, minConfidence, timeoutMs, keepAlive, logger }
   */
  constructor(clientLike, policy = {}) {
    this.client = clientLike;
    this.policy = {
      model: policy.model || 'tev1:0.8b',
      minConfidence: policy.minConfidence ?? 0.55,
      timeoutMs: policy.timeoutMs ?? 3000,
      keepAlive: policy.keepAlive || '10m',
      logger: policy.logger || null,
    };
    this.calls = 0;
  }

  /**
   * @param {object} params {
   *   state: object            compact, versioned market state (see buildTev1State)
   *   candidates: [{ strategyId, direction, score, description }]
   * }
   * @returns {Promise<{status:'SELECTED', strategyId, confidence, probabilities}|{status:'NO_TRADE', reason}>}
   */
  async select({ state, candidates }) {
    if (!candidates || candidates.length === 0) {
      return { status: 'NO_TRADE', reason: 'NO_ELIGIBLE_CANDIDATES' };
    }

    // Only rule-engine-approved strategies ever reach the model.
    const known = new Set(candidates.map((c) => c.strategyId));
    const criteria = {};
    for (const c of candidates) criteria[c.strategyId] = c.description || c.strategyId;
    criteria[NO_TRADE_KEY] = 'No eligible candidate provides a sufficiently clear setup right now.';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.policy.timeoutMs);
    this.calls += 1;

    // Belt-and-braces: race the call against the abort signal so a hung
    // transport can never outlive the decision deadline.
    const abortPromise = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('decision deadline exceeded')), { once: true });
    });

    try {
      const response = await Promise.race([
        this.client.systemOne(
          {
            model: this.policy.model,
            state,
            questions: {
              strategy: {
                type: 'choice',
                instructions:
                  'Considering the supplied market context, eligible strategies and portfolio state, ' +
                  'select the most suitable strategy. Choose NO_TRADE when the evidence does not justify an entry.',
                criteria,
              },
            },
            keep_alive: this.policy.keepAlive,
          },
          { signal: controller.signal },
        ),
        abortPromise,
      ]);

      const answer = response?.answers?.strategy;
      if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') {
        return { status: 'NO_TRADE', reason: 'INVALID_DECISION_TYPE' };
      }
      if (answer.choice === NO_TRADE_KEY) {
        return { status: 'NO_TRADE', reason: 'MODEL_SELECTED_NO_TRADE' };
      }
      if (!known.has(answer.choice)) {
        return { status: 'NO_TRADE', reason: 'UNKNOWN_STRATEGY_SELECTION' };
      }
      const confidence = answer.confidence;
      if (!Number.isFinite(confidence) || confidence < this.policy.minConfidence) {
        return { status: 'NO_TRADE', reason: 'INSUFFICIENT_MODEL_CONFIDENCE' };
      }
      return {
        status: 'SELECTED',
        strategyId: answer.choice,
        confidence: Math.round(confidence * 1000) / 1000,
        probabilities: answer.probabilities || {},
      };
    } catch {
      // Timeout, network failure, malformed response, model unavailable:
      // never turn an inference failure into a trade.
      return { status: 'NO_TRADE', reason: 'DECISION_SERVICE_UNAVAILABLE' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build the compact, versioned market state sent to Tev1.
 * Kept deliberately small: Tev1's decision context is limited.
 */
export function buildTev1State({ snapshotId, symbol, expiry, context, candidates, portfolio }) {
  return {
    schemaVersion: 'options-decision-v1',
    snapshotId,
    timestamp: new Date().toISOString(),
    underlying: {
      symbol,
      spot: context.spot,
      changePct: context.changePct,
      rsi14: context.rsi14,
      atrPct: context.atrPct,
    },
    marketContext: {
      regime: context.regime,
      trendStrength: context.trendStrength,
      adx: context.adx,
      vwapDistancePct: context.vwapDistancePct,
      supportDistancePct: context.supportDistancePct,
      resistanceDistancePct: context.resistanceDistancePct,
    },
    chainSummary: context.chain ? {
      atmStrike: context.chain.atmStrike,
      atmIv: context.chain.atmIv,
      putCallOiRatio: context.chain.putCallOiRatio,
      chainBias: context.chain.chainBias,
      daysToExpiry: expiry?.daysToExpiry ?? null,
    } : null,
    eligibleCandidates: (candidates || []).map((c) => ({
      strategyId: c.strategyId,
      direction: c.direction === 'CE' ? 'BULLISH' : 'BEARISH',
      score: c.score,
    })),
    portfolio: {
      openPositions: portfolio?.openPositions ?? 0,
      dailyPnl: portfolio?.dailyPnl ?? 0,
    },
  };
}

/**
 * Create a Tev1Selector from config. Loads the SDK dynamically so the bot
 * still runs (deterministic-only) when the package or server is absent.
 * Returns null when the SDK cannot be loaded.
 */
export async function createTev1Selector(tev1Cfg, { logger = null } = {}) {
  let mod;
  try {
    mod = await import('@nemesis-oss/ollama-sdk');
  } catch (err) {
    logger?.warn(`@nemesis-oss/ollama-sdk not available - falling back to deterministic selection (${err.message})`);
    return null;
  }
  const client = new mod.OllamaClient({
    baseUrl: tev1Cfg.baseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    timeoutMs: tev1Cfg.timeoutMs ?? 3000,
    retries: 0, // never spend the entry decision budget on retries
  });
  return new Tev1StrategySelector(client, { ...tev1Cfg, logger });
}

/**
 * Deterministic selector (no model): highest-scoring candidate wins,
 * or NO_TRADE when nothing clears the minimum score.
 */
export function deterministicSelect(candidates, { minScore = 0.45 } = {}) {
  if (!candidates || candidates.length === 0) {
    return { status: 'NO_TRADE', reason: 'NO_ELIGIBLE_CANDIDATES' };
  }
  const best = [...candidates].sort((a, b) => b.score - a.score)[0];
  if (best.score < minScore) {
    return { status: 'NO_TRADE', reason: 'BELOW_MIN_SCORE' };
  }
  return { status: 'SELECTED', strategyId: best.strategyId, confidence: best.score, probabilities: {} };
}
