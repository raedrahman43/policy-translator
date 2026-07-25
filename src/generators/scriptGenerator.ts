/**
 * Script Generator
 *
 * Takes mapped features + tenant config and emits the final migration package:
 * runnable PowerShell scripts (sourced from `templates/`), a gap report, and
 * a README.
 *
 * Templates were proven end-to-end against a real External ID test tenant
 * before being parameterized. Only the CONFIG block (tenantId / appName /
 * bundleId / flowName / flowDescription) differs per generated package.
 */

import fs from "fs";
import path from "path";
import { MappingResult, StepKind, RequiredStep, GapEntry } from "../mappers/featureMap";
import { manualRecreationSteps } from "./manualRecreation";
import { PolicyContext } from "../parsers/policyContextParser";

export interface TenantConfig {
  tenantId: string;
  appName: string;
  bundleId: string;
  flowName: string;
  flowDescription: string;
  // Google IdP — only used when `add-google-idp` step is emitted.
  googleClientId: string;
  googleClientSecret: string;
  googleIdpDisplayName: string;
  // Facebook IdP — only used when `add-facebook-idp` step is emitted.
  facebookAppId: string;
  facebookAppSecret: string;
  facebookIdpDisplayName: string;
  // Conditional Access targets the protected resource, not the public client.
  caResourceAppId: string;
}

export interface GeneratedOutput {
  scripts: { filename: string; content: string }[];
  gapReport: string | null;
  readme: string;
}

interface StepTemplate {
  filename: string;
  templatePath: string;
}

const TEMPLATES_DIR = path.join(__dirname, "templates");

const STEP_TEMPLATES: Record<StepKind, StepTemplate> = {
  "create-native-app": {
    filename: "01-create-native-app.ps1",
    templatePath: path.join(TEMPLATES_DIR, "01-create-native-app.ps1"),
  },
  "create-user-flow-emailpassword": {
    filename: "02-create-user-flow.ps1",
    templatePath: path.join(TEMPLATES_DIR, "02-create-user-flow.ps1"),
  },
  "smoke-test-native-auth": {
    filename: "03-smoke-test-native-auth.ps1",
    templatePath: path.join(TEMPLATES_DIR, "03-smoke-test-native-auth.ps1"),
  },
  "add-google-idp": {
    filename: "04-add-google-idp.ps1",
    templatePath: path.join(TEMPLATES_DIR, "04-add-google-idp.ps1"),
  },
  "add-facebook-idp": {
    filename: "05-add-facebook-idp.ps1",
    templatePath: path.join(TEMPLATES_DIR, "05-add-facebook-idp.ps1"),
  },
  "enable-email-otp": {
    filename: "07-enable-email-otp.ps1",
    templatePath: path.join(TEMPLATES_DIR, "07-enable-email-otp.ps1"),
  },
  "enable-sms-mfa": {
    filename: "11-enable-sms-mfa.ps1",
    templatePath: path.join(TEMPLATES_DIR, "11-enable-sms-mfa.ps1"),
  },
  "create-ca-policy": {
    filename: "12-create-ca-policy.ps1",
    templatePath: path.join(TEMPLATES_DIR, "12-create-ca-policy.ps1"),
  },
  "enable-passkey": {
    filename: "13-enable-passkey.ps1",
    templatePath: path.join(TEMPLATES_DIR, "13-enable-passkey.ps1"),
  },
  "claims-mapping-policy": {
    filename: "08-claims-mapping-policy.ps1",
    templatePath: path.join(TEMPLATES_DIR, "08-claims-mapping-policy.ps1"),
  },
  "enable-sspr": {
    filename: "09-enable-sspr.ps1",
    templatePath: path.join(TEMPLATES_DIR, "09-enable-sspr.ps1"),
  },
  "create-custom-attributes": {
    filename: "14-create-custom-attributes.ps1",
    templatePath: path.join(TEMPLATES_DIR, "14-create-custom-attributes.ps1"),
  },
};

const CANONICAL_STEP_ORDER: StepKind[] = [
  "create-native-app",
  "create-user-flow-emailpassword",
  "smoke-test-native-auth",
  "add-google-idp",
  "add-facebook-idp",
  "enable-email-otp",
  "claims-mapping-policy",
  "enable-sspr",
  "enable-sms-mfa",
  "create-ca-policy",
  "enable-passkey",
  "create-custom-attributes",
];

const STEP_ORDER_INDEX = new Map(CANONICAL_STEP_ORDER.map((kind, index) => [kind, index]));

