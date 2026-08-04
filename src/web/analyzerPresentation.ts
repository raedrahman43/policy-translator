import { classifyEmailOtpMode, MappingResult } from "../mappers/featureMap";
import { AnalysisFeature, ReadinessScore } from "../types";

export const STATUS_LABELS: Record<string, string> = {
  Available: "Supported",
  Partial: "Partially available",
  NeedsExtensions: "Needs custom extensions",
  DifferentApproach: "Different approach",
  OnRoadmap: "On roadmap",
  NotAvailable: "Not yet available",
  RequiresCustomDevelopment: "Custom development required",
  ArchitectureIncompatible: "Architecture redesign required",
  NotCurrentlySupported: "Not currently supported",
  NoAction: "No action required",
};

const FEATURE_CONTEXT_DESCRIPTIONS: Record<string, string> = {
  signIn_otp_email: "Email OTP - sign-in method; primary passwordless use requires explicit user-flow configuration",
  signUp_otp_email: "Email OTP - email verification during sign-up",
  signIn_otp_phoneSms: "SMS OTP - second-factor MFA during sign-in",
  passwordReset_recovery: "Self-service password reset - account recovery",
  global_token_externalClaims: "Custom token claims - emitted during token issuance",
  global_token_claimsMapping: "Claims mapping - application token contract",
  signUp_attributes_custom: "Custom attributes - collected and stored during sign-up",
};

export function buildReadiness(
  rawJson: unknown,
  features: AnalysisFeature[],
  featureView: Array<{ status: string }>,
) {
  const byStatus: Record<string, number> = {};
  for (const feature of features) {
    byStatus[feature.externalIdAvailability] = (byStatus[feature.externalIdAvailability] || 0) + 1;
  }
  const available = byStatus.Available || 0;
  const total = features.length;
  const readyCount = featureView.filter((feature) => ["Available", "NoAction"].includes(feature.status)).length;
  const percent = total > 0 ? Math.round((readyCount / total) * 100) : 0;
  const score: ReadinessScore = percent >= 70 ? "High" : percent >= 40 ? "Medium" : "Low";
  const summary = rawJson && typeof rawJson === "object"
    ? (rawJson as Record<string, unknown>).migrationSummary
    : undefined;
  const sourceScore = summary && typeof summary === "object"
    ? (summary as Record<string, unknown>).readinessScore
    : undefined;
  const analyzerScore: ReadinessScore | undefined =
    sourceScore === "High" || sourceScore === "Medium" || sourceScore === "Low"
      ? sourceScore
      : undefined;

  return {
    score,
    analyzerScore,
    percent,
    total,
    available,
    ready: readyCount,
    needsWork: total - readyCount,
    byStatus,
  };
}

export function buildFeatureView(
  features: AnalysisFeature[],
  mapped: MappingResult[],
  availableLabel = STATUS_LABELS.Available,
) {
  const mappingByFeature = new Map<string, MappingResult[]>();
  for (const result of mapped) {
    const existing = mappingByFeature.get(result.featureName) || [];
    existing.push(result);
    mappingByFeature.set(result.featureName, existing);
  }

  return features.map((feature) => {
    let mappings = mappingByFeature.get(feature.name) || [];
    if (feature.occurrence) {
      const occurrenceMappings = mappings.filter(
        (mapping) => mapping.featureOccurrence === feature.occurrence,
      );
      if (occurrenceMappings.length) mappings = occurrenceMappings;
    }
    if (feature.name === "signIn_otp_email" && mappings.length > 1) {
      const mode = classifyEmailOtpMode(feature);
      if (mode === "primary") {
        mappings = mappings.filter(
          (mapping) =>
            Boolean(mapping.gapReport) &&
            mapping.steps.some((step) => step.kind === "enable-email-otp") &&
            !mapping.steps.some((step) => step.kind === "create-user-flow-emailpassword"),
        );
      } else if (mode === "mfa") {
        mappings = mappings.filter((mapping) =>
          mapping.steps.some((step) => step.kind === "create-ca-policy"),
        );
      }
    }
    const hasGap = mappings.some((mapping) => Boolean(mapping.gapReport));
    const hasAutomatedPortion = mappings.some((mapping) => mapping.steps.length > 0);
    const gapReports = mappings
      .map((mapping) => mapping.gapReport)
      .filter((gap): gap is NonNullable<MappingResult["gapReport"]> => Boolean(gap));
    const validationOnly =
      gapReports.length > 0 &&
      gapReports.every((gap) => gap.followUpType === "validation");
    const allNoop = mappings.length > 0 && mappings.every((mapping) => mapping.category === "noop");
    let status: string = feature.externalIdAvailability;
    let statusLabel = status === "Available"
      ? availableLabel
      : (STATUS_LABELS[status] || status);
    const contextualGuidance = FEATURE_CONTEXT_DESCRIPTIONS[feature.name] || "";
    let guidance = [contextualGuidance, feature.notes].filter(Boolean).join(" ");
    const mappingAvailability = mappings
      .map((mapping) => mapping.gapReport?.availability)
      .find((availability) => availability && availability !== "Available");
    if (mappingAvailability) {
      status = mappingAvailability;
      statusLabel = STATUS_LABELS[mappingAvailability] || mappingAvailability;
    }

    if (feature.name === "global_ux_tenantBranding") {
      status = "Available";
      statusLabel = "Port 4001 automation; live validation required";
      guidance = "Import or customize Company Branding in the guided experience, then verify the hosted sign-in page.";
    } else if (allNoop) {
      status = "NoAction";
      statusLabel = STATUS_LABELS.NoAction;
      const noopReason = mappings.map((mapping) => mapping.noopReason).find(Boolean);
      guidance = noopReason || guidance;
    } else if (!mappingAvailability && validationOnly && hasAutomatedPortion) {
      status = "Available";
      statusLabel = "Automated; live validation required";
      guidance = [
        guidance,
        ...gapReports.map((gap) => gap.recommendation),
      ].filter(Boolean).join(" ");
    } else if (!mappingAvailability && hasGap && hasAutomatedPortion) {
      status = "Partial";
      statusLabel = "Partial automation";
    } else if (!mappingAvailability && hasGap && feature.externalIdAvailability === "Available") {
      status = "DifferentApproach";
      statusLabel = "Manual configuration";
    }

    return {
      name: feature.name,
      occurrence: feature.occurrence,
      description: feature.description || contextualGuidance,
      status,
      statusLabel,
      externalIdAvailability: feature.externalIdAvailability,
      guidance,
      ...(feature.docLink ? { docLink: feature.docLink } : {}),
    };
  });
}
