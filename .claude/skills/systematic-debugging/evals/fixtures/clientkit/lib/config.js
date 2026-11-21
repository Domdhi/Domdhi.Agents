const { DEFAULTS } = require('./defaults');
const { deepMerge } = require('./merge');

// The configuration of one client: the library defaults with the caller's overrides on top.
function resolveConfig(overrides) {
  return deepMerge(DEFAULTS, overrides);
}

module.exports = { resolveConfig };
