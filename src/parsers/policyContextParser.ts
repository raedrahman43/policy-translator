/**
 * Policy Context Parser
 *
 * Extracts policy-specific configuration from Analyzer output:
 * - App/flow names derived from the policy name
 * - Claims mappings detected in the policy
 * - User attributes collected during sign-up
 * - IdP display names from detected providers
 */

import { AnalysisFeature } from "../types";

export interface ClaimMapping {
  source: string;   // Directory attribute (e.g., "displayname", "mail")
  jwtName: string;  // JWT claim name (e.g., "name", "email")
}

export interface UserAttribute {
  id: string;           // Attribute ID (e.g., "email", "city", "jobTitle")
  displayName: string;  // Human-friendly name
  dataType: string;     // "string", "boolean", etc.
  required: boolean;
}

export interface CustomAttribute {
  name: string;         // Raw attribute name (e.g., "loyaltyTier")
  displayName: string;  // Human-friendly name (e.g., "Loyalty Tier")
  dataType: string;     // "string", "boolean", etc.
  required: boolean;
}

export interface PolicyContext {
  appName: string;
  flowName: string;
  claims: ClaimMapping[];
  attributes: UserAttribute[];
  customAttributes: CustomAttribute[];
  idpDisplayNames: {
    google?: string;
    facebook?: string;
    oidc?: string;
  };
}

export function withEmailPasswordBaseline(attributes: UserAttribute[]): UserAttribute[] {
  const byId = new Map<string, UserAttribute>();
  const baseline: UserAttribute[] = [
    { id: "email", displayName: "Email Address", dataType: "string", required: true },
    { id: "displayName", displayName: "Display Name", dataType: "string", required: true },
  ];
  for (const attribute of [...baseline, ...attributes]) {
    byId.set(attribute.id, { ...attribute });
  }
  return [...byId.values()];
}

/**
 * Derive a clean app name from the B2C policy name.
 * "B2C_1A_FullSignUpSignIn" → "migrated-FullSignUpSignIn"
 */
function deriveAppName(policyName: string): string {
  const cleaned = policyName
    .replace(/^B2C_1A_/i, "")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .toLowerCase();
  return `migrated-${cleaned}`;
}

/**
 * Derive a flow name from the B2C policy name.
 * "B2C_1A_FullSignUpSignIn" → "migrated-FullSignUpSignIn-flow"
 */
function deriveFlowName(policyName: string): string {
  const cleaned = policyName
    .replace(/^B2C_1A_/i, "")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .toLowerCase();
  return `migrated-${cleaned}-flow`;
}

/**
 * Extract claims mappings from features that indicate token customization.
 * Parses the reason/description fields for clues about what claims were configured.
 */
function extractClaims(features: AnalysisFeature[]): ClaimMapping[] {
  const claims: ClaimMapping[] = [];
  const seen = new Set<string>();

  for (const feature of features) {
    if (feature.name === "global_token_claimsMapping" || feature.name === "global_token_externalClaims") {
      // Parse the reason field for PartnerClaimType info
      const reason = feature.reason.toLowerCase();
      const description = (feature.description || "").toLowerCase();

      // Default claims that are almost always present in B2C policies
      const defaultClaims: ClaimMapping[] = [
        { source: "displayname", jwtName: "name" },
        { source: "mail", jwtName: "email" },
        { source: "surname", jwtName: "family_name" },
        { source: "givenname", jwtName: "given_name" },
      ];

      // Check for additional specific claims mentioned in reason/description
      // Do not invent an extension-attribute ID. External ID assigns the real
      // directory extension name when the attribute is created; a generic
      // placeholder would produce an invalid or empty token claim.
      if (reason.includes("department") || description.includes("department")) {
        defaultClaims.push({ source: "department", jwtName: "dept" });
      }
      if (reason.includes("jobtitle") || reason.includes("job title") || description.includes("job")) {
        defaultClaims.push({ source: "jobTitle", jwtName: "jobTitle" });
      }
      if (reason.includes("phone") || description.includes("phone")) {
        defaultClaims.push({ source: "mobilePhone", jwtName: "phone_number" });
      }
      if (reason.includes("address") || description.includes("address")) {
        defaultClaims.push({ source: "streetAddress", jwtName: "address" });
      }
      if (reason.includes("city") || description.includes("city")) {
        defaultClaims.push({ source: "city", jwtName: "city" });
      }
      if (reason.includes("country") || description.includes("country")) {
        defaultClaims.push({ source: "country", jwtName: "country" });
      }
      if (reason.includes("postal") || description.includes("postal")) {
        defaultClaims.push({ source: "postalCode", jwtName: "postal_code" });
      }

      for (const claim of defaultClaims) {
        if (!seen.has(claim.jwtName)) {
          seen.add(claim.jwtName);
          claims.push(claim);
        }
      }
    }
  }

  // If no claims features found, return a minimal sensible default
  if (claims.length === 0) {
    return [
      { source: "displayname", jwtName: "name" },
      { source: "mail", jwtName: "email" },
    ];
  }

  return claims;
}

