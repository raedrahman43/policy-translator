/**
 * Types for the Policy Translator.
 * Derived from REAL Policy Analyzer output (May 2026).
 */

// The availability states from the Analyzer
export type ExternalIdAvailability =
  | "Available"
  | "OnRoadmap"
  | "NeedsExtensions"
  | "NotAvailable"
  | "DifferentApproach"
  | "Partial"
  | "RequiresCustomDevelopment"
  | "ArchitectureIncompatible"
  | "NotCurrentlySupported";

export type ReadinessScore = "High" | "Medium" | "Low";

export interface AnalysisFeature {
  name: string;
  description?: string;
  reason: string;
  recommendation: string;
  externalIdAvailability: ExternalIdAvailability;
  notes?: string;
  docLink?: string;
}

export interface MigrationSummary {
  readinessScore: ReadinessScore;
  totalFeaturesDetected: number;
  availableInExternalId?: number;
  available?: number;
  onRoadmap?: number;
  needsExtensions?: number;
  requiresCustomDevelopment?: number;
  notCurrentlySupported?: number;
  architectureIncompatible?: number;
  migrationBlockers: string[];
  migrationWarnings: string[];
  quickWins: string[];
  overallRecommendation: string;
}

export interface AnalyzerOutput {
  policyName: string;
  features: AnalysisFeature[];
  migrationSummary?: MigrationSummary;
}

// --- Translator output types ---

export interface GraphApiCall {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  endpoint: string;
  body?: Record<string, unknown>;
  description: string;
}

export interface TranslationResult {
  featureName: string;
  description: string;
  availability: ExternalIdAvailability;
  graphApiCalls: GraphApiCall[];
  bicepResources: string[];
  manualSteps: string[];
  gapReason?: string;
}

export interface TranslatorOutput {
  policyName: string;
  generatedAt: string;
  summary: {
    totalFeatures: number;
    automated: number;
    needsManual: number;
    blocked: number;
  };
  translations: TranslationResult[];
}
