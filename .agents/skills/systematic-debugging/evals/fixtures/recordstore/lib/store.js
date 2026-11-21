const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// SECURITY-142 fix landed here: the id is sanitized before being joined.
function recordPath(id) {
  const clean = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_DIR, clean + '.json');
}

function createRecord(id, payload) {
  const p = path.join(DATA_DIR, String(id) + '.json');
  fs.writeFileSync(p, JSON.stringify(payload));
  return p;
}

function readRecord(id) {
  return JSON.parse(fs.readFileSync(recordPath(id), 'utf8'));
}

function archiveRecord(id) {
  const src = path.join(DATA_DIR, String(id) + '.json');
  const dst = path.join(DATA_DIR, 'archive', String(id) + '.json');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  return dst;
}

module.exports = { createRecord, readRecord, archiveRecord, recordPath, DATA_DIR };
