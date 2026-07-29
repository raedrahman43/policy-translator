import { MappingResult } from "../mappers/featureMap";
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

export function buildReadiness(rawJson: unknown, features: AnalysisFeature[]) {
  const byStatus: Record<string, number> = {};
  for (const feature of features) {
    byStatus[feature.externalIdAvailability] = (byStatus[feature.externalIdAvailability] || 0) + 1;
  }
  const available = byStatus.Available || 0;
  const total = features.length;
  const percent = total > 0 ? Math.round((available / total) * 100) : 0;
  const computedScore: ReadinessScore = percent >= 70 ? "High" : percent >= 40 ? "Medium" : "Low";
  const summary = rawJson && typeof rawJson === "object"
    ? (rawJson as Record<string, unknown>).migrationSummary
    : undefined;
  const sourceScore = summary && typeof summary === "object"
    ? (summary as Record<string, unknown>).readinessScore
    : undefined;
  const score: ReadinessScore =
    sourceScore === "High" || sourceScore === "Medium" || sourceScore === "Low"
      ? sourceScore
      : computedScore;

  return {
    score,
    percent,
    total,
    available,
    needsWork: total - available,
    byStatus,
  };
}

export function buildFeatureView(
  features: AnalysisFeature[],
  mapped: MappingResult[],
  availableLabel = STATUS_LABELS.Available,
) {
  const mappingByFeature = new Map(mapped.map((result) => [result.featureName, result]));

  return features.map((feature) => {
    const mapping = mappingByFeature.get(feature.name);
    const hasGap = Boolean(mapping?.gapReport);
    const hasAutomatedPortion = Boolean(mapping?.steps.length);
    let status: string = feature.externalIdAvailability;
    let statusLabel = status === "Available"
      ? availableLabel
      : (STATUS_LABELS[status] || status);
    let guidance = feature.notes || "";

    if (mapping?.category === "noop") {
      status = "NoAction";
      statusLabel = STATUS_LABELS.NoAction;
      guidance = mapping.noopReason || guidance;
    } else if (hasGap && hasAutomatedPortion) {
      status = "Partial";
      statusLabel = "Partial automation";
    } else if (hasGap && feature.externalIdAvailability === "Available") {
      status = "DifferentApproach";
      statusLabel = "Manual configuration";
    }

    return {
      name: feature.name,
      description: feature.description || "",
      status,
      statusLabel,
      externalIdAvailability: feature.externalIdAvailability,
      guidance,
      ...(feature.docLink ? { docLink: feature.docLink } : {}),
    };
  });
}
