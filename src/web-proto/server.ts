/**
 * Policy Translator — local guided apply server
 *
 * This isolated port-4001 experience reuses the deterministic translation
 * engine and adds an opt-in live Microsoft Graph workflow:
 *
 *   upload -> review -> select/brand -> consent -> simulate or real apply
 *
 * Simulation is the default. Real apply requires explicit selection and
 * device-code administrator sign-in. Tokens remain server-side in memory.
 *
 * Run:  npm run web:proto   (then open http://localhost:4001)
 */

import express, { Request, Response } from "express";
import path from "path";
import crypto from "crypto";
import JSZip from "jszip";

import { validateAndNormalize } from "../parsers/inputValidator";
import { extractPolicyContext } from "../parsers/policyContextParser";
import { mapAllFeatures, StepKind } from "../mappers/featureMap";
import { injectCustomAttributeStep } from "../generators/scriptGenerator";
import { manualRecreationSteps } from "../generators/manualRecreation";
import { deriveRequiredInputs } from "../web/inputRequirements";
import { generate } from "../web/server";
import { startDeviceCode, pollForToken } from "./graphClient";
import { executeApply, scopesForKinds, ApplyConfig } from "./graphExecutor";
import { readSourceBranding, ImportedBranding } from "./branding";
import { deepRepairMojibake } from "./textFix";

const app = express();
const PORT = process.env.PROTO_PORT ? Number(process.env.PROTO_PORT) : 4001;
const LOOPBACK_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const csrfTokens = new Map<string, number>();

function pruneCsrfTokens() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [token, createdAt] of csrfTokens) if (createdAt < cutoff) csrfTokens.delete(token);
}

app.use((req, res, next) => {
  const host = String(req.headers.host || "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    return res.status(403).json({ error: "This prototype only accepts requests addressed to localhost." });
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (!LOOPBACK_HOSTS.has(originUrl.host.toLowerCase())) {
        return res.status(403).json({ error: "Cross-origin requests are not allowed." });
      }
    } catch {
      return res.status(403).json({ error: "Invalid request origin." });
    }
  }
  next();
});

app.get("/api/security-token", (_req: Request, res: Response) => {
  pruneCsrfTokens();
  const token = crypto.randomBytes(32).toString("base64url");
  csrfTokens.set(token, Date.now());
  res.setHeader("Cache-Control", "no-store");
  res.json({ token });
});

app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" || !req.path.startsWith("/api/")) {
    return next();
  }
  pruneCsrfTokens();
  const token = String(req.headers["x-policy-translator-csrf"] || "");
  const supplied = Buffer.from(token);
  let valid = false;
  for (const expected of csrfTokens.keys()) {
    const expectedBytes = Buffer.from(expected);
    if (supplied.length === expectedBytes.length && crypto.timingSafeEqual(supplied, expectedBytes)) {
      valid = true;
      break;
    }
  }
  if (!valid) return res.status(403).json({ error: "Missing or invalid local session token. Refresh the page and try again." });
  next();
});

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));
// Heal "mojibake" (UTF-8 decoded as Windows-1252) in whatever the customer
// pastes, before it reaches the engine — so em dashes, smart quotes, etc. in
// analyzer output or branding text render correctly in the generated package.
app.use((req, _res, next) => {
  if (req.body && typeof req.body === "object") {
    req.body = deepRepairMojibake(req.body);
  }
  next();
});

const STATUS_LABELS: Record<string, string> = {
  Available: "Supported",
  Partial: "Partially available",
  NeedsExtensions: "Needs custom extensions",
  DifferentApproach: "Different approach",
  OnRoadmap: "On roadmap",
  NotAvailable: "Not yet available",
};

interface AnalyzerBranding {
  hasSignal: boolean;
  hasConcreteValues: boolean;
  source: "policy-analyzer";
  backgroundColor?: string;
  accentColor?: string;
  logoUrl?: string;
  backgroundImageUrl?: string;
  note: string;
}

