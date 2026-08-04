/**
 * Input Validator & Normalizer
 *
 * Makes the translator deterministic and robust for end users (no AI in loop).
 * Validates Analyzer JSON on entry, normalizes inconsistencies, and fails loud
 * with actionable error messages when structure is wrong.
 *
 * Three layers:
 *   1. Schema validation — required fields, correct types
 *   2. Normalization — canonicalize feature keys, availability statuses
 *   3. Graceful degradation — unknown features warn, don't crash
 */

import { AnalysisFeature, ExternalIdAvailability } from "../types";

// ─── Validation Result ──────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  valid: boolean;
  policyName: string;
  features: AnalysisFeature[];
  errors: ValidationError[];
  warnings: ValidationError[];
  normalized: boolean; // true if any values were auto-corrected
}

// ─── Status Synonyms ────────────────────────────────────────────────────────
// The 166-feature doc uses different status names than the Analyzer output.
// This maps all known synonyms to the canonical ExternalIdAvailability values.

const STATUS_SYNONYMS: Record<string, ExternalIdAvailability> = {
  // Canonical values (already correct)
  "available": "Available",
  "onroadmap": "OnRoadmap",
  "needsextensions": "NeedsExtensions",
  "notavailable": "NotAvailable",
  "differentapproach": "DifferentApproach",
  "partial": "Partial",
  "requirescustomdevelopment": "RequiresCustomDevelopment",
  "requires custom development": "RequiresCustomDevelopment",
  "architectureincompatible": "ArchitectureIncompatible",
  "architecture incompatible": "ArchitectureIncompatible",
  "notcurrentlysupported": "NotCurrentlySupported",
  "not currently supported": "NotCurrentlySupported",

  // Synonyms from the 166-feature tracking doc
  "ready to migrate": "Available",
  "readytomigrate": "Available",
  "alternative path available": "NeedsExtensions",
  "alternativepathavailable": "NeedsExtensions",
  "partially available": "Partial",
  "partiallyavailable": "Partial",
  "different approach": "DifferentApproach",
  "not yet available": "NotAvailable",
  "notyetavailable": "NotAvailable",
  "on roadmap": "OnRoadmap",

  // Common typos / casing variants
  "partiallysupported": "Partial",
  "blocked": "NotAvailable",
  "notavailableyet": "NotAvailable",
  "roadmap": "OnRoadmap",
};

// ─── Feature Key Pattern ────────────────────────────────────────────────────
// Valid feature keys follow: category_subcategory_method (e.g., signIn_idp_google)
const FEATURE_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*_[a-zA-Z0-9]+_[a-zA-Z0-9]+$/;

// Known category prefixes from the 166-feature doc
const KNOWN_CATEGORIES = [
  "signUp", "signIn", "global", "passwordReset", "profileEdit", "invitation",
];

// ─── Core Validation ────────────────────────────────────────────────────────

/**
 * Validate and normalize raw Analyzer JSON input.
 * Call this BEFORE any feature mapping or context extraction.
 */
