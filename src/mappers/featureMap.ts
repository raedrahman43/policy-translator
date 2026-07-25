/**
 * Feature Mapping Registry — Scheme B (canonical)
 *
 * Each B2C feature name (Scheme B: `journey_mechanism_method`) maps to a set
 * of `StepKind`s required to produce equivalent config in External ID, plus
 * an optional gap entry if the feature cannot be fully automated.
 *
 * Multiple features may request the same StepKind; the script generator
 * dedups them so e.g. `signUp_auth_emailPassword` and
 * `signIn_auth_emailPassword` together emit one set of scripts, not two.
 */

import { AnalysisFeature } from "../types";

/**
 * A discrete action the generated migration package may need to perform.
 * Each StepKind corresponds 1:1 to a template in `src/generators/templates/`.
 */
export type StepKind =
  | "create-native-app"
  | "create-user-flow-emailpassword"
  | "add-google-idp"
  | "add-facebook-idp"
  | "enable-email-otp"
  | "enable-sms-mfa"
  | "create-ca-policy"
  | "enable-passkey"
  | "claims-mapping-policy"
  | "enable-sspr"
  | "create-custom-attributes"
  | "smoke-test-native-auth";

export interface RequiredStep {
  kind: StepKind;
  reason: string;
}

export interface GapEntry {
  feature: string;
  reason: string;
  recommendation: string;
  effort: string;
  workaround?: string;
}

export type MappingCategory =
  | "user-flow"
  | "idp"
  | "claims"
  | "token"
  | "gap"
  | "noop";

export interface MappingResult {
  featureName: string;
  category: MappingCategory;
  steps: RequiredStep[];
  gapReport?: GapEntry;
  noopReason?: string;
}

type FeatureMapper = (feature: AnalysisFeature) => MappingResult;

function manualFederationGap(feature: AnalysisFeature, provider: string): MappingResult {
  return {
    featureName: feature.name,
    category: "gap",
    steps: [],
    gapReport: {
      feature: feature.name,
      reason: `${provider} is supported in External ID, but Microsoft does not publish a supported external-tenant Graph create API for this provider. The existing beta identity-provider model is documented for Azure AD B2C only.`,
      recommendation: `Configure ${provider} in the Microsoft Entra admin center, add it to the target user flow, and validate a real browser sign-in.`,
      effort: "Manual configuration",
    },
  };
}

/**
 * The mapping table: Scheme B feature names → External ID actions.
 * Add entries here as new feature support lands.
 */
