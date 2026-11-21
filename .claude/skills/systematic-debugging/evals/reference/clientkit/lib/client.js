const { resolveConfig } = require('./config');
const { withTracing } = require('./tracing');
const { applyProfile } = require('./profiles');

function createClient(name, overrides) {
  const config = resolveConfig(overrides);
  if (config.profile) applyProfile(config, config.profile);
  if (config.trace) withTracing(config, name);

  function request(path) {
    if (config.quota.remaining <= 0) throw new Error('quota exhausted');
    config.quota.remaining -= 1;
    return { url: config.baseUrl + path, status: 200, headers: Object.assign({}, config.headers) };
  }

  return { name, config, request };
}

module.exports = { createClient };
