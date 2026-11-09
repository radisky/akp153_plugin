#!/usr/bin/env node
'use strict';

const http = require('http');

const DEFAULT_PORT = 17530;
const envPort = Number(process.env.CLAUDE_SD_HTTP_PORT || DEFAULT_PORT);
const PORT = Number.isInteger(envPort) && envPort >= 1024 && envPort <= 65535 ? envPort : DEFAULT_PORT;

function buildSessionMeta() {
  const env = process.env || {};
  return {
    agentPid: process.ppid || 0,
    cwd: process.cwd(),
    termProgram: env.TERM_PROGRAM || env.TERMINAL_EMULATOR || '',
    orcaHandle:
      env.ORCA_TERMINAL_HANDLE ||
      env.ORCA_TERMINAL_ID ||
      env.ORCA_HANDLE ||
      '',
    orcaWorktreeId: env.ORCA_WORKTREE_ID || '',
    orcaWorktreePath: env.ORCA_WORKTREE_PATH || '',
    orcaSessionId: env.ORCA_AGENT_SESSION_ID || '',
    orcaCli: env.ORCA_CLI_COMMAND || '',
    vscodePid: Number(env.VSCODE_PID || 0) || 0
  };
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  let obj = {};
  if (raw) {
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      obj = { hook_event_name: raw };
    }
  }
  if (!obj.hook_event_name && process.argv[2]) {
    obj.hook_event_name = process.argv[2];
  }
  if (!obj.hook_event_name) {
    obj.hook_event_name = 'ping';
  }
  obj._session = buildSessionMeta();
  const payload = JSON.stringify(obj);

  const req = http.request(
    {
      hostname: '127.0.0.1',
      localAddress: '127.0.0.1',
      port: PORT,
      path: '/hook',
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${PORT}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload, 'utf8')
      },
      timeout: 160
    },
    (res) => {
      res.resume();
      res.on('end', () => process.exit(0));
    }
  );

  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });

  req.on('error', () => {
    process.exit(0);
  });

  req.write(payload);
  req.end();
});

setTimeout(() => process.exit(0), 220);