function findStringByKey(root: unknown, keyPattern: RegExp, valuePattern?: RegExp, depth = 0): string | undefined {
  if (depth > 5 || !root || typeof root !== "object") return undefined;
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findStringByKey(item, keyPattern, valuePattern, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    if (typeof value === "string" && keyPattern.test(key) && (!valuePattern || valuePattern.test(value.trim()))) {
      return value.trim();
    }
    const nested = findStringByKey(value, keyPattern, valuePattern, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function extractAnalyzerBranding(rawJson: unknown, features: Array<{ name: string; description?: string; reason: string; recommendation: string }>): AnalyzerBranding | undefined {
  const feature = features.find((f) => /(?:tenant|domain|perApp)?Branding/i.test(f.name));
  if (!feature) return undefined;

  const rawFeatures = rawJson && typeof rawJson === "object" && Array.isArray((rawJson as Record<string, unknown>).features)
    ? ((rawJson as Record<string, unknown>).features as unknown[])
    : [];
  const rawFeature = rawFeatures.find(
    (f) => f && typeof f === "object" && String((f as Record<string, unknown>).name || "") === feature.name,
  );
  const source = rawFeature || feature;
  const colorPattern = /^#[0-9a-f]{6}$/i;
  const assetPattern = /^(?:data:image\/|https:\/\/)/i;
  const backgroundColor = findStringByKey(source, /background.*color|page.*color/i, colorPattern);
  const accentColor = findStringByKey(source, /accent.*color|primary.*color|button.*color/i, colorPattern);
  const backgroundImageUrl = findStringByKey(source, /background.*(?:image|url)/i, assetPattern);
  const logoUrl = findStringByKey(source, /(?:banner|square)?logo.*(?:url|uri|image)?/i, assetPattern);
  const hasConcreteValues = Boolean(backgroundColor || accentColor || backgroundImageUrl || logoUrl);

  return {
    hasSignal: true,
    hasConcreteValues,
    source: "policy-analyzer",
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(accentColor ? { accentColor } : {}),
    ...(backgroundImageUrl ? { backgroundImageUrl } : {}),
    ...(logoUrl ? { logoUrl } : {}),
    note: hasConcreteValues
      ? "Branding values were detected in the analyzer output. Import from the source B2C tenant to verify the exact assets."
      : "The analyzer detected company branding, but its output does not contain the actual logo or colors. Import from the source B2C tenant for an exact preview.",
  };
}

// ─── Analyze: reuse the real engine, return what the wizard needs ────────────
function analyze(rawJson: unknown) {
  const validation = validateAndNormalize(rawJson);
  if (!validation.valid) {
    return { ok: false as const, status: 400, body: { valid: false, errors: validation.errors, warnings: validation.warnings } };
  }

  const { policyName, features } = validation;
  const context = extractPolicyContext(policyName, features);
  const { mapped, unmapped } = mapAllFeatures(features);

  const byStatus: Record<string, number> = {};
  for (const f of features) byStatus[f.externalIdAvailability] = (byStatus[f.externalIdAvailability] || 0) + 1;
  const available = byStatus["Available"] || 0;
  const total = features.length;
  const readinessPct = total > 0 ? Math.round((available / total) * 100) : 0;
  const readinessScore = readinessPct >= 70 ? "High" : readinessPct >= 40 ? "Medium" : "Low";

  const mappingByFeature = new Map(mapped.map((result) => [result.featureName, result]));
  const featureView = features.map((f) => {
    const mapping = mappingByFeature.get(f.name);
    const isManual = Boolean(mapping?.gapReport);
    return {
      name: f.name,
      description: f.description || "",
      status: isManual ? "DifferentApproach" : f.externalIdAvailability,
      statusLabel: isManual ? "Manual configuration" : (STATUS_LABELS[f.externalIdAvailability] || f.externalIdAvailability),
      externalIdAvailability: f.externalIdAvailability,
    };
  });

  // StepKind → the features that requested it (dedup)
  const stepReasons = new Map<string, string[]>();
  const stepOrder: string[] = [];
  for (const r of mapped) {
    for (const s of r.steps) {
      if (!stepReasons.has(s.kind)) { stepReasons.set(s.kind, []); stepOrder.push(s.kind); }
      stepReasons.get(s.kind)!.push(r.featureName);
    }
  }
  const orderedKinds = injectCustomAttributeStep(stepOrder as StepKind[], context);
  if (context.customAttributes.length > 0 && !stepReasons.has("create-custom-attributes")) {
    stepReasons.set("create-custom-attributes", ["Custom attribute collection"]);
  }
  const steps = orderedKinds.map((kind) => ({ kind, features: [...new Set(stepReasons.get(kind) || [])] }));

  const gaps = mapped
    .filter((r) => r.gapReport)
    .map((r) => {
      const g = r.gapReport!;
      const rec = manualRecreationSteps(g.feature, g.reason, g.recommendation);
      return { feature: g.feature, reason: g.reason, recommendation: g.recommendation, manual: rec };
    });

  const requiredInputs = deriveRequiredInputs(mapped, [
    "add-google-idp",
    "add-facebook-idp",
    "create-ca-policy",
  ]);
  const branding = extractAnalyzerBranding(rawJson, features);

  return {
    ok: true as const,
    status: 200,
    body: {
      valid: true,
      warnings: validation.warnings,
      policyName,
      readiness: { score: readinessScore, percent: readinessPct, total, available, needsWork: total - available, byStatus },
      context: {
        appName: context.appName,
        flowName: context.flowName,
        idpDisplayNames: context.idpDisplayNames,
        customAttributesCount: context.customAttributes.length,
        attributes: context.attributes.map((a) => ({
          id: a.id, displayName: a.displayName, dataType: a.dataType, required: a.required,
        })),
        claims: context.claims.map((c) => ({ source: c.source, jwtName: c.jwtName })),
        customAttributes: context.customAttributes.map((a) => ({
          name: a.name, displayName: a.displayName, dataType: a.dataType, required: a.required,
        })),
        ...(branding ? { branding } : {}),
      },
      features: featureView,
      steps,
      gaps,
      unmapped,
      requiredInputs,
    },
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post("/api/analyze", (req: Request, res: Response) => {
  try {
    const rawJson = req.body?.json ?? req.body;
    const outcome = analyze(rawJson);
    res.status(outcome.status).json(outcome.body);
  } catch (err) {
    res.status(500).json({ valid: false, errors: [{ field: "server", message: String(err) }] });
  }
});

/**
 * MOCK apply. Produces a plan-only simulation for the selected steps.
 * No Microsoft Graph calls are made and no success/resource IDs are fabricated.
 */
app.post("/api/apply", (req: Request, res: Response) => {
  try {
    const selected: string[] = Array.isArray(req.body?.selectedKinds) ? req.body.selectedKinds : [];
    const config = (req.body?.config ?? {}) as Record<string, string>;
    const branding = (req.body?.branding ?? {}) as Record<string, string>;

    const now = () => new Date().toISOString();

    const LABELS: Record<string, string> = {
      "create-native-app": "Native app registration",
      "create-user-flow-emailpassword": "Sign-up / sign-in user flow",
      "smoke-test-native-auth": "Native-auth smoke test",
      "add-google-idp": "Google identity provider",
      "add-facebook-idp": "Facebook identity provider",
      "add-oidc-idp": "Custom OIDC identity provider",
      "add-apple-idp": "Apple identity provider",
      "enable-email-otp": "Email one-time-passcode method",
      "enable-sms-mfa": "SMS one-time-passcode (MFA) method",
      "create-ca-policy": "Conditional Access policy (report-only)",
      "enable-passkey": "Passkey (FIDO2) method",
      "claims-mapping-policy": "Claims mapping policy",
      "enable-sspr": "Self-service password reset",
      "create-custom-attributes": "Custom user attributes",
      "migrate-company-branding": "Company branding",
    };

    const flowName = config.flowName || "SignUpSignIn";

    const applied = selected.map((kind) => {
      let resource: Record<string, unknown> = { action: "would configure" };
      if (kind === "create-native-app") resource = { displayName: config.appName || "migrated-app" };
      if (kind === "create-user-flow-emailpassword") resource = { name: flowName };
      if (kind === "create-ca-policy") resource = { state: "enabledForReportingButNotEnforced" };
      return { kind, label: LABELS[kind] || kind, status: "planned", resource, at: now() };
    });

    const idps = selected
      .filter((k) => k.startsWith("add-") && k.endsWith("-idp"))
      .map((k) => k.replace("add-", "").replace("-idp", ""));
    const authMethods = selected
      .filter((k) => ["enable-email-otp", "enable-sms-mfa", "enable-passkey"].includes(k))
      .map((k) => k.replace("enable-", ""));

    res.json({
      simulated: true,
      appliedAt: now(),
      summary: {
        tenantId: config.tenantId || "<your-tenant-id>",
        appId: "—",
        appName: config.appName || "migrated-app",
        flowName,
        idps,
        authMethods,
        conditionalAccess: selected.includes("create-ca-policy"),
        branding: { companyName: branding.companyName || config.appName || "Your app", accent: branding.accent || "#0067b8" },
      },
      applied,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/health", (_req: Request, res: Response) => res.json({ status: "ok", prototype: true }));

/**
 * View the equivalent scripts. Reuses the SAME deterministic generator as the
 * scripts app (port 4000) — no duplication — so devs can inspect the exact
 * PowerShell/Graph package that corresponds to the apply steps and preview.
 * Read-only: generates in-memory, nothing is written to disk or the tenant.
 */
function buildScripts(req: Request) {
  const rawJson = req.body?.json ?? req.body?.rawJson ?? req.body;
  const config = (req.body?.config ?? {}) as Record<string, string>;
  const result = generate(rawJson, config);
  if ("error" in result) return { ok: false as const, errors: result.error };
  const files = [
    ...result.output.scripts.map((s) => ({ name: s.filename, content: s.content, kind: "script" as const })),
    { name: "README.md", content: result.output.readme, kind: "doc" as const },
    ...(result.output.gapReport ? [{ name: "gap-report.md", content: result.output.gapReport, kind: "doc" as const }] : []),
  ];
  return { ok: true as const, policyName: result.policyName, files };
}

app.post("/api/scripts", (req: Request, res: Response) => {
  try {
    const built = buildScripts(req);
    if (!built.ok) return res.status(400).json({ errors: built.errors });
    res.json({ policyName: built.policyName, files: built.files });
  } catch (err) {
    res.status(500).json({ errors: [{ field: "server", message: String(err) }] });
  }
});

app.post("/api/scripts-zip", async (req: Request, res: Response) => {
  try {
    const built = buildScripts(req);
    if (!built.ok) return res.status(400).json({ errors: built.errors });
    const safeName = built.policyName.replace(/[^a-zA-Z0-9-_]/g, "_");
    const zip = new JSZip();
    for (const f of built.files) zip.file(f.name, f.content);
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    res.attachment(`migration-package-${safeName}.zip`);
    res.setHeader("Content-Type", "application/zip");
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ errors: [{ field: "server", message: String(err) }] });
  }
});

// ─── REAL apply (opt-in) ──────────────────────────────────────────────────────
// Device-code sign-in + real Microsoft Graph calls, behind an explicit admin
// sign-in. Nothing runs until the admin completes device-code auth AND clicks
// apply. Tokens are held server-side only (never sent to the browser) in a
// short-lived in-memory map — this is a single-process prototype.

interface AuthSession {
  tenantId: string;
  deviceCode: string;
  scopes: string[];
  accessToken?: string;
  expiresAt?: number;
  createdAt: number;
}
const authSessions = new Map<string, AuthSession>();

// Best-effort cleanup of stale sessions (older than 20 min).
function pruneSessions() {
  const cutoff = Date.now() - 20 * 60 * 1000;
  for (const [id, s] of authSessions) if (s.createdAt < cutoff) authSessions.delete(id);
}

/** Start device-code sign-in for the scopes the selected steps need. */
app.post("/api/auth/start", async (req: Request, res: Response) => {
  try {
    pruneSessions();
    const tenantId = String(req.body?.tenantId || "").trim();
    const selected: string[] = Array.isArray(req.body?.selectedKinds) ? req.body.selectedKinds : [];
    if (!tenantId) return res.status(400).json({ error: "tenantId is required." });

    // If the user set/imported branding, request the branding scope too so the
    // company-branding write isn't blocked at consent time.
    const kindsForScope = req.body?.brandingIntent || req.body?.wantsBranding
      ? [...selected, "migrate-company-branding"]
      : selected;
    const scopes = scopesForKinds(kindsForScope);
    const dc = await startDeviceCode(tenantId, scopes);
    const sessionId = crypto.randomUUID();
    authSessions.set(sessionId, { tenantId, deviceCode: dc.deviceCode, scopes, createdAt: Date.now() });

    res.json({
      sessionId,
      userCode: dc.userCode,
      verificationUri: dc.verificationUri,
      message: dc.message,
      expiresIn: dc.expiresIn,
      interval: dc.interval,
      scopes,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Poll for the token. On success the token is stored server-side only. */
app.post("/api/auth/poll", async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.body?.sessionId || "");
    const session = authSessions.get(sessionId);
    if (!session) return res.status(404).json({ status: "error", error: "unknown_session", description: "Sign-in session expired. Start again." });
    if (session.accessToken) return res.json({ status: "ready" });

    const result = await pollForToken(session.tenantId, session.deviceCode);
    if (result.status === "ready") {
      session.accessToken = result.accessToken;
      session.expiresAt = result.expiresAt;
      return res.json({ status: "ready" });
    }
    if (result.status === "error") return res.json({ status: "error", error: result.error, description: result.description });
    res.json({ status: "pending" });
  } catch (err) {
    res.status(500).json({ status: "error", error: "server", description: String(err) });
  }
});

/** Start device-code sign-in against the SOURCE B2C tenant to read its branding. */
app.post("/api/branding/connect-start", async (req: Request, res: Response) => {
  try {
    pruneSessions();
    const tenantId = String(req.body?.tenantId || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Source tenant ID is required." });

    const scopes = ["OrganizationalBranding.Read.All"];
    const dc = await startDeviceCode(tenantId, scopes);
    const sessionId = crypto.randomUUID();
    authSessions.set(sessionId, { tenantId, deviceCode: dc.deviceCode, scopes, createdAt: Date.now() });

    res.json({
      sessionId,
      userCode: dc.userCode,
      verificationUri: dc.verificationUri,
      message: dc.message,
      expiresIn: dc.expiresIn,
      interval: dc.interval,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Read the source tenant's company branding once sign-in is complete. */
app.post("/api/branding/import", async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.body?.sessionId || "");
    const session = authSessions.get(sessionId);
    if (!session || !session.accessToken) {
      return res.status(401).json({ error: "Not signed in to the source tenant yet." });
    }
    const branding = await readSourceBranding(session.tenantId, session.accessToken);
    // The source session is single-use for the read — drop it.
    authSessions.delete(sessionId);
    res.json({ branding });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Minimal custom CSS to approximate a source brand accent on the primary button. */
function accentCss(accent: string): string {
  return [
    "/* Policy Translator — approximate the source brand accent on the primary button */",
    `.ext-button.ext-primary { background-color: ${accent}; border-color: ${accent}; }`,
    `.ext-button.ext-primary:hover, .ext-button.ext-primary:focus { background-color: ${accent}; filter: brightness(0.92); }`,
  ].join("\n");
}

/**
 * Decide what branding to write. Imported B2C branding is the 1:1 gold path
 * (with the chosen accent layered on as CSS). With no import, build a
 * closest-match from the manual inputs. Returns `undefined` when there is
 * nothing meaningful to write (so we never stomp the tenant with defaults).
 */
function buildFinalBranding(body: any): ImportedBranding | undefined {
  if (body?.brandingIntent !== true) return undefined;

  const sourceBranding: ImportedBranding | undefined =
    body?.branding && typeof body.branding === "object" && body.branding.hasBranding
      ? (body.branding as ImportedBranding)
      : undefined;
  const manual = body?.brandingManual && typeof body.brandingManual === "object" ? body.brandingManual : {};
  const mode = body?.brandingMode === "modernize" ? "modernize" : "preserve";
  const manualEnabled = mode === "modernize" && manual.enabled === true;
  const hex = (v: unknown) => (typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim() : "");
  const accent = manualEnabled ? hex(manual.accent) : "";
  const bg = manualEnabled ? hex(manual.bg) : "";
  const logo = manualEnabled && typeof manual.logo === "string" ? manual.logo.trim() : "";
  const backgroundImage = manualEnabled && typeof manual.backgroundImage === "string" ? manual.backgroundImage.trim() : "";

  const out: ImportedBranding = { ...(sourceBranding || { hasBranding: false }) };
  if (out.accentColor && !out.customCss) out.customCss = accentCss(out.accentColor);
  if (bg) out.backgroundColor = bg;
  if (logo) out.bannerLogoUrl = logo;
  if (backgroundImage) out.backgroundImageUrl = backgroundImage;
  if (accent) out.customCss = accentCss(accent);
  out.hasBranding = Boolean(
    out.backgroundColor ||
    out.signInPageText ||
    out.bannerLogoUrl ||
    out.squareLogoUrl ||
    out.backgroundImageUrl ||
    out.customCss,
  );
  return out.hasBranding ? out : undefined;
}

const APPLY_REQUIRED_CONFIG: Record<string, Array<{ key: string; label: string }>> = {
  "add-google-idp": [
    { key: "googleClientId", label: "Google Client ID" },
    { key: "googleClientSecret", label: "Google Client Secret" },
  ],
  "add-facebook-idp": [
    { key: "facebookAppId", label: "Facebook App ID" },
    { key: "facebookAppSecret", label: "Facebook App Secret" },
  ],
  "create-ca-policy": [
    { key: "caResourceAppId", label: "Conditional Access resource application ID" },
  ],
};

function missingApplyInputs(selected: string[], config: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const kind of selected) {
    for (const field of APPLY_REQUIRED_CONFIG[kind] || []) {
      if (typeof config[field.key] !== "string" || !String(config[field.key]).trim()) missing.push(field.label);
    }
  }
  return [...new Set(missing)];
}

/** Real apply: execute the selected steps against the signed-in tenant. */
app.post("/api/apply-real", async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.body?.sessionId || "");
    const session = authSessions.get(sessionId);
    if (!session || !session.accessToken) {
      return res.status(401).json({ error: "Not signed in. Complete device-code sign-in first." });
    }
    if (session.expiresAt && session.expiresAt <= Date.now()) {
      authSessions.delete(sessionId);
      return res.status(401).json({ error: "Your admin sign-in expired. Sign in again, then re-run the apply." });
    }
    const selected: string[] = Array.isArray(req.body?.selectedKinds) ? req.body.selectedKinds : [];
    const analysisContext = (req.body?.analysisContext ?? {}) as { attributes?: unknown; claims?: unknown; customAttributes?: unknown };
    const brandingMeta = (req.body?.brandingMeta ?? {}) as Record<string, string>;

    // Branding to write: the imported B2C branding is the 1:1 gold path; when
    // there's no import, build a closest-match from the manual inputs (bg,
    // logo, accent). Either way the preview equals what we write.
    const finalBranding = buildFinalBranding(req.body);

    const config = {
      ...(req.body?.config ?? {}),
      tenantId: session.tenantId,
      ...(Array.isArray(analysisContext.attributes) ? { attributes: analysisContext.attributes } : {}),
      ...(Array.isArray(analysisContext.claims) ? { claims: analysisContext.claims } : {}),
      ...(Array.isArray(analysisContext.customAttributes) ? { customAttributes: analysisContext.customAttributes } : {}),
      ...(finalBranding ? { branding: finalBranding } : {}),
    } as ApplyConfig;

    // Run the branding step only when there is branding to write.
    const selectedForApply = finalBranding && !selected.includes("migrate-company-branding")
      ? [...selected, "migrate-company-branding"]
      : selected;
    const missing = missingApplyInputs(selectedForApply, config);
    if (missing.length) {
      return res.status(400).json({
        error: `Complete the required configuration before applying: ${missing.join(", ")}.`,
      });
    }
    if (
      selectedForApply.includes("create-ca-policy") &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(config.caResourceAppId))
    ) {
      return res.status(400).json({ error: "Conditional Access resource application ID must be a GUID." });
    }
    const { applied, state } = await executeApply(selectedForApply, config, session.accessToken);

    const idps = applied
      .filter((a) => a.kind.startsWith("add-") && a.kind.endsWith("-idp") && (a.status === "created" || a.status === "reused"))
      .map((a) => a.kind.replace("add-", "").replace("-idp", ""));
    const authMethods = applied
      .filter((a) => ["enable-email-otp", "enable-sms-mfa", "enable-passkey"].includes(a.kind) && (a.status === "created" || a.status === "reused"))
      .map((a) => a.kind.replace("enable-", ""));
    const manualFollowUps = applied
      .filter((a) => a.status === "manual" || a.status === "failed" || a.status === "skipped" || a.requiresFollowUp)
      .map((a) => ({
        label: a.label,
        status: a.status,
        reason: a.message || "",
        manual: manualRecreationSteps(a.kind, a.message || a.label, a.message || "Configure this feature manually in External ID."),
      }));

    res.json({
      simulated: false,
      appliedAt: new Date().toISOString(),
      summary: {
        tenantId: session.tenantId,
        appId: state.appId || "—",
        appName: config.appName || "migrated-app",
        flowName: state.flowName || config.flowName || "SignUpSignIn",
        idps,
        authMethods,
        conditionalAccess: applied.some((a) => a.kind === "create-ca-policy" && (a.status === "created" || a.status === "reused")),
        branding: {
          companyName: brandingMeta.companyName || config.appName || "Your app",
          accent: brandingMeta.accent || (finalBranding && finalBranding.backgroundColor) || "#0067b8",
          applied: applied.some((a) => a.kind === "migrate-company-branding" && (a.status === "created" || a.status === "reused")),
        },
      },
      applied,
      manualFollowUps,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

if (require.main === module) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`\n  Policy Translator — PROTOTYPE ("Apply" experience):`);
    console.log(`  → http://localhost:${PORT}`);
    console.log(`  (simulation by default; real Graph apply is explicit opt-in)\n`);
  });
}

export { app, analyze, buildFinalBranding };
