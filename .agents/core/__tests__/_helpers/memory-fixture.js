/**
 * memory-fixture — writes structured JSON memory files matching the shape
 * produced by memory-extractor.js and memory-manager.js create.
 *
 * File layout: {tmpDirHelper.root}/docs/.output/.memory/{category}/{id}.json
 * (the TRACKED JSON source — jsonRoot per _lib/memory-paths.js, ADR 0006 Am. 2).
 */

'use strict';

const path = require('node:path');
const CONSTANTS = require('../../constants');

const DEFAULT_CATEGORIES = Object.values(CONSTANTS.MEMORY_CATEGORIES);

/**
 * createMemory(tmpDirHelper, category, id, opts)
 *
 * opts:
 *   description  {string}        — content.description (the summary text the prime hook extracts)
 *   confidence   {number}        — metadata.confidence (default 1)
 *   importance   {number}        — write-time retention priority 1–5 (default 3); stored at
 *                                  content.importance AND top-level importance to mirror the
 *                                  real memory-manager.js create shape. Omit to use default.
 *   usage_count  {number}        — default 0
 *   updated      {string|Date}   — ISO timestamp (default: now)
 *   created      {string|Date}   — ISO timestamp (default: now)
 *   extra        {object}        — extra fields spread into content
 */
function createMemory(tmpDirHelper, category, id, opts = {}) {
  const {
    description = '',
    confidence = 1,
    importance,
    usage_count = 0,
    updated,
    created,
    extra = {},
  } = opts;

  const nowIso = new Date().toISOString();
  const updatedIso = updated instanceof Date
    ? updated.toISOString()
    : (updated || nowIso);
  const createdIso = created instanceof Date
    ? created.toISOString()
    : (created || updatedIso);

  const contentImportance = importance !== undefined ? { importance } : {};

  const memory = {
    id,
    type: category.replace(/s$/, ''),
    category,
    created: createdIso,
    updated: updatedIso,
    usage_count,
    ...(importance !== undefined ? { importance } : {}),
    content: {
      description,
      ...contentImportance,
      ...extra,
    },
    metadata: {
      sessions: [],
      agents: [],
      confidence,
    },
  };

  const relPath = path.join('docs', '.output', '.memory', category, `${id}.json`);
  return tmpDirHelper.write(relPath, JSON.stringify(memory, null, 2));
}

module.exports = { createMemory, DEFAULT_CATEGORIES };
