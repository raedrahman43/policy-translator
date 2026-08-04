import fs from "fs";
import path from "path";

import { filenameForStep } from "../generators/scriptGenerator";
import { mapFeatureToExternalId, StepKind } from "../mappers/featureMap";
import { AnalysisFeature } from "../types";

type Bucket =
  | "Automated"
  | "Guided manual"
  | "Not currently supported"
  | "Architecture redesign"
  | "No generated action"
  | "Unaccounted";
type Verification =
  | "Live verified"
  | "Automated; live validation required"
  | "Partial automation with required follow-up"
  | "Manual"
  | "Not currently supported"
  | "Architecture redesign"
  | "Platform/default behavior";

interface DashboardRow {
  feature: string;
  bucket: Bucket;
  steps: string[];
  scripts: string[];
  verification: Verification;
  note: string;
}

const WEB_ONLY_AUTOMATION: Record<string, Omit<DashboardRow, "feature">> = {
  global_ux_tenantBranding: {
    bucket: "Automated",
    steps: ["migrate-company-branding"],
    scripts: ["Port 4001 Graph apply"],
    verification: "Automated; live validation required",
    note: "The guided port-4001 workflow can import, preview, and write Company Branding.",
  },
};

const VERIFICATION: Record<StepKind, Verification> = {
  "create-native-app": "Live verified",
  "create-user-flow-emailpassword": "Live verified",
  "smoke-test-native-auth": "Live verified",
  "add-google-idp": "Automated; live validation required",
  "add-facebook-idp": "Automated; live validation required",
  "enable-email-otp": "Live verified",
  "enable-sms-mfa": "Partial automation with required follow-up",
  "create-ca-policy": "Partial automation with required follow-up",
  "enable-passkey": "Partial automation with required follow-up",
  "claims-mapping-policy": "Automated; live validation required",
  "enable-sspr": "Automated; live validation required",
  "create-custom-attributes": "Automated; live validation required",
};

const VERIFICATION_RANK: Record<Verification, number> = {
  "Live verified": 0,
  "Platform/default behavior": 0,
  "Automated; live validation required": 1,
  "Partial automation with required follow-up": 2,
  Manual: 3,
  "Not currently supported": 4,
  "Architecture redesign": 5,
};

function syntheticFeature(name: string): AnalysisFeature {
  return {
    name,
    description: `${name} coverage entry`,
    reason: `${name} detected`,
    recommendation: "Follow the documented External ID migration path.",
    externalIdAvailability: "Available",
  };
}

function weakestVerification(steps: StepKind[]): Verification {
  return steps
    .map((step) => VERIFICATION[step])
    .sort((a, b) => VERIFICATION_RANK[b] - VERIFICATION_RANK[a])[0] || "Manual";
}

