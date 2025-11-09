#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVER_PORT = process.env.ACP_PORT ?? '8000';
const SERVER_URL = process.env.ACP_BASE_URL ?? `http://localhost:${SERVER_PORT}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');

function log(...args) {
  console.log('[acp-e2e]', ...args);
}

function startServer() {
  log('starting ACP Next.js server...');
  return spawn('npm', ['run', 'dev'], {
    cwd: PACKAGE_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ACP_PORT: SERVER_PORT },
  });
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${SERVER_URL}/api/acp/agents`);
      if (res.ok) {
        log('server is ready');
        return;
      }
    } catch {
      // wait and retry
    }
    await sleep(1000);
  }
  throw new Error('Timed out waiting for ACP server to start');
}

async function runClient() {
  log('running ACP client tests...');
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'client:test'], {
      cwd: PACKAGE_ROOT,
      stdio: 'inherit',
      env: { ...process.env, ACP_BASE_URL: SERVER_URL },
    });
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`client exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  const server = startServer();
  const cleanup = () => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
  };
  try {
    await waitForServer();
    await runClient();
    log('ACP end-to-end test succeeded');
  } finally {
    cleanup();
  }
}

main().catch(err => {
  console.error('[acp-e2e] failed:', err);
  process.exit(1);
});
