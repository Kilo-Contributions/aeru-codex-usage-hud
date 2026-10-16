'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { normalizeAeruSummary } = require('../experiments/workglass/normalize-aeru');
const { scanCodexUsage } = require('../usage');

function fixture() {
  return {
    generatedAt: '2026-10-16T12:00:00.000Z',
    lifetime: {
      totalTokens: 350, inputTokens: 300, outputTokens: 50,
      cachedInputTokens: 200, estimatedCost: 0.001
    },
    source: {
      filesScanned: 1, sessionsFound: 1,
      localHistoryPath: '/home/person/.codex/private',
      token: 'SYNTHETIC_CANARY_DO_NOT_EXPORT'
    },
    topProjects: [{
      name: 'SYNTHETIC_CANARY_DO_NOT_EXPORT', tokens: 350
    }],
    models: [{ name: 'SYNTHETIC_CANARY_DO_NOT_EXPORT', tokens: 350 }]
  };
}

test('exports aggregate-only unverified telemetry without local identifiers', () => {
  const report = normalizeAeruSummary(fixture());
  assert.equal(report.provider, 'codex');
  assert.equal(report.usage.totalTokens, 350);
  assert.equal(report.usage.cachedInputTokens, 200);
  assert.equal(report.model, null);
  assert.equal(report.source.authenticated, false);
  assert.equal(report.cost.billedUsd, null);
  assert.equal(report.cost.apiEquivalentEstimateUsd, 0.001);
  assert.equal(report.outcome.causalTokenSavings, null);
  assert.equal(report.outcome.independentlyVerifiedCompletedTasks, null);
  assert.equal(report.authorityEffect, 'none');
  const encoded = JSON.stringify(report);
  assert.ok(!encoded.includes('SYNTHETIC_CANARY_DO_NOT_EXPORT'));
  assert.ok(!encoded.includes('/home/person'));
  assert.ok(!encoded.includes('topProjects'));
});

test('does not upgrade missing cost to zero or infer productivity', () => {
  const f = fixture();
  delete f.lifetime.estimatedCost;
  const result = normalizeAeruSummary(f);
  assert.equal(result.cost.apiEquivalentEstimateUsd, null);
  assert.equal(result.outcome.confidence, 'NOT_ESTABLISHED');
  assert.equal(result.outcome.causalCostSavingsUsd, null);
});

test('refuses fabricated totals and unsafe negative/nonnumeric fields', () => {
  for (const [field, value] of [
    ['inputTokens', -1], ['outputTokens', NaN],
    ['totalTokens', Infinity], ['cachedInputTokens', 301],
    ['totalTokens', 100], ['inputTokens', '300']
  ]) {
    const f = fixture();
    f.lifetime[field] = value;
    assert.throws(() => normalizeAeruSummary(f), TypeError);
  }
  const f = fixture();
  f.source.sessionsFound = 10;
  assert.throws(() => normalizeAeruSummary(f), TypeError);
});

test('normalizes actual scanner output from synthetic local history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workglass-contract-'));
  try {
    const dir = path.join(root, 'sessions');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'sample.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 's1', cwd: '/PRIVATE_CODEBASE' } }),
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-10-16T11:00:00Z',
        payload: {
          response_id: 'response_1',
          usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, total_tokens: 120 }
        }
      })
    ].join('\n') + '\n');
    const source = await scanCodexUsage({ codexDir: root });
    const result = normalizeAeruSummary(source);
    assert.equal(result.usage.totalTokens, 120);
    assert.equal(result.source.sessionsFound, 1);
    assert.equal(result.cost.billedUsd, null);
    assert.equal(result.outcome.causalTokenSavings, null);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_CODEBASE'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
