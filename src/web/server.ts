/**
 * Policy Translator — Web Server
 *
 * Thin HTTP layer over the existing deterministic translator modules.
 * Nothing is persisted: uploaded policy JSON and customer credentials live only
 * for the duration of a request and are used solely to render scripts.
 *
 * Endpoints:
 *   POST /api/analyze       → validate JSON, return readiness + required inputs
 *   POST /api/generate      → return generated scripts/readme/gap report (JSON)
 *   POST /api/generate-zip  → stream the migration package as a .zip
 *
 * Run:  npm run web   (then open http://localhost:4000)
 */

import express, { Request, Response } from "express";
import path from "path";
import JSZip from "jszip";

import { validateAndNormalize } from "../parsers/inputValidator";
import { extractPolicyContext } from "../parsers/policyContextParser";
import { mapAllFeatures, MappingResult, StepKind } from "../mappers/featureMap";
import { generatePackage, injectCustomAttributeStep, TenantConfig } from "../generators/scriptGenerator";
import { deriveRequiredInputs } from "./inputRequirements";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Shared analysis pipeline ────────────────────────────────────────────────

interface AnalyzeOutcome {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

const STATUS_LABELS: Record<string, string> = {
  Available: "Ready to migrate",
  Partial: "Partially available",
  NeedsExtensions: "Needs custom extensions",
  DifferentApproach: "Different approach",
  OnRoadmap: "On roadmap",
  NotAvailable: "Not yet available",
};

function analyze(rawJson: unknown): AnalyzeOutcome {
  const validation = validateAndNormalize(rawJson);

  if (!validation.valid) {
    return {
      ok: false,
      status: 400,
      body: {
        valid: false,
        errors: validation.errors,
        warnings: validation.warnings,
      },
    };
  }

  const { policyName, features } = validation;
  const context = extractPolicyContext(policyName, features);
  const { mapped, unmapped } = mapAllFeatures(features);

  // Readiness counts by status
  const byStatus: Record<string, number> = {};
  for (const f of features) {
    byStatus[f.externalIdAvailability] = (byStatus[f.externalIdAvailability] || 0) + 1;
  }
  const available = byStatus["Available"] || 0;
  const total = features.length;
  const readinessPct = total > 0 ? Math.round((available / total) * 100) : 0;
  const readinessScore = readinessPct >= 70 ? "High" : readinessPct >= 40 ? "Medium" : "Low";

  // Per-feature view for the review table
  const featureView = features.map((f) => ({
    name: f.name,
    description: f.description || "",
    status: f.externalIdAvailability,
    statusLabel: STATUS_LABELS[f.externalIdAvailability] || f.externalIdAvailability,
  }));

  // What scripts will be generated + why
  const stepReasons = new Map<string, string[]>();
  const stepOrder: string[] = [];
  for (const r of mapped) {
    for (const s of r.steps) {
      if (!stepReasons.has(s.kind)) {
        stepReasons.set(s.kind, []);
        stepOrder.push(s.kind);
      }
      stepReasons.get(s.kind)!.push(r.featureName);
    }
  }
  // Inject the custom-attributes step (14) after the user-flow step when the
  // policy collected true custom (extension) attributes. Mirrors generatePackage.
  const orderedKinds = injectCustomAttributeStep(stepOrder as StepKind[], context);
  if (context.customAttributes.length > 0 && !stepReasons.has("create-custom-attributes")) {
    stepReasons.set("create-custom-attributes", ["Custom attribute collection"]);
  }
  const steps = orderedKinds.map((kind) => ({
    kind,
    features: [...new Set(stepReasons.get(kind) || [])],
  }));

  // Gaps (manual work)
  const gaps = mapped
    .filter((r) => r.gapReport)
    .map((r) => ({
      feature: r.gapReport!.feature,
      reason: r.gapReport!.reason,
      recommendation: r.gapReport!.recommendation,
    }));

  const requiredInputs = deriveRequiredInputs(mapped);

  return {
    ok: true,
    status: 200,
    body: {
      valid: true,
      warnings: validation.warnings,
      normalized: validation.normalized,
      policyName,
      readiness: {
        score: readinessScore,
        percent: readinessPct,
        total,
        available,
        needsWork: total - available,
        byStatus,
      },
      context: {
        appName: context.appName,
        flowName: context.flowName,
        claimsCount: context.claims.length,
        attributesCount: context.attributes.length,
        customAttributesCount: context.customAttributes.length,
        idpDisplayNames: context.idpDisplayNames,
      },
      features: featureView,
      steps,
      gaps,
      unmapped,
      requiredInputs,
    },
  };
}

/**
 * Build a TenantConfig from auto-derived context + customer-provided inputs.
 * Customer values win where provided; everything else falls back to a sensible
 * default or the value derived from the policy.
 */
export function buildConfig(policyName: string, mapped: MappingResult[], rawJson: unknown, config: Record<string, string>): TenantConfig {
  const validation = validateAndNormalize(rawJson);
  const context = extractPolicyContext(policyName, validation.features);

  const val = (k: string, fallback: string) => {
    const v = config[k];
    return v !== undefined && v !== null && String(v).trim() !== "" ? String(v).trim() : fallback;
  };

  return {
    tenantId: val("tenantId", "<EDIT_ME_TENANT_ID>"),
    appName: val("appName", context.appName),
    bundleId: val("bundleId", "com.contoso.yourapp"),
    flowName: val("flowName", context.flowName),
    flowDescription: `Migrated from ${policyName} (generated by policy-translator)`,
    googleClientId: val("googleClientId", "<EDIT_ME_GOOGLE_CLIENT_ID>"),
    googleClientSecret: val("googleClientSecret", "<EDIT_ME_GOOGLE_CLIENT_SECRET>"),
    googleIdpDisplayName: val("googleIdpDisplayName", context.idpDisplayNames.google || "Sign in with Google"),
    facebookAppId: val("facebookAppId", "<EDIT_ME_FACEBOOK_APP_ID>"),
    facebookAppSecret: val("facebookAppSecret", "<EDIT_ME_FACEBOOK_APP_SECRET>"),
    facebookIdpDisplayName: val("facebookIdpDisplayName", context.idpDisplayNames.facebook || "Sign in with Facebook"),
    caResourceAppId: val("caResourceAppId", "<EDIT_ME_CA_RESOURCE_APP_ID>"),
  };
}

export function generate(rawJson: unknown, config: Record<string, string>) {
  const validation = validateAndNormalize(rawJson);
  if (!validation.valid) {
    return { error: validation.errors };
  }
  const { policyName, features } = validation;
  const context = extractPolicyContext(policyName, features);
  const { mapped } = mapAllFeatures(features);
  const tenantConfig = buildConfig(policyName, mapped, rawJson, config);
  const output = generatePackage(policyName, mapped, tenantConfig, context);
  return { policyName, output };
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

app.post("/api/generate", (req: Request, res: Response) => {
  try {
    const rawJson = req.body?.json;
    const config = (req.body?.config ?? {}) as Record<string, string>;
    const result = generate(rawJson, config);
    if ("error" in result) {
      return res.status(400).json({ errors: result.error });
    }
    res.json({
      policyName: result.policyName,
      scripts: result.output.scripts,
      gapReport: result.output.gapReport,
      readme: result.output.readme,
    });
  } catch (err) {
    res.status(500).json({ errors: [{ field: "server", message: String(err) }] });
  }
});

app.post("/api/generate-zip", async (req: Request, res: Response) => {
  try {
    const rawJson = req.body?.json;
    const config = (req.body?.config ?? {}) as Record<string, string>;
    const result = generate(rawJson, config);
    if ("error" in result) {
      return res.status(400).json({ errors: result.error });
    }

    const safeName = result.policyName.replace(/[^a-zA-Z0-9-_]/g, "_");

    const zip = new JSZip();
    for (const script of result.output.scripts) {
      zip.file(script.filename, script.content);
    }
    zip.file("README.md", result.output.readme);
    if (result.output.gapReport) {
      zip.file("gap-report.md", result.output.gapReport);
    }

    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    res.attachment(`migration-package-${safeName}.zip`);
    res.setHeader("Content-Type", "application/zip");
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ errors: [{ field: "server", message: String(err) }] });
  }
});

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// Only start the HTTP listener when run directly (npm run web). When this module
// is imported (e.g. by the regression harness) we expose generate()/buildConfig()
// without binding a port.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Policy Translator web UI running:`);
    console.log(`  → http://localhost:${PORT}\n`);
  });
}
