/**
 * manualRecreation — deterministic "how to recreate this in External ID"
 * guidance for gap-report features that the tool can't (fully) automate.
 *
 * Given a gap's feature name / reason / recommendation, returns concrete,
 * ordered steps a customer can follow by hand in the Microsoft Entra admin
 * center — or an honest "not supported, here's the closest alternative" when
 * there is genuinely no equivalent. Keyword-matched and side-effect free, so
 * the same text is reproducible across runs (safe for the regression suite).
 *
 * Used by:
 *   - scriptGenerator (embeds the steps in gap-report.md)
 *   - the prototype server (returns structured steps to the wizard UI)
 */

export interface ManualRecreation {
  /** true = the customer can rebuild an equivalent; false = no equivalent. */
  recreatable: boolean;
  /** One-line framing shown above the steps. */
  note: string;
  /** Ordered, do-this-then-that steps. */
  steps: string[];
}

type Rule = { test: RegExp; build: () => ManualRecreation };

const RULES: Rule[] = [
  // ── Apple federation ────────────────────────────────────────────────────────
  {
    test: /\bapple\b.*(?:idp|identity|sign.?in|federat)|sign.?in.*\bapple\b/,
    build: () => ({
      recreatable: true,
      note: "External ID supports Apple federation, but Microsoft currently documents setup through the admin center rather than a supported external-tenant Graph create API.",
      steps: [
        "In Apple Developer, create or select the Sign in with Apple Services ID, key, Team ID, and Key ID.",
        "Entra admin center → External Identities → All identity providers → Apple.",
        "Enter the Apple values and register the exact redirect URL shown by the External ID setup experience.",
        "Open the target user flow → Identity providers and enable Apple.",
        "Run a real browser sign-in. Apple only returns the user's email on the first consent, so capture and verify it then.",
      ],
    }),
  },
  // ── Custom OpenID Connect federation ────────────────────────────────────────
  {
    test: /custom.*oidc|openid connect|partner.*(?:idp|identity provider)|oidc.*provider/,
    build: () => ({
      recreatable: true,
      note: "External ID supports custom OIDC federation, but the published Graph provider model is not documented for external-tenant creation. Configure it in the admin center.",
      steps: [
        "Collect the provider's well-known configuration URL, issuer URI, client ID, client secret, scopes, and claims mapping.",
        "Entra admin center → External Identities → All identity providers → Custom OIDC.",
        "Create the provider using authorization code flow and the claims required by your source policy.",
        "Open the target user flow → Identity providers and enable the new provider.",
        "Run a real browser sign-in and verify both account creation and the resulting token claims.",
      ],
    }),
  },
  // ── Passkey rollout prerequisites ──────────────────────────────────────────
  {
    test: /passkey|fido2/,
    build: () => ({
      recreatable: true,
      note: "Enabling the FIDO2 policy is only one part of an External ID passkey rollout. Passkeys use browser-delegated authentication, not native-auth APIs.",
      steps: [
        "Configure and verify a custom URL domain for the external tenant.",
        "Entra admin center → Protection → Authentication methods → Passkey (FIDO2), then verify the intended target population.",
        "Provide a credential-management experience where users can register and remove passkeys.",
        "Test registration and browser sign-in on the custom domain before production rollout.",
      ],
    }),
  },
  // ── Conditional Access validation ──────────────────────────────────────────
  {
    test: /conditional access|require mfa|step.?up/,
    build: () => ({
      recreatable: true,
      note: "Conditional Access must target the protected resource/API and should remain report-only until sign-in results are reviewed.",
      steps: [
        "Identify the application ID of the protected resource/API; do not assume the public/native client is the resource.",
        "Entra admin center → Protection → Conditional Access → Policies and open the generated report-only policy.",
        "Confirm the target resource, users, and Require multifactor authentication grant control.",
        "Review report-only sign-in logs with test users, then enable the policy only after successful MFA validation.",
      ],
    }),
  },
  // ── SMS MFA readiness ───────────────────────────────────────────────────────
  {
    test: /\bsms\b|phone.*(?:otp|mfa)|text message/,
    build: () => ({
      recreatable: true,
      note: "The tenant SMS policy can be enabled automatically, but users, billing, and telephony readiness still require validation.",
      steps: [
        "Entra admin center → Protection → Authentication methods → SMS and confirm it is enabled for the intended population.",
        "Confirm the external tenant is linked to billing/telephony as required.",
        "Register a phone method for a test customer account.",
        "Run a browser sign-in that requires MFA and confirm the SMS code completes successfully.",
      ],
    }),
  },
  // ── Password reset validation ───────────────────────────────────────────────
  {
    test: /sspr|password reset|forgot password/,
    build: () => ({
      recreatable: true,
      note: "External ID password reset is a combination of an Email + Password user flow, a verification method, and the hosted sign-in experience.",
      steps: [
        "Confirm the user flow uses Email with password for local accounts.",
        "Entra admin center → Protection → Authentication methods → Email OTP (and optionally SMS), and verify the method is enabled.",
        "Company Branding → Default sign-in experience → Sign-in form, and confirm the Forgot password link is shown.",
        "Complete one real password reset with a test customer account.",
      ],
    }),
  },
  // ── Password complexity (fixed policy in External ID) ──────────────────────
  {
    test: /password.*(complex|policy|predicate|strength)|complexity/,
    build: () => ({
      recreatable: false,
      note: "External ID enforces a fixed default password policy; B2C-style custom complexity predicates aren't configurable.",
      steps: [
        "Entra admin center → Protection → Authentication methods → Password protection.",
        "Review the default policy (length and banned-password enforcement) and add your organization's terms under Custom banned passwords.",
        "There is no per-user-flow custom complexity rule — record the difference from your B2C policy for your security review.",
      ],
    }),
  },
  // ── UI / CSS / HTML customization ──────────────────────────────────────────
  {
    test: /\bcss\b|\bhtml\b|\bui\b|user interface|advanced ui|page (layout|template)|ui customiz|look and feel/,
    build: () => ({
      recreatable: true,
      note: "External ID hosts the sign-in page (no self-hosted HTML/JavaScript). Background, logo and accent are handled by the branding step; use Company Branding + custom CSS for the rest.",
      steps: [
        "Entra admin center → Company Branding → Default sign-in experience → Edit.",
        "Set the background color/image and banner logo to match your B2C page.",
        "Under Sign-in form → Custom CSS, upload a .css file to fine-tune colors, spacing and fonts (JavaScript is not permitted).",
        "Repeat under a Company Branding language localization for each language you support.",
        "Verify by opening your app's sign-in page and comparing side-by-side with B2C.",
      ],
    }),
  },
  // ── Branding / logo / background (when not caught by the UI rule) ──────────
  {
    test: /brand|logo|background|favicon|color scheme/,
    build: () => ({
      recreatable: true,
      note: "Company Branding covers background, logo and text. The branding step in this tool writes these automatically; here is the manual equivalent.",
      steps: [
        "Entra admin center → Company Branding → Default sign-in experience → Edit.",
        "Upload the banner logo and set the page background color/image.",
        "Add footer links and sign-in page text to match your B2C experience.",
        "Save and preview via your app's sign-in page.",
      ],
    }),
  },
  // ── Localization / languages ───────────────────────────────────────────────
  {
    test: /localiz|language|\bi18n\b|translat/,
    build: () => ({
      recreatable: true,
      note: "External ID localizes the sign-in experience through Company Branding language localizations.",
      steps: [
        "Entra admin center → Company Branding → Add browser language.",
        "For each language, set the localized text, logo and background.",
        "For user-flow attribute labels, edit the attribute display strings per language under the user flow's page layouts.",
        "Test by appending ?ui_locales=<lang> to a sign-in request.",
      ],
    }),
  },
  // ── REST API validation / API connectors ───────────────────────────────────
  {
    test: /rest ?api|api connector|external.*api|validat.*api|api.*validat|orchestration.*rest/,
    build: () => ({
      recreatable: true,
      note: "B2C REST API calls / API connectors map to External ID custom authentication extensions (an Azure Function you own).",
      steps: [
        "Build an HTTP-triggered Azure Function that implements your validation/enrichment logic (start from the RESTful profile's request/response contract).",
        "Entra admin center → External Identities → Custom authentication extensions → Create (OnAttributeCollectionSubmit or OnTokenIssuanceStart).",
        "Point the extension at your Function URL and register the API app + permissions it requires.",
        "Attach the extension to your user flow and test the end-to-end sign-up.",
        "Note: this is developer work (Phase 2) — the generated scripts do not create the Function for you.",
      ],
    }),
  },
  // ── Custom / token signing certificate ─────────────────────────────────────
  {
    test: /signing (cert|certificate|key)|token signing|custom.*cert|\bx509\b/,
    build: () => ({
      recreatable: false,
      note: "External ID manages token signing keys for you — you cannot upload a custom signing certificate as in B2C.",
      steps: [
        "No action is possible or needed: Microsoft rotates and manages the signing keys.",
        "Update any relying party that pinned your B2C signing certificate to instead read keys dynamically from the OpenID Connect metadata (jwks_uri).",
        "If you require customer-managed signing keys, raise it with Microsoft as a product requirement — there is no current workaround.",
      ],
    }),
  },
  // ── Custom JavaScript ──────────────────────────────────────────────────────
  {
    test: /javascript|custom script|client.?side script/,
    build: () => ({
      recreatable: false,
      note: "The Microsoft-hosted sign-in page does not allow custom JavaScript (an intentional security boundary).",
      steps: [
        "For layout/branding, use Company Branding custom CSS instead (CSS only).",
        "For fully custom UI logic, build a native-auth experience in your app using the Microsoft Authentication Library — your app then owns 100% of the UI in code.",
        "Move any validation that relied on inline JS to a custom authentication extension (Azure Function).",
      ],
    }),
  },
  // ── Custom domain ──────────────────────────────────────────────────────────
  {
    test: /custom domain|vanity|\bdomain\b/,
    build: () => ({
      recreatable: true,
      note: "External ID supports custom URL domains for the sign-in endpoint.",
      steps: [
        "Verify your domain: Entra admin center → Settings → Domain names → Add custom domain.",
        "Configure a custom URL domain and add the CNAME records your DNS provider requires.",
        "Update your app's authority/redirect URIs to the custom domain.",
        "Test sign-in on the custom domain before switching production traffic.",
      ],
    }),
  },
  // ── Custom email / SMS provider ────────────────────────────────────────────
  {
    test: /email provider|sms provider|notification provider|custom.*(email|sms)|third.?party.*(email|sms)/,
    build: () => ({
      recreatable: true,
      note: "External ID sends OTP email/SMS through Microsoft by default; a custom provider requires a notification-provider extension.",
      steps: [
        "For default delivery: Entra admin center → Protection → Authentication methods → Email OTP / SMS, and enable the method.",
        "For a custom provider, implement a custom email/SMS provider extension (Azure Function) and register it as a notification extension.",
        "Attach the extension and send a test OTP to confirm delivery.",
      ],
    }),
  },
];

const GENERIC: ManualRecreation = {
  recreatable: true,
  note: "No dedicated automation yet — configure this manually in the Entra admin center.",
  steps: [
    "Open the Microsoft Entra admin center and locate the matching setting (External Identities, user flows, or Protection).",
    "Recreate the behavior described in the recommendation above as closely as the platform allows.",
    "If the capability has no direct equivalent, capture the gap for your migration sign-off.",
  ],
};

/** Derive manual recreation guidance for a gap from its text. */
export function manualRecreationSteps(feature: string, reason: string, recommendation: string): ManualRecreation {
  const hay = `${feature} ${reason} ${recommendation}`.toLowerCase();
  for (const rule of RULES) {
    if (rule.test.test(hay)) return rule.build();
  }
  return GENERIC;
}
