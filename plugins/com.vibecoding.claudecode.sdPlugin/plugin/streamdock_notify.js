#!/usr/bin/env node
'use strict';

const http = require('http');

let chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  const payload = raw || JSON.stringify({ hook_event_name: process.argv[2] || 'ping' });

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 17530,
      path: '/hook',
      method: 'POST',
      headers: {
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
