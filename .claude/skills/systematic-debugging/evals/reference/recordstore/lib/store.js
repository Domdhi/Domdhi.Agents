const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// SECURITY-142 fix: every id is sanitized before it is joined to a path. Read, create, archive and the CLI all
// go through this one helper, so no sink can build a path from a raw id.
function cleanId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function recordPath(id) {
  return path.join(DATA_DIR, cleanId(id) + '.json');
}

function archivePath(id) {
  return path.join(DATA_DIR, 'archive', cleanId(id) + '.json');
}

function createRecord(id, payload) {
  const p = recordPath(id);
  fs.writeFileSync(p, JSON.stringify(payload));
  return p;
}

function readRecord(id) {
  return JSON.parse(fs.readFileSync(recordPath(id), 'utf8'));
}

function archiveRecord(id) {
  const src = recordPath(id);
  const dst = archivePath(id);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  return dst;
}

module.exports = { createRecord, readRecord, archiveRecord, recordPath, archivePath, DATA_DIR };
