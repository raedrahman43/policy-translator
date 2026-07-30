import crypto from "crypto";

export const TELEMETRY_EVENT_NAMES = [
  "app_started",
  "analysis_completed",
  "analysis_failed",
  "simulation_completed",
  "simulation_failed",
  "scripts_previewed",
  "scripts_downloaded",
  "gap_report_previewed",
  "gap_report_downloaded",
  "real_apply_started",
  "real_apply_completed",
  "real_apply_failed",
] as const;

export type TelemetryEventName = typeof TELEMETRY_EVENT_NAMES[number];
export type TelemetryErrorCategory =
  | "validation"
  | "missing_input"
  | "authentication"
  | "permission"
  | "licensing"
  | "throttling"
  | "graph"
  | "network"
  | "internal";

type TelemetryValue = string;
type TelemetryProperties = Record<string, unknown>;

const ALLOWED_PROPERTIES: Record<TelemetryEventName, ReadonlySet<string>> = {
  app_started: new Set(["surface"]),
  analysis_completed: new Set(["surface", "durationBucket", "featureCountBucket", "actionCountBucket", "gapCountBucket"]),
  analysis_failed: new Set(["surface", "durationBucket", "errorCategory"]),
  simulation_completed: new Set(["durationBucket", "actionCountBucket", "gapCountBucket"]),
  simulation_failed: new Set(["durationBucket", "errorCategory"]),
  scripts_previewed: new Set(["fileCountBucket"]),
  scripts_downloaded: new Set(["fileCountBucket"]),
  gap_report_previewed: new Set(["gapCountBucket"]),
  gap_report_downloaded: new Set(["gapCountBucket"]),
  real_apply_started: new Set(["actionCountBucket"]),
  real_apply_completed: new Set(["durationBucket", "createdCountBucket", "reusedCountBucket", "failedCountBucket", "followUpCountBucket"]),
  real_apply_failed: new Set(["durationBucket", "errorCategory"]),
};

const COUNT_BUCKETS = new Set(["0", "1", "2-5", "6-10", "11-25", "26+"]);
const DURATION_BUCKETS = new Set(["<1s", "1-3s", "3-10s", "10-30s", "30s+"]);
const ERROR_CATEGORIES = new Set<TelemetryErrorCategory>([
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

export interface TelemetryPayload {
  schemaVersion: 1;
  eventName: TelemetryEventName;
  occurredAt: string;
  sessionId: string;
  appVersion: string;
  runtime: {
    platform: string;
    nodeMajor: string;
  };
  properties: Record<string, TelemetryValue>;
}

export interface TelemetryClientOptions {
  endpoint?: string;
  key?: string;
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sessionId?: string;
  appVersion?: string;
  now?: () => Date;
}

export class TelemetryClient {
  private readonly endpoint: string | undefined;
  private readonly key: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sessionId: string;
  private readonly appVersion: string;
  private readonly now: () => Date;
  private readonly hardDisabled: boolean;
  private enabled: boolean;

  constructor(options: TelemetryClientOptions = {}) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.key = options.key?.trim() || undefined;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.sessionId = options.sessionId || crypto.randomUUID();
    this.appVersion = options.appVersion || process.env.npm_package_version || "dev";
    this.now = options.now || (() => new Date());
    this.hardDisabled = process.env.POLICY_TRANSLATOR_TELEMETRY?.toLowerCase() === "off";
    this.enabled = (options.enabled ?? true) && !this.hardDisabled;
  }

  isConfigured(): boolean {
    return Boolean(this.endpoint);
  }

  isEnabled(): boolean {
    return this.enabled && !this.hardDisabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled && !this.hardDisabled;
  }

  async emit(eventName: TelemetryEventName, properties: TelemetryProperties = {}): Promise<boolean> {
    if (!this.endpoint || !this.isEnabled()) return false;

    const payload: TelemetryPayload = {
      schemaVersion: 1,
      eventName,
      occurredAt: this.now().toISOString(),
      sessionId: this.sessionId,
      appVersion: this.appVersion,
      runtime: {
        platform: process.platform,
        nodeMajor: process.versions.node.split(".")[0] || "unknown",
      },
      properties: sanitizeProperties(eventName, properties),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.key) headers["x-functions-key"] = this.key;
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeEndpoint(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeProperties(
  eventName: TelemetryEventName,
  properties: TelemetryProperties,
): Record<string, TelemetryValue> {
  const allowed = ALLOWED_PROPERTIES[eventName];
  const result: Record<string, TelemetryValue> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!allowed.has(key)) continue;
    const sanitized = sanitizePropertyValue(key, value);
    if (sanitized) result[key] = sanitized;
  }
  return result;
}

function sanitizePropertyValue(key: string, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (key === "surface") return value === "web-proto" ? value : undefined;
  if (key === "durationBucket") return DURATION_BUCKETS.has(value) ? value : undefined;
  if (key === "errorCategory") return ERROR_CATEGORIES.has(value as TelemetryErrorCategory) ? value : undefined;
  if (key.endsWith("CountBucket")) return COUNT_BUCKETS.has(value) ? value : undefined;
  return undefined;
}

export function bucketCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value === 1) return "1";
  if (value <= 5) return "2-5";
  if (value <= 10) return "6-10";
  if (value <= 25) return "11-25";
  return "26+";
}

export function bucketDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 1000) return "<1s";
  if (milliseconds < 3000) return "1-3s";
  if (milliseconds < 10_000) return "3-10s";
  if (milliseconds < 30_000) return "10-30s";
  return "30s+";
}

export function categorizeTelemetryError(error: unknown): TelemetryErrorCategory {
  const message = String(
    error && typeof error === "object" && "message" in error
      ? (error as { message?: unknown }).message
      : error,
  ).toLowerCase();

  if (message.includes("validation") || message.includes("invalid input")) return "validation";
  if (message.includes("required") || message.includes("missing")) return "missing_input";
  if (message.includes("sign-in") || message.includes("authentication") || message.includes("token expired")) return "authentication";
  if (message.includes("403") || message.includes("permission") || message.includes("admin role")) return "permission";
  if (message.includes("license") || message.includes("subscription")) return "licensing";
  if (message.includes("429") || message.includes("throttl")) return "throttling";
  if (message.includes("graph")) return "graph";
  if (message.includes("fetch") || message.includes("network") || message.includes("timeout")) return "network";
  return "internal";
}

export function telemetryAllowedForRequest(headerValue: unknown): boolean {
  return String(headerValue || "").toLowerCase() !== "off";
}

const configuredEndpoint = process.env.POLICY_TRANSLATOR_TELEMETRY_ENDPOINT;
const configuredKey = process.env.POLICY_TRANSLATOR_TELEMETRY_KEY;

export const telemetryClient = new TelemetryClient({
  ...(configuredEndpoint ? { endpoint: configuredEndpoint } : {}),
  ...(configuredKey ? { key: configuredKey } : {}),
});
