#!/usr/bin/env node
// Minimal ops CLI for the record store.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const [, , cmd, id, json] = process.argv;

if (cmd === 'put') {
  const p = path.join(DATA_DIR, id + '.json');
  fs.writeFileSync(p, json || '{}');
  console.log('wrote ' + p);
} else if (cmd === 'del') {
  const p = path.join(DATA_DIR, id + '.json');
  fs.unlinkSync(p);
  console.log('deleted ' + p);
} else {
  console.log('usage: cli.js put|del <id> [json]');
}
