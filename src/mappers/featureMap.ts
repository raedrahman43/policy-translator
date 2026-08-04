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
  featureOccurrence?: number;
  followUpType?: "validation" | "manual" | "redesign";
  reason: string;
  recommendation: string;
  effort: string;
  workaround?: string;
  notes?: string;
  docLink?: string;
  availability?: AnalysisFeature["externalIdAvailability"];
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
  featureOccurrence?: number;
  emailOtpMode?: EmailOtpMode;
  category: MappingCategory;
  steps: RequiredStep[];
  gapReport?: GapEntry;
  noopReason?: string;
}

type FeatureMapper = (feature: AnalysisFeature) => MappingResult;

export type EmailOtpMode = "primary" | "mfa" | "unspecified";

export function classifyEmailOtpMode(feature: AnalysisFeature): EmailOtpMode {
  const decisiveText = `${feature.description || ""} ${feature.reason}`.toLowerCase();
  const negatedSecondary =
    /\bnot (?:an? )?(?:mfa|multi[- ]?factor|second[- ]?factor|secondary)\b/.test(decisiveText);
  const explicitlySecondary =
    !negatedSecondary &&
    /\bmfa\b|multi[- ]?factor|second[- ]?factor|secondary|additional verification/.test(decisiveText);
  const explicitlyPrimary =
    /passwordless|primary sign.?in|one.?time passcode as (?:the )?primary|each time they sign in/.test(decisiveText);
  if (explicitlyPrimary && explicitlySecondary) return "unspecified";
  if (explicitlyPrimary && !explicitlySecondary) return "primary";
  if (explicitlySecondary) return "mfa";
  return "unspecified";
}

function isPrimaryEmailOtp(feature: AnalysisFeature): boolean {
  return classifyEmailOtpMode(feature) === "primary";
}

function isEmailOtpMfa(feature: AnalysisFeature): boolean {
  return classifyEmailOtpMode(feature) === "mfa";
}

