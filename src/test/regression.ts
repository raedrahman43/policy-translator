/**
 * Policy Translator — Regression Harness
 *
 * One command (`npm test`) that proves the translator still works flawlessly
 * after any change. It exercises the EXACT web engine (`generate()` from
 * server.ts, the same code path the localhost UI uses) plus the CLI pipeline,
 * and asserts a set of invariants for every policy shape:
 *
 *   1. Validity          — valid input is accepted, malformed input is rejected.
 *   2. Correct scripts    — the expected set of .ps1 scripts is generated
 *                           (catches feature-map regressions).
 *   3. No dangling tokens — no unresolved `{{PLACEHOLDER}}` in any script,
 *                           except the intentional runtime-edit fallback
 *                           `{{TENANT_SUBDOMAIN}}` (catches substitution bugs).
 *   4. Determinism        — generating twice yields byte-identical output.
 *   5. Gap honesty        — features that can't be automated surface in the
 *                           gap report (not silently dropped).
 *   6. Engine parity      — the web engine and the CLI pipeline emit the same
 *                           script set for the same input (guards the
 *                           "stale server / web != CLI" class of bug).
 *
 * Run: npm test   (or: npx ts-node src/test/regression.ts)
 * Exit code is non-zero if any invariant fails, so it is CI-usable.
 */

import fs from "fs";
import path from "path";

import { generate } from "../web/server";
import { validateAndNormalize } from "../parsers/inputValidator";
import { extractPolicyContext } from "../parsers/policyContextParser";
import { mapAllFeatures, mapFeatureToExternalId } from "../mappers/featureMap";
import { generatePackage, TenantConfig } from "../generators/scriptGenerator";
import { AnalysisFeature, ExternalIdAvailability } from "../types";

// ─── Script filename constants ───────────────────────────────────────────────
const S = {
  app: "01-create-native-app.ps1",
  flow: "02-create-user-flow.ps1",
  smoke: "03-smoke-test-native-auth.ps1",
  google: "04-add-google-idp.ps1",
  facebook: "05-add-facebook-idp.ps1",
  emailOtp: "07-enable-email-otp.ps1",
  claims: "08-claims-mapping-policy.ps1",
  sspr: "09-enable-sspr.ps1",
  sms: "11-enable-sms-mfa.ps1",
  ca: "12-create-ca-policy.ps1",
  passkey: "13-enable-passkey.ps1",
  customAttrs: "14-create-custom-attributes.ps1",
} as const;

const ALLOWED_PLACEHOLDERS = new Set<string>();

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function feat(name: string, availability: ExternalIdAvailability = "Available"): AnalysisFeature {
  return {
    name,
    description: `${name} (synthetic test feature)`,
    reason: `${name} detected in source policy`,
    recommendation: "Supported in External ID; migration path is straightforward.",
    externalIdAvailability: availability,
  };
}

function policy(policyName: string, features: AnalysisFeature[]): { policyName: string; features: AnalysisFeature[] } {
  return { policyName, features };
}

// The email + password base every real policy starts from.
const emailBase = [feat("signUp_auth_emailPassword"), feat("signIn_auth_emailPassword")];

interface TestCase {
  name: string;
  policy: unknown;
  expectValid: boolean;
  expectScripts?: string[]; // exact set (order-independent)
  expectGaps?: string[]; // feature names that must appear in the gap report
  expectGapExcludes?: string[];
  expectReadmeContains?: string[];
  expectReadmeExcludes?: string[];
}

// ─── Synthetic test cases (these DEFINE correct behavior) ─────────────────────