const FEATURE_MAP: Record<string, FeatureMapper> = {
  // ─── POC: email + password native auth ────────────────────────────
  signUp_auth_emailPassword: (feature) => ({
    featureName: feature.name,
    category: "user-flow",
    steps: [
      {
        kind: "create-native-app",
        reason: "signUp_auth_emailPassword requires a native-auth-enabled app registration",
      },
      {
        kind: "create-user-flow-emailpassword",
        reason: "signUp_auth_emailPassword requires an email+password sign-up user flow",
      },
      {
        kind: "smoke-test-native-auth",
        reason: "validate native auth wiring end-to-end after provisioning",
      },
    ],
  }),

  signIn_auth_emailPassword: (feature) => ({
    featureName: feature.name,
    category: "user-flow",
    steps: [
      {
        kind: "create-native-app",
        reason: "signIn_auth_emailPassword requires a native-auth-enabled app registration",
      },
      {
        kind: "create-user-flow-emailpassword",
        reason: "signIn_auth_emailPassword is served by the same email+password user flow as sign-up",
      },
      {
        kind: "smoke-test-native-auth",
        reason: "validate native auth wiring end-to-end after provisioning",
      },
    ],
  }),

  // ─── Social IdP: Google ────────────────────────────────────────────
  signIn_idp_google: (feature) => ({
    featureName: feature.name,
    category: "idp",
    steps: [
      {
        kind: "create-native-app",
        reason: "Google sign-in requires a native-auth-enabled app registration",
      },
      {
        kind: "create-user-flow-emailpassword",
        reason: "Google IdP attaches to the email+password user flow as an additional sign-in option",
      },
      {
        kind: "add-google-idp",
        reason: "signIn_idp_google requires Google to be provisioned and bound to the user flow",
      },
      {
        kind: "smoke-test-native-auth",
        reason: "validate native auth wiring end-to-end after provisioning",
      },
    ],
  }),
  // signUp variant: same provisioning as sign-in; Google attaches to the shared user flow.
  signUp_idp_google: (feature) => ({
    featureName: feature.name,
    category: "idp",
    steps: [
      {
        kind: "create-native-app",
        reason: "Google sign-up requires a native-auth-enabled app registration",
      },
      {
        kind: "create-user-flow-emailpassword",
        reason: "Google IdP attaches to the email+password user flow as an additional sign-up option",
      },
      {
        kind: "add-google-idp",
        reason: "signUp_idp_google requires Google to be provisioned and bound to the user flow",
      },
      {
        kind: "smoke-test-native-auth",
        reason: "validate native auth wiring end-to-end after provisioning",
      },
    ],
  }),
  // ─── Social IdP: Facebook ─────────────────────────────────────────
  signIn_idp_facebook: (feature) => ({
    featureName: feature.name,
    category: "idp",
    steps: [
      {
        kind: "create-native-app",
        reason: "Facebook sign-in requires a native-auth-enabled app registration",
      },
      {
        kind: "create-user-flow-emailpassword",
        reason: "Facebook IdP attaches to the email+password user flow as an additional sign-in option",
      },
      {
        kind: "add-facebook-idp",
        reason: "signIn_idp_facebook requires Facebook to be provisioned and bound to the user flow",
      },
      {
        kind: "smoke-test-native-auth",
        reason: "validate native auth wiring end-to-end after provisioning",
      },
    ],
  }),
  // signUp variant: same provisioning as sign-in; Facebook attaches to the shared user flow.
  signUp_idp_facebook: (feature) => ({
    featureName: feature.name,
    category: "idp",
    steps: [
      {
        kind: "create-native-app",
        reason: "Facebook sign-up requires a native-auth-enabled app registration",
      },
      {
        kind: "create-user-flow-emailpassword",
        reason: "Facebook IdP attaches to the email+password user flow as an additional sign-up option",
      },
      {
        kind: "add-facebook-idp",
        reason: "signUp_idp_facebook requires Facebook to be provisioned and bound to the user flow",
      },
      {
        kind: "smoke-test-native-auth",
        reason: "validate native auth wiring end-to-end after provisioning",
      },
    ],
  }),

  // ─── Custom OIDC IdP (enterprise federation) ────────────────────────
  signIn_idp_partnerIdp: (feature) => manualFederationGap(feature, "the custom OpenID Connect provider"),

  signIn_idp_customOidc: (feature) => manualFederationGap(feature, "the custom OpenID Connect provider"),

  signUp_idp_customOidc: (feature) => manualFederationGap(feature, "the custom OpenID Connect provider"),

  // ─── Apple IdP ──────────────────────────────────────────────────────
  signIn_idp_apple: (feature) => manualFederationGap(feature, "Apple federation"),
  signUp_idp_apple: (feature) => manualFederationGap(feature, "Apple federation"),

  // ─── Email OTP ─────────────────────────────────────────────────────
  signIn_otp_email: (feature) => ({
    featureName: feature.name,
    category: "user-flow",
    steps: [
      {
        kind: "create-native-app",
        reason: "Email OTP requires an app registration in the tenant",
      },
      {
        kind: "create-user-flow-emailpassword",
        reason: "Email OTP is enabled at the tenant level and applies to user flows",
      },
      {
        kind: "enable-email-otp",
        reason: "signIn_otp_email requires email OTP to be enabled as an authentication method",
      },
      {
        kind: "smoke-test-native-auth",
        reason: "validate native auth wiring end-to-end after provisioning",
      },
    ],
  }),
  // signUp variant: email OTP is a tenant-level method shared by sign-up and sign-in.
  signUp_otp_email: (feature) => ({
    featureName: feature.name,
    category: "user-flow",
    steps: [
      {
        kind: "create-native-app",
        reason: "Email OTP requires an app registration in the tenant",
      },
      {
        kind: "create-user-flow-emailpassword",
        reason: "Email OTP is enabled at the tenant level and applies to user flows",
      },
      {
        kind: "enable-email-otp",
        reason: "signUp_otp_email requires email OTP to be enabled as an authentication method",
      },
      {
        kind: "smoke-test-native-auth",
        reason: "validate native auth wiring end-to-end after provisioning",
      },
    ],
  }),

  // ─── SMS MFA (Phase 1.5) ───────────────────────────────────────────
  // In External ID, SMS is a SECOND FACTOR (MFA), not a primary sign-in
  // method. signUp_otp_phoneSms (primary phone sign-up) is On Roadmap and
  // falls through to the gap report; only the MFA variant is in-built.
  signIn_otp_phoneSms: (feature) => ({
    featureName: feature.name,
    category: "user-flow",
    steps: [
      {
        kind: "create-native-app",
        reason: "SMS MFA needs an app registration in the tenant for context",
      },
      {
        kind: "enable-sms-mfa",
        reason: "signIn_otp_phoneSms requires SMS enabled as an MFA authentication method",
      },
    ],
  }),

  // ─── Conditional Access / MFA Enforcement (Phase 1.5) ──────────────
  // B2C "require MFA" / step-up requirements translate to an External ID
  // Conditional Access policy whose grant control requires MFA. The
  // generated script creates the policy in REPORT-ONLY mode so it cannot
  // lock users out; the admin flips it to On after validating MFA.
  signIn_security_conditionalAccess: (feature) => ({
    featureName: feature.name,
    category: "user-flow",
    steps: [
      {
        kind: "create-native-app",
        reason: "The migration still needs its External ID application; Conditional Access separately targets the protected resource supplied by the operator",
      },
      {
        kind: "create-ca-policy",
        reason: "signIn_security_conditionalAccess maps to an External ID Conditional Access policy",
      },
    ],
  }),

  signIn_mfa_stepUp: (feature) => ({
    featureName: feature.name,
    category: "user-flow",
    steps: [
      {
        kind: "create-native-app",
        reason: "The migration still needs its External ID application; Conditional Access separately targets the protected resource supplied by the operator",
      },
      {
        kind: "create-ca-policy",
        reason: "Step-up MFA is enforced via a Conditional Access policy requiring MFA",
      },
    ],
  }),

  // ─── Passkey (FIDO2) MFA (Phase 1.5) ───────────────────────────────
  // B2C FIDO2/passkey/WebAuthn sign-in translates to enabling passkey
  // (FIDO2) as an MFA authentication method in External ID. Supported for
  // password-based local accounts (Email/Username + password); NOT for
  // external-IdP or email-OTP-first users. Pair with Conditional Access
  // (script 12) to require MFA. Passkey sign-UP (signUp_auth_passkey)
  // stays in the gap report (needs custom auth extensions).
  signIn_auth_passkey: (feature) => ({
    featureName: feature.name,
    category: "user-flow",
    steps: [
      {
        kind: "create-native-app",
        reason: "Passkey MFA needs an app registration in the tenant for context",
      },
      {
        kind: "enable-passkey",
        reason: "signIn_auth_passkey requires passkey (FIDO2) enabled as an MFA authentication method",
      },
    ],
  }),

  // ─── Sign-up Attribute Collection ──────────────────────────────────
  // Standard + custom attributes are collected by the sign-up user flow.
  // Custom attributes are emitted dynamically from policy context by the
  // create-user-flow template's ATTRIBUTES_BLOCK, so no extra step is needed.
  signUp_attributes_standard: (feature) => ({
    featureName: feature.name,
    category: "user-flow",
    steps: [
      {
        kind: "create-native-app",
        reason: "Attribute collection requires a native-auth-enabled app registration",
      },
      {
        kind: "create-user-flow-emailpassword",
        reason: "signUp_attributes_standard is satisfied by the sign-up user flow's attribute collection",
      },
      {
        kind: "smoke-test-native-auth",
        reason: "validate native auth wiring end-to-end after provisioning",
      },
    ],
  }),

  signUp_attributes_custom: (feature) => ({
    featureName: feature.name,
    category: "user-flow",
    steps: [
      {
        kind: "create-native-app",
        reason: "Custom attribute collection requires a native-auth-enabled app registration",
      },
      {
        kind: "create-user-flow-emailpassword",
        reason: "signUp_attributes_custom is satisfied by the sign-up user flow; custom attributes are emitted from policy context",
      },
      {
        kind: "smoke-test-native-auth",
        reason: "validate native auth wiring end-to-end after provisioning",
      },
    ],
  }),

  // ─── Claims Mapping / Custom Token Claims ──────────────────────────
  global_token_claimsMapping: (feature) => ({
    featureName: feature.name,
    category: "claims",
    steps: [
      {
        kind: "create-native-app",
        reason: "Claims mapping policy requires an app registration and service principal",
      },
      {
        kind: "claims-mapping-policy",
        reason: "global_token_claimsMapping requires a claims mapping policy assigned to the SP",
      },
    ],
  }),

  global_token_externalClaims: (feature) => ({
    featureName: feature.name,
    category: "claims",
    steps: [
      {
        kind: "create-native-app",
        reason: "Custom token claims require an app registration and service principal",
      },
      {
        kind: "claims-mapping-policy",
        reason: "global_token_externalClaims uses a claims mapping policy to emit custom claims in the token",
      },
    ],
  }),

  // ─── Noops: features already handled by External ID by default ────
  global_token_refreshToken: (feature) => ({
    featureName: feature.name,
    category: "noop",
    steps: [],
    noopReason: "Refresh tokens are supported by default in External ID. No configuration needed.",
  }),

  signIn_security_preventDisabledSocialLogon: (feature) => ({
    featureName: feature.name,
    category: "noop",
    steps: [],
    noopReason: "External ID natively blocks disabled accounts from signing in. No configuration needed.",
  }),

  global_infra_orchestrationLinear: (feature) => ({
    featureName: feature.name,
    category: "noop",
    steps: [],
    noopReason: "Linear orchestration is the default model in External ID user flows.",
  }),

  global_ux_tenantBranding: (feature) => ({
    featureName: feature.name,
    category: "noop",
    steps: [],
    noopReason: "Company branding is configurable in the Entra admin center. No script needed.",
  }),

  global_ux_localization: (feature) => ({
    featureName: feature.name,
    category: "gap",
    steps: [],
    gapReport: {
      feature: feature.name,
      reason: "External ID supports localization, but each browser-language branding and user-flow label set must be recreated explicitly.",
      recommendation: "Configure Company Branding language localizations and localized user-flow attribute labels in the Entra admin center.",
      effort: "Manual configuration",
    },
  }),

  signIn_session_kmsi: (feature) => ({
    featureName: feature.name,
    category: "gap",
    steps: [],
    gapReport: {
      feature: feature.name,
      reason: "Keep Me Signed In is supported, but this tool does not have a documented Graph write for the user-flow toggle.",
      recommendation: "Open the External ID user flow properties and configure Keep Me Signed In manually.",
      effort: "Manual configuration",
    },
  }),

  signIn_session_lifecycleManagement: (feature) => ({
    featureName: feature.name,
    category: "noop",
    steps: [],
    noopReason: "Session lifetime is configurable via token lifetime policies in External ID.",
  }),

  global_token_lifetimeManagement: (feature) => ({
    featureName: feature.name,
    category: "noop",
    steps: [],
    noopReason: "Token lifetime policies are configurable in External ID. No script needed.",
  }),

  // ─── Password complexity (NOT SSPR) ──────────────────────────────
  // External ID enforces a fixed default password policy and does not support
  // B2C-style custom complexity predicates, so there is no automated equivalent.
  // Route to the gap report instead of enabling SSPR (an unrelated capability).
  passwordReset_security_passwordComplexity: (feature) => ({
    featureName: feature.name,
    category: "gap",
    steps: [],
    gapReport: {
      feature: feature.name,
      reason: feature.reason,
      recommendation:
        "External ID enforces a fixed default password policy (length and character-class requirements) and does not support B2C-style custom password complexity predicates. There is no automated equivalent; review the requirement against the default policy. This is distinct from self-service password reset, which is handled separately.",
      effort: "Not configurable — External ID uses a fixed password policy",
    },
  }),

  // Self-service password recovery is served by the same SSPR configuration.
  passwordReset_recovery: (feature) => ({
    featureName: feature.name,
    category: "user-flow",
    steps: [
      {
        kind: "create-native-app",
        reason: "SSPR requires an app registration in the tenant",
      },
      {
        kind: "create-user-flow-emailpassword",
        reason: "Password recovery is enabled on the user flow's sign-in experience",
      },
      {
        kind: "enable-sspr",
        reason: "passwordReset_recovery requires SSPR to be enabled so users can reset their own password",
      },
    ],
  }),
};