function manualFederationGap(feature: AnalysisFeature, provider: string): MappingResult {
  return {
    featureName: feature.name,
    category: "gap",
    steps: [],
    gapReport: {
      feature: feature.name,
      followUpType: "manual",
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
    gapReport: {
      feature: feature.name,
      followUpType: "validation",
      reason: "Graph can create and bind the Google provider but cannot validate the customer-managed client secret or complete the provider's browser journey.",
      recommendation: "Complete a real Google sign-up/sign-in and verify account creation, redirect behavior, and issued token claims.",
      effort: "Live provider validation",
    },
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
    gapReport: {
      feature: feature.name,
      followUpType: "validation",
      reason: "Graph can create and bind the Google provider but cannot validate the customer-managed client secret or complete the provider's browser journey.",
      recommendation: "Complete a real Google sign-up/sign-in and verify account creation, redirect behavior, and issued token claims.",
      effort: "Live provider validation",
    },
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
    gapReport: {
      feature: feature.name,
      followUpType: "validation",
      reason: "Graph can create and bind the Facebook provider but cannot validate the customer-managed app secret or complete the provider's browser journey.",
      recommendation: "Complete a real Facebook sign-up/sign-in and verify account creation, redirect behavior, and issued token claims.",
      effort: "Live provider validation",
    },
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
    gapReport: {
      feature: feature.name,
      followUpType: "validation",
      reason: "Graph can create and bind the Facebook provider but cannot validate the customer-managed app secret or complete the provider's browser journey.",
      recommendation: "Complete a real Facebook sign-up/sign-in and verify account creation, redirect behavior, and issued token claims.",
      effort: "Live provider validation",
    },
  }),

  // ─── Custom OIDC IdP (enterprise federation) ────────────────────────
  signIn_idp_partnerIdp: (feature) => manualFederationGap(feature, "the custom OpenID Connect provider"),

  signIn_idp_customOidc: (feature) => manualFederationGap(feature, "the custom OpenID Connect provider"),

  signUp_idp_customOidc: (feature) => manualFederationGap(feature, "the custom OpenID Connect provider"),

  // ─── Apple IdP ──────────────────────────────────────────────────────
  signIn_idp_apple: (feature) => manualFederationGap(feature, "Apple federation"),
  signUp_idp_apple: (feature) => manualFederationGap(feature, "Apple federation"),

  // ─── Email OTP ─────────────────────────────────────────────────────
  signIn_otp_email: (feature) => {
    const mode = classifyEmailOtpMode(feature);
    if (mode === "primary") {
      return {
        featureName: feature.name,
        emailOtpMode: "primary",
        category: "user-flow",
        steps: [
          {
            kind: "create-native-app",
            reason: "Primary Email OTP requires an application registration",
          },
          {
            kind: "enable-email-otp",
            reason: "Primary Email OTP requires the tenant authentication method to be enabled",
          },
        ],
        gapReport: {
          feature: feature.name,
          followUpType: "manual",
          reason: "Policy Translator currently creates an Email + Password user flow and does not switch the flow's primary local-account provider to Email one-time passcode.",
          recommendation: "Create or update the target user flow to use Email with one-time passcode as the primary identity provider, bind the application, and test a real passwordless sign-in.",
          effort: "Manual user-flow configuration and live validation",
        },
      };
    }
    if (mode === "unspecified") {
      return {
        featureName: feature.name,
        emailOtpMode: "unspecified",
        category: "user-flow",
        steps: [
          {
            kind: "create-native-app",
            reason: "Email OTP requires an application registration",
          },
          {
            kind: "enable-email-otp",
            reason: "The tenant-level Email OTP method can be enabled safely before the user-flow mode is clarified",
          },
        ],
        gapReport: {
          feature: feature.name,
          followUpType: "manual",
          reason: "The Analyzer detected Email OTP but did not identify whether it is primary passwordless sign-in, secondary MFA, sign-up verification, or password-reset verification.",
          recommendation: "Confirm the journey context before creating or changing a user flow. Policy Translator enables only the safe tenant-level method and does not infer a password flow or Conditional Access policy.",
          effort: "Requirements clarification and user-flow validation",
        },
      };
    }
    const steps: RequiredStep[] = [
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
    ];
    return {
      featureName: feature.name,
      emailOtpMode: "mfa",
      category: "user-flow",
      steps,
      gapReport: {
        feature: feature.name,
        followUpType: "manual",
        reason: "Enabling Email OTP makes the method available but does not enforce MFA. The Analyzer output does not provide the protected resource, user/group scope, emergency-access exclusions, or whether every targeted user's primary sign-in method is compatible with Email OTP MFA.",
        recommendation: "Design a report-only Conditional Access policy for the intended resource and eligible users, exclude emergency-access accounts, validate sign-in logs, and only then enable enforcement. Federated or primary-Email-OTP users may require SMS instead.",
        effort: "Conditional Access design and live validation",
      },
    };
  },
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
    gapReport: {
      feature: feature.name,
      followUpType: "validation",
      reason: "Policy Translator enables Email OTP and creates the user flow, but a successful Graph write does not prove sign-up email verification completes for a real customer.",
      recommendation: "Complete a real sign-up, receive and redeem the email code, verify the account is created, and inspect the resulting token.",
      effort: "Live sign-up verification",
    },
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
    gapReport: {
      feature: feature.name,
      followUpType: "manual",
      reason: "The script enables the tenant SMS method but does not establish billing/telephony readiness, register a customer phone method, or enforce a scoped MFA policy.",
      recommendation: "Confirm subscription linkage and SMS terms, register a test phone, configure approved MFA scope, and complete a real SMS challenge.",
      effort: "Tenant readiness and live MFA validation",
    },
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
    gapReport: {
      feature: feature.name,
      followUpType: "manual",
      reason: "Conditional Access is created report-only and cannot be considered complete until resource targeting, user scope, emergency-access exclusions, and sign-in impact are reviewed.",
      recommendation: "Review report-only sign-in logs and enable the policy only after approved MFA validation.",
      effort: "Policy review and rollout approval",
    },
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
    gapReport: {
      feature: feature.name,
      followUpType: "manual",
      reason: "The report-only MFA policy does not recreate arbitrary B2C step-up conditions inside a journey.",
      recommendation: "Validate the protected resource and step-up trigger in the application, review report-only logs, and approve enforcement separately.",
      effort: "Application integration and policy validation",
    },
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
    gapReport: {
      feature: feature.name,
      followUpType: "manual",
      reason: "Enabling the FIDO2 policy does not choose the customer's email-password versus username-password account model or complete passkey rollout. A compatible application-bound password user flow is required, users must complete MFA shortly before registration, and the tenant needs Azure Front Door, a custom URL domain, passkey profiles, and a credential-management experience.",
      recommendation: "Use a compatible password user flow generated by another detected feature or configure the intended email/username password flow manually. Then configure MFA for enrollment, complete the custom-domain setup, build or adopt a passkey management experience, and validate browser-delegated registration/sign-in.",
      effort: "Partial automation with rollout prerequisites",
    },
  }),

  global_ux_customSmsTemplate: (feature) => ({
    featureName: feature.name,
    category: "gap",
    steps: [],
    gapReport: {
      feature: feature.name,
      availability: "NotCurrentlySupported",
      reason: "External ID uses Microsoft's SMS delivery path and does not expose a supported event for replacing authentication SMS delivery with a custom provider or template.",
      recommendation: "Use Microsoft-managed SMS if it meets the requirement. If custom routing or templating is mandatory, record this as a platform gap and redesign communication outside the authentication OTP pipeline.",
      effort: "Not currently supported",
    },
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
    gapReport: {
      feature: feature.name,
      followUpType: "validation",
      reason: "Policy Translator creates and binds detected custom attributes, but Graph success does not prove page labels, required behavior, stored values, or token output match the customer contract.",
      recommendation: "Complete a real sign-up, verify every custom field on the page and user object, and inspect any expected token claims.",
      effort: "Live custom-attribute validation",
    },
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
    gapReport: {
      feature: feature.name,
      followUpType: "validation",
      reason: "A successful claims-mapping write does not prove the application receives the expected token contract.",
      recommendation: "Sign in through the target application, decode a real token, and compare every expected claim and value with the source contract.",
      effort: "Token comparison",
    },
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
    gapReport: {
      feature: feature.name,
      reason:
        "Claims mapping can emit directory-backed attributes, but custom extension attributes need their resolved External ID directory IDs and runtime data from external APIs requires a custom claims provider.",
      recommendation:
        "Use the generated claims mapping policy for directory-backed claims. Resolve any custom attribute IDs after creation, and use an OnTokenIssuanceStart custom authentication extension for claims fetched from external systems. Compare the final External ID token with the source B2C token.",
      effort: "Partial automation with custom development when claims come from external systems",
    },
  }),

  global_token_passthroughNoDirectory: (feature) => ({
    featureName: feature.name,
    category: "gap",
    steps: [],
    gapReport: {
      feature: feature.name,
      followUpType: "redesign",
      availability: "ArchitectureIncompatible",
      reason: "This B2C journey issues a token without a normal directory-backed user. External ID requires an explicit linked directory user and cannot reproduce directory-less passthrough.",
      recommendation: "Redesign the credential, federation, account-linking, user-lifecycle, and token-issuance architecture before provisioning the target application.",
      effort: "Architecture redesign",
    },
  }),

  global_token_claimsTransformation: (feature) => ({
    featureName: feature.name,
    category: "gap",
    steps: [],
    gapReport: {
      feature: feature.name,
      reason:
        "B2C claims-transformation chains cannot be translated safely into a declarative claims mapping policy because they can contain ordering, conditional, string, collection, and validation logic.",
      recommendation:
        "Reimplement required runtime transformations in an appropriate custom authentication extension, commonly OnTokenIssuanceStart for token enrichment or OnAttributeCollectionSubmit for sign-up validation. Keep simple renames as claims mappings.",
      effort: "Custom development and token comparison",
    },
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
    gapReport: {
      feature: feature.name,
      followUpType: "validation",
      reason: "Company Branding is tenant-wide and a successful Graph write does not prove the hosted sign-in page matches the intended customer experience.",
      recommendation: "Apply branding through port 4001 or the Entra admin center, then open the real browser-hosted sign-in page and verify every asset, localization, and custom CSS behavior.",
      effort: "Hosted-page validation",
    },
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
    gapReport: {
      feature: feature.name,
      followUpType: "validation",
      reason: "Policy Translator configures SSPR prerequisites but cannot prove the hosted Forgot password journey completes for a real customer.",
      recommendation: "Complete one real password reset and verify Email OTP, password update, subsequent sign-in, and branding.",
      effort: "Live password-reset validation",
    },
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
    return addAnalyzerGuidance(mapper(feature), feature);
  }

  if (feature.externalIdAvailability !== "Available") {
    return addAnalyzerGuidance({
      featureName: feature.name,
      category: "gap",
      steps: [],
      gapReport: genericGapEntry(feature),
    }, feature);
  }

  // Available in External ID but this tool has no mapper for it yet. Do NOT
  // silently drop it: surface it in the gap report so the customer sees it was
  // detected and needs manual configuration. Warn for developer visibility.
  console.warn(`⚠️  No mapper for "${feature.name}" (Available) — routed to gap report for manual configuration`);
  return addAnalyzerGuidance({
    featureName: feature.name,
    category: "gap",
    steps: [],
    gapReport: coverageGapEntry(feature),
  }, feature);
}

