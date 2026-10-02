"use strict";

/** Return an ISO timestamp for a Date-compatible value. */
function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

/** Sleep without blocking the event loop. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Bound a promise by a wall-clock timeout and observe late rejection safely. */
function withTimeout(operation, timeoutMs, options = {}) {
  const limit = Math.max(1, Number(timeoutMs) || 1);
  const promise = Promise.resolve().then(() => typeof operation === "function" ? operation() : operation);
  promise.catch(() => {});
  let timer;
  let abortHandler;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(options.message || `Operation timed out after ${limit} ms`);
      error.code = options.code || "ETIMEDOUT";
      error.retryable = options.retryable !== false;
      error.timeoutMs = limit;
      reject(error);
    }, limit);
  });
  const aborted = new Promise((_resolve, reject) => {
    if (!options.signal) return;
    abortHandler = () => {
      const error = new Error(options.abortMessage || "Operation was aborted");
      error.code = "ERR_ABORTED";
      error.retryable = false;
      reject(error);
    };
    if (options.signal.aborted) abortHandler();
    else options.signal.addEventListener("abort", abortHandler, { once: true });
  });
  return Promise.race([promise, timeout, aborted]).finally(() => {
    clearTimeout(timer);
    if (options.signal && abortHandler) options.signal.removeEventListener("abort", abortHandler);
  });
}

/** Limit a numeric value to an inclusive range. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Convert a value to a finite number or return null. */
function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : null;
}

/** Calculate the median of finite numeric values. */
function median(values) {
  const sorted = values.map(finite).filter((value) => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** Calculate median absolute deviation. */
function mad(values, center = median(values)) {
  if (center === null) return null;
  return median(values.map((value) => Math.abs(value - center)));
}

/** Calculate a percentile using linear interpolation. */
function percentile(values, probability) {
  const sorted = values.map(finite).filter((value) => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = clamp(probability, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Execute asynchronous work with bounded concurrency. */
async function mapLimit(items, limit, worker) {
  const source = Array.from(items);
  const results = new Array(source.length);
  let index = 0;
  const count = Math.max(1, Math.min(Number(limit) || 1, source.length || 1));
  async function runner() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= source.length) return;
      try {
        results[current] = { status: "fulfilled", value: await worker(source[current], current) };
      } catch (error) {
        results[current] = { status: "rejected", reason: error };
      }
    }
  }
  await Promise.all(Array.from({ length: count }, runner));
  return results;
}

/** Return a serializable error without credentials or stack details. */
function publicError(error, details = {}) {
  return {
    code: error && error.code ? String(error.code) : "ERR_SHELLY_ADMIN",
    message: error && error.message ? String(error.message) : String(error),
    retryable: Boolean(error && error.retryable),
    ...(error && Number.isFinite(Number(error.timeoutMs)) ? { timeoutMs: Number(error.timeoutMs) } : {}),
    ...(error && error.details && typeof error.details === "object" ? { details: clone(error.details) } : {}),
    ...details
  };
}

/** Deeply merge plain objects while replacing arrays and scalar values. */
function mergeObjects(base, overlay) {
  if (!isPlainObject(base)) return clone(overlay);
  if (!isPlainObject(overlay)) return clone(overlay);
  const output = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    output[key] = isPlainObject(value) && isPlainObject(output[key])
      ? mergeObjects(output[key], value)
      : clone(value);
  }
  return output;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/** Make an identifier safe for topics and object keys. */
function safeId(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

module.exports = {
  clamp,
  clone,
  finite,
  iso,
  mad,
  mapLimit,
  median,
  mergeObjects,
  percentile,
  publicError,
  safeId,
  sleep,
  withTimeout
};
