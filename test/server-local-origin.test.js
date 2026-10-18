'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('../server');

async function request(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: route, headers }, res => {
      const chunks = [];
      res.on('data', part => chunks.push(part));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject);
  });
}

test('localhost HUD rejects forged Host and cross-origin browser requests', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aeru-guard-'));
  const server = createServer({ codexDir: root });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const validHost = '127.0.0.1:' + port;
  const legitimate = await request(port, '/api/usage', { Host: validHost });
  assert.equal(legitimate.status, 200);
  assert.equal(JSON.parse(legitimate.body).lifetime.totalTokens, 0);

  const forged = await request(port, '/api/usage', { Host: 'attacker.invalid' });
  assert.equal(forged.status, 403, 'data must not be readable with attacker-controlled Host');

  const wrongPort = await request(port, '/api/usage', { Host: 'localhost:8787' });
  assert.equal(wrongPort.status, 403);

  const hostileOrigin = await request(port, '/api/usage', {
    Host: validHost,
    Origin: 'https://attacker.invalid'
  });
  assert.equal(hostileOrigin.status, 403, 'cross-site Origin must be denied');

  const legitOrigin = await request(port, '/api/usage', {
    Host: validHost,
    Origin: 'http://' + validHost
  });
  assert.equal(legitOrigin.status, 200);
});
