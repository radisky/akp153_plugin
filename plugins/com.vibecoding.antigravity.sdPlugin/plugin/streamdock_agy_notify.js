#!/usr/bin/env node
'use strict';

const http = require('http');

const eventArg = process.argv[2] || '';
const DEFAULT_PORT = 17531;
const envPort = Number(process.env.AGY_SD_HTTP_PORT || DEFAULT_PORT);
const PORT = Number.isInteger(envPort) && envPort >= 1024 && envPort <= 65535 ? envPort : DEFAULT_PORT;

let finished = false;

function finish() {
  if (finished) return;
  finished = true;
  if (eventArg === 'Stop') {
    process.stdout.write('{"decision":"stop"}\n');
  } else {
    process.stdout.write('{}\n');
  }
  process.exit(0);
}

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
  let obj = {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw) {
    try { obj = JSON.parse(raw); } catch (_) {}
  }
  if (!obj.hook_event_name && eventArg) {
    obj.hook_event_name = eventArg;
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
      timeout: 150
    },
    (res) => {
      res.resume();
      res.on('end', finish);
    }
  );

  req.on('timeout', () => {
    req.destroy();
    finish();
  });

  req.on('error', finish);
  req.write(payload);
  req.end();
});

setTimeout(finish, 200);
