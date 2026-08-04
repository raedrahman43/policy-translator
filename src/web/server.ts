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
import { extractPolicyContext, withEmailPasswordBaseline } from "../parsers/policyContextParser";
import { GapEntry, mapAllFeatures, MappingResult, StepKind } from "../mappers/featureMap";
import { generatePackage, injectCustomAttributeStep, TenantConfig } from "../generators/scriptGenerator";
import { buildFeatureView, buildReadiness } from "./analyzerPresentation";
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

  const featureView = buildFeatureView(features, mapped, "Ready to migrate");
  const readiness = buildReadiness(rawJson, features, featureView);

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
      featureOccurrence: r.gapReport!.featureOccurrence,
      reason: r.gapReport!.reason,
      recommendation: r.gapReport!.recommendation,
      availability: r.gapReport!.availability,
      notes: r.gapReport!.notes,
      docLink: r.gapReport!.docLink,
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
      readiness,
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

const STEP_KINDS = new Set<StepKind>([
  "create-native-app",
  "create-user-flow-emailpassword",
  "add-google-idp",
  "add-facebook-idp",
  "enable-email-otp",
  "enable-sms-mfa",
  "create-ca-policy",
  "enable-passkey",
  "claims-mapping-policy",
  "enable-sspr",
  "create-custom-attributes",
  "smoke-test-native-auth",
]);

const STEP_DEPENDENCIES: Partial<Record<StepKind, StepKind[]>> = {
  "create-user-flow-emailpassword": ["create-native-app"],
  "smoke-test-native-auth": ["create-native-app", "create-user-flow-emailpassword"],
  "add-google-idp": ["create-native-app", "create-user-flow-emailpassword"],
  "add-facebook-idp": ["create-native-app", "create-user-flow-emailpassword"],
  "enable-email-otp": ["create-native-app"],
  "enable-sms-mfa": ["create-native-app"],
  "create-ca-policy": ["create-native-app"],
  "enable-passkey": ["create-native-app"],
  "claims-mapping-policy": ["create-native-app"],
  "enable-sspr": ["create-native-app", "create-user-flow-emailpassword"],
  "create-custom-attributes": ["create-native-app", "create-user-flow-emailpassword"],
};

export function resolveSelectedKinds(selectedKinds: string[]): StepKind[] {
  const selected = new Set<StepKind>();
  const add = (kind: StepKind) => {
    for (const dependency of STEP_DEPENDENCIES[kind] || []) add(dependency);
    selected.add(kind);
  };
  for (const kind of selectedKinds) {
    if (STEP_KINDS.has(kind as StepKind)) add(kind as StepKind);
  }
  return [...selected];
}

function selectedGap(
  kind: StepKind,
  feature: string,
  reason: string,
  recommendation: string,
  followUpType: GapEntry["followUpType"] = "manual",
): MappingResult {
  const gapReport: GapEntry = {
    feature,
    followUpType,
    reason,
    recommendation,
    effort: "Selected modernization capability with required follow-up",
  };
  return {
    featureName: `selected_${kind}`,
    category: "user-flow",
    steps: [{ kind, reason: `${kind} was selected in the guided migration plan` }],
    gapReport,
  };
}

function selectedKindMapping(kind: StepKind): MappingResult {
  switch (kind) {
    case "enable-email-otp":
      return selectedGap(
        kind,
        "signIn_otp_email (selected modernization)",
        "Enabling Email OTP makes the tenant method available but does not choose whether it is primary passwordless sign-in, MFA, sign-up verification, or password-reset verification.",
        "Choose the intended journey role. Configure the matching user flow, scoped Conditional Access policy, or SSPR experience and validate that exact end-user journey.",
      );
    case "enable-sms-mfa":
      return selectedGap(
        kind,
        "signIn_otp_phoneSms (selected modernization)",
        "Policy Translator enables the tenant SMS method, but billing/telephony readiness and customer phone registration remain outside the script.",
        "Confirm subscription linkage and SMS terms, register a test phone method, require MFA through an approved scoped policy, and complete a real SMS challenge.",
      );
    case "create-ca-policy":
      return selectedGap(
        kind,
        "signIn_security_conditionalAccess (selected modernization)",
        "The generated policy is report-only and requires the protected resource application ID plus customer-specific user and emergency-access scope decisions.",
        "Review the report-only policy and sign-in logs, validate exclusions and MFA compatibility, then enable it only after approval.",
      );
    case "enable-passkey":
      return selectedGap(
        kind,
        "signIn_auth_passkey (selected modernization)",
        "The script enables only the FIDO2 base policy. It does not choose the password account model, passkey profiles, targeting, MFA enrollment, Azure Front Door/custom domain, or credential-management experience.",
        "Complete every passkey prerequisite and validate registration and browser-delegated sign-in before rollout.",
      );
    case "enable-sspr":
      return selectedGap(
        kind,
        "passwordReset_recovery (selected modernization)",
        "The script configures SSPR prerequisites on a generated Email + Password flow, but a real customer reset and hosted-page link must still be verified.",
        "Complete one real Forgot password flow and verify Email OTP, password update, sign-in, and branding behavior.",
        "validation",
      );
    default:
      return {
        featureName: `selected_${kind}`,
        category: "user-flow",
        steps: [{ kind, reason: `${kind} was selected in the guided migration plan` }],
      };
  }
}