function genericGapEntry(feature: AnalysisFeature): GapEntry {
  return {
    feature: feature.name,
    reason: feature.reason,
    recommendation: feature.recommendation,
    effort: "Unknown — needs investigation",
  };
}

// For features that ARE available in External ID but have no mapper yet. We do
// not silently drop them; they go to the gap report so the customer sees the
// tool detected them and knows they need manual configuration.
function coverageGapEntry(feature: AnalysisFeature): GapEntry {
  return {
    feature: feature.name,
    reason: feature.reason,
    recommendation:
      feature.recommendation +
      " (Detected as available in External ID, but this tool does not generate a script for it yet — configure manually.)",
    effort: "Manual configuration",
  };
}

/**
 * Map a single Analyzer feature to its External ID equivalent.
 *
 * Resolution order:
 *   1. Direct match in FEATURE_MAP → explicit handler
 *   2. Non-Available feature without a mapper → generic gap entry (manual work)
 *   3. Available feature without a mapper → null (translator coverage gap; warn)
 */
export function mapFeatureToExternalId(feature: AnalysisFeature): MappingResult | null {
  const mapper = FEATURE_MAP[feature.name];
  if (mapper) {
    return mapper(feature);
  }

  if (feature.externalIdAvailability !== "Available") {
    return {
      featureName: feature.name,
      category: "gap",
      steps: [],
      gapReport: genericGapEntry(feature),
    };
  }

  // Available in External ID but this tool has no mapper for it yet. Do NOT
  // silently drop it: surface it in the gap report so the customer sees it was
  // detected and needs manual configuration. Warn for developer visibility.
  console.warn(`⚠️  No mapper for "${feature.name}" (Available) — routed to gap report for manual configuration`);
  return {
    featureName: feature.name,
    category: "gap",
    steps: [],
    gapReport: coverageGapEntry(feature),
  };
}

export function mapAllFeatures(features: AnalysisFeature[]): {
  mapped: MappingResult[];
  unmapped: string[];
} {
  const mapped: MappingResult[] = [];
  const unmapped: string[] = [];

  for (const feature of features) {
    const result = mapFeatureToExternalId(feature);
    if (result) {
      mapped.push(result);
    } else {
      unmapped.push(feature.name);
    }
  }

  return { mapped, unmapped };
}