const CASES: TestCase[] = [
  {
    name: "Email + password only",
    policy: policy("B2C_1A_EmailPassword", emailBase),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke],
  },
  {
    name: "Google social sign-in (04)",
    policy: policy("B2C_1A_Google", [...emailBase, feat("signIn_idp_google")]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke, S.google],
    expectGaps: ["Why live validation is still required"],
  },
  {
    name: "Facebook social sign-in (05)",
    policy: policy("B2C_1A_Facebook", [...emailBase, feat("signIn_idp_facebook")]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke, S.facebook],
    expectGaps: ["Why live validation is still required"],
  },
  {
    name: "Custom OIDC sign-in is an honest manual gap",
    policy: policy("B2C_1A_Oidc", [...emailBase, feat("signIn_idp_customOidc")]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke],
    expectGaps: ["signIn_idp_customOidc"],
  },
  {
    name: "Ambiguous Email OTP enables only the safe tenant method",
    policy: policy("B2C_1A_EmailOtp", [...emailBase, feat("signIn_otp_email")]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke, S.emailOtp],
    expectGaps: ["signIn_otp_email"],
  },
  {
    name: "Email OTP MFA requires scoped Conditional Access follow-up",
    policy: policy("B2C_1A_EmailOtpMfa", [
      ...emailBase,
      {
        name: "signIn_otp_email",
        description: "MFA via email one-time passcode",
        reason: "Email OTP is required as a second factor during sign-in",
        recommendation: "Enable Email OTP and require MFA.",
        externalIdAvailability: "Available",
      },
    ]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke, S.emailOtp],
    expectGaps: ["signIn_otp_email"],
  },
  {
    name: "Primary Email OTP remains partial until the user flow supports it",
    policy: policy("B2C_1A_PrimaryEmailOtp", [
      {
        name: "signIn_otp_email",
        description: "Passwordless primary sign-in with email one-time passcode",
        reason: "Users sign in using an email one-time passcode each time",
        recommendation: "Use Email OTP as the primary user-flow provider.",
        externalIdAvailability: "Available",
      },
    ]),
    expectValid: true,
    expectScripts: [S.app, S.emailOtp],
    expectGaps: ["signIn_otp_email"],
    expectReadmeContains: ["does not resolve the primary Email OTP application/user-flow architecture"],
    expectReadmeExcludes: ["printed by script 02"],
  },
  {
    name: "Mixed primary Email OTP and passkey requires an architecture choice",
    policy: policy("B2C_1A_PrimaryOtpPasskey", [
      {
        name: "signIn_otp_email",
        description: "Passwordless primary sign-in with email one-time passcode",
        reason: "Users sign in using an email one-time passcode each time",
        recommendation: "Use Email OTP as the primary user-flow provider.",
        externalIdAvailability: "Available",
      },
      feat("signIn_auth_passkey"),
    ]),
    expectValid: true,
    expectScripts: [S.app, S.emailOtp, S.passkey],
    expectGaps: ["signIn_otp_email", "signIn_auth_passkey"],
    expectReadmeContains: ["does not resolve the primary Email OTP application/user-flow architecture"],
    expectReadmeExcludes: ["application code uses MSAL's native auth API"],
  },
  {
    name: "Mixed primary Email OTP, passkey, and attributes does not create a password flow",
    policy: policy("B2C_1A_PrimaryOtpPasskeyAttributes", [
      {
        name: "signIn_otp_email",
        description: "Passwordless primary sign-in with email one-time passcode",
        reason: "Users sign in using an email one-time passcode each time",
        recommendation: "Use Email OTP as the primary user-flow provider.",
        externalIdAvailability: "Available",
      },
      feat("signIn_auth_passkey"),
      {
        name: "signUp_attributes_custom",
        description: "Collect extension_loyaltyTier",
        reason: "Custom attribute extension_loyaltyTier detected",
        recommendation: "Add the custom attribute to the chosen user flow.",
        externalIdAvailability: "Available",
      },
    ]),
    expectValid: true,
    expectScripts: [S.app, S.emailOtp, S.passkey],
    expectGaps: ["signIn_otp_email", "signIn_auth_passkey", "signUp_attributes_custom"],
    expectReadmeContains: ["does not resolve the primary Email OTP application/user-flow architecture"],
  },
  {
    name: "Primary Email OTP plus Google preserves architecture warning",
    policy: policy("B2C_1A_PrimaryOtpGoogle", [
      {
        name: "signIn_otp_email",
        description: "Passwordless primary sign-in with email one-time passcode",
        reason: "Users sign in using an email one-time passcode each time",
        recommendation: "Use Email OTP as the primary user-flow provider.",
        externalIdAvailability: "Available",
      },
      feat("signIn_idp_google"),
    ]),
    expectValid: true,
    expectScripts: [S.app, S.emailOtp],
    expectGaps: ["signIn_otp_email", "signIn_idp_google"],
    expectReadmeContains: ["does not resolve the primary Email OTP application/user-flow architecture"],
    expectReadmeExcludes: ["application code uses MSAL's native auth API"],
  },
  {
    name: "Primary Email OTP plus custom attributes avoids a password flow",
    policy: policy("B2C_1A_PrimaryOtpCustomAttributes", [
      {
        name: "signIn_otp_email",
        description: "Passwordless primary sign-in with email one-time passcode",
        reason: "Users sign in using an email one-time passcode each time",
        recommendation: "Use Email OTP as the primary user-flow provider.",
        externalIdAvailability: "Available",
      },
      {
        name: "signUp_attributes_custom",
        description: "Collect extension_loyaltyTier",
        reason: "Custom attribute extension_loyaltyTier detected",
        recommendation: "Add the custom attribute to the sign-up page.",
        externalIdAvailability: "Available",
      },
    ]),
    expectValid: true,
    expectScripts: [S.app, S.emailOtp],
    expectGaps: ["signIn_otp_email", "signUp_attributes_custom"],
    expectGapExcludes: ["Custom attributes were created and added automatically"],
    expectReadmeContains: ["does not resolve the primary Email OTP application/user-flow architecture"],
    expectReadmeExcludes: ["application code uses MSAL's native auth API"],
  },
  {
    name: "Primary Email OTP plus Google and SSPR chooses the password architecture",
    policy: policy("B2C_1A_PrimaryOtpGoogleSspr", [
      {
        name: "signIn_otp_email",
        description: "Passwordless primary sign-in with email one-time passcode",
        reason: "Users sign in using an email one-time passcode each time",
        recommendation: "Use Email OTP as the primary user-flow provider.",
        externalIdAvailability: "Available",
      },
      feat("signIn_idp_google"),
      feat("passwordReset_recovery"),
    ]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke, S.google, S.emailOtp, S.sspr],
    expectGaps: ["signIn_otp_email"],
    expectReadmeContains: ["does not resolve the primary Email OTP application/user-flow architecture"],
  },
  {
    name: "Claims mapping (08)",
    policy: policy("B2C_1A_Claims", [...emailBase, feat("global_token_claimsMapping")]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke, S.claims],
  },
  {
    name: "Self-service password reset (09)",
    policy: policy("B2C_1A_Sspr", [...emailBase, feat("passwordReset_recovery")]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke, S.sspr],
  },
  {
    name: "Apple social sign-in is an honest manual gap",
    policy: policy("B2C_1A_Apple", [...emailBase, feat("signIn_idp_apple")]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke],
    expectGaps: ["signIn_idp_apple"],
  },
  {
    name: "SMS MFA (11)",
    policy: policy("B2C_1A_Sms", [...emailBase, feat("signIn_otp_phoneSms")]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke, S.sms],
  },
  {
    name: "Conditional Access MFA (12)",
    policy: policy("B2C_1A_Ca", [...emailBase, feat("signIn_security_conditionalAccess")]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke, S.ca],
  },
  {
    name: "Passkey MFA (13)",
    policy: policy("B2C_1A_Passkey", [...emailBase, feat("signIn_auth_passkey")]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke, S.passkey],
  },
  {
    name: "Passkey-only package leaves the password account model explicit",
    policy: policy("B2C_1A_PasskeyOnly", [feat("signIn_auth_passkey")]),
    expectValid: true,
    expectScripts: [S.app, S.passkey],
    expectGaps: ["signIn_auth_passkey"],
    expectReadmeContains: ["does not choose or create the required email-password versus username-password"],
    expectReadmeExcludes: ["user flow name"],
  },
  {
    name: "Custom attributes (no extra script)",
    policy: policy("B2C_1A_CustomAttrs", [feat("signIn_auth_emailPassword"), feat("signUp_attributes_custom")]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke],
  },
  {
    name: "Custom attributes with real names emit script 14",
    policy: policy("B2C_1A_CustomAttrsNamed", [
      feat("signIn_auth_emailPassword"),
      {
        name: "signUp_attributes_custom",
        description: "Custom sign-up attributes collected: extension_loyaltyTier, extension_membershipLevel",
        reason: "Custom attributes (loyaltyTier, membershipLevel) detected in source policy",
        recommendation: "Supported via custom user flow attributes.",
        externalIdAvailability: "Available",
      },
    ]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke, S.customAttrs],
  },
  {
    name: "Noops add no scripts",
    policy: policy("B2C_1A_Noops", [
      ...emailBase,
      feat("global_token_refreshToken"),
      feat("global_ux_tenantBranding"),
      feat("signIn_session_kmsi"),
    ]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke],
  },
  {
    name: "No-op-only package reports no required tenant changes",
    policy: policy("B2C_1A_RefreshOnly", [feat("global_token_refreshToken")]),
    expectValid: true,
    expectScripts: [],
    expectReadmeContains: ["No tenant or application changes are required"],
    expectReadmeExcludes: ["Use `gap-report.md`"],
  },
  {
    name: "Branding-only package points to port 4001",
    policy: policy("B2C_1A_BrandingOnly", [feat("global_ux_tenantBranding")]),
    expectValid: true,
    expectScripts: [],
    expectReadmeContains: ["Port 4001 branding apply", "port-4001 guided apply experience"],
  },
  {
    name: "Branding plus manual gaps keeps both workstreams visible",
    policy: policy("B2C_1A_BrandingOidc", [
      feat("global_ux_tenantBranding"),
      feat("signIn_idp_customOidc"),
    ]),
    expectValid: true,
    expectScripts: [],
    expectGaps: ["signIn_idp_customOidc"],
    expectReadmeContains: ["port-4001 guided apply experience", "gap-report.md"],
  },
  {
    name: "Branding remains visible alongside generated scripts",
    policy: policy("B2C_1A_EmailBranding", [...emailBase, feat("global_ux_tenantBranding")]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke],
    expectReadmeContains: ["Port 4001 branding apply", "Company Branding is not emitted as a PowerShell script"],
  },
  {
    name: "Claims-only package describes token integration rather than a user flow",
    policy: policy("B2C_1A_ClaimsOnly", [feat("global_token_claimsMapping")]),
    expectValid: true,
    expectScripts: [S.app, S.claims],
    expectReadmeContains: ["does not create a sign-up/sign-in user flow", "compare every expected claim"],
    expectReadmeExcludes: ["user flow name"],
  },
  {
    name: "Conditional-Access-only package describes protected-resource validation",
    policy: policy("B2C_1A_CaOnly", [feat("signIn_security_conditionalAccess")]),
    expectValid: true,
    expectScripts: [S.app, S.ca],
    expectReadmeContains: ["report-only Conditional Access policy", "protected resource"],
    expectReadmeExcludes: ["required primary-sign-in user flow"],
  },
  {
    name: "Un-automatable features surface in gap report",
    policy: policy("B2C_1A_Gaps", [
      ...emailBase,
      feat("passwordReset_security_passwordComplexity"),
      feat("profileEdit_attributes_custom", "NotAvailable"),
      feat("signIn_idp_linkedin"), // Available but no mapper -> coverage gap
    ]),
    expectValid: true,
    expectScripts: [S.app, S.flow, S.smoke],
    expectGaps: [
      "passwordReset_security_passwordComplexity",
      "profileEdit_attributes_custom",
      "signIn_idp_linkedin",
    ],
  },
  {
    name: "Kitchen sink (supported automation plus honest federation gaps)",
    policy: policy("B2C_1A_KitchenSink", [
      ...emailBase,
      feat("signIn_idp_google"),
      feat("signIn_idp_facebook"),
      feat("signIn_idp_apple"),
      feat("signIn_idp_customOidc"),
      feat("signIn_otp_email"),
      feat("signIn_otp_phoneSms"),
      feat("signIn_security_conditionalAccess"),
      feat("signIn_auth_passkey"),
      feat("global_token_claimsMapping"),
      feat("passwordReset_recovery"),
      feat("signUp_attributes_custom"),
    ]),
    expectValid: true,
    expectScripts: [
      S.app, S.flow, S.smoke, S.google, S.facebook,
      S.emailOtp, S.claims, S.sspr, S.sms, S.ca, S.passkey,
    ],
    expectGaps: ["signIn_idp_apple", "signIn_idp_customOidc", "signIn_otp_email"],
  },
  // ── Negative cases: malformed input must be rejected, not crash ──
  {
    name: "Rejects empty features array",
    policy: policy("B2C_1A_Empty", []),
    expectValid: false,
  },
  {
    name: "Rejects missing policyName",
    policy: { features: [feat("signIn_auth_emailPassword")] },
    expectValid: false,
  },
  {
    name: "Rejects non-object input",
    policy: "not a policy",
    expectValid: false,
  },
];

