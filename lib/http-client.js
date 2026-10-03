"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { abortError } = require("./util");

class HttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "HttpError";
    this.code = options.code || "ERR_HTTP";
    this.statusCode = options.statusCode;
    this.retryable = options.retryable !== undefined ? options.retryable : !options.statusCode || options.statusCode >= 500;
    this.responseBody = options.responseBody;
  }
}

function parseChallenge(header) {
  if (!header) return null;
  const match = String(header).match(/^\s*(Basic|Digest)\s+(.*)$/i);
  if (!match) return null;
  const params = {};
  const regex = /(\w+)=(?:"((?:\\.|[^"])*)"|([^,\s]+))/g;
  let item;
  while ((item = regex.exec(match[2])) !== null) params[item[1].toLowerCase()] = (item[2] ?? item[3] ?? "").replace(/\\"/g, "\"");
  return { scheme: match[1].toLowerCase(), params };
}

function digestHeader(challenge, method, url, username, password) {
  const params = challenge.params;
  const algorithm = String(params.algorithm || "MD5").toUpperCase();
  const hashName = algorithm.startsWith("SHA-256") ? "sha256" : "md5";
  const hash = (value) => crypto.createHash(hashName).update(value).digest("hex");
  const uri = `${url.pathname}${url.search}`;
  const cnonce = crypto.randomBytes(12).toString("hex");
  const nc = "00000001";
  const qop = String(params.qop || "").split(",").map((value) => value.trim()).find((value) => value === "auth") || "";
  let ha1 = hash(`${username}:${params.realm}:${password}`);
  if (algorithm.endsWith("-SESS")) ha1 = hash(`${ha1}:${params.nonce}:${cnonce}`);
  const ha2 = hash(`${method}:${uri}`);
  const response = qop
    ? hash(`${ha1}:${params.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : hash(`${ha1}:${params.nonce}:${ha2}`);
  const fields = [
    `username="${escapeQuotes(username)}"`,
    `realm="${escapeQuotes(params.realm || "")}"`,
    `nonce="${escapeQuotes(params.nonce || "")}"`,
    `uri="${escapeQuotes(uri)}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`
  ];
  if (params.opaque) fields.push(`opaque="${escapeQuotes(params.opaque)}"`);
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${fields.join(", ")}`;
}

function escapeQuotes(value) {
  return String(value).replace(/([\\"])/g, "\\$1");
}

function rawRequest(url, options = {}) {
  const target = url instanceof URL ? url : new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const body = options.body === undefined || options.body === null
    ? null
    : typeof options.body === "string" || Buffer.isBuffer(options.body)
      ? options.body
      : JSON.stringify(options.body);
  const headers = { Accept: "application/json", ...options.headers };
  if (body !== null && !headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
  if (body !== null) headers["Content-Length"] = Buffer.byteLength(body);
  const started = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    if (options.signal && options.signal.aborted) {
      reject(abortError(options.signal));
      return;
    }
    const timeout = Math.max(250, Number(options.timeoutMs) || 2500);
    let settled = false;
    let wallClockTimer;
    let abortHandler;
    const complete = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClockTimer);
      if (options.signal && abortHandler) options.signal.removeEventListener("abort", abortHandler);
      callback(value);
    };
    const request = transport.request(target, {
      method: options.method || "GET",
      headers,
      agent: options.agent,
      rejectUnauthorized: true
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > (options.maxBytes || 2 * 1024 * 1024)) {
          request.destroy(Object.assign(new Error("Response body limit exceeded"), { code: "ERR_RESPONSE_LIMIT" }));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => complete(resolve, {
        statusCode: response.statusCode || 0,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8"),
        latencyMs: Number(process.hrtime.bigint() - started) / 1e6
      }));
    });
    const timeoutError = () => Object.assign(new Error(`Request timed out after ${timeout} ms`), {
      code: "ETIMEDOUT",
      retryable: true,
      timeoutMs: timeout
    });
    wallClockTimer = setTimeout(() => request.destroy(timeoutError()), timeout);
    request.setTimeout(timeout, () => request.destroy(timeoutError()));
    request.on("error", (error) => complete(reject, error));
    if (options.signal) {
      abortHandler = () => request.destroy(abortError(options.signal));
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }
    if (body !== null) request.write(body);
    request.end();
  });
}

async function requestJson(url, options = {}) {
  const target = url instanceof URL ? url : new URL(url);
  const method = options.method || "GET";
  let response = await rawRequest(target, options);
  if (response.statusCode === 401 && options.username) {
    const challenge = parseChallenge(response.headers["www-authenticate"]);
    if (challenge) {
      const authorization = challenge.scheme === "basic"
        ? `Basic ${Buffer.from(`${options.username}:${options.password || ""}`).toString("base64")}`
        : digestHeader(challenge, method, target, options.username, options.password || "");
      response = await rawRequest(target, { ...options, headers: { ...options.headers, Authorization: authorization } });
    }
  }
  let data = null;
  if (response.text) {
    try {
      data = JSON.parse(response.text);
    } catch (error) {
      throw new HttpError(`Invalid JSON from ${target.hostname}`, {
        code: "ERR_INVALID_JSON",
        statusCode: response.statusCode,
        responseBody: response.text.slice(0, 256)
      });
    }
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new HttpError(`HTTP ${response.statusCode} from ${target.hostname}`, {
      statusCode: response.statusCode,
      responseBody: data,
      retryable: response.statusCode >= 500 || response.statusCode === 408 || response.statusCode === 429
    });
  }
  return { data, latencyMs: response.latencyMs, headers: response.headers, statusCode: response.statusCode };
}

module.exports = {
  HttpError,
  digestHeader,
  parseChallenge,
  rawRequest,
  requestJson
};