export function filenameForStep(kind: StepKind): string {
  return STEP_TEMPLATES[kind].filename;
}

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match;
  });
}

function psDoubleQuoted(value: string): string {
  return value
    .replace(/`/g, "``")
    .replace(/\$/g, "`$")
    .replace(/"/g, '`"')
    .replace(/\r\n?|\n/g, "`n");
}

function renderStep(
  kind: StepKind,
  policyName: string,
  generatedAt: string,
  config: TenantConfig,
  policyContext?: PolicyContext,
  nextFilename?: string,
): { filename: string; content: string } {
  const tpl = STEP_TEMPLATES[kind];
  const raw = fs.readFileSync(tpl.templatePath, "utf-8");

  // Build claims schema PowerShell block from policy context
  let claimsSchemaBlock = "";
  if (policyContext && policyContext.claims.length > 0) {
    const entries = policyContext.claims.map(c =>
      `    @{ Source = "user"; ID = "${psDoubleQuoted(c.source)}"; JwtClaimType = "${psDoubleQuoted(c.jwtName)}" }`
    );
    claimsSchemaBlock = entries.join("\n");
  }

  // Build attributes PowerShell block from policy context
  let attributesBlock = "";
  let attributeInputsBlock = "";
  if (policyContext && policyContext.attributes.length > 0) {
    const attrEntries = policyContext.attributes.map(a =>
      `            @{\n` +
      `                id                    = "${psDoubleQuoted(a.id)}"\n` +
      `                displayName           = "${psDoubleQuoted(a.displayName)}"\n` +
      `                description           = "${psDoubleQuoted(a.displayName)} of the user"\n` +
      `                userFlowAttributeType = "builtIn"\n` +
      `                dataType              = "${psDoubleQuoted(a.dataType)}"\n` +
      `            }`
    );
    attributesBlock = attrEntries.join(",\n");

    const inputEntries = policyContext.attributes.map(a =>
      `                        @{\n` +
      `                            attribute        = "${psDoubleQuoted(a.id)}"\n` +
      `                            label            = "${psDoubleQuoted(a.displayName)}"\n` +
      `                            inputType        = "text"\n` +
      `                            hidden           = ${a.id === "email" ? "$true" : "$false"}\n` +
      `                            editable         = ${a.id === "email" ? "$false" : "$true"}\n` +
      `                            writeToDirectory = $true\n` +
      `                            required         = ${a.required ? "$true" : "$false"}\n` +
      `                        }`
    );
    attributeInputsBlock = inputEntries.join(",\n");
  }

  // Build custom (extension) attribute config block from policy context
  let customAttributesBlock = "";
  if (policyContext && policyContext.customAttributes.length > 0) {
    customAttributesBlock = policyContext.customAttributes.map(a =>
      `    @{ name = "${psDoubleQuoted(a.name)}"; displayName = "${psDoubleQuoted(a.displayName)}"; dataType = "${psDoubleQuoted(a.dataType)}"; required = ${a.required ? "$true" : "$false"} }`
    ).join(",\n");
  }

  const content = substitute(raw, {
    POLICY_NAME: psDoubleQuoted(policyName),
    GENERATED_AT: psDoubleQuoted(generatedAt),
    TENANT_ID: psDoubleQuoted(config.tenantId),
    APP_NAME: psDoubleQuoted(config.appName),
    BUNDLE_ID: psDoubleQuoted(config.bundleId),
    FLOW_NAME: psDoubleQuoted(config.flowName),
    FLOW_DESCRIPTION: psDoubleQuoted(config.flowDescription),
    GOOGLE_CLIENT_ID: psDoubleQuoted(config.googleClientId),
    GOOGLE_CLIENT_SECRET: psDoubleQuoted(config.googleClientSecret),
    GOOGLE_IDP_DISPLAY_NAME: psDoubleQuoted(config.googleIdpDisplayName),
    FACEBOOK_APP_ID: psDoubleQuoted(config.facebookAppId),
    FACEBOOK_APP_SECRET: psDoubleQuoted(config.facebookAppSecret),
    FACEBOOK_IDP_DISPLAY_NAME: psDoubleQuoted(config.facebookIdpDisplayName),
    CA_RESOURCE_APP_ID: psDoubleQuoted(config.caResourceAppId),
    CLAIMS_SCHEMA_BLOCK: claimsSchemaBlock,
    ATTRIBUTES_BLOCK: attributesBlock,
    ATTRIBUTE_INPUTS_BLOCK: attributeInputsBlock,
    CUSTOM_ATTRIBUTES_BLOCK: customAttributesBlock,
    NEXT_STEP: psDoubleQuoted(nextFilename
      ? `Continue with: pwsh ./${nextFilename}`
      : "All scripts in this package have been run. See README.md for validation steps."),
  });
  return { filename: tpl.filename, content };
}

/**
 * Collect and dedup all StepKinds requested by mapped features.
 * Preserves first-seen order so output filenames stay 01, 02, 03... in sequence.
 */
function collectSteps(results: MappingResult[]): { kind: StepKind; reasons: string[] }[] {
  const order: StepKind[] = [];
  const reasons = new Map<StepKind, string[]>();

  for (const result of results) {
    for (const step of result.steps) {
      if (!reasons.has(step.kind)) {
        order.push(step.kind);
        reasons.set(step.kind, []);
      }
      reasons.get(step.kind)!.push(`${result.featureName}: ${step.reason}`);
    }
  }

  return order.map((kind) => ({ kind, reasons: reasons.get(kind)! }));
}

/**
 * Inject the create-custom-attributes step right after the user-flow step when the
 * policy collected true custom (extension) attributes at sign-up. The step is
 * injected here (not by a feature mapper) so it does not affect coverage
 * classification and never disturbs the working built-in attribute path.
 * Returns the list unchanged when there are no custom attributes, when the
 * user-flow step is absent, or when the step is already present.
 */
export function injectCustomAttributeStep(kinds: StepKind[], context?: PolicyContext): StepKind[] {
  if (!context || context.customAttributes.length === 0) return kinds;
  if (kinds.includes("create-custom-attributes")) return kinds;
  const flowIndex = kinds.indexOf("create-user-flow-emailpassword");
  if (flowIndex === -1) return kinds;
  const result = [...kinds];
  result.splice(flowIndex + 1, 0, "create-custom-attributes");
  return result;
}

function generateGapEntry(gap: GapEntry): string {
  let md = `### ${gap.feature}\n\n`;
  md += `**Why can't this be automated?**\n${gap.reason}\n\n`;
  md += `**Recommendation:**\n${gap.recommendation}\n\n`;
  md += `**Estimated Effort:** ${gap.effort}\n\n`;
  if (gap.workaround) {
    md += `**Workaround:**\n${gap.workaround}\n\n`;
  }
  const rec = manualRecreationSteps(gap.feature, gap.reason, gap.recommendation);
  md += `**How to recreate this manually in External ID** ${rec.recreatable ? "" : "(no direct equivalent)"}\n`;
  md += `${rec.note}\n\n`;
  rec.steps.forEach((s, i) => { md += `${i + 1}. ${s}\n`; });
  md += `\n---\n\n`;
  return md;
}

function generateReadme(
  policyName: string,
  config: TenantConfig,
  scripts: { filename: string; content: string }[],
  gaps: GapEntry[],
): string {
  const hasGoogleStep = scripts.some((s) => s.filename === "04-add-google-idp.ps1");
  const hasFacebookStep = scripts.some((s) => s.filename === "05-add-facebook-idp.ps1");
  const hasEmailOtpStep = scripts.some((s) => s.filename === "07-enable-email-otp.ps1");
  const hasSmsStep = scripts.some((s) => s.filename === "11-enable-sms-mfa.ps1");
  const hasCaStep = scripts.some((s) => s.filename === "12-create-ca-policy.ps1");
  const hasPasskeyStep = scripts.some((s) => s.filename === "13-enable-passkey.ps1");
  const hasClaimsMappingStep = scripts.some((s) => s.filename === "08-claims-mapping-policy.ps1");
  const hasCustomAttrsStep = scripts.some((s) => s.filename === "14-create-custom-attributes.ps1");

  let md = `# Migration Package — ${policyName}\n\n`;
  md += `Generated by Policy Translator on ${new Date().toISOString().split("T")[0]}\n\n`;

  md += `## What's in this package\n\n`;
  md += `| # | Script | What it does |\n`;
  md += `|---|--------|-------------|\n`;
  for (let i = 0; i < scripts.length; i++) {
    md += `| ${i + 1} | \`${scripts[i]!.filename}\` | Run in order |\n`;
  }
  if (gaps.length > 0) {
    md += `| — | \`gap-report.md\` | Features needing manual config or custom code |\n`;
  }

  md += `\n## Prerequisites\n\n`;
  md += `1. PowerShell 7+ (\`pwsh\`).\n`;
  md += `2. Microsoft Graph PowerShell SDK:\n`;
  md += `   \`\`\`powershell\n`;
  md += `   Install-Module Microsoft.Graph -Scope CurrentUser\n`;
  md += `   \`\`\`\n`;
  md += `3. Caller must have these roles in the target tenant:\n`;
  md += `   - Application Administrator (for script 01)\n`;
  md += `   - External ID User Flow Administrator (for script 02)\n`;
  if (hasGoogleStep) {
    md += `   - External Identity Provider Administrator (for script 04)\n`;
  }
  if (hasFacebookStep) {
    md += `   - External Identity Provider Administrator (for script 05)\n`;
  }
  if (hasEmailOtpStep) {
    md += `   - Authentication Policy Administrator (for script 07)\n`;
  }
  if (hasSmsStep) {
    md += `   - Authentication Policy Administrator (for script 11)\n`;
  }
  if (hasCaStep) {
    md += `   - Conditional Access Administrator or Security Administrator (for script 12)\n`;
  }
  if (hasPasskeyStep) {
    md += `   - Authentication Policy Administrator (for script 13)\n`;
  }
  if (hasClaimsMappingStep) {
    md += `   - Application Administrator (for script 08)\n`;
  }
  if (hasCustomAttrsStep) {
    md += `   - External ID User Flow Administrator (for script 14)\n`;
  }
  md += `\n`;

  if (hasGoogleStep) {
    md += `## Google IdP — extra one-time setup (before running script 04)\n\n`;
    md += `You'll need a Google OAuth client to point External ID at. Setup is in Google Cloud Console, not Microsoft's:\n\n`;
    md += `1. https://console.cloud.google.com → create or pick a project\n`;
    md += `2. **APIs & Services → OAuth consent screen** — pick **External**, fill app name + your email\n`;
    md += `3. **Authorized domains:** add \`ciamlogin.com\` and \`microsoftonline.com\`\n`;
    md += `4. **Credentials → Create credentials → OAuth client ID → Web application**\n`;
    md += `5. **Run script 04 ONCE with the placeholder values** — it'll print the 7 redirect URIs your OAuth client needs (computed from your tenant id), then exit safely\n`;
    md += `6. Paste those 7 URIs into Google Cloud Console → your OAuth client → Authorized redirect URIs → Save\n`;
    md += `7. Copy the **Client ID** and **Client Secret** Google gives you → paste into the CONFIG block at the top of \`04-add-google-idp.ps1\`\n`;
    md += `8. Re-run script 04 — it will create the IdP and bind it to your user flow\n\n`;
    md += `> **Why we can't auto-extract the Client Secret:** B2C stores social IdP secrets encrypted in the policy keystore. Even Global Admins can't read them back via Graph. Re-entering is the only path — and it's the right pattern, because the secret never leaves your machine.\n\n`;
  }

  if (hasFacebookStep) {
    md += `## Facebook IdP — extra one-time setup (before running script 05)\n\n`;
    md += `You'll need a Facebook app to point External ID at. Setup is in Facebook Developer Console:\n\n`;
    md += `1. https://developers.facebook.com → create app (type: **Consumer**)\n`;
    md += `2. Add the **Facebook Login** product\n`;
    md += `3. **Settings → Basic** → record the **App ID** and **App Secret**\n`;
    md += `4. **Facebook Login → Settings → Valid OAuth Redirect URIs:**\n`;
    md += `   - \`https://login.microsoftonline.com/common/oauth2/nativeclient\`\n`;
    md += `   - \`https://<tenant-subdomain>.ciamlogin.com\`\n`;
    md += `5. Paste App ID and App Secret into the CONFIG block at the top of \`05-add-facebook-idp.ps1\`\n`;
    md += `6. Run script 05 — it will create the IdP and bind it to your user flow\n\n`;
  }

  if (hasCaStep) {
    md += `## Conditional Access resource target (before running script 12)\n\n`;
    md += `Conditional Access evaluates the **protected resource/API**, not a public/native client by default. Set \`$caResourceAppId\` in \`12-create-ca-policy.ps1\` to the application ID of the resource whose token access should require MFA. The script refuses to guess and creates the policy in report-only mode.\n\n`;
  }

  md += `## Before running — edit the CONFIG block in script 01\n\n`;
  md += `\`\`\`powershell\n`;
  md += `$tenantId    = "${config.tenantId}"   # your External ID tenant id\n`;
  md += `$appName     = "${config.appName}"   # display name for the new app reg\n`;
  md += `$bundleId    = "${config.bundleId}"  # your mobile bundle id (com.contoso.app)\n`;
  md += `\`\`\`\n\n`;
  md += `Script 02 already chains from script 01 via \`.last-created-app.json\`. `;
  md += `If you want to rename the user flow, edit \`$flowName\` in script 02.\n\n`;

  md += `## How to run\n\n`;
  md += `**Step 0. Open a terminal inside this folder.** Every command below is relative to `;
  md += `this package folder, so PowerShell has to be running inside it. If you skip this, you `;
  md += `will get "The term './01-...' is not recognized". Two easy ways:\n\n`;
  md += `- In File Explorer, open the folder you extracted this package to. Then hold **Shift**, `;
  md += `right-click an empty area, and choose **Open in Terminal** (or "Open PowerShell window here"). `;
  md += `This starts PowerShell already in the right place, no typing needed.\n`;
  md += `- Or open PowerShell and change directory to wherever you extracted it. Replace the path `;
  md += `with your real one:\n\n`;
  md += `\`\`\`powershell\n`;
  md += `cd "C:\\Users\\<you>\\Downloads\\migration-package-${policyName}"\n`;
  md += `\`\`\`\n\n`;
  md += `Confirm you are in the right folder by running \`ls\`. You should see the \`.ps1\` files listed. \n\n`;
  md += `**Step 1. Run the scripts in order** in your own \`pwsh\` window (don't run from a subprocess — `;
  md += `WAM browser auth needs a real window handle, and \`-UseDeviceCode\` will cause a `;
  md += `dual-code issue):\n\n`;
  md += `\`\`\`powershell\n`;
  for (const s of scripts) {
    md += `./${s.filename}\n`;
  }
  md += `\`\`\`\n\n`;
  md += `Script 03 is a smoke test against the native auth \`/initiate\` endpoint with a `;
  md += `non-existent user. Expect \`PASS\` with \`user_not_found\` — that proves the app + `;
  md += `service principal + user flow + EmailPassword IdP are all wired correctly.\n\n`;

  md += `## What the customer's app needs to do next\n\n`;
  md += `This package only configures the **tenant side** (app reg + user flow). Your `;
  md += `application code uses MSAL's native auth API with three values from the scripts:\n`;
  md += `- **tenantId** (you provided it above)\n`;
  md += `- **clientId** (= app reg's \`appId\` — printed by script 01)\n`;
  md += `- **user flow name** (printed by script 02)\n\n`;
  md += `See https://learn.microsoft.com/entra/identity-platform/concept-native-authentication `;
  md += `for the MSAL native auth client setup.\n\n`;

  if (gaps.length > 0) {
    md += `## Manual steps required\n\n`;
    md += `${gaps.length} feature(s) cannot be fully automated by this package. `;
    md += `See \`gap-report.md\` for the list with recommendations.\n`;
  }

  return md;
}

/**
 * Produce the final migration package: scripts + gap report + README.
 */
export function generatePackage(
  policyName: string,
  results: MappingResult[],
  config: TenantConfig,
  policyContext?: PolicyContext,
): GeneratedOutput {
  const generatedAt = new Date().toISOString();

  const steps = collectSteps(results);
  const orderedKinds = injectCustomAttributeStep(steps.map(({ kind }) => kind), policyContext)
    .sort((a, b) => (STEP_ORDER_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER) - (STEP_ORDER_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER));
  const orderedFilenames = orderedKinds.map((kind) => STEP_TEMPLATES[kind].filename);
  const scripts = orderedKinds.map((kind, i) =>
    renderStep(kind, policyName, generatedAt, config, policyContext, orderedFilenames[i + 1]),
  );

  const gaps: GapEntry[] = [];
  for (const result of results) {
    if (result.gapReport) {
      gaps.push(result.gapReport);
    }
  }

  let gapReport: string | null = null;
  if (gaps.length > 0) {
    gapReport = `# Gap Report — ${policyName}\n\n`;
    gapReport += `These features require manual configuration or custom development.\n\n`;
    gapReport += `---\n\n`;
    for (const gap of gaps) {
      gapReport += generateGapEntry(gap);
    }
  }

  const readme = generateReadme(policyName, config, scripts, gaps);

  return { scripts, gapReport, readme };
}

// Re-export for callers that previously imported from this module.
export type { RequiredStep, StepKind, GapEntry, MappingResult };
