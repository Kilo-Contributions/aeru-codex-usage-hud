#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { scanCodexUsage } = require('./usage');

const HOST = '127.0.0.1';
const PREFERRED_PORT = Number(process.env.PORT) || 8787;
const ROOT = __dirname;
const CODEX_DIR = process.env.AERU_CODEX_DIR || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');
const SHOULD_OPEN = !process.argv.includes('--no-open');

function contentType(file) {
  return file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true });
  else if (process.platform === 'darwin') execFile('open', [url]);
  else execFile('xdg-open', [url]);
}

function createServer({ codexDir = CODEX_DIR } = {}) {
  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url, `http://${HOST}`).pathname;
    if (pathname === '/api/usage') {
      const weekOffset = Number(new URL(request.url, `http://${HOST}`).searchParams.get('weekOffset')) || 0;
      try { sendJson(response, 200, await scanCodexUsage({ codexDir, weekOffset })); }
      catch (error) {
        console.error(`Unable to scan local Codex history: ${error.message}`);
        sendJson(response, 500, { error: 'Unable to scan local Codex history.' });
      }
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      try {
        const page = await fsp.readFile(path.join(ROOT, 'public', 'index.html'));
        response.writeHead(200, { 'Content-Type': contentType('index.html'), 'Cache-Control': 'no-store' });
        response.end(page);
      } catch { response.writeHead(500); response.end('Dashboard file is missing.'); }
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  });
}

async function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

async function main() {
  if (!fs.existsSync(CODEX_DIR)) {
    console.error(`Could not find a Codex directory at: ${CODEX_DIR}`);
    console.error('Set AERU_CODEX_DIR only if your Codex data lives elsewhere.');
    process.exitCode = 1;
    return;
  }
  const server = createServer();
  let port = PREFERRED_PORT;
  for (; port < PREFERRED_PORT + 10; port += 1) {
    try { await listen(server, port); break; }
    catch (error) { if (error.code !== 'EADDRINUSE' || port === PREFERRED_PORT + 9) throw error; }
  }
  const url = `http://${HOST}:${port}`;
  console.log('\nAERU CODEX USAGE HUD\nLocal-only Codex analytics\n');
  console.log(`Reading Codex data from:\n${CODEX_DIR}\n`);
  console.log('Archived logs: included when available');
  console.log(`Dashboard: ${url}`);
  if (SHOULD_OPEN) { console.log('Opening browser...'); openBrowser(url); }
  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (require.main === module) {
  main().catch((error) => { console.error(`Unable to start dashboard: ${error.message}`); process.exitCode = 1; });
}

module.exports = { createServer };
