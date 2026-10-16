'use strict';

// Optional, read-only experiment. No model launches, persistence, network calls,
// authority grants, or claims of authenticated provider receipts.

const SCHEMA = 'gsv.workglass.usage-observation.v1';
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function count(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE) {
    throw new TypeError('invalid nonnegative integer: ' + field);
  }
  return value;
}

function optionalEstimate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function normalizeAeruSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary) ||
      !summary.lifetime || !summary.source) {
    throw new TypeError('invalid Aeru usage summary');
  }
  const usage = summary.lifetime;
  const inputTokens = count(usage.inputTokens, 'inputTokens');
  const outputTokens = count(usage.outputTokens, 'outputTokens');
  const cachedInputTokens = count(usage.cachedInputTokens, 'cachedInputTokens');
  const totalTokens = count(usage.totalTokens, 'totalTokens');
  if (cachedInputTokens > inputTokens || totalTokens < inputTokens + outputTokens) {
    throw new TypeError('inconsistent token counters');
  }
  const filesScanned = count(summary.source.filesScanned, 'filesScanned');
  const sessionsFound = count(summary.source.sessionsFound, 'sessionsFound');
  if (sessionsFound > filesScanned) throw new TypeError('inconsistent session count');

  const generated = new Date(summary.generatedAt);
  if (typeof summary.generatedAt !== 'string' || Number.isNaN(generated.getTime())) {
    throw new TypeError('invalid generation timestamp');
  }
  // Whitelist explicitly: source contains local filesystem metadata, project
  // names and arbitrary history labels; none should cross this boundary.
  return {
    schema: SCHEMA,
    generatedAt: generated.toISOString(),
    provider: 'codex',
    model: null,
    usage: { inputTokens, outputTokens, cachedInputTokens, totalTokens },
    cost: {
      billedUsd: null,
      apiEquivalentEstimateUsd: optionalEstimate(usage.estimatedCost)
    },
    source: {
      kind: 'LOCAL_CLI_HISTORY_SUMMARY',
      authenticated: false,
      filesScanned,
      sessionsFound
    },
    outcome: {
      independentlyVerifiedCompletedTasks: null,
      operatorMinutes: null,
      endToEndDurationMs: null,
      causalTokenSavings: null,
      causalCostSavingsUsd: null,
      confidence: 'NOT_ESTABLISHED'
    },
    authorityEffect: 'none'
  };
}

module.exports = { SCHEMA, normalizeAeruSummary };