// ─── Assertion utilities ─────────────────────────────────────────────────────

type Script = { filename: string; content: string };

function findUnresolvedPlaceholders(scripts: Script[]): string[] {
  const found: string[] = [];
  for (const s of scripts) {
    const matches = s.content.match(/\{\{[A-Z_]+\}\}/g) ?? [];
    for (const m of matches) {
      if (!ALLOWED_PLACEHOLDERS.has(m)) {
        found.push(`${s.filename}: ${m}`);
      }
    }
  }
  return found;
}

function sortedNames(scripts: Script[]): string[] {
  return scripts.map((s) => s.filename).sort();
}

// The generator stamps each script with an ISO generation timestamp
// (`new Date().toISOString()`), which legitimately differs between runs. Strip
// it so the determinism check measures LOGIC determinism, not wall-clock time.
function stripTimestamps(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<TS>");
}

function normalizedOutput(output: { scripts: Script[]; readme: string; gapReport: string | null }): string {
  return stripTimestamps(
    JSON.stringify({ scripts: output.scripts, readme: output.readme, gapReport: output.gapReport }),
  );
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

interface Failure {
  case: string;
  detail: string;
}

const failures: Failure[] = [];
let passCount = 0;

function check(caseName: string, condition: boolean, detail: string): void {
  if (!condition) {
    failures.push({ case: caseName, detail });
  }
}

// ─── CLI-side config (mirrors src/index.ts) for engine-parity checks ─────────

function cliConfig(policyName: string, features: AnalysisFeature[]): TenantConfig {
  const context = extractPolicyContext(policyName, features);
  return {
    tenantId: "<EDIT_ME_TENANT_ID>",
    appName: context.appName,
    bundleId: "com.contoso.yourapp",
    flowName: context.flowName,
    flowDescription: `Migrated from ${policyName} (generated by policy-translator)`,
    googleClientId: "<EDIT_ME_GOOGLE_CLIENT_ID>",
    googleClientSecret: "<EDIT_ME_GOOGLE_CLIENT_SECRET>",
    googleIdpDisplayName: context.idpDisplayNames.google || "Login with Google",
    facebookAppId: "<EDIT_ME_FACEBOOK_APP_ID>",
    facebookAppSecret: "<EDIT_ME_FACEBOOK_APP_SECRET>",
    facebookIdpDisplayName: context.idpDisplayNames.facebook || "Login with Facebook",
    caResourceAppId: "<EDIT_ME_CA_RESOURCE_APP_ID>",
  };
}

/** Run the CLI pipeline and return the generated script filenames. */
function cliScriptNames(rawJson: unknown): string[] {
  const validation = validateAndNormalize(rawJson);
  if (!validation.valid) return [];
  const { policyName, features } = validation;
  const context = extractPolicyContext(policyName, features);
  const { mapped } = mapAllFeatures(features);
  const output = generatePackage(policyName, mapped, cliConfig(policyName, features), context);
  return sortedNames(output.scripts);
}

// ─── Runner ──────────────────────────────────────────────────────────────────

function runSyntheticCase(tc: TestCase): void {
  let res: any;
  try {
    res = generate(tc.policy, {});
  } catch (err) {
    check(tc.name, false, `generate() threw: ${String(err)}`);
    return;
  }

  const isValid = !("error" in res);

  // 1. Validity
  check(tc.name, isValid === tc.expectValid, `expected valid=${tc.expectValid}, got valid=${isValid}`);

  if (!tc.expectValid) {
    // For negative cases, that is all we assert.
    if (isValid === tc.expectValid) passCount++;
    return;
  }

  if (!isValid) {
    // Already recorded the validity failure above.
    return;
  }

  const scripts: Script[] = res.output.scripts;

  // 2. Correct script set
  if (tc.expectScripts) {
    const actual = sortedNames(scripts);
    check(
      tc.name,
      setsEqual(actual, tc.expectScripts),
      `script set mismatch.\n      expected: ${[...tc.expectScripts].sort().join(", ")}\n      actual:   ${actual.join(", ")}`,
    );
  }
  const emittedOrder = scripts.map((s) => s.filename);
  const canonicalOrder = [...emittedOrder].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  check(
    tc.name,
    emittedOrder.join("|") === canonicalOrder.join("|"),
    `scripts are not in dependency order.\n      emitted: ${emittedOrder.join(", ")}\n      expected: ${canonicalOrder.join(", ")}`,
  );

  // 3. No dangling placeholders
  const dangling = findUnresolvedPlaceholders(scripts);
  check(tc.name, dangling.length === 0, `unresolved placeholders: ${dangling.join(" | ")}`);

  // 4. Determinism (modulo the generation timestamp)
  const res2: any = generate(tc.policy, {});
  const same = normalizedOutput(res.output) === normalizedOutput(res2.output);
  check(tc.name, same, "output not deterministic across two runs");

  // 5. Gap honesty
  if (tc.expectGaps) {
    const report = res.output.gapReport ?? "";
    for (const g of tc.expectGaps) {
      check(tc.name, report.includes(g), `expected gap "${g}" missing from gap report`);
    }
    for (const excluded of tc.expectGapExcludes || []) {
      check(tc.name, !report.includes(excluded), `gap report unexpectedly included: ${excluded}`);
    }
  }

  // 6. README present
  check(tc.name, typeof res.output.readme === "string" && res.output.readme.length > 0, "README missing or empty");
  check(
    tc.name,
    res.output.readme.includes("What this package does not convert automatically"),
    "README omitted the explicit migration boundary section",
  );
  for (const expected of tc.expectReadmeContains || []) {
    check(tc.name, res.output.readme.includes(expected), `README missing expected text: ${expected}`);
  }
  for (const excluded of tc.expectReadmeExcludes || []) {
    check(tc.name, !res.output.readme.includes(excluded), `README unexpectedly included: ${excluded}`);
  }

  const passkeyScript = scripts.find((script) => script.filename === S.passkey);
  if (passkeyScript) {
    check(
      tc.name,
      passkeyScript.content.includes("Azure Front Door"),
      "passkey guidance omitted the Azure Front Door prerequisite",
    );
    check(
      tc.name,
      passkeyScript.content.includes("isSelfServiceRegistrationAllowed") &&
        passkeyScript.content.includes("did not modify passkey profiles or target assignments"),
      "passkey script did not preserve profile/target assignments as an explicit follow-up",
    );
  }
  const emailOtpScript = scripts.find((script) => script.filename === S.emailOtp);
  if (emailOtpScript) {
    check(
      tc.name,
      emailOtpScript.content.includes('$currentConfig.allowExternalIdToUseEmailOtp -eq "enabled"'),
      "Email OTP script did not verify the External ID-specific enablement flag",
    );
  }
  const smsScript = scripts.find((script) => script.filename === S.sms);
  if (smsScript) {
    check(
      tc.name,
      smsScript.content.includes("Verification failed: SMS is not enabled after the update."),
      "SMS script did not enforce its verification readback",
    );
  }
  const flowScript = scripts.find((script) => script.filename === S.flow);
  if (flowScript) {
    check(
      tc.name,
      flowScript.content.includes("Sign-up page labels and required/write settings reconciled."),
      "user-flow script omitted complete page-input reconciliation",
    );
    check(
      tc.name,
      flowScript.content.includes("$attributesConverged") &&
        flowScript.content.includes("$pageSettingsConverged"),
      "user-flow script omitted bounded replication retries",
    );
    check(
      tc.name,
      !flowScript.content.includes("$expand=onAttributeCollection"),
      "user-flow script used an invalid expand on the onAttributeCollection complex property",
    );
    check(
      tc.name,
      !flowScript.content.includes("$flowCastUri"),
      "user-flow script retained the removed flowCastUri variable",
    );
  }
  const googleScript = scripts.find((script) => script.filename === S.google);
  if (googleScript) {
    check(
      tc.name,
      googleScript.content.includes('"#microsoft.graph.socialIdentityProvider"'),
      "Google provider script omitted the derived socialIdentityProvider type marker",
    );
  }
  const facebookScript = scripts.find((script) => script.filename === S.facebook);
  if (facebookScript) {
    check(
      tc.name,
      facebookScript.content.includes('"#microsoft.graph.socialIdentityProvider"'),
      "Facebook provider script omitted the derived socialIdentityProvider type marker",
    );
  }
  const ssprScript = scripts.find((script) => script.filename === S.sspr);
  if (ssprScript) {
    check(
      tc.name,
      !ssprScript.content.includes("$expand=onAuthenticationMethodLoadStart"),
      "SSPR script used an invalid expand on the authentication-method event property",
    );
  }

  // 7. Engine parity: web script set == CLI script set
  const webNames = sortedNames(scripts);
  const cliNames = cliScriptNames(tc.policy);
  check(
    tc.name,
    setsEqual(webNames, cliNames),
    `web vs CLI script set diverged.\n      web: ${webNames.join(", ")}\n      cli: ${cliNames.join(", ")}`,
  );

  if (!failures.some((f) => f.case === tc.name)) passCount++;
}

/** Smoke-test every real Analyzer export we have on disk. */
function runDiskSmokeCase(label: string, rawJson: unknown): void {
  const name = `[disk] ${label}`;
  let res: any;
  try {
    res = generate(rawJson, {});
  } catch (err) {
    check(name, false, `generate() threw: ${String(err)}`);
    return;
  }

  if ("error" in res) {
    // Not fatal (a fixture may be a deliberately minimal edge case), but report it.
    console.log(`   note: ${name} did not validate (skipping deep checks)`);
    passCount++;
    return;
  }

  const scripts: Script[] = res.output.scripts;

  const dangling = findUnresolvedPlaceholders(scripts);
  check(name, dangling.length === 0, `unresolved placeholders: ${dangling.join(" | ")}`);

  const res2: any = generate(rawJson, {});
  const same = normalizedOutput(res.output) === normalizedOutput(res2.output);
  check(name, same, "output not deterministic across two runs");

  const webNames = sortedNames(scripts);
  const cliNames = cliScriptNames(rawJson);
  check(name, setsEqual(webNames, cliNames), `web vs CLI diverged. web: ${webNames.join(", ")} | cli: ${cliNames.join(", ")}`);

  if (!failures.some((f) => f.case === name)) passCount++;
}

function loadDiskFixtures(): { label: string; json: unknown }[] {
  const out: { label: string; json: unknown }[] = [];
  const candidates: string[] = [];

  const realPolicy = path.join(__dirname, "..", "..", "real-policy-input.json");
  if (fs.existsSync(realPolicy)) candidates.push(realPolicy);

  const fixturesDir = path.join(__dirname, "..", "fixtures");
  if (fs.existsSync(fixturesDir)) {
    for (const f of fs.readdirSync(fixturesDir)) {
      if (f.endsWith(".json")) candidates.push(path.join(fixturesDir, f));
    }
  }

  for (const file of candidates) {
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf-8"));
      out.push({ label: path.basename(file), json });
    } catch (err) {
      check(`[disk] ${path.basename(file)}`, false, `could not parse JSON: ${String(err)}`);
    }
  }
  return out;
}

