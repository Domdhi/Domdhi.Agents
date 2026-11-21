// Library defaults. Every client starts from these values.
const DEFAULTS = {
  baseUrl: 'https://api.example.test',
  timeoutMs: 3000,
  retry: { max: 3, backoffMs: [100, 200, 400] },
  quota: { remaining: 100 },
  headers: { accept: 'application/json' },
  tags: ['svc'],
  trace: false,
  profile: null,
};

module.exports = { DEFAULTS };