export function validateAndNormalize(raw: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  let normalized = false;

  // --- Layer 1: Structure check ---
  if (raw === null || raw === undefined) {
    return fail("root", "Input is null or undefined. Expected Analyzer JSON object.");
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return fail("root", "Input must be a JSON object with policyName and features fields.");
  }

  const obj = raw as Record<string, unknown>;

  // Check policyName
  if (!obj.policyName) {
    errors.push({ field: "policyName", message: "Missing required field 'policyName'.", severity: "error" });
  } else if (typeof obj.policyName !== "string") {
    errors.push({ field: "policyName", message: `'policyName' must be a string, got ${typeof obj.policyName}.`, severity: "error" });
  } else if (obj.policyName.trim().length === 0) {
    errors.push({ field: "policyName", message: "'policyName' cannot be empty.", severity: "error" });
  }

  // Check features array
  if (!obj.features) {
    errors.push({ field: "features", message: "Missing required field 'features'. Expected an array of feature objects.", severity: "error" });
  } else if (!Array.isArray(obj.features)) {
    errors.push({ field: "features", message: `'features' must be an array, got ${typeof obj.features}.`, severity: "error" });
  } else if (obj.features.length === 0) {
    errors.push({ field: "features", message: "'features' array is empty. The Analyzer should detect at least one feature.", severity: "error" });
  }

  // If structural errors, bail early
  if (errors.length > 0) {
    return {
      valid: false,
      policyName: (typeof obj.policyName === "string" ? obj.policyName : ""),
      features: [],
      errors,
      warnings,
      normalized: false,
    };
  }

  const policyName = (obj.policyName as string).trim();
  const rawFeatures = obj.features as unknown[];

  // --- Layer 2: Feature-level validation + normalization ---
  const validFeatures: AnalysisFeature[] = [];

  for (let i = 0; i < rawFeatures.length; i++) {
    const f = rawFeatures[i];
    const prefix = `features[${i}]`;

    if (f === null || f === undefined || typeof f !== "object" || Array.isArray(f)) {
      errors.push({ field: prefix, message: `Feature at index ${i} is not a valid object.`, severity: "error" });
      continue;
    }

    const feat = f as Record<string, unknown>;

    // Required: name
    if (!feat.name || typeof feat.name !== "string") {
      errors.push({ field: `${prefix}.name`, message: `Feature at index ${i} missing 'name' (string).`, severity: "error" });
      continue;
    }

    // Required: externalIdAvailability
    if (!feat.externalIdAvailability && !feat.migrationStatus && !feat.status) {
      errors.push({
        field: `${prefix}.externalIdAvailability`,
        message: `Feature "${feat.name}" missing availability status. Expected 'externalIdAvailability', 'migrationStatus', or 'status' field.`,
        severity: "error",
      });
      continue;
    }

    // Normalize feature key
    let featureKey = normalizeFeatureKey(feat.name as string);
    if (featureKey !== feat.name) {
      warnings.push({
        field: `${prefix}.name`,
        message: `Feature key normalized: "${feat.name}" → "${featureKey}"`,
        severity: "warning",
      });
      normalized = true;
    }

    // Validate feature key pattern
    if (!FEATURE_KEY_PATTERN.test(featureKey)) {
      warnings.push({
        field: `${prefix}.name`,
        message: `Feature key "${featureKey}" doesn't match expected pattern (category_subcategory_method). It will still be processed.`,
        severity: "warning",
      });
    }

    // Normalize availability status
    const rawStatus = (feat.externalIdAvailability || feat.migrationStatus || feat.status) as string;
    const normalizedStatus = normalizeAvailability(rawStatus);

    if (!normalizedStatus) {
      warnings.push({
        field: `${prefix}.externalIdAvailability`,
        message: `Unknown availability status "${rawStatus}" for feature "${featureKey}". Defaulting to "NeedsExtensions".`,
        severity: "warning",
      });
    }

    if (normalizedStatus && rawStatus !== normalizedStatus) {
      normalized = true;
    }

    // Build the validated feature
    const validFeature: AnalysisFeature = {
      name: featureKey,
      reason: typeof feat.reason === "string" ? feat.reason : "(no reason provided)",
      recommendation: typeof feat.recommendation === "string" ? feat.recommendation : "(no recommendation)",
      externalIdAvailability: normalizedStatus || "NeedsExtensions",
    };
    if (typeof feat.description === "string") {
      validFeature.description = feat.description;
    }
    if (typeof feat.notes === "string" && feat.notes.trim()) {
      validFeature.notes = feat.notes.trim();
    }
    if (typeof feat.docLink === "string" && feat.docLink.trim()) {
      const docLink = normalizeDocumentationLink(feat.docLink);
      if (docLink) {
        validFeature.docLink = docLink;
      } else {
        warnings.push({
          field: `${prefix}.docLink`,
          message: `Documentation link for "${featureKey}" must use HTTPS and point to learn.microsoft.com or aka.ms. The link was ignored.`,
          severity: "warning",
        });
      }
    }

    // Warn on missing optional fields
    if (!feat.reason) {
      warnings.push({
        field: `${prefix}.reason`,
        message: `Feature "${featureKey}" has no 'reason' field. Context extraction may be less accurate.`,
        severity: "warning",
      });
    }

    validFeatures.push(validFeature);
  }

  // --- Layer 3: Cross-feature checks ---
  const featureNames = validFeatures.map(f => f.name);
  const duplicates = featureNames.filter((name, idx) => featureNames.indexOf(name) !== idx);
  if (duplicates.length > 0) {
    const uniqueDups = [...new Set(duplicates)];
    for (const duplicateName of uniqueDups) {
      let occurrence = 0;
      for (const feature of validFeatures) {
        if (feature.name === duplicateName) {
          occurrence++;
          feature.occurrence = occurrence;
        }
      }
    }
    warnings.push({
      field: "features",
      message: `Duplicate feature keys detected: ${uniqueDups.join(", ")}. Every occurrence will be evaluated because the same key can represent different journey contexts.`,
      severity: "warning",
    });
  }

  return {
    valid: errors.length === 0,
    policyName,
    features: validFeatures,
    errors,
    warnings,
    normalized,
  };
}

