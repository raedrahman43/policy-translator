"use strict";

const EVENT_PROPERTIES = {
  app_started: ["surface"],
  analysis_completed: ["surface", "durationBucket", "featureCountBucket", "actionCountBucket", "gapCountBucket"],
  analysis_failed: ["surface", "durationBucket", "errorCategory"],
  simulation_completed: ["durationBucket", "actionCountBucket", "gapCountBucket"],
  simulation_failed: ["durationBucket", "errorCategory"],
  scripts_previewed: ["fileCountBucket"],
  scripts_downloaded: ["fileCountBucket"],
  gap_report_previewed: ["gapCountBucket"],
  gap_report_downloaded: ["gapCountBucket"],
  real_apply_started: ["actionCountBucket"],
  real_apply_completed: ["durationBucket", "createdCountBucket", "reusedCountBucket", "failedCountBucket", "followUpCountBucket"],
  real_apply_failed: ["durationBucket", "errorCategory"],
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COUNT_BUCKETS = new Set(["0", "1", "2-5", "6-10", "11-25", "26+"]);
const DURATION_BUCKETS = new Set(["<1s", "1-3s", "3-10s", "10-30s", "30s+"]);
const ERROR_CATEGORIES = new Set([
  "validation",
  "missing_input",
  "authentication",
  "permission",
  "licensing",
  "throttling",
  "graph",
  "network",
  "internal",
]);
const PLATFORMS = new Set(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32"]);

module.exports = async function (context, req) {
  try {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return respond(context, 400, "A JSON object is required.");
    }
    if (JSON.stringify(body).length > 8192) {
      return respond(context, 413, "Telemetry payload is too large.");
    }
    if (body.schemaVersion !== 1 || !Object.prototype.hasOwnProperty.call(EVENT_PROPERTIES, body.eventName)) {
      return respond(context, 400, "Unsupported telemetry schema or event.");
    }
    if (typeof body.sessionId !== "string" || !UUID_PATTERN.test(body.sessionId)) {
      return respond(context, 400, "Invalid session identifier.");
    }
    const occurredAtMs = Date.parse(body.occurredAt);
    if (!Number.isFinite(occurredAtMs) || Math.abs(Date.now() - occurredAtMs) > 7 * 24 * 60 * 60 * 1000) {
      return respond(context, 400, "Invalid event timestamp.");
    }

    const runtime = body.runtime && typeof body.runtime === "object" ? body.runtime : {};
    const entry = {
      schemaVersion: 1,
      eventName: body.eventName,
      occurredAt: new Date(occurredAtMs).toISOString(),
      sessionId: body.sessionId,
      appVersion: safeString(body.appVersion, 32),
      runtime: {
        platform: PLATFORMS.has(runtime.platform) ? runtime.platform : "",
        nodeMajor: typeof runtime.nodeMajor === "string" && /^\d{1,3}$/.test(runtime.nodeMajor)
          ? runtime.nodeMajor
          : "",
      },
      properties: sanitizeProperties(body.eventName, body.properties),
    };

    context.log(`PolicyTranslatorTelemetry ${JSON.stringify(entry)}`);
    return respond(context, 202);
  } catch {
    return respond(context, 400, "Telemetry payload was rejected.");
  }
};

function sanitizeProperties(eventName, value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const key of EVENT_PROPERTIES[eventName]) {
    const current = input[key];
    const sanitized = sanitizePropertyValue(key, current);
    if (sanitized) result[key] = sanitized;
  }
  return result;
}

function sanitizePropertyValue(key, value) {
  if (typeof value !== "string") return undefined;
  if (key === "surface") return value === "web-proto" ? value : undefined;
  if (key === "durationBucket") return DURATION_BUCKETS.has(value) ? value : undefined;
  if (key === "errorCategory") return ERROR_CATEGORIES.has(value) ? value : undefined;
  if (key.endsWith("CountBucket")) return COUNT_BUCKETS.has(value) ? value : undefined;
  return undefined;
}

function safeString(value, maxLength) {
  return typeof value === "string" && /^[0-9a-zA-Z][a-zA-Z0-9.+_-]*$/.test(value)
    ? value.slice(0, maxLength)
    : "";
}

function respond(context, status, message) {
  context.res = {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
    body: message ? { message } : undefined,
  };
}
