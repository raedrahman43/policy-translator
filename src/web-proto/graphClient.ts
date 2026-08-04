/**
 * graphClient — minimal Microsoft Graph auth + request helpers for the
 * PROTOTYPE "real apply" path.
 *
 * Auth uses the OAuth 2.0 **device code** flow against Microsoft's first-party
 * "Microsoft Graph PowerShell" public client. That means:
 *   - NO app registration of our own is required.
 *   - The admin signs in once in a browser and consents to the delegated
 *     scopes; we then call Graph on their behalf with the returned token.
 *
 * Everything here uses the global `fetch` (Node 18+), so there are NO new
 * dependencies. This module makes NO changes on its own — the caller
 * (graphExecutor) decides what Graph writes to perform.
 */

import * as dns from "dns/promises";
import * as net from "net";

// Microsoft Graph PowerShell — a well-known Microsoft first-party public client.
// Pre-authorized for the delegated Graph scopes the migration needs, so the
// admin only sees a normal consent prompt (no custom app to register).
const GRAPH_PS_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const GRAPH_BASE = "https://graph.microsoft.com";

export interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  message: string;
}

export interface TokenPending { status: "pending"; }
export interface TokenReady { status: "ready"; accessToken: string; expiresAt: number; }
export interface TokenError { status: "error"; error: string; description: string; }
export type TokenPoll = TokenPending | TokenReady | TokenError;
export type TokenFallbackContext = "apply" | "apply-with-branding" | "branding-import";

export function describeTokenError(
  data: Record<string, unknown>,
  context: TokenFallbackContext = "apply",
): string {
  const raw = String(data.error_description || data.error || "Sign-in failed.");
  if (/530035|security defaults/i.test(raw)) {
    if (context === "branding-import") {
      return [
        "Security Defaults blocked device-code sign-in (AADSTS530035).",
        "Do not disable production security controls just to import branding.",
        "Use the manual branding controls or review the source tenant's Company Branding in the Entra admin center.",
      ].join(" ");
    }
    if (context === "apply-with-branding") {
      return [
        "Security Defaults blocked device-code sign-in (AADSTS530035).",
        "Do not disable production security controls just to use Policy Translator.",
        "Use the generated PowerShell package for supported scripted actions.",
        "Company Branding is not included in that package and must be applied manually in the Entra admin center.",
      ].join(" ");
    }
    return [
      "Security Defaults blocked device-code sign-in (AADSTS530035).",
      "Do not disable production security controls just to use Policy Translator.",
      "Use the generated PowerShell package with its interactive Connect-MgGraph sign-in,",
      "or ask your tenant administrator whether an approved Conditional Access configuration is appropriate.",
    ].join(" ");
  }
  return raw;
}

function fullScopes(shortScopes: string[]): string {
  // Graph delegated scopes as fully-qualified URIs + the standard OIDC scopes.
  const graphScopes = shortScopes.map((s) => `${GRAPH_BASE}/${s}`);
  return ["openid", "profile", "offline_access", ...graphScopes].join(" ");
}