function unselectedMapping(mapping: MappingResult): MappingResult | undefined {
  if (!mapping.gapReport) return undefined;
  return {
    featureName: mapping.featureName,
    ...(mapping.featureOccurrence ? { featureOccurrence: mapping.featureOccurrence } : {}),
    category: "gap",
    steps: [],
    gapReport: {
      ...mapping.gapReport,
      followUpType: "manual",
      reason: "This source capability remains in scope, but its automated action was not selected in this package.",
      recommendation: "Select the corresponding automated action in Policy Translator or configure the capability separately before completing the migration.",
      effort: "Unselected source capability",
    },
  };
}

function selectMappings(
  mapped: MappingResult[],
  selectedKinds: string[],
  brandingIntent: boolean,
): MappingResult[] {
  const direct = new Set(
    selectedKinds.filter((kind): kind is StepKind => STEP_KINDS.has(kind as StepKind)),
  );
  const selected = new Set(resolveSelectedKinds(selectedKinds));
  const foundational = new Set<StepKind>([
    "create-native-app",
    "create-user-flow-emailpassword",
    "smoke-test-native-auth",
  ]);
  const result: MappingResult[] = [];

  for (const mapping of mapped) {
    if (!mapping.steps.length) {
      if (mapping.featureName === "global_ux_tenantBranding" && !brandingIntent) {
        const unselected = unselectedMapping(mapping);
        if (unselected) result.push(unselected);
      } else {
        result.push(mapping);
      }
      continue;
    }
    const steps = mapping.steps.filter((step) => selected.has(step.kind));
    const distinctiveSteps = mapping.steps.filter((step) => !foundational.has(step.kind));
    const directlySelected = mapping.featureName === "signUp_attributes_custom"
      ? direct.has("create-custom-attributes")
      : distinctiveSteps.length
        ? distinctiveSteps.some((step) => direct.has(step.kind))
        : mapping.steps.some((step) => step.kind !== "create-native-app" && direct.has(step.kind));

    if (directlySelected) {
      result.push({ ...mapping, steps });
    } else if (steps.length) {
      result.push({
        featureName: `dependency_${mapping.featureName}`,
        category: mapping.category,
        steps,
      });
    }
    if (!directlySelected && mapping.gapReport) {
      const unselected = unselectedMapping(mapping);
      if (unselected) result.push(unselected);
    }
  }
  const present = new Set(result.flatMap((mapping) => mapping.steps.map((step) => step.kind)));

  for (const kind of selected) {
    if (present.has(kind)) continue;
    result.push(selectedKindMapping(kind));
  }
  return result;
}

export function generate(
  rawJson: unknown,
  config: Record<string, string>,
  selectedKinds?: string[],
  options: { brandingIntent?: boolean } = {},
) {
  const validation = validateAndNormalize(rawJson);
  if (!validation.valid) {
    return { error: validation.errors };
  }
  const { policyName, features } = validation;
  const context = extractPolicyContext(policyName, features);
  const { mapped } = mapAllFeatures(features);
  const resolvedKinds = selectedKinds ? resolveSelectedKinds(selectedKinds) : undefined;
  const effectiveMapped = selectedKinds
    ? selectMappings(mapped, selectedKinds, options.brandingIntent === true)
    : [...mapped];
  if (
    options.brandingIntent &&
    !effectiveMapped.some((mapping) => mapping.featureName === "global_ux_tenantBranding")
  ) {
    effectiveMapped.push({
      featureName: "global_ux_tenantBranding",
      category: "noop",
      steps: [],
      noopReason: "Company Branding was selected in the guided migration plan.",
      gapReport: {
        feature: "global_ux_tenantBranding (selected branding)",
        followUpType: "validation",
        reason: "Company Branding is tenant-wide and a successful Graph write does not prove the hosted sign-in page matches the intended customer experience.",
        recommendation: "Apply branding through port 4001, then open the real browser-hosted sign-in page and verify assets, localizations, and custom CSS.",
        effort: "Hosted-page validation",
      },
    });
  }
  let effectiveContext = resolvedKinds && !resolvedKinds.includes("create-custom-attributes")
    ? { ...context, customAttributes: [] }
    : context;
  if (effectiveMapped.some((mapping) =>
    mapping.steps.some((step) => step.kind === "create-user-flow-emailpassword")
  )) {
    effectiveContext = {
      ...effectiveContext,
      attributes: withEmailPasswordBaseline(effectiveContext.attributes),
    };
  }
  const tenantConfig = buildConfig(policyName, effectiveMapped, rawJson, config);
  const output = generatePackage(policyName, effectiveMapped, tenantConfig, effectiveContext);
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
    const selectedKinds = Array.isArray(req.body?.selectedKinds) ? req.body.selectedKinds.map(String) : undefined;
    const result = generate(rawJson, config, selectedKinds, {
      brandingIntent: req.body?.brandingIntent === true,
    });
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
    const selectedKinds = Array.isArray(req.body?.selectedKinds) ? req.body.selectedKinds.map(String) : undefined;
    const result = generate(rawJson, config, selectedKinds, {
      brandingIntent: req.body?.brandingIntent === true,
    });
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