function classify(feature: string): DashboardRow {
  const webOnly = WEB_ONLY_AUTOMATION[feature];
  if (webOnly) return { feature, ...webOnly };
  if (feature === "signIn_otp_email") {
    const kinds: StepKind[] = [
      "create-native-app",
      "enable-email-otp",
    ];
    return {
      feature,
      bucket: "Automated",
      steps: kinds,
      scripts: kinds.map(filenameForStep),
      verification: "Partial automation with required follow-up",
      note: "Context-dependent coverage: the tenant Email OTP method is automated. Primary passwordless Email OTP still requires explicit user-flow configuration, while MFA enforcement requires a scoped report-only Conditional Access design and validation.",
    };
  }
  const result = mapFeatureToExternalId(syntheticFeature(feature));
  if (!result) {
    return {
      feature,
      bucket: "Unaccounted",
      steps: [],
      scripts: [],
      verification: "Manual",
      note: "No mapper, gap entry, or no-action classification exists.",
    };
  }
  if (result.steps.length) {
    const kinds = [...new Set(result.steps.map((step) => step.kind))];
    return {
      feature,
      bucket: "Automated",
      steps: kinds,
      scripts: kinds.map(filenameForStep),
      verification: result.gapReport?.followUpType === "validation"
        ? "Automated; live validation required"
        : result.gapReport
          ? "Partial automation with required follow-up"
          : weakestVerification(kinds),
      note: [
        result.steps.map((step) => step.reason).join("; "),
        result.gapReport?.recommendation,
      ].filter(Boolean).join("; "),
    };
  }
  if (result.gapReport || result.category === "gap") {
    if (result.gapReport?.availability === "NotCurrentlySupported") {
      return {
        feature,
        bucket: "Not currently supported",
        steps: [],
        scripts: [],
        verification: "Not currently supported",
        note: result.gapReport.recommendation,
      };
    }
    if (result.gapReport?.availability === "ArchitectureIncompatible") {
      return {
        feature,
        bucket: "Architecture redesign",
        steps: [],
        scripts: [],
        verification: "Architecture redesign",
        note: result.gapReport.recommendation,
      };
    }
    return {
      feature,
      bucket: "Guided manual",
      steps: [],
      scripts: [],
      verification: "Manual",
      note: result.gapReport?.recommendation || "Manual migration guidance is generated.",
    };
  }
  if (result.category === "noop") {
    return {
      feature,
      bucket: "No generated action",
      steps: [],
      scripts: [],
      verification: "Platform/default behavior",
      note: result.noopReason || "External ID handles this without a generated action.",
    };
  }
  return {
    feature,
    bucket: "Unaccounted",
    steps: [],
    scripts: [],
    verification: "Manual",
    note: "Unexpected mapping classification.",
  };
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function main(): void {
  const root = path.join(__dirname, "..", "..");
  const featureKeysPath = path.join(__dirname, "..", "test", "analyzer-feature-keys.json");
  const docsDir = path.join(root, "docs");
  const keys = JSON.parse(fs.readFileSync(featureKeysPath, "utf8").replace(/^\uFEFF/, "")) as string[];
  const originalWarn = console.warn;
  console.warn = () => {};
  let rows: DashboardRow[];
  try {
    rows = [...new Set(keys)].sort().map(classify);
  } finally {
    console.warn = originalWarn;
  }
  const counts = {
    automated: rows.filter((row) => row.bucket === "Automated").length,
    guidedManual: rows.filter((row) => row.bucket === "Guided manual").length,
    notCurrentlySupported: rows.filter((row) => row.bucket === "Not currently supported").length,
    architectureRedesign: rows.filter((row) => row.bucket === "Architecture redesign").length,
    noGeneratedAction: rows.filter((row) => row.bucket === "No generated action").length,
    unaccounted: rows.filter((row) => row.bucket === "Unaccounted").length,
    total: rows.length,
  };

  const md = [
    "# Feature coverage dashboard",
    "",
    "> Generated by `npm run docs:features`. Do not edit this file by hand.",
    "",
    "This dashboard tracks every Policy Analyzer feature key known to the repository. A pull request that adds or changes a mapper automatically changes this report.",
    "",
    "```mermaid",
    "pie showData",
    `  \"Automated\" : ${counts.automated}`,
    `  \"Guided manual\" : ${counts.guidedManual}`,
    `  \"Not currently supported\" : ${counts.notCurrentlySupported}`,
    `  \"Architecture redesign\" : ${counts.architectureRedesign}`,
    `  \"No generated action\" : ${counts.noGeneratedAction}`,
    `  \"Unaccounted\" : ${counts.unaccounted}`,
    "```",
    "",
    "| Metric | Count |",
    "| --- | ---: |",
    `| Total Analyzer feature keys | ${counts.total} |`,
    `| Automated | ${counts.automated} |`,
    `| Guided manual | ${counts.guidedManual} |`,
    `| Not currently supported | ${counts.notCurrentlySupported} |`,
    `| Architecture redesign | ${counts.architectureRedesign} |`,
    `| No generated action | ${counts.noGeneratedAction} |`,
    `| Unaccounted | ${counts.unaccounted} |`,
    "",
    "## Feature details",
    "",
    "| Analyzer feature | Migration path | Verification | Generated action | Notes |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((row) =>
      `| \`${escapeCell(row.feature)}\` | ${row.bucket} | ${row.verification} | ${row.scripts.length ? row.scripts.map((file) => `\`${file}\``).join(", ") : "—"} | ${escapeCell(row.note)} |`
    ),
    "",
    "## Interpreting verification",
    "",
    "- **Live verified:** exercised against an External ID test tenant.",
    "- **Automated; live validation required:** implemented using documented APIs and covered by deterministic/mocked tests, but the final tenant/provider behavior must be verified.",
    "- **Partial automation with required follow-up:** the tool configures the safe automated portion and emits explicit follow-up steps.",
    "- **Guided manual:** the platform supports a path, but the tool does not claim an automated write.",
    "- **Not currently supported:** External ID has no current supported equivalent for the detected capability.",
    "- **Architecture redesign:** the source pattern has no direct External ID equivalent and requires an explicit target design.",
    "- **No generated action:** External ID handles the behavior by default or outside the script package.",
    "",
  ].join("\n");

  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, "FEATURE-MATRIX.md"), md, "utf8");
  fs.writeFileSync(
    path.join(docsDir, "feature-coverage.json"),
    `${JSON.stringify({ counts, rows }, null, 2)}\n`,
    "utf8",
  );

  if (counts.unaccounted > 0) {
    console.error(`Feature dashboard has ${counts.unaccounted} unaccounted feature(s).`);
    process.exit(1);
  }
  console.log(`Feature dashboard generated: ${counts.total} features, ${counts.automated} automated, 0 unaccounted.`);
}

main();