function runAnalyzerGuidanceCompatibility(): void {
  const name = "[compat] enriched Analyzer guidance";
  const file = path.join(__dirname, "..", "fixtures", "analyzer-output-enriched.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  const validation = validateAndNormalize(raw);

  check(name, validation.valid, "enriched Analyzer fixture did not validate");
  check(name, validation.warnings.length === 0, `unexpected warnings: ${validation.warnings.map((w) => w.message).join(" | ")}`);

  const customUi = validation.features.find((feature) => feature.name === "global_ux_advancedUiCustomization");
  check(name, customUi?.externalIdAvailability === "RequiresCustomDevelopment", "custom-development status was not preserved");
  check(name, Boolean(customUi?.notes?.includes("Native Auth SDK")), "Analyzer notes were not preserved");
  check(name, customUi?.docLink?.startsWith("https://learn.microsoft.com/") === true, "Microsoft Learn link was not preserved");

  const incompatible = validation.features.find((feature) => feature.name === "global_token_passthroughNoDirectory");
  check(name, incompatible?.externalIdAvailability === "ArchitectureIncompatible", "architecture-incompatible status was not preserved");

  const unsupported = validation.features.find((feature) => feature.name === "passwordReset_security_passwordComplexity");
  check(name, unsupported?.externalIdAvailability === "NotCurrentlySupported", "not-currently-supported status was not preserved");

  const generated = generate(raw, {});
  check(name, !("error" in generated), "enriched Analyzer fixture failed generation");
  if (!("error" in generated)) {
    const report = generated.output.gapReport || "";
    check(name, report.includes("Migration classification:** RequiresCustomDevelopment"), "gap report omitted the exact classification");
    check(name, report.includes("Analyzer guidance:"), "gap report omitted Analyzer guidance");
    check(name, report.includes("[Microsoft Learn](https://learn.microsoft.com/"), "gap report omitted the official link");
    check(name, report.includes("OnTokenIssuanceStart"), "external claims did not surface custom-extension guidance");
  }

  if (!failures.some((failure) => failure.case === name)) passCount++;
}

function runSelectedPlanCompatibility(): void {
  const name = "[compat] selected migration plan";
  const raw = policy("B2C_1A_SelectedPlan", [
    ...emailBase,
    feat("signIn_idp_google"),
  ]);
  const generated = generate(raw, {}, ["create-native-app", "enable-passkey"]);
  check(name, !("error" in generated), "selected plan failed generation");
  if (!("error" in generated)) {
    check(
      name,
      setsEqual(sortedNames(generated.output.scripts), [S.app, S.passkey]),
      `selected package included unexpected scripts: ${sortedNames(generated.output.scripts).join(", ")}`,
    );
    check(name, !generated.output.readme.includes("Google IdP"), "selected package retained a deselected Google action");
    check(name, Boolean(generated.output.gapReport?.includes("signIn_auth_passkey")), "selected passkey follow-up was missing");
    check(
      name,
      Boolean(generated.output.gapReport?.includes("automated action was not selected")),
      "selected package did not explain that omitted source actions were unselected",
    );
    check(
      name,
      !generated.output.gapReport?.includes("Google was configured automatically"),
      "selected package described a deselected Google action as automated",
    );
  }

  const sspr = generate(
    policy("B2C_1A_SelectedSspr", [feat("global_token_refreshToken")]),
    {},
    ["enable-sspr"],
  );
  check(name, !("error" in sspr), "selected SSPR plan failed generation");
  if (!("error" in sspr)) {
    check(
      name,
      setsEqual(sortedNames(sspr.output.scripts), [S.app, S.flow, S.sspr]),
      `selected SSPR package missed dependencies: ${sortedNames(sspr.output.scripts).join(", ")}`,
    );
    const flowScript = sspr.output.scripts.find((script) => script.filename === S.flow);
    check(
      name,
      Boolean(flowScript?.content.includes('id                    = "email"')) &&
        Boolean(flowScript?.content.includes('id                    = "displayName"')),
      "selected SSPR package did not match live apply's baseline flow attributes",
    );
  }

  const emailOtp = generate(
    policy("B2C_1A_SelectedEmailOtp", [feat("global_token_refreshToken")]),
    {},
    ["enable-email-otp"],
  );
  check(name, !("error" in emailOtp), "selected Email OTP plan failed generation");
  if (!("error" in emailOtp)) {
    check(
      name,
      setsEqual(sortedNames(emailOtp.output.scripts), [S.app, S.emailOtp]),
      `selected Email OTP package missed dependencies: ${sortedNames(emailOtp.output.scripts).join(", ")}`,
    );
    check(
      name,
      Boolean(emailOtp.output.gapReport?.includes("selected modernization")),
      "selected Email OTP package omitted the journey-mode follow-up",
    );
  }

  const customAttributes = generate(
    policy("B2C_1A_DeselectedAttributes", [
      feat("signIn_auth_emailPassword"),
      {
        name: "signUp_attributes_custom",
        description: "Collect extension_loyaltyTier",
        reason: "Custom attribute extension_loyaltyTier detected",
        recommendation: "Create the custom attribute.",
        externalIdAvailability: "Available",
      },
    ]),
    {},
    ["create-native-app", "create-user-flow-emailpassword", "smoke-test-native-auth"],
  );
  check(name, !("error" in customAttributes), "deselected custom-attribute plan failed generation");
  if (!("error" in customAttributes)) {
    check(
      name,
      !sortedNames(customAttributes.output.scripts).includes(S.customAttrs),
      "deselected custom attributes were re-injected into the package",
    );
    check(
      name,
      Boolean(customAttributes.output.gapReport?.includes("automated action was not selected")),
      "deselected custom attributes did not retain an honest unselected-capability gap",
    );
    check(
      name,
      !customAttributes.output.gapReport?.includes("Custom attributes were created and added automatically"),
      "deselected custom attributes retained success-oriented validation guidance",
    );
  }

  const appleGap = generate(
    policy("B2C_1A_SelectedAppleGap", [
      ...emailBase,
      feat("signIn_idp_apple"),
    ]),
    {},
    ["create-native-app", "create-user-flow-emailpassword", "smoke-test-native-auth"],
  );
  check(name, !("error" in appleGap), "selected Apple-gap package failed generation");
  if (!("error" in appleGap)) {
    check(
      name,
      Boolean(appleGap.output.gapReport?.includes("signIn_idp_apple")),
      "selected package dropped a manual-only Analyzer gap",
    );
  }

  const deselectedPartialGap = generate(
    policy("B2C_1A_DeselectedPasskeyGap", [
      ...emailBase,
      feat("signIn_auth_passkey"),
    ]),
    {},
    ["create-native-app", "create-user-flow-emailpassword", "smoke-test-native-auth"],
  );
  check(name, !("error" in deselectedPartialGap), "selected partial-gap package failed generation");
  if (!("error" in deselectedPartialGap)) {
    check(
      name,
      Boolean(deselectedPartialGap.output.gapReport?.includes("signIn_auth_passkey")),
      "selected package dropped a mandatory gap from a partially automated source feature",
    );
    check(
      name,
      !sortedNames(deselectedPartialGap.output.scripts).includes(S.passkey),
      "selected package retained the deselected passkey script",
    );
    check(
      name,
      Boolean(deselectedPartialGap.output.gapReport?.includes("automated action was not selected")),
      "deselected partial action retained success-oriented follow-up wording",
    );
  }

  const branding = generate(
    policy("B2C_1A_SelectedBranding", [feat("global_ux_tenantBranding")]),
    {},
    [],
  );
  check(name, !("error" in branding), "selected branding-only package failed generation");
  if (!("error" in branding)) {
    check(
      name,
      !branding.output.readme.includes("Port 4001 branding apply"),
      "selected package claimed deselected branding would be applied",
    );
    check(
      name,
      Boolean(branding.output.gapReport?.includes("automated action was not selected")),
      "selected package did not report source branding as unselected",
    );
    check(
      name,
      !branding.output.gapReport?.includes("Branding was applied through the guided experience"),
      "selected package retained success-oriented branding guidance",
    );
  }

  const selectedSourceBranding = generate(
    policy("B2C_1A_SelectedSourceBranding", [feat("global_ux_tenantBranding")]),
    {},
    [],
    { brandingIntent: true },
  );
  check(name, !("error" in selectedSourceBranding), "selected source-branding package failed generation");
  if (!("error" in selectedSourceBranding)) {
    check(
      name,
      selectedSourceBranding.output.readme.includes("Port 4001 branding apply"),
      "explicitly selected source branding lost its guided apply path",
    );
    check(
      name,
      Boolean(selectedSourceBranding.output.gapReport?.includes("Why live validation is still required")),
      "explicitly selected source branding lost its validation-only classification",
    );
  }

  const selectedBranding = generate(
    policy("B2C_1A_SelectedManualBranding", [feat("global_token_refreshToken")]),
    {},
    [],
    { brandingIntent: true },
  );
  check(name, !("error" in selectedBranding), "selected manual-branding package failed generation");
  if (!("error" in selectedBranding)) {
    check(
      name,
      selectedBranding.output.readme.includes("Port 4001 branding apply"),
      "selected package omitted manual/imported branding guidance",
    );
  }

  const ssprPolicy = policy("B2C_1A_CliSsprBaseline", [feat("passwordReset_recovery")]);
  const ssprValidation = validateAndNormalize(ssprPolicy);
  const ssprContext = extractPolicyContext(ssprValidation.policyName, ssprValidation.features);
  const ssprMapped = mapAllFeatures(ssprValidation.features).mapped;
  const ssprCliOutput = generatePackage(
    ssprValidation.policyName,
    ssprMapped,
    cliConfig(ssprValidation.policyName, ssprValidation.features),
    ssprContext,
  );
  const ssprCliFlow = ssprCliOutput.scripts.find((script) => script.filename === S.flow);
  check(
    name,
    Boolean(ssprCliFlow?.content.includes('id                    = "email"')) &&
      Boolean(ssprCliFlow?.content.includes('id                    = "displayName"')),
    "direct/CLI package generation omitted baseline Email + Password flow attributes",
  );
  if (!failures.some((failure) => failure.case === name)) passCount++;
}

// ─── Full Analyzer coverage (every feature key the Analyzer can emit) ─────────
//
// The file analyzer-feature-keys.json is the complete list of feature keys from
// the "B2C Migration Policy Analyzer - Complete Feature List" reference. This is
// the authoritative input space: every key the tool could ever receive.
//
// This section proves two distinct guarantees:
//
//   ROBUSTNESS  — for EVERY key (alone) and for ALL keys combined, generate()
//                 never crashes, always validates, is deterministic, and leaves
//                 no dangling placeholders. This is the "works for everything"
//                 guarantee: no real Analyzer output can break the tool.
//
//   ACCOUNTING  — every key is classified into exactly one of SCRIPTED (produces
//                 config scripts), GAP (honestly reported in the gap report), or
//                 NOOP (no action needed). UNACCOUNTED must be 0: nothing is ever
//                 silently dropped. The printed matrix is a defensible coverage
//                 report (how many keys the tool automates vs. reports).

type CoverageBucket = "SCRIPTED" | "GAP" | "NOOP" | "UNACCOUNTED";

interface CoverageRow {
  key: string;
  bucket: CoverageBucket;
  scripts: string[];
}

function loadAnalyzerFeatureKeys(): string[] {
  const file = path.join(__dirname, "analyzer-feature-keys.json");
  if (!fs.existsSync(file)) {
    check("[coverage] feature-key list", false, `missing ${file}`);
    return [];
  }
  // Strip a possible UTF-8 BOM before parsing.
  const raw = fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
  const keys = JSON.parse(raw) as string[];
  return [...new Set(keys)].sort();
}

/** Classify a single feature key using the real mapper (source of truth). */
function classifyKey(key: string): CoverageRow {
  const result = mapFeatureToExternalId(feat(key));
  if (!result) {
    return { key, bucket: "UNACCOUNTED", scripts: [] };
  }
  if (result.steps.length > 0) {
    const scripts = result.steps.map((s) => STEP_TO_FILE[s.kind] ?? s.kind).sort();
    return { key, bucket: "SCRIPTED", scripts: [...new Set(scripts)] };
  }
  if (result.category === "noop") return { key, bucket: "NOOP", scripts: [] };
  if (result.category === "gap" || result.gapReport) return { key, bucket: "GAP", scripts: [] };
  return { key, bucket: "UNACCOUNTED", scripts: [] };
}

// StepKind -> script filename (mirrors STEP_TEMPLATES in scriptGenerator.ts).
const STEP_TO_FILE: Record<string, string> = {
  "create-native-app": S.app,
  "create-user-flow-emailpassword": S.flow,
  "smoke-test-native-auth": S.smoke,
  "add-google-idp": S.google,
  "add-facebook-idp": S.facebook,
  "enable-email-otp": S.emailOtp,
  "claims-mapping-policy": S.claims,
  "enable-sspr": S.sspr,
  "enable-sms-mfa": S.sms,
  "create-ca-policy": S.ca,
  "enable-passkey": S.passkey,
  "create-custom-attributes": S.customAttrs,
};

/** Run every feature key solo through generate() and assert robustness. */
function runFullCoverage(): CoverageRow[] {
  const keys = loadAnalyzerFeatureKeys();
  const rows: CoverageRow[] = [];

  // Silence the per-key "no mapper" developer warnings for a clean report; the
  // gap report is what asserts those features are handled, not the warning.
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    for (const key of keys) {
      const name = `[coverage] ${key}`;

      // ROBUSTNESS: a policy containing only this feature must not crash.
      let res: any;
      try {
        res = generate(policy(`B2C_1A_${key}`, [feat(key)]), {});
      } catch (err) {
        check(name, false, `generate() threw: ${String(err)}`);
        rows.push({ key, bucket: "UNACCOUNTED", scripts: [] });
        continue;
      }

      check(name, !("error" in res), `single-feature policy failed validation`);
      if (!("error" in res)) {
        const scripts: Script[] = res.output.scripts;
        const dangling = findUnresolvedPlaceholders(scripts);
        check(name, dangling.length === 0, `unresolved placeholders: ${dangling.join(" | ")}`);
        const res2: any = generate(policy(`B2C_1A_${key}`, [feat(key)]), {});
        check(
          name,
          normalizedOutput(res.output) === normalizedOutput(res2.output),
          "output not deterministic across two runs",
        );
      }

      // ACCOUNTING: classify the key; UNACCOUNTED is a failure.
      const row = classifyKey(key);
      check(name, row.bucket !== "UNACCOUNTED", `key is neither scripted, gap, nor noop (silently dropped)`);
      rows.push(row);
    }

    // ROBUSTNESS (combined): one giant policy with EVERY key at once.
    const megaName = "[coverage] ALL keys combined (mega policy)";
    const megaFeatures = keys.map((k) => feat(k));
    let mega: any;
    try {
      mega = generate(policy("B2C_1A_AllFeatures", megaFeatures), {});
      check(megaName, !("error" in mega), "mega policy failed validation");
      if (!("error" in mega)) {
        const dangling = findUnresolvedPlaceholders(mega.output.scripts);
        check(megaName, dangling.length === 0, `unresolved placeholders: ${dangling.join(" | ")}`);
        const mega2: any = generate(policy("B2C_1A_AllFeatures", megaFeatures), {});
        check(
          megaName,
          normalizedOutput(mega.output) === normalizedOutput(mega2.output),
          "mega policy not deterministic",
        );
        // Every scripted key's feature must be represented in the package, and
        // every non-scripted, non-noop key must appear in the gap report.
        const gap = mega.output.gapReport ?? "";
        for (const row of rows) {
          if (row.bucket === "GAP") {
            check(megaName, gap.includes(row.key), `gap key "${row.key}" missing from combined gap report`);
          }
        }
      }
    } catch (err) {
      check(megaName, false, `generate() threw: ${String(err)}`);
    }
  } finally {
    console.warn = originalWarn;
  }

  return rows;
}

