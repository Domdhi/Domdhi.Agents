const PROFILES = {
  patient: { timeoutMs: 10000, retryMax: 6, extraBackoffMs: [800, 1600] },
};

// Tunes a client's config for a named profile.
function applyProfile(config, name) {
  const profile = PROFILES[name];
  if (!profile) throw new Error('unknown profile: ' + name);
  config.timeoutMs = profile.timeoutMs;
  config.retry.max = profile.retryMax;
  config.retry.backoffMs.push(...profile.extraBackoffMs);
  return config;
}

module.exports = { applyProfile, PROFILES };
