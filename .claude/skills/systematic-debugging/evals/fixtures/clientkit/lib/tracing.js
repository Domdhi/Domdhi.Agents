// Marks a client's config so its requests can be told apart in the logs.
function withTracing(config, name) {
  config.headers['x-client'] = name;
  config.tags.push('traced:' + name);
  return config;
}

module.exports = { withTracing };