// ─── Normalization Helpers ──────────────────────────────────────────────────

/**
 * Normalize a feature key to canonical form.
 * - Trims whitespace
 * - Handles common formatting issues (extra spaces, wrong separators)
 */
function normalizeFeatureKey(key: string): string {
  let normalized = key.trim();

  // Replace dashes or spaces with underscores (common copy-paste issue)
  normalized = normalized.replace(/[\s-]+/g, "_");

  // Remove any non-alphanumeric/underscore characters
  normalized = normalized.replace(/[^a-zA-Z0-9_]/g, "");

  // Ensure first char of each segment maintains original casing (camelCase convention)
  // e.g., "signup_auth_emailPassword" → "signUp_auth_emailPassword"
  normalized = normalized
    .replace(/^signup_/i, "signUp_")
    .replace(/^signin_/i, "signIn_")
    .replace(/^passwordreset_/i, "passwordReset_")
    .replace(/^profileedit_/i, "profileEdit_")
    .replace(/^global_/, "global_");

  return normalized;
}

/**
 * Normalize availability status to canonical ExternalIdAvailability.
 * Returns null if unrecognized (caller should default + warn).
 */
function normalizeAvailability(status: string): ExternalIdAvailability | null {
  if (!status) return null;

  const trimmed = status.trim();

  // Direct match (already canonical)
  const canonical: ExternalIdAvailability[] = [
    "Available", "OnRoadmap", "NeedsExtensions", "NotAvailable", "DifferentApproach", "Partial",
    "RequiresCustomDevelopment", "ArchitectureIncompatible", "NotCurrentlySupported",
  ];
  if (canonical.includes(trimmed as ExternalIdAvailability)) {
    return trimmed as ExternalIdAvailability;
  }

  // Lookup in synonyms (case-insensitive)
  const lower = trimmed.toLowerCase();
  if (STATUS_SYNONYMS[lower]) {
    return STATUS_SYNONYMS[lower];
  }

  // Fuzzy match: check if the status contains a known keyword
  if (lower.includes("available") && !lower.includes("not")) return "Available";
  if (lower.includes("requirescustomdevelopment") || (lower.includes("custom") && lower.includes("development"))) {
    return "RequiresCustomDevelopment";
  }
  if (lower.includes("architectureincompatible") || (lower.includes("architecture") && lower.includes("incompatible"))) {
    return "ArchitectureIncompatible";
  }
  if (lower.includes("notcurrentlysupported") || (lower.includes("not") && lower.includes("currently") && lower.includes("supported"))) {
    return "NotCurrentlySupported";
  }
  if (lower.includes("roadmap")) return "OnRoadmap";
  if (lower.includes("partial")) return "Partial";
  if (lower.includes("different")) return "DifferentApproach";
  if (lower.includes("not") && lower.includes("available")) return "NotAvailable";
  if (lower.includes("extension") || lower.includes("alternative")) return "NeedsExtensions";

  return null;
}

function normalizeDocumentationLink(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "learn.microsoft.com" && host !== "aka.ms")) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

// ─── Helper ─────────────────────────────────────────────────────────────────

function fail(field: string, message: string): ValidationResult {
  return {
    valid: false,
    policyName: "",
    features: [],
    errors: [{ field, message, severity: "error" }],
    warnings: [],
    normalized: false,
  };
}

// ─── Convenience: Print validation report ───────────────────────────────────

export function printValidationReport(result: ValidationResult): void {
  if (result.valid) {
    console.log(`✅ Input validation passed (${result.features.length} features)`);
    if (result.normalized) {
      console.log(`   ℹ️  Some values were auto-normalized`);
    }
    if (result.warnings.length > 0) {
      console.log(`   ⚠️  ${result.warnings.length} warning(s):`);
      for (const w of result.warnings.slice(0, 5)) {
        console.log(`      - [${w.field}] ${w.message}`);
      }
      if (result.warnings.length > 5) {
        console.log(`      ... and ${result.warnings.length - 5} more`);
      }
    }
  } else {
    console.error(`❌ Input validation FAILED:`);
    for (const e of result.errors) {
      console.error(`   ERROR [${e.field}]: ${e.message}`);
    }
    if (result.warnings.length > 0) {
      for (const w of result.warnings) {
        console.warn(`   WARN  [${w.field}]: ${w.message}`);
      }
    }
    console.error(`\n   Fix the errors above and re-run. The Analyzer JSON must have:`);
    console.error(`   - "policyName": string (the B2C policy name)`);
    console.error(`   - "features": array of { name, externalIdAvailability, reason, recommendation }`);
  }
}
