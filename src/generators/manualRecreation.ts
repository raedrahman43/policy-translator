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
  /** Optional UI/report heading when these are validation rather than recreation steps. */
  heading?: string;
  /** Ordered, do-this-then-that steps. */
  steps: string[];
}

type Rule = {
  test: RegExp;
  build: () => ManualRecreation;
  followUpType?: "validation";
};

const RULES: Rule[] = [
  // ── Validation-only follow-ups for automated resources ─────────────────────
  {
    test: /(?:signin|signup)_idp_google.*(?:can(?:not|'t) validate|real google|live provider validation)/,
    followUpType: "validation",
    build: () => ({
      recreatable: true,
      heading: "How to validate this automated result",
      note: "Google was configured automatically; the remaining work is a real provider journey and token check.",
      steps: [
        "Start the target application's hosted sign-up/sign-in flow.",
        "Choose Google and complete provider authentication with a test account.",
        "Confirm the External ID user is created or linked as expected.",
        "Decode the issued token and verify required claims and values.",
      ],
    }),
  },
  {
    test: /(?:signin|signup)_idp_facebook.*(?:can(?:not|'t) validate|real facebook|live provider validation)/,
    followUpType: "validation",
    build: () => ({
      recreatable: true,
      heading: "How to validate this automated result",
      note: "Facebook was configured automatically; the remaining work is a real provider journey and token check.",
      steps: [
        "Start the target application's hosted sign-up/sign-in flow.",
        "Choose Facebook and complete provider authentication with a test account.",
        "Confirm the External ID user is created or linked as expected.",
        "Decode the issued token and verify required claims and values.",
      ],
    }),
  },
  {
    test: /global_ux_tenantbranding.*(?:hosted.*sign-in|successful graph write|hosted-page validation|verify the real)/,
    followUpType: "validation",
    build: () => ({
      recreatable: true,
      heading: "How to validate this automated result",
      note: "Branding was applied through the guided experience; validate the actual Microsoft-hosted page rather than the local preview alone.",
      steps: [
        "Open the real application sign-in URL in a private browser session.",
        "Verify logos, background, colors, text, localizations, and custom CSS.",
        "Test desktop and mobile viewport behavior.",
        "Record any difference between the preview and hosted result before rollout.",
      ],
    }),
  },
  {
    test: /global_token_claimsmapping.*(?:successful claims-mapping write|token comparison|expected token contract|verify.*token)/,
    followUpType: "validation",
    build: () => ({
      recreatable: true,
      heading: "How to validate this automated result",
      note: "The claims mapping policy was configured; only a real application token proves the contract.",
      steps: [
        "Sign in through the target application and request the intended token audience.",
        "Decode the token with a trusted local tool.",
        "Compare every expected claim name, source, type, and value with the source contract.",
        "Verify that no unnecessary or sensitive claim is exposed.",
      ],
    }),
  },
  {
    test: /passwordreset_recovery.*(?:configures sspr prerequisites|real password reset|forgot password)/,
    followUpType: "validation",
    build: () => ({
      recreatable: true,
      heading: "How to validate this automated result",
      note: "SSPR prerequisites were configured automatically; validate the complete hosted recovery journey.",
      steps: [
        "Open the target application's sign-in page and select Forgot password.",
        "Complete Email OTP or the approved recovery method.",
        "Set a new password and sign in with it.",
        "Verify branding, error handling, and audit/sign-in logs.",
      ],
    }),
  },
  {
    test: /signup_otp_email.*(?:successful graph write|real sign-up|email verification)/,
    followUpType: "validation",
    build: () => ({
      recreatable: true,
      heading: "How to validate this automated result",
      note: "Email OTP was configured automatically; validate email verification during a real sign-up.",
      steps: [
        "Start a new customer sign-up with a test email address.",
        "Receive and redeem the one-time passcode.",
        "Confirm the account is created only after successful verification.",
        "Inspect the issued token and sign-in logs.",
      ],
    }),
  },
  {
    test: /signup_attributes_custom.*(?:creates and binds|live custom-attribute validation|stored values)/,
    followUpType: "validation",
    build: () => ({
      recreatable: true,
      heading: "How to validate this automated result",
      note: "Custom attributes were created and added automatically; validate the customer-visible and stored result.",
      steps: [
        "Open the real sign-up page and verify every custom label, input type, order, and required flag.",
        "Complete a sign-up with representative values.",
        "Inspect the created user and confirm each value was written correctly.",
        "Decode the application token if any custom attributes should be emitted as claims.",
      ],
    }),
  },
  // ── Identity-broker / no-directory architecture ───────────────────────────
  {
    test: /identity broker|credential.?less|passthrough.*directory|without.*directory|no directory|does not (?:capture|own).*credentials/,
    build: () => ({
      recreatable: false,
      note: "A credential-less B2C broker is an architecture redesign, not a direct user-flow translation. External ID requires an explicit account, federation, and token-issuance model.",
      steps: [
        "Document the source of truth for credentials, MFA, SSO, user lifecycle, and token claims.",
        "Decide whether the upstream identity system should become a custom OIDC/SAML provider or remain behind a customer-owned API.",
        "Define how and when the required linked External ID directory user is provisioned and associated with the upstream identity.",
        "Map validation and external claims to supported custom authentication extension events.",
        "Test account linking, sign-in, sign-out, MFA, and token contracts end to end before rollout.",
      ],
    }),
  },
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
  // ── Google federation on a manually created flow ──────────────────────────
  {
    test: /\bgoogle\b.*(?:idp|identity provider|federat|sign.?in)|sign.?in.*\bgoogle\b/,
    build: () => ({
      recreatable: true,
      note: "Google federation is supported, but this migration shape requires the target user flow to be created or selected manually first.",
      steps: [
        "Create the intended External ID user flow and choose its primary local-account method.",
        "Configure the Google identity provider with the client ID, client secret, and redirect URIs.",
        "Enable Google on the same target user flow; a separate application is not required unless the application is already bound to an incompatible flow.",
        "Run a real Google sign-up/sign-in and verify account creation and token claims.",
      ],
    }),
  },
  // ── Facebook federation on a manually created flow ────────────────────────
  {
    test: /\bfacebook\b.*(?:idp|identity provider|federat|sign.?in)|sign.?in.*\bfacebook\b/,
    build: () => ({
      recreatable: true,
      note: "Facebook federation is supported, but this migration shape requires the target user flow to be created or selected manually first.",
      steps: [
        "Create the intended External ID user flow and choose its primary local-account method.",
        "Configure the Facebook identity provider with the app ID, app secret, and redirect URI.",
        "Enable Facebook on the same target user flow; a separate application is not required unless the application is already bound to an incompatible flow.",
        "Run a real Facebook sign-up/sign-in and verify account creation and token claims.",
      ],
    }),
  },
  // ── Inbound SAML / WS-Fed federation ──────────────────────────────────────
  {
    test: /enterprise.*saml|saml.*(?:idp|identity provider|federat)|ws-?fed/,
    build: () => ({
      recreatable: true,
      note: "External ID can federate inbound to a supported SAML or WS-Fed identity provider, but it is not a general SAML broker and cannot reproduce every B2C SAML orchestration pattern.",
      steps: [
        "Collect the identity provider metadata URL or issuer, sign-in endpoint, signing certificate, and required email/NameID claims.",
        "Confirm whether domain-based or domainless federation is required; external tenants allow only one domainless SAML provider.",
        "Configure the inbound federation in the Microsoft Entra admin center.",
        "Map the required claims and confirm a linked External ID directory user is created.",
        "Run a real sign-in and verify issuer, NameID/email, account linking, and application token behavior.",
      ],
    }),
  },
  // ── Primary Email OTP user flow ────────────────────────────────────────────
  {
    test: /signin_otp_email.*(?:did not identify|whether it is|requirements clarification|mode is unclear)/,
    build: () => ({
      recreatable: true,
      note: "The Analyzer detected Email OTP but did not identify its journey role. Policy Translator enables only the safe tenant-level method until the authentication design is clarified.",
      steps: [
        "Confirm whether Email OTP is primary passwordless sign-in, secondary MFA, sign-up verification, or password-reset verification.",
        "If primary, configure an Email OTP user flow and bind the intended application.",
        "If MFA, keep a compatible primary sign-in method and create a report-only Conditional Access policy that requires MFA.",
        "If used for password reset, verify the Email + Password flow and Forgot password experience.",
        "Run the exact end-user journey and verify the issued token before rollout.",
      ],
    }),
  },
  {
    test: /signin_otp_email.*(?:primary email otp|passwordless.*email|email.*one.?time.*primary|one.?time passcode as (?:the )?primary)/,
    build: () => ({
      recreatable: true,
      note: "The Email OTP authentication method can be enabled automatically, but Policy Translator does not currently create a user flow whose primary local-account method is Email one-time passcode.",
      steps: [
        "If the existing application is already bound to an Email + Password or passkey-bootstrap flow, create a separate application registration for the primary Email OTP journey.",
        "Entra admin center → External Identities → User flows and create or open the target sign-up/sign-in flow.",
        "Set the local account identity provider to Email with one-time passcode.",
        "Add the intended application to that flow; one application can be associated with only one user flow.",
        "Run a real passwordless sign-up and sign-in and verify the issued token.",
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
        "Confirm the target users have email/username-and-password local accounts; Email OTP and federated users can't currently register passkeys.",
        "Require and complete MFA no more than five minutes before passkey registration.",
        "Configure Azure Front Door for the external tenant and complete the custom URL domain setup.",
        "Verify the custom domain and update the application's authority and redirect configuration.",
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
  // ── External token claims / custom claims provider ─────────────────────────
  {
    test: /global_token_externalclaims|external token claims|custom claims provider|ontokenissuancestart/,
    build: () => ({
      recreatable: true,
      note: "Directory-backed claims can use claims mapping. Runtime data from external systems requires an OnTokenIssuanceStart custom claims provider plus an application claims mapping policy.",
      steps: [
        "Classify each claim as directory-backed, extension-attribute-backed, transformed, or fetched from an external system.",
        "Use claims mapping for directory-backed values and resolve the real External ID extension attribute IDs.",
        "For runtime external data, implement and secure an OnTokenIssuanceStart REST API/custom claims provider.",
        "Map the returned claim IDs into the target application's token policy.",
        "Compare a real source B2C token and target External ID token claim by claim.",
      ],
    }),
  },
  // ── Custom user-flow attributes ────────────────────────────────────────────
  {
    test: /custom (?:user |extension )?attribute|sign.?up_attributes_custom/,
    build: () => ({
      recreatable: true,
      note: "Custom user-flow attributes can be created in External ID and added to the target sign-up page once the intended user flow exists.",
      steps: [
        "Record each attribute's name, data type, display label, and required/optional behavior.",
        "Entra admin center → External Identities → Custom user attributes, and create the attributes.",
        "Open the target user flow → User attributes and add each custom attribute to the sign-up page.",
        "Configure labels, input types, ordering, and required status.",
        "Complete a real sign-up and verify the values are stored and emitted only where the application requires them.",
      ],
    }),
  },
  // ── Custom email provider ──────────────────────────────────────────────────
  {
    test: /custom email provider|custom email template|third.?party email|email notification provider|byo email/,
    build: () => ({
      recreatable: true,
      note: "External ID supports a custom OTP email provider through the OnOtpSend custom authentication extension.",
      steps: [
        "Implement a public REST endpoint or Azure Function that validates the Entra call token and sends the supplied OTP through the approved email provider.",
        "Create an OnOtpSend custom authentication extension and associate the endpoint/application registration.",
        "Create an onEmailOtpSend event listener and assign it to the target applications or tenant scope.",
        "Test sign-up, sign-in, MFA, and password-reset email scenarios that use OTP.",
      ],
    }),
  },
  // ── Custom SMS provider ────────────────────────────────────────────────────
  {
    test: /sms provider|custom.*sms|third.?party.*sms|sms.*notification provider/,
    build: () => ({
      recreatable: false,
      note: "External ID currently uses Microsoft's SMS delivery path and does not expose an OnOtpSend-equivalent event for replacing it with a custom SMS provider.",
      steps: [
        "Confirm whether Microsoft-managed SMS satisfies the requirement.",
        "If custom SMS routing is mandatory, record it as a platform gap and redesign the surrounding customer communication outside the authentication OTP pipeline.",
        "Do not claim that an Azure Function can replace the built-in SMS MFA sender.",
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
    test: /localiz|language|\bi18n\b|translation/,
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
export function manualRecreationSteps(
  feature: string,
  reason: string,
  recommendation: string,
  followUpType?: "validation" | "manual" | "redesign",
): ManualRecreation {
  const hay = `${feature} ${reason} ${recommendation}`.toLowerCase();
  for (const rule of RULES) {
    if (rule.followUpType === "validation" && followUpType !== "validation") continue;
    if (rule.test.test(hay)) return rule.build();
  }
  return GENERIC;
}