function addAnalyzerGuidance(result: MappingResult, feature: AnalysisFeature): MappingResult {
  const withOccurrence: MappingResult = {
    ...result,
    ...(feature.occurrence ? { featureOccurrence: feature.occurrence } : {}),
  };
  if (!result.gapReport) return withOccurrence;
  return {
    ...withOccurrence,
    gapReport: {
      ...result.gapReport,
      ...(feature.occurrence ? { featureOccurrence: feature.occurrence } : {}),
      availability: result.gapReport.availability || feature.externalIdAvailability,
      ...(feature.notes ? { notes: feature.notes } : {}),
      ...(feature.docLink ? { docLink: feature.docLink } : {}),
    },
  };
}

export function mapAllFeatures(features: AnalysisFeature[]): {
  mapped: MappingResult[];
  unmapped: string[];
} {
  const mapped: MappingResult[] = [];
  const unmapped: string[] = [];
  const hasPrimaryEmailOtp = features.some(
    (feature) => feature.name === "signIn_otp_email" && isPrimaryEmailOtp(feature),
  );
  const hasSecondaryEmailOtp = features.some(
    (feature) => feature.name === "signIn_otp_email" && isEmailOtpMfa(feature),
  );
  const hasEmailPassword = features.some(
    (feature) => feature.name === "signIn_auth_emailPassword" || feature.name === "signUp_auth_emailPassword",
  );
  const hasPasskeyArchitecture = features.some((feature) => feature.name === "signIn_auth_passkey");
  const hasPasswordResetArchitecture = features.some((feature) => feature.name === "passwordReset_recovery");
  const primaryOtpCompatibleSocialKeys = new Set([
    "signIn_idp_google",
    "signUp_idp_google",
    "signIn_idp_facebook",
    "signUp_idp_facebook",
  ]);
  const hasMixedEmailOtpArchitecture =
    hasPrimaryEmailOtp &&
    (hasSecondaryEmailOtp || hasEmailPassword || hasPasskeyArchitecture || hasPasswordResetArchitecture);
  const generatedPasswordArchitecture =
    hasSecondaryEmailOtp || hasEmailPassword || hasPasswordResetArchitecture;
  const suppressImplicitPasswordFlow =
    hasPrimaryEmailOtp &&
    (!hasMixedEmailOtpArchitecture || (hasPasskeyArchitecture && !generatedPasswordArchitecture));

  for (const feature of features) {
    if (
      hasMixedEmailOtpArchitecture &&
      feature.name === "signIn_otp_email" &&
      isPrimaryEmailOtp(feature)
    ) {
      mapped.push(addAnalyzerGuidance({
        featureName: feature.name,
        emailOtpMode: "primary",
        category: "gap",
        steps: [{
          kind: "enable-email-otp",
          reason: "Email OTP can be enabled safely at the tenant level while the application/user-flow architecture is resolved",
        }],
        gapReport: {
          feature: feature.name,
          followUpType: "manual",
          reason: generatedPasswordArchitecture
            ? "The Analyzer detected both primary Email OTP and an Email + Password or secondary-MFA path. One application can be associated with only one External ID user flow, and primary Email OTP cannot also serve as that flow's Email OTP MFA factor."
            : "The Analyzer detected primary Email OTP together with passkey. External ID currently requires an email/username-and-password local account to register passkeys; primary Email OTP users cannot enroll passkeys.",
          recommendation: generatedPasswordArchitecture
            ? "Choose the target authentication architecture explicitly. The generated package follows the password/MFA path; use a separate application/flow or a separate migration package if primary passwordless Email OTP is required."
            : "Choose the account model explicitly: keep primary Email OTP and omit passkey, or create a compatible password-based user flow for passkey users. The generated package enables only the safe tenant-level Email OTP and FIDO2 settings and does not create a user flow.",
          effort: "Architecture decision and separate user-flow validation",
        },
      }, feature));
      continue;
    }
    const primaryOtpCandidate = FEATURE_MAP[feature.name]?.(feature);
    if (
      hasPrimaryEmailOtp &&
      suppressImplicitPasswordFlow &&
      feature.name !== "signIn_otp_email" &&
      primaryOtpCandidate?.steps.some((step) => step.kind === "create-user-flow-emailpassword")
    ) {
      const isSocialProvider = primaryOtpCompatibleSocialKeys.has(feature.name);
      const safeSteps = primaryOtpCandidate.steps.filter(
        (step) => step.kind === "create-native-app" || step.kind === "enable-email-otp",
      );
      mapped.push(addAnalyzerGuidance({
        featureName: feature.name,
        category: "gap",
        steps: safeSteps,
        gapReport: {
          feature: feature.name,
          followUpType: "manual",
          reason: "This capability is compatible with a primary Email OTP user flow, but its current deterministic mapper would create an Email + Password flow instead.",
          recommendation: isSocialProvider
            ? "Create the primary Email OTP user flow for the generated application, then configure this provider and enable it on the same flow. A separate application is not required."
            : `Create the primary Email OTP user flow for the generated application, then configure this capability on that same flow. ${feature.recommendation}`,
          effort: "Manual primary-OTP user-flow configuration and live validation",
        },
      }, feature));
      continue;
    }
    const result = mapFeatureToExternalId(feature);
    if (result) {
      mapped.push(result);
    } else {
      unmapped.push(feature.name);
    }
  }

  return { mapped, unmapped };
}
