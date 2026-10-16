'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { scanCodexUsage } = require('../usage');

test('Codex cumulative token_count events count advances once, not repeated snapshots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aeru-codex-rollout-'));
  try {
    const filename = path.join(root, 'sessions', 'sample.jsonl');
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const events = [
      { type: 'session_meta', payload: { id: 'sample', cwd: '/projects/demo' } },
      { type: 'turn_context', payload: { model: 'codex-example' } },
      { type: 'event_msg', timestamp: '2026-10-16T10:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, total_tokens: 120 } } } },
      { type: 'event_msg', timestamp: '2026-10-16T10:00:01Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, total_tokens: 120 } } } },
      { type: 'event_msg', timestamp: '2026-10-16T10:00:02Z', payload: { type: 'token_count', info: null } },
      { type: 'event_msg', timestamp: '2026-10-16T10:00:03Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 50, total_tokens: 350 } } } }
    ];
    await fs.writeFile(filename, events.map(row => JSON.stringify(row)).join('\n') + '\n');
    const result = await scanCodexUsage({ codexDir: root });
    assert.equal(result.lifetime.totalTokens, 350);
    assert.equal(result.lifetime.inputTokens, 300);
    assert.equal(result.lifetime.outputTokens, 50);
    assert.equal(result.lifetime.cachedInputTokens, 200);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