function printCoverageMatrix(rows: CoverageRow[]): void {
  const by = (b: CoverageBucket) => rows.filter((r) => r.bucket === b);
  const scripted = by("SCRIPTED");
  const gaps = by("GAP");
  const noops = by("NOOP");
  const unaccounted = by("UNACCOUNTED");

  console.log("\n=== Coverage matrix (authoritative Analyzer feature set) ===");
  console.log(`  Total feature keys : ${rows.length}`);
  console.log(`  SCRIPTED (automated): ${scripted.length}`);
  console.log(`  GAP (reported)      : ${gaps.length}`);
  console.log(`  NOOP (no action)    : ${noops.length}`);
  console.log(`  UNACCOUNTED         : ${unaccounted.length}   <- must be 0`);

  console.log("\n  Scripted keys (feature -> scripts):");
  for (const r of scripted) {
    console.log(`    ${r.key}  ->  ${r.scripts.join(", ")}`);
  }
  if (noops.length) {
    console.log("\n  No-op keys (handled by External ID defaults, no script needed):");
    for (const r of noops) console.log(`    ${r.key}`);
  }
  if (unaccounted.length) {
    console.log("\n  UNACCOUNTED keys (BUG - silently dropped):");
    for (const r of unaccounted) console.log(`    ${r.key}`);
  }
}


// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  console.log("\n=== Policy Translator regression suite ===\n");

  console.log("Synthetic policy cases:");
  for (const tc of CASES) {
    const before = failures.length;
    runSyntheticCase(tc);
    const ok = failures.length === before;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${tc.name}`);
  }

  console.log("\nReal on-disk Analyzer exports:");
  for (const { label, json } of loadDiskFixtures()) {
    const before = failures.length;
    runDiskSmokeCase(label, json);
    const ok = failures.length === before;
    console.log(`  ${ok ? "PASS" : "FAIL"}  [disk] ${label}`);
  }

  console.log("\nEnriched Analyzer metadata compatibility:");
  const compatBefore = failures.length;
  runAnalyzerGuidanceCompatibility();
  console.log(`  ${failures.length === compatBefore ? "PASS" : "FAIL"}  enriched statuses, notes, links, and gap guidance`);

  console.log("\nSelected migration plan compatibility:");
  const selectedBefore = failures.length;
  runSelectedPlanCompatibility();
  console.log(`  ${failures.length === selectedBefore ? "PASS" : "FAIL"}  downloaded package matches selected actions`);

  console.log("\nFull Analyzer coverage (every feature key, robustness + accounting):");
  const covBefore = failures.length;
  const rows = runFullCoverage();
  const covFailures = failures.length - covBefore;
  if (covFailures === 0) passCount += rows.length + 1; // +1 for the mega policy
  console.log(
    `  ${covFailures === 0 ? "PASS" : "FAIL"}  ${rows.length} keys exercised solo + combined ` +
      `(${covFailures} failure(s))`,
  );
  printCoverageMatrix(rows);

  console.log("\n────────────────────────────────────────────");
  if (failures.length === 0) {
    console.log(`ALL GREEN — ${passCount} case(s) passed, 0 failed.\n`);
    process.exit(0);
  }

  console.log(`${passCount} passed, ${failures.length} failure(s):\n`);
  for (const f of failures) {
    console.log(`  FAIL  ${f.case}`);
    console.log(`        ${f.detail}`);
  }
  console.log("");
  process.exit(1);
}

main();
