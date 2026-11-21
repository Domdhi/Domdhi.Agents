#!/usr/bin/env node
// Minimal ops CLI for the record store.
const fs = require('fs');
const { recordPath } = require('../lib/store');

const [, , cmd, id, json] = process.argv;

if (cmd === 'put') {
  const p = recordPath(id);
  fs.writeFileSync(p, json || '{}');
  console.log('wrote ' + p);
} else if (cmd === 'del') {
  const p = recordPath(id);
  fs.unlinkSync(p);
  console.log('deleted ' + p);
} else {
  console.log('usage: cli.js put|del <id> [json]');
}