/** Kick off the device-code flow. Returns the code the admin types in a browser. */
export async function startDeviceCode(tenantId: string, scopes: string[]): Promise<DeviceCodeStart> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/devicecode`;
  const body = new URLSearchParams({ client_id: GRAPH_PS_CLIENT_ID, scope: fullScopes(scopes) });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(`Device code request failed: ${data.error_description || data.error || res.status}`);
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval || 5,
    message: data.message,
  };
}

/** Poll once for a token. Caller repeats on `pending` until `ready` / `error`. */
export async function pollForToken(
  tenantId: string,
  deviceCode: string,
  context: TokenFallbackContext = "apply",
): Promise<TokenPoll> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: GRAPH_PS_CLIENT_ID,
    device_code: deviceCode,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data: any = await res.json();
  if (res.ok && data.access_token) {
    return { status: "ready", accessToken: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  }
  if (data.error === "authorization_pending" || data.error === "slow_down") {
    return { status: "pending" };
  }
  return {
    status: "error",
    error: data.error || "unknown",
    description: describeTokenError(data, context),
  };
}

export class GraphError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    const code = body?.error?.code || body?.error || "";
    const msg = body?.error?.message || body?.error_description || JSON.stringify(body);
    super(`Graph ${status} ${code}: ${msg}`);
    this.status = status;
    this.body = body;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRYABLE_GRAPH_STATUSES = new Set([429, 502, 503, 504]);

function retryDelayMs(res: Response, attempt: number): number {
  const retryAfterMs = Number(res.headers.get("x-ms-retry-after-ms"));
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, 30_000);

  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    const dateMs = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateMs) && dateMs > 0) return Math.min(dateMs, 30_000);
  }
  return Math.min(750 * (2 ** attempt), 10_000);
}

async function fetchGraph(url: string, init: RequestInit, retries = 3): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      lastError = err;
      if (attempt === retries) throw err;
      await delay(Math.min(750 * (2 ** attempt), 10_000));
      continue;
    }
    if (!RETRYABLE_GRAPH_STATUSES.has(res.status) || attempt === retries) return res;
    lastResponse = res;
    await res.arrayBuffer();
    await delay(retryDelayMs(res, attempt));
  }
  if (lastResponse) return lastResponse;
  throw lastError;
}

/**
 * Call Microsoft Graph. `pathOrUrl` may be an absolute Graph URL or a path
 * beginning with `/v1.0` or `/beta`.
 */
export async function graph<T = any>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  pathOrUrl: string,
  token: string,
  jsonBody?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(extraHeaders || {}),
    },
  };
  if (jsonBody !== undefined) init.body = JSON.stringify(jsonBody);
  const res = await fetchGraph(url, init);
  const text = await res.text();
  let data: any = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!res.ok) throw new GraphError(res.status, data);
  return data as T;
}

/** PUT raw bytes to a Graph stream property (e.g. branding bannerLogo). */
export async function graphPutBinary(
  pathOrUrl: string,
  token: string,
  bytes: Buffer,
  contentType: string,
): Promise<void> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const authValue = ["Bearer", token].join(" ");
  const res = await fetchGraph(url, {
    method: "PUT",
    headers: { Authorization: authValue, "Content-Type": contentType },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) {
    let data: any = {};
    try { data = JSON.parse(await res.text()); } catch { /* ignore */ }
    throw new GraphError(res.status, data);
  }
}

/** GET raw bytes from a Graph stream property. */
export async function graphGetBinary(
  pathOrUrl: string,
  token: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const authValue = ["Bearer", token].join(" ");
  const res = await fetchGraph(url, {
    method: "GET",
    headers: { Authorization: authValue, Accept: "*/*" },
  });
  if (!res.ok) {
    let data: any = {};
    try { data = JSON.parse(await res.text()); } catch { /* ignore */ }
    throw new GraphError(res.status, data);
  }
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") || "application/octet-stream",
  };
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    return a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
    if (mappedHex?.[1] && mappedHex[2]) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb");
  }
  return true;
}

async function validatePublicHttpsUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new Error("Branding assets must use HTTPS.");
  if (url.username || url.password) throw new Error("Branding asset URLs cannot contain credentials.");
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("Branding asset URL resolves to a private or local network address.");
  }
}

async function fetchPublicImage(url: string): Promise<Response> {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 4; redirects++) {
    await validatePublicHttpsUrl(current);
    const res = await fetch(current, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Branding asset redirect (${res.status}) had no Location header.`);
      current = new URL(location, current);
      continue;
    }
    return res;
  }
  throw new Error("Branding asset URL redirected too many times.");
}

/** Download a public URL (e.g. a branding CDN asset) as bytes + content type. */
export async function fetchBytes(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  // Support inline data: URLs (used for logos uploaded from the user's machine).
  const dataMatch = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(url);
  if (dataMatch) {
    const contentType = dataMatch[1] || "application/octet-stream";
    if (!contentType.toLowerCase().startsWith("image/")) throw new Error("Inline branding asset must be an image.");
    const isBase64 = Boolean(dataMatch[2]);
    const payload = dataMatch[3] || "";
    const bytes = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    if (bytes.length > 2 * 1024 * 1024) throw new Error("Branding image must be 2 MB or smaller.");
    return { bytes, contentType };
  }
  const res = await fetchPublicImage(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`Branding asset must be an image (received ${contentType || "unknown content type"}).`);
  }
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
    throw new Error("Branding image must be 2 MB or smaller.");
  }
  const arrayBuf = await res.arrayBuffer();
  if (arrayBuf.byteLength > 2 * 1024 * 1024) throw new Error("Branding image must be 2 MB or smaller.");
  return { bytes: Buffer.from(arrayBuf), contentType };
}
