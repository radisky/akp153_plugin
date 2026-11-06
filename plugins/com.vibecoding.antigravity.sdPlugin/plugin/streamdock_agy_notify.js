#!/usr/bin/env node
'use strict';

const http = require('http');

const eventArg = process.argv[2] || '';
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
  const payload = JSON.stringify(obj);

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 17531,
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
