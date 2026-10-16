'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanCodexUsage } = require('../usage');

async function writeJsonl(file, records) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n') + '\n');
}

test('scans current and archived rollouts, deduplicates responses, and skips malformed lines', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aeru-usage-hud-'));
  try {
    await writeJsonl(path.join(root, 'sessions', 'current.jsonl'), [
      { type: 'session_meta', payload: { session_id: 'session-current', cwd: path.join(root, 'sample-project') } },
      { type: 'turn_context', payload: { model: 'test-model' } },
      { type: 'token_usage_record', timestamp: '2026-10-15T12:00:00.000Z', payload: { response_id: 'response-1', usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40, total_tokens: 120 } } },
      '{not-json}'
    ]);
    await writeJsonl(path.join(root, 'archived_sessions', 'archived.jsonl'), [
      { type: 'session_meta', payload: { session_id: 'session-archived', cwd: path.join(path.dirname(root), 'other-project') } },
      { type: 'turn_context', payload: { model: 'test-model' } },
      { type: 'token_usage_record', timestamp: '2026-10-14T12:00:00.000Z', payload: { response_id: 'response-1', usage: { input_tokens: 900, output_tokens: 90, total_tokens: 990 } } },
      { type: 'token_usage_record', timestamp: '2026-10-14T13:00:00.000Z', payload: { response_id: 'response-2', usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } } }
    ]);

    const result = await scanCodexUsage({ codexDir: root });
    assert.equal(result.source.filesScanned, 2);
    assert.equal(result.source.sessionsFound, 2);
    assert.equal(result.source.archivedIncluded, true);
    assert.equal(result.lifetime.totalTokens, 180);
    assert.equal(result.lifetime.inputTokens, 150);
    assert.equal(result.lifetime.outputTokens, 30);
    assert.equal(result.lifetime.cachedInputTokens, 40);
    assert.equal(result.warnings.malformedLines, 1);
    assert.equal(result.warnings.unreadableFiles, 0);
    assert.equal(result.models[0].name, 'test-model');
    assert.equal(result.topProjects[0].name, 'Codex workspace');
    assert.ok(result.topProjects.some((project) => project.name === 'other-project'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('returns an empty safe result when the history folders are absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aeru-usage-hud-empty-'));
  try {
    const result = await scanCodexUsage({ codexDir: root });
    assert.equal(result.source.filesScanned, 0);
    assert.equal(result.source.sessionsFound, 0);
    assert.equal(result.lifetime.totalTokens, 0);
    assert.equal(result.topProjects.length, 0);
    assert.equal(result.models.length, 0);
    assert.deepEqual(result.warnings, { malformedLines: 0, unreadableFiles: 0 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