/**
 * Extract user attributes that the B2C policy collected during sign-up.
 * Infers from feature names and descriptions.
 */
function extractAttributes(features: AnalysisFeature[]): UserAttribute[] {
  const attrs: UserAttribute[] = [];
  const seen = new Set<string>();

  // Email is always collected for email+password
  const hasEmailPassword = features.some(f => f.name.includes("emailPassword"));
  if (hasEmailPassword) {
    attrs.push({ id: "email", displayName: "Email Address", dataType: "string", required: true });
    seen.add("email");
    attrs.push({ id: "displayName", displayName: "Display Name", dataType: "string", required: true });
    seen.add("displayName");
  }

  // Only the sign-up attribute feature describes fields collected on the page.
  // Authentication features such as SMS MFA mention "phone" but do not mean
  // the user flow should collect a phone attribute during sign-up.
  for (const feature of features.filter((f) => f.name === "signUp_attributes_standard")) {
    const combined = `${feature.name} ${feature.description || ""} ${feature.reason}`.toLowerCase();

    if ((combined.includes("phone") || combined.includes("mobile")) && !seen.has("phone")) {
      attrs.push({ id: "mobilePhone", displayName: "Phone Number", dataType: "string", required: false });
      seen.add("phone");
    }
    if (combined.includes("city") && !seen.has("city")) {
      attrs.push({ id: "city", displayName: "City", dataType: "string", required: false });
      seen.add("city");
    }
    if (combined.includes("country") && !seen.has("country")) {
      attrs.push({ id: "country", displayName: "Country", dataType: "string", required: false });
      seen.add("country");
    }
    if ((combined.includes("jobtitle") || combined.includes("job title")) && !seen.has("jobTitle")) {
      attrs.push({ id: "jobTitle", displayName: "Job Title", dataType: "string", required: false });
      seen.add("jobTitle");
    }
    if ((combined.includes("surname") || combined.includes("last name") || combined.includes("family_name")) && !seen.has("surname")) {
      attrs.push({ id: "surname", displayName: "Last Name", dataType: "string", required: false });
      seen.add("surname");
    }
    if ((combined.includes("givenname") || combined.includes("given name") || combined.includes("first name")) && !seen.has("givenName")) {
      attrs.push({ id: "givenName", displayName: "First Name", dataType: "string", required: false });
      seen.add("givenName");
    }
    if (combined.includes("postal") && !seen.has("postalCode")) {
      attrs.push({ id: "postalCode", displayName: "Postal Code", dataType: "string", required: false });
      seen.add("postalCode");
    }
    if ((combined.includes("street") || combined.includes("address")) && !seen.has("streetAddress")) {
      attrs.push({ id: "streetAddress", displayName: "Street Address", dataType: "string", required: false });
      seen.add("streetAddress");
    }
    if (combined.includes("company") && !seen.has("companyName")) {
      attrs.push({ id: "companyName", displayName: "Company Name", dataType: "string", required: false });
      seen.add("companyName");
    }
  }

  return attrs;
}

/**
 * Convert a raw attribute name into a human-friendly display name.
 * "loyaltyTier" -> "Loyalty Tier", "membership_level" -> "Membership Level"
 */
