function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Merge `over` onto `base`: plain objects merge key by key, any other value in `over` replaces the base value.
function deepMerge(base, over) {
  const out = Object.assign({}, base);
  for (const key of Object.keys(over || {})) {
    if (isPlainObject(out[key]) && isPlainObject(over[key])) out[key] = deepMerge(out[key], over[key]);
    else out[key] = over[key];
  }
  return out;
}

module.exports = { deepMerge, isPlainObject };
