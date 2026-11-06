#!/usr/bin/env node
'use strict';

const http = require('http');

const argPayload = process.argv[2] || '';
let sent = false;

function sendAndExit(rawStr) {
  if (sent) return;
  sent = true;

  let obj = {};
  if (rawStr) {
    try {
      obj = JSON.parse(rawStr);
    } catch (_) {
      obj = { hook_event_name: rawStr };
    }
  }
  if (!obj.hook_event_name && argPayload && !argPayload.trim().startsWith('{')) {
    obj.hook_event_name = argPayload.trim();
  }
  const payload = JSON.stringify(obj);

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 17532,
      path: '/hook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload, 'utf8')
      },
      timeout: 150
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

  req.on('error', () => process.exit(0));
  req.write(payload);
  req.end();
}

// Codex `notify = [...]` passes JSON as argv[2] with closed/empty stdin,
// while `~/.codex/hooks.json` passes JSON on stdin and event name as argv[2].
if (argPayload && argPayload.trim().startsWith('{')) {
  sendAndExit(argPayload.trim());
} else {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    sendAndExit(raw || argPayload || 'ping');
  });
}

setTimeout(() => process.exit(0), 180);