function toDisplayName(name: string): string {
  const spaced = name
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Attribute names that External ID exposes as built-in user-flow attributes.
// True custom (extension) attributes are anything NOT in this set.
const BUILT_IN_ATTR_NAMES = new Set([
  "email", "emailaddress", "displayname", "phonenumber", "phone", "mobile",
  "city", "country", "jobtitle", "surname", "givenname", "postalcode",
  "streetaddress", "companyname", "name", "mail", "given_name", "family_name",
  "state", "province",
]);

/**
 * Extract true custom (extension) attributes the B2C policy collected at sign-up.
 * Gated by the signUp_attributes_custom feature (that is the semantic signal that
 * custom attributes are collected). Names are parsed from that feature's text:
 *   - extension_<optional-guid>_name tokens
 *   - identifier-like names inside parentheses, e.g. "(loyaltyTier, membershipLevel)"
 * Built-in attribute names are excluded so they are not double-collected.
 */
function extractCustomAttributes(features: AnalysisFeature[]): CustomAttribute[] {
  const custom: CustomAttribute[] = [];
  const seen = new Set<string>();

  const customFeatures = features.filter(
    (f) => f.name === "signUp_attributes_custom" && f.externalIdAvailability === "Available",
  );
  if (!customFeatures.length) return custom;

  const candidates: string[] = [];

  for (const customFeature of customFeatures) {
    const text = `${customFeature.description || ""} ${customFeature.reason || ""}`;
    const extRe = /extension_(?:[0-9a-fA-F]{32}_)?([A-Za-z][A-Za-z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = extRe.exec(text)) !== null) candidates.push(m[1]!);

    const parenRe = /\(([^)]*)\)/g;
    let p: RegExpExecArray | null;
    while ((p = parenRe.exec(text)) !== null) {
      for (const raw of p[1]!.split(/[,;]/)) {
        const t = raw.trim();
        if (/^[A-Za-z][A-Za-z0-9_]*$/.test(t)) candidates.push(t);
      }
    }
  }

  for (const rawCandidate of candidates) {
    const name = rawCandidate.replace(/^extension_/, "");
    const key = name.toLowerCase();
    if (BUILT_IN_ATTR_NAMES.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    custom.push({
      name,
      displayName: toDisplayName(name),
      dataType: "string",
      required: false,
    });
  }

  return custom;
}

/**
 * Extract IdP display names from features that reference identity providers.
 * Parses the reason field: "Identity provider detected: Google (OAuth2)"
 */
function extractIdpDisplayNames(features: AnalysisFeature[]): PolicyContext["idpDisplayNames"] {
  const names: PolicyContext["idpDisplayNames"] = {};

  for (const feature of features) {
    const reason = feature.reason || "";
    const description = feature.description || "";

    if (feature.name === "signIn_idp_google") {
      // Try to extract custom display name from description
      if (description && description !== "Google social identity provider") {
        names.google = description;
      } else {
        names.google = "Sign in with Google";
      }
    }

    if (feature.name === "signIn_idp_facebook") {
      if (description && description !== "Facebook social identity provider") {
        names.facebook = description;
      } else {
        names.facebook = "Sign in with Facebook";
      }
    }

    if (
      feature.name === "signIn_idp_partnerIdp" ||
      feature.name === "signIn_idp_customOidc" ||
      feature.name === "signUp_idp_customOidc"
    ) {
      // Extract the provider name from reason: "Identity provider detected: JWT Issuer (OpenIdConnect)"
      const match = reason.match(/Identity provider detected:\s*(.+?)(?:\s*\(|$)/);
      if (match) {
        const providerName = match[1]!.trim();
        names.oidc = `Sign in with ${providerName}`;
      } else if (description) {
        names.oidc = description;
      } else {
        names.oidc = "Partner Login";
      }
    }
  }

  return names;
}

/**
 * Main entry: extract all policy-specific context from the Analyzer output.
 */
export function extractPolicyContext(policyName: string, features: AnalysisFeature[]): PolicyContext {
  return {
    appName: deriveAppName(policyName),
    flowName: deriveFlowName(policyName),
    claims: extractClaims(features),
    attributes: extractAttributes(features),
    customAttributes: extractCustomAttributes(features),
    idpDisplayNames: extractIdpDisplayNames(features),
  };
}
