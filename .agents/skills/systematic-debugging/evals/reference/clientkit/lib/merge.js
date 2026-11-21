function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A deep copy of a plain value: no object or array of the result is shared with the source.
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out;
  }
  return value;
}

function mergeInto(target, over) {
  for (const key of Object.keys(over || {})) {
    target[key] = isPlainObject(target[key]) && isPlainObject(over[key]) ? mergeInto(target[key], over[key]) : clone(over[key]);
  }
  return target;
}

// Merge `over` onto `base`: plain objects merge key by key, any other value in `over` replaces the base value.
// The result shares no object or array with `base` or `over`, so a caller that mutates its config (a client
// counting requests, tracing, a profile) can never change the defaults or another client's config.
function deepMerge(base, over) {
  return mergeInto(clone(base || {}), over);
}

module.exports = { deepMerge, isPlainObject };
