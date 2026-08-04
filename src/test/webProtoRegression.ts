import assert from "assert";

import {
  brandingWriteStepResult,
  caPolicyMatches,
  executeApply,
  flowHasAppBinding,
  flowHasEmailPasswordProvider,
  isReplicationError,
} from "../web-proto/graphExecutor";
import { describeTokenError, fetchBytes, graph, GraphError } from "../web-proto/graphClient";
import {
  analyze,
  buildFinalBranding,
  realApplyFollowUps,
  simulationFollowUps,
} from "../web-proto/server";
import { generate } from "../web/server";
import { manualRecreationSteps } from "../generators/manualRecreation";
import { classifyEmailOtpMode } from "../mappers/featureMap";
const { mergeApplyGapItems } = require("../web-proto/public/followUpMerge.js");

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(status === 204 ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
  });
}

async function testAuthenticationMethodVerification(): Promise<void> {
  let reads = 0;
  let patches = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = String(init?.method || "GET");
    if (url.endsWith("/authenticationMethodConfigurations/Sms") && method === "GET") {
      reads++;
      return jsonResponse({
        "@odata.type": "#microsoft.graph.smsAuthenticationMethodConfiguration",
        state: reads === 1 ? "disabled" : "enabled",
      });
    }
    if (url.endsWith("/authenticationMethodConfigurations/Sms") && method === "PATCH") {
      patches++;
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.state, "enabled");
      return jsonResponse({}, 204);
    }
    throw new Error(`Unexpected authentication-method call: ${method} ${url}`);
  }) as typeof fetch;

  const result = await executeApply(
    ["enable-sms-mfa"],
    { tenantId: "11111111-1111-1111-1111-111111111111" },
    "test-token",
  );
  assert.equal(result.applied[0]?.status, "created");
  assert.equal(reads, 2);
  assert.equal(patches, 1);
}

async function testAnalyzeContext(): Promise<void> {
  const raw = {
    policyName: "B2C_1A_ContextTest",
    features: [
      {
        name: "signUp_auth_emailPassword",
        reason: "Email password sign-up detected",
        recommendation: "Use an External ID user flow",
        externalIdAvailability: "Available",
      },
      {
        name: "signIn_auth_emailPassword",
        reason: "Email password sign-in detected",
        recommendation: "Use an External ID user flow",
        externalIdAvailability: "Available",
      },
      {
        name: "signUp_attributes_standard",
        reason: "Collect givenName and surname",
        recommendation: "Use built-in attributes",
        externalIdAvailability: "Available",
      },
      {
        name: "signIn_otp_phoneSms",
        reason: "SMS phone factor detected for MFA",
        recommendation: "Enable SMS authentication method",
        externalIdAvailability: "Available",
      },
      {
        name: "global_ux_tenantBranding",
        reason: "Company branding detected",
        recommendation: "Use Company Branding",
        externalIdAvailability: "Available",
        backgroundColor: "#112233",
        logoUrl: "https://cdn.example.com/logo.png",
      },
      {
        name: "signIn_idp_customOidc",
        reason: "Custom OIDC provider detected",
        recommendation: "Configure custom OIDC",
        externalIdAvailability: "Available",
      },
      {
        name: "signIn_idp_apple",
        reason: "Apple provider detected",
        recommendation: "Configure Apple",
        externalIdAvailability: "Available",
      },
    ],
  };

  const result = analyze(raw);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Analyzer unexpectedly failed.");
  const context = result.body.context;
  assert(context.attributes.some((attribute) => attribute.id === "givenName"));
  assert(!context.attributes.some((attribute) => attribute.id === "mobilePhone"));
  assert.equal(context.branding?.hasSignal, true);
  assert.equal(context.branding?.hasConcreteValues, true);
  assert.equal(context.branding?.backgroundColor, "#112233");
  assert(!result.body.steps.some((step) => ["add-oidc-idp", "add-apple-idp"].includes(String(step.kind))));
  assert(result.body.gaps.some((gap) => gap.feature === "signIn_idp_customOidc"));
  assert(result.body.gaps.some((gap) => gap.feature === "signIn_idp_apple"));

  const phoneResult = analyze({
    policyName: "B2C_1A_PhoneAttribute",
    features: [
      {
        name: "signUp_auth_emailPassword",
        reason: "Email password sign-up detected",
        recommendation: "Use an External ID user flow",
        externalIdAvailability: "Available",
      },
      {
        name: "signUp_attributes_standard",
        reason: "Collect mobile phone during sign-up",
        recommendation: "Use built-in attributes",
        externalIdAvailability: "Available",
      },
    ],
  });
  assert.equal(phoneResult.ok, true);
  if (!phoneResult.ok) throw new Error("Phone attribute fixture unexpectedly failed.");
  assert(phoneResult.body.context.attributes.some((attribute) => attribute.id === "mobilePhone"));
  assert(!phoneResult.body.context.attributes.some((attribute) => attribute.id === "phoneNumber"));

  const enrichedResult = analyze({
    policyName: "B2C_1A_EnrichedMetadata",
    features: [
      {
        name: "global_ux_advancedUiCustomization",
        reason: "Custom HTML detected",
        recommendation: "Use branding and Native Auth.",
        notes: "Use the Native Auth SDK when full UI ownership is required.",
        docLink: "https://learn.microsoft.com/en-us/entra/identity-platform/concept-native-authentication",
        externalIdAvailability: "RequiresCustomDevelopment",
      },
      {
        name: "global_token_externalClaims",
        reason: "External token claims detected",
        recommendation: "Use claims mapping or a custom claims provider.",
        notes: "Use OnTokenIssuanceStart to fetch claims from an external API.",
        docLink: "https://learn.microsoft.com/en-us/entra/identity-platform/custom-extension-overview",
        externalIdAvailability: "Available",
      },
      {
        name: "signIn_security_preventDisabledSocialLogon",
        reason: "accountEnabled check detected",
        recommendation: "Block disabled users.",
        notes: "Analyzer suggested a custom extension.",
        docLink: "https://learn.microsoft.com/en-us/entra/external-id/customers/concept-custom-extensions",
        externalIdAvailability: "RequiresCustomDevelopment",
      },
    ],
    migrationSummary: {
      readinessScore: "Medium",
      totalFeaturesDetected: 3,
      available: 1,
      requiresCustomDevelopment: 2,
      migrationBlockers: [],
      migrationWarnings: [],
      quickWins: ["global_token_externalClaims"],
      overallRecommendation: "Moderate effort.",
    },
  });
  assert.equal(enrichedResult.ok, true);
  if (!enrichedResult.ok) throw new Error("Enriched metadata fixture unexpectedly failed.");
  assert.equal(enrichedResult.body.readiness.score, "Low");
  assert.equal(enrichedResult.body.readiness.analyzerScore, "Medium");
  const customUi = enrichedResult.body.features.find((feature) => feature.name === "global_ux_advancedUiCustomization");
  assert.equal(customUi?.status, "RequiresCustomDevelopment");
  assert(customUi?.guidance.includes("Native Auth SDK"));
  assert(customUi?.docLink?.includes("learn.microsoft.com"));
  const externalClaims = enrichedResult.body.features.find((feature) => feature.name === "global_token_externalClaims");
  assert.equal(externalClaims?.status, "Partial");
  const externalClaimsGap = enrichedResult.body.gaps.find((gap) => gap.feature === "global_token_externalClaims");
  assert(externalClaimsGap?.notes?.includes("OnTokenIssuanceStart"));
  assert(externalClaimsGap?.docLink?.includes("learn.microsoft.com"));
  const disabledAccount = enrichedResult.body.features.find((feature) => feature.name === "signIn_security_preventDisabledSocialLogon");
  assert.equal(disabledAccount?.status, "NoAction");
  assert(disabledAccount?.guidance.includes("natively blocks disabled accounts"));

  const mixedOtpResult = analyze({
    policyName: "B2C_1A_MixedEmailOtp",
    features: [
      {
        name: "signIn_auth_emailPassword",
        reason: "Email password sign-in detected",
        recommendation: "Use an External ID user flow.",
        externalIdAvailability: "Available",
      },
      {
        name: "signIn_otp_email",
        description: "Passwordless primary sign-in with email one-time passcode",
        reason: "Users sign in using a one-time passcode each time",
        recommendation: "Use Email OTP as primary sign-in.",
        externalIdAvailability: "Available",
      },
      {
        name: "signIn_otp_email",
        description: "MFA via email OTP",
        reason: "Email OTP is required as a second factor",
        recommendation: "Require MFA.",
        externalIdAvailability: "Available",
      },
    ],
  });
  assert.equal(mixedOtpResult.ok, true);
  if (!mixedOtpResult.ok) throw new Error("Mixed Email OTP fixture unexpectedly failed.");
  const otpRows = mixedOtpResult.body.features.filter((feature) => feature.name === "signIn_otp_email");
  assert.deepEqual(otpRows.map((feature) => feature.status), ["Partial", "Partial"]);

  const duplicatePrimaryOtpResult = analyze({
    policyName: "B2C_1A_DuplicatePrimaryEmailOtp",
    features: [
      {
        name: "signIn_otp_email",
        description: "Passwordless primary sign-in with email one-time passcode",
        reason: "Users sign in using an email one-time passcode each time",
        recommendation: "Use Email OTP as primary sign-in.",
        externalIdAvailability: "Available",
      },
      {
        name: "signIn_otp_email",
        description: "Primary Email OTP for another relying-party journey",
        reason: "One-time passcode is the primary sign-in method",
        recommendation: "Use Email OTP as primary sign-in.",
        externalIdAvailability: "Available",
      },
    ],
  });
  assert.equal(duplicatePrimaryOtpResult.ok, true);
  if (!duplicatePrimaryOtpResult.ok) throw new Error("Duplicate primary Email OTP fixture unexpectedly failed.");
  assert.deepEqual(
    duplicatePrimaryOtpResult.body.features
      .filter((feature) => feature.name === "signIn_otp_email")
      .map((feature) => feature.status),
    ["Partial", "Partial"],
  );
  assert.equal(duplicatePrimaryOtpResult.body.readiness.percent, 0);
  assert.equal(duplicatePrimaryOtpResult.body.readiness.needsWork, 2);
  assert.deepEqual(
    duplicatePrimaryOtpResult.body.gaps
      .filter((gap) => gap.feature === "signIn_otp_email")
      .map((gap) => gap.featureOccurrence),
    [1, 2],
  );

  const primaryOtpAttributesResult = analyze({
    policyName: "B2C_1A_PrimaryOtpAttributes",
    features: [
      {
        name: "signIn_otp_email",
        description: "Passwordless primary sign-in with email one-time passcode",
        reason: "Users sign in using an email one-time passcode each time",
        recommendation: "Use Email OTP as primary sign-in.",
        externalIdAvailability: "Available",
      },
      {
        name: "signUp_attributes_custom",
        description: "Collect extension_loyaltyTier",
        reason: "Custom attribute extension_loyaltyTier detected",
        recommendation: "Create the custom attribute on the primary OTP flow.",
        externalIdAvailability: "Available",
      },
    ],
  });
  assert.equal(primaryOtpAttributesResult.ok, true);
  if (!primaryOtpAttributesResult.ok) throw new Error("Primary OTP attribute fixture unexpectedly failed.");
  const primaryOtpAttributeGap = primaryOtpAttributesResult.body.gaps.find(
    (gap) => gap.feature === "signUp_attributes_custom",
  );
  assert.deepEqual(primaryOtpAttributeGap?.actionKinds, []);
  assert.notEqual(
    primaryOtpAttributeGap?.manual.heading,
    "How to validate this automated result",
  );

  const duplicateAttributesResult = analyze({
    policyName: "B2C_1A_DuplicateCustomAttributes",
    features: [
      {
        name: "signUp_attributes_custom",
        description: "Collect extension_loyaltyTier",
        reason: "Custom attribute extension_loyaltyTier detected",
        recommendation: "Create a custom attribute.",
        externalIdAvailability: "Available",
      },
      {
        name: "signUp_attributes_custom",
        description: "Collect extension_membershipLevel",
        reason: "Custom attribute extension_membershipLevel detected",
        recommendation: "Create a custom attribute.",
        externalIdAvailability: "Available",
      },
    ],
  });
  assert.equal(duplicateAttributesResult.ok, true);
  if (!duplicateAttributesResult.ok) throw new Error("Duplicate custom-attribute fixture unexpectedly failed.");
  assert.deepEqual(
    duplicateAttributesResult.body.context.customAttributes.map((attribute) => attribute.name).sort(),
    ["loyaltyTier", "membershipLevel"],
  );

  const brokerResult = analyze({
    policyName: "B2C_1A_DirectorylessBroker",
    features: [
      {
        name: "global_token_passthroughNoDirectory",
        reason: "The journey issues a token without a directory-backed user.",
        recommendation: "Redesign the identity broker.",
        externalIdAvailability: "Available",
      },
    ],
  });
  assert.equal(brokerResult.ok, true);
  if (!brokerResult.ok) throw new Error("Broker fixture unexpectedly failed.");
  assert.equal(brokerResult.body.features[0]?.status, "ArchitectureIncompatible");
  assert.equal(brokerResult.body.readiness.ready, 0);

  assert(
    describeTokenError({
      error: "access_denied",
      error_description: "AADSTS530035: Access has been blocked by security defaults.",
    }).includes("Do not disable production security controls"),
  );
  assert(
    describeTokenError({
      error: "access_denied",
      error_description: "AADSTS530035: Access has been blocked by security defaults.",
    }, "branding-import").includes("manual branding controls"),
  );
  assert(
    describeTokenError({
      error: "access_denied",
      error_description: "AADSTS530035: Access has been blocked by security defaults.",
    }, "apply-with-branding").includes("must be applied manually"),
  );
  assert.equal(
    flowHasAppBinding(
      { conditions: { applications: { includeApplications: [{ appId: "app-1" }] } } },
      "app-1",
    ),
    true,
  );
  assert.equal(flowHasAppBinding({ conditions: { applications: { includeApplications: [] } } }, "app-1"), false);
  assert.equal(
    isReplicationError(new GraphError(400, {
      error: { code: "Request_BadRequest", message: "The application is not visible yet because replication is pending." },
    })),
    true,
  );
  assert.equal(flowHasEmailPasswordProvider({
    onAuthenticationMethodLoadStart: { identityProviders: [{ id: "EmailPassword-OAUTH" }] },
  }), true);
  assert.equal(flowHasEmailPasswordProvider({
    onAuthenticationMethodLoadStart: { identityProviders: [{ id: "EmailOtp-OAUTH" }] },
  }), false);
  assert.equal(caPolicyMatches({
    conditions: {
      applications: { includeApplications: ["api-1"], excludeApplications: [] },
      users: { includeUsers: ["All"], excludeUsers: [], includeGroups: [], excludeGroups: [], includeRoles: [], excludeRoles: [] },
      clientAppTypes: ["all"],
    },
    grantControls: { operator: "OR", builtInControls: ["mfa"] },
  }, "api-1"), true);
  assert.equal(caPolicyMatches({
    conditions: {
      applications: { includeApplications: ["api-1"], excludeApplications: [] },
      users: { includeUsers: ["All"] },
      clientAppTypes: ["exchangeActiveSync"],
    },
    grantControls: { operator: "OR", builtInControls: ["mfa"] },
  }, "api-1"), false);
  assert.equal(caPolicyMatches({
    conditions: {
      applications: {
        includeApplications: ["api-1"],
        excludeApplications: [],
        applicationFilter: { mode: "exclude", rule: "CustomSecurityAttribute.foo -eq 'bar'" },
      },
      users: { includeUsers: ["All"] },
      clientAppTypes: ["all"],
    },
    grantControls: { operator: "OR", builtInControls: ["mfa"] },
  }, "api-1"), false);
  assert.equal(caPolicyMatches({
    conditions: {
      applications: { includeApplications: ["api-1"], excludeApplications: [] },
      users: {
        includeUsers: ["All"],
        excludeUsers: [],
        includeGuestsOrExternalUsers: { guestOrExternalUserTypes: "b2bCollaborationGuest" },
      },
      clientAppTypes: ["all"],
    },
    grantControls: { operator: "OR", builtInControls: ["mfa"] },
  }, "api-1"), false);

  const broker = manualRecreationSteps(
    "global_token_passthroughNoDirectory",
    "B2C does not own credentials and acts as an identity broker",
    "Redesign the account model.",
  );
  assert.equal(broker.recreatable, false);

  const saml = manualRecreationSteps(
    "signIn_idp_enterpriseSaml",
    "ForgeRock SAML identity provider detected",
    "Configure inbound SAML federation.",
  );
  assert.equal(saml.recreatable, true);

  const customSms = manualRecreationSteps(
    "global_ux_customSmsTemplate",
    "Custom SMS provider detected",
    "Use the customer SMS provider.",
  );
  assert.equal(customSms.recreatable, false);

  const googleManual = manualRecreationSteps(
    "signIn_idp_google",
    "Google federation requires a manually selected primary Email OTP flow",
    "Configure Google on the same flow.",
  );
  assert(googleManual.steps.some((step) => step.includes("same target user flow")));

  const googleValidation = manualRecreationSteps(
    "signIn_idp_google",
    "Graph can't validate the Google provider secret or customer-visible outcome.",
    "Complete a real Google sign-up/sign-in.",
    "validation",
  );
  assert.equal(googleValidation.heading, "How to validate this automated result");
  assert(!googleValidation.steps.some((step) => step.includes("Configure the Google identity provider")));

  const googleReadiness = analyze({
    policyName: "B2C_1A_GoogleValidation",
    features: [{
      name: "signIn_idp_google",
      reason: "Google identity provider detected.",
      recommendation: "Configure Google.",
      externalIdAvailability: "Available",
    }],
  });
  assert.equal(googleReadiness.ok, true);
  if (!googleReadiness.ok) throw new Error("Google validation fixture unexpectedly failed.");
  assert.equal(googleReadiness.body.features[0]?.status, "Available");
  assert.equal(
    googleReadiness.body.features[0]?.statusLabel,
    "Automated; live validation required",
  );
  assert.equal(googleReadiness.body.readiness.percent, 100);
  assert.deepEqual(googleReadiness.body.gaps[0]?.actionKinds, ["add-google-idp"]);
  assert.equal(googleReadiness.body.gaps[0]?.followUpType, "validation");

  const brandingValidation = manualRecreationSteps(
    "global_ux_tenantBranding",
    "A successful Graph write does not prove the browser-hosted sign-in page.",
    "Verify the real hosted sign-in page.",
    "validation",
  );
  assert.equal(brandingValidation.heading, "How to validate this automated result");

  const customAttributeManual = manualRecreationSteps(
    "signUp_attributes_custom",
    "Custom attribute extension_loyaltyTier must be added to a primary Email OTP flow",
    "Create the custom attribute.",
  );
  assert(customAttributeManual.steps.some((step) => step.includes("Custom user attributes")));
  assert(!customAttributeManual.steps.some((step) => step.includes("OnOtpSend")));

  const externalClaimsManual = manualRecreationSteps(
    "global_token_externalClaims",
    "Custom extension attributes and external token claims detected",
    "Use an OnTokenIssuanceStart custom claims provider.",
  );
  assert(externalClaimsManual.steps.some((step) => step.includes("OnTokenIssuanceStart")));
  assert(!externalClaimsManual.steps.some((step) => step.includes("sign-up page")));

  const customSmsResult = analyze({
    policyName: "B2C_1A_CustomSms",
    features: [{
      name: "global_ux_customSmsTemplate",
      reason: "Custom SMS provider and template detected",
      recommendation: "Use the customer SMS provider.",
      externalIdAvailability: "Available",
    }],
  });
  assert.equal(customSmsResult.ok, true);
  if (!customSmsResult.ok) throw new Error("Custom SMS fixture unexpectedly failed.");
  assert.equal(customSmsResult.body.features[0]?.status, "NotCurrentlySupported");

  const ambiguousOtpManual = manualRecreationSteps(
    "signIn_otp_email",
    "The Analyzer did not identify whether it is primary passwordless sign-in or secondary MFA.",
    "Clarify the Email OTP mode before changing the flow or Conditional Access.",
  );
  assert(ambiguousOtpManual.steps[0]?.includes("Confirm whether Email OTP"));
  assert(!ambiguousOtpManual.steps.some((step) => step.includes("open the generated report-only policy")));

  const ambiguousOtpResult = analyze({
    policyName: "B2C_1A_AmbiguousOtp",
    features: [{
      name: "signIn_otp_email",
      description: "Email OTP usage",
      reason: "The Analyzer did not identify whether it is primary passwordless sign-in or secondary MFA.",
      recommendation: "Clarify the journey.",
      externalIdAvailability: "Available",
    }],
  });
  assert.equal(ambiguousOtpResult.ok, true);
  if (!ambiguousOtpResult.ok) throw new Error("Ambiguous OTP fixture unexpectedly failed.");
  assert.equal(ambiguousOtpResult.body.features[0]?.status, "Partial");
  assert(!ambiguousOtpResult.body.steps.some((step) => step.kind === "create-ca-policy"));
  assert(!ambiguousOtpResult.body.steps.some((step) => step.kind === "create-user-flow-emailpassword"));
  assert.equal(classifyEmailOtpMode({
    name: "signIn_otp_email",
    reason: "Email OTP is not an MFA factor",
    recommendation: "Clarify usage.",
    externalIdAvailability: "Available",
  }), "unspecified");
  assert.equal(classifyEmailOtpMode({
    name: "signIn_otp_email",
    reason: "Email OTP is used for multi-factor authentication as a second-factor",
    recommendation: "Require MFA.",
    externalIdAvailability: "Available",
  }), "mfa");

  assert(simulationFollowUps(
    ["add-google-idp", "claims-mapping-policy", "enable-sspr"],
    [],
  ).some((followUp) => followUp.label === "Claims mapping policy"));
  assert(!simulationFollowUps(
    ["enable-email-otp"],
    [],
  ).some((followUp) => followUp.label === "Email OTP authentication method"));
  assert(simulationFollowUps(
    ["create-native-app", "enable-email-otp"],
    ["enable-email-otp"],
  ).some((followUp) => followUp.label === "Email OTP authentication method"));

  const successfulGoogleFollowUp = realApplyFollowUps([{
    kind: "add-google-idp",
    label: "Google identity provider",
    status: "created",
    message: "Graph can't validate the provider secret; complete a real Google sign-in.",
    requiresFollowUp: true,
  }], []);
  assert.equal(
    successfulGoogleFollowUp[0]?.manual.heading,
    "How to validate this automated result",
  );

  const failedGoogleFollowUp = realApplyFollowUps([{
    kind: "add-google-idp",
    label: "Google identity provider",
    status: "failed",
    message: "Permission denied by Microsoft Graph (403).",
  }], []);
  assert.notEqual(
    failedGoogleFollowUp[0]?.manual.heading,
    "How to validate this automated result",
  );
  assert(
    failedGoogleFollowUp[0]?.manual.steps.some((step) =>
      step.includes("Configure the Google identity provider")
    ),
  );

  const failedEmailOtpFollowUps = realApplyFollowUps([{
    kind: "enable-email-otp",
    label: "Email one-time-passcode method",
    status: "failed",
    message: "Permission denied by Microsoft Graph (403).",
  }], ["enable-email-otp"]);
  assert.equal(failedEmailOtpFollowUps.length, 1);
  assert(!failedEmailOtpFollowUps[0]?.reason.includes("Email OTP is enabled"));

  const mergedFailedGoogle = mergeApplyGapItems({
    analysisGaps: [{
      label: "Google",
      reason: "Complete a real Google sign-in.",
      followUpType: "validation",
      actionKinds: ["add-google-idp"],
      manual: googleValidation,
    }],
    runtimeFollowUps: failedGoogleFollowUp,
    applied: [{
      kind: "add-google-idp",
      status: "failed",
    }],
  });
  assert.equal(mergedFailedGoogle.length, 2);
  assert.equal(mergedFailedGoogle[0]?.label, "Google identity provider");
  assert.equal(
    mergedFailedGoogle[0]?.manual.heading,
    "How to resolve and complete this capability",
  );
  const failedGoogleAnalysis = mergedFailedGoogle.find((item: any) => item.label === "Google");
  assert.equal(
    failedGoogleAnalysis?.manual.heading,
    "How to resolve and complete this capability",
  );
  assert(
    failedGoogleAnalysis?.manual.steps.some((step: string) =>
      step.includes("complete provider authentication")
    ),
  );

  const mergedDeselectedGoogle = mergeApplyGapItems({
    analysisGaps: [{
      label: "Google",
      reason: "Complete a real Google sign-in.",
      followUpType: "validation",
      actionKinds: ["add-google-idp"],
      manual: googleValidation,
    }],
    runtimeFollowUps: [],
    applied: [],
  });
  assert.equal(
    mergedDeselectedGoogle[0]?.manual.heading,
    "How to complete this unselected capability",
  );
  assert(mergedDeselectedGoogle[0]?.reason.includes("not selected or applied"));

  const primaryOtpManual = manualRecreationSteps(
    "signIn_otp_email",
    "Primary Email OTP requires a dedicated passwordless user flow.",
    "Create and bind the primary Email OTP user flow.",
    "manual",
  );
  const mergedFailedPrimaryOtp = mergeApplyGapItems({
    analysisGaps: [{
      label: "Primary Email OTP user flow",
      reason: "Create and bind the primary Email OTP user flow.",
      followUpType: "manual",
      actionKinds: ["enable-email-otp"],
      manual: primaryOtpManual,
    }],
    runtimeFollowUps: failedEmailOtpFollowUps,
    applied: [{
      kind: "enable-email-otp",
      status: "failed",
    }],
  });
  assert.equal(mergedFailedPrimaryOtp.length, 2);
  assert(
    mergedFailedPrimaryOtp
      .find((item: any) => item.label === "Primary Email OTP user flow")
      ?.manual.steps.some((step: string) => step.includes("primary Email OTP")),
  );

  const caManual = manualRecreationSteps(
    "signIn_security_conditionalAccess",
    "The report-only policy requires customer-specific scope decisions.",
    "Review the generated report-only policy before enforcement.",
    "manual",
  );
  const plannedCa = mergeApplyGapItems({
    analysisGaps: [{
      label: "Conditional Access",
      reason: "Review the generated report-only policy.",
      followUpType: "manual",
      actionKinds: ["create-ca-policy"],
      manual: caManual,
    }],
    runtimeFollowUps: simulationFollowUps(["create-ca-policy"], []),
    applied: [{
      kind: "create-ca-policy",
      status: "planned",
    }],
    simulated: true,
  });
  const plannedCaAnalysis = plannedCa.find((item: any) => item.label === "Conditional Access");
  const plannedCaRuntime = plannedCa.find((item: any) => item.label === "Conditional Access policy");
  assert.equal(
    plannedCaRuntime?.manual.heading,
    "How to validate after applying this plan",
  );
  assert.equal(
    plannedCaAnalysis?.manual.heading,
    "How to validate after applying this plan",
  );
  assert.equal(
    plannedCaAnalysis?.manual.steps[0],
    "Apply the selected action to the target External ID tenant.",
  );

  const failedAppRuntime = mergeApplyGapItems({
    runtimeFollowUps: realApplyFollowUps([{
      kind: "create-native-app",
      label: "Native app registration",
      status: "failed",
      message: "Permission denied by Microsoft Graph (403).",
    }], []),
    applied: [{
      kind: "create-native-app",
      status: "failed",
    }],
  });
  assert.equal(
    failedAppRuntime[0]?.manual.heading,
    "How to resolve and complete this capability",
  );
}

function testBrandingIntent(): void {
  assert.equal(
    buildFinalBranding({
      brandingIntent: false,
      brandingManual: { enabled: true, bg: "#f3f6fb", accent: "#0067b8" },
    }),
    undefined,
  );

  const source = { hasBranding: true, backgroundColor: "#101010", customCss: "source-css" };
  assert.deepEqual(
    buildFinalBranding({
      brandingIntent: true,
      brandingMode: "preserve",
      branding: source,
      brandingManual: { enabled: false, accent: "#0067b8" },
    }),
    source,
  );

  const modernized = buildFinalBranding({
    brandingIntent: true,
    brandingMode: "modernize",
    branding: source,
    brandingManual: { enabled: true, accent: "#cc3300" },
  });
  assert(modernized?.customCss?.includes("#cc3300"));

  const partialWrite = brandingWriteStepResult({
    written: ["colors/text"],
    skipped: [],
    errors: ["banner logo: upload failed"],
  });
  assert.equal(partialWrite.status, "failed");
  assert(partialWrite.message?.includes("only partially applied"));
  assert.equal(partialWrite.requiresFollowUp, undefined);
  const partialFollowUp = realApplyFollowUps([partialWrite], []);
  assert.equal(partialFollowUp.length, 1);
  assert.notEqual(
    partialFollowUp[0]?.manual.heading,
    "How to validate this automated result",
  );

  const completeWrite = brandingWriteStepResult({
    written: ["colors/text", "banner logo"],
    skipped: [],
    errors: [],
  });
  assert.equal(completeWrite.status, "created");
  assert.equal(completeWrite.requiresFollowUp, true);
}

async function testGraphRetry(): Promise<void> {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1
      ? jsonResponse({ error: { code: "TooManyRequests", message: "retry" } }, 429, { "Retry-After": "0" })
      : jsonResponse({ value: "ok" });
  }) as typeof fetch;

  const result = await graph<{ value: string }>("GET", "/v1.0/test", "test-token");
  assert.equal(result.value, "ok");
  assert.equal(calls, 2);
}

async function testInlineBrandingAsset(): Promise<void> {
  const image = await fetchBytes("data:image/png;base64,aGVsbG8=");
  assert.equal(image.contentType, "image/png");
  assert.equal(image.bytes.toString("utf8"), "hello");
  await assert.rejects(() => fetchBytes("data:text/plain;base64,aGVsbG8="), /must be an image/);
  await assert.rejects(
    () => fetchBytes("https://[::ffff:172.16.0.1]/logo.png"),
    /private or local network address/,
  );
}

function testPowerShellEscaping(): void {
  const result = generate({
    policyName: "B2C_1A_Escape",
    features: [
      {
        name: "signUp_auth_emailPassword",
        reason: "Email sign-up",
        recommendation: "Use a user flow",
        externalIdAvailability: "Available",
      },
      {
        name: "signIn_idp_google",
        reason: "Google detected",
        recommendation: "Use Google federation",
        externalIdAvailability: "Available",
      },
    ],
  }, {
    tenantId: "11111111-1111-1111-1111-111111111111",
    appName: 'customer$"app`name',
    googleClientId: 'client$"id',
    googleClientSecret: 'secret$"value`tail',
  });
  if ("error" in result) throw new Error("Escaping fixture failed validation.");
  const google = result.output.scripts.find((script) => script.filename === "04-add-google-idp.ps1");
  assert(google);
  assert(google.content.includes('client`$`"id'));
  assert(google.content.includes('secret`$`"value``tail'));
}

const graphScopes = [
  { id: "37f7f235-527c-4136-accd-4a02d197296e", type: "Scope" },
  { id: "7427e0e9-2fba-42fe-b0c0-848c9e6a8182", type: "Scope" },
  { id: "14dad69e-099b-42c9-810b-d002981feec1", type: "Scope" },
];

async function testCreateAndReuseFlow(): Promise<void> {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  let bindingVisible = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = String(init?.method || "GET");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, ...(body ? { body } : {}) });

    if (method === "GET" && url.includes("/v1.0/applications?")) return jsonResponse({ value: [] });
    if (method === "POST" && url.endsWith("/v1.0/applications")) {
      assert.equal(body.nativeAuthenticationApisEnabled, "all");
      return jsonResponse({ id: "app-object-1", appId: "app-client-1", displayName: "context-app" }, 201);
    }
    if (method === "GET" && url.includes("/v1.0/servicePrincipals?")) return jsonResponse({ value: [] });
    if (method === "POST" && url.endsWith("/v1.0/servicePrincipals")) {
      return jsonResponse({ id: "sp-1", appId: "app-client-1" }, 201);
    }
    if (method === "GET" && url.endsWith("/v1.0/identity/authenticationEventsFlows")) {
      return jsonResponse({ value: [] });
    }
    if (method === "POST" && url.endsWith("/v1.0/identity/authenticationEventsFlows")) {
      assert(body.onAttributeCollection.attributes.some((attribute: any) => attribute.id === "givenName"));
      return jsonResponse({ id: "flow-1", displayName: "context-flow" }, 201);
    }
    if (method === "GET" && url.endsWith("/v1.0/identity/authenticationEventsFlows/flow-1")) {
      return jsonResponse({
        id: "flow-1",
        conditions: {
          applications: {
            includeApplications: bindingVisible ? [{ appId: "app-client-1" }] : [],
          },
        },
      });
    }
    if (method === "POST" && url.endsWith("/conditions/applications/includeApplications")) {
      assert.equal(body.appId, "app-client-1");
      bindingVisible = true;
      return jsonResponse({}, 204);
    }
    throw new Error(`Unexpected mocked Graph call: ${method} ${url}`);
  }) as typeof fetch;

  const cfg = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    appName: "context-app",
    flowName: "context-flow",
    bundleId: "com.contoso.app",
    attributes: [
      { id: "email", displayName: "Email Address", dataType: "string", required: true },
      { id: "displayName", displayName: "Display Name", dataType: "string", required: true },
      { id: "givenName", displayName: "First Name", dataType: "string", required: false },
    ],
  };
  const created = await executeApply(["create-native-app", "create-user-flow-emailpassword"], cfg, "test-token");
  assert.deepEqual(created.applied.map((step) => step.status), ["created", "created"]);
  assert(calls.some((call) => call.url.endsWith("/conditions/applications/includeApplications")));

  calls.length = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = String(init?.method || "GET");
    calls.push({ method, url });
    if (method === "GET" && url.includes("/v1.0/applications?")) {
      return jsonResponse({ value: [{ id: "app-object-1", appId: "app-client-1", displayName: "context-app" }] });
    }
    if (method === "GET" && url.includes("/v1.0/applications/app-object-1?")) {
      return jsonResponse({
        id: "app-object-1",
        appId: "app-client-1",
        displayName: "context-app",
        isFallbackPublicClient: true,
        nativeAuthenticationApisEnabled: "all",
        publicClient: { redirectUris: ["msauth://com.contoso.app/callback"] },
        api: { requestedAccessTokenVersion: 2 },
        requiredResourceAccess: [{
          resourceAppId: "00000003-0000-0000-c000-000000000000",
          resourceAccess: graphScopes,
        }],
      });
    }
    if (method === "GET" && url.includes("/v1.0/servicePrincipals?")) {
      return jsonResponse({ value: [{ id: "sp-1", appId: "app-client-1" }] });
    }
    if (method === "GET" && url.endsWith("/v1.0/identity/authenticationEventsFlows")) {
      return jsonResponse({ value: [{ id: "flow-1", displayName: "context-flow" }] });
    }
    if (method === "GET" && url.endsWith("/v1.0/identity/authenticationEventsFlows/flow-1")) {
      return jsonResponse({
        id: "flow-1",
        conditions: { applications: { includeApplications: [{ appId: "app-client-1" }] } },
      });
    }
    if (method === "GET" && url.includes("externalUsersSelfServiceSignUpEventsFlow?$expand=onAttributeCollection")) {
      return jsonResponse({
        onAttributeCollection: {
          attributes: cfg.attributes,
          attributeCollectionPage: {
            views: [{
              inputs: [
                { attribute: "email", label: "Email Address", inputType: "text", hidden: true, editable: false, writeToDirectory: true, required: true },
                { attribute: "displayName", label: "Display Name", inputType: "text", hidden: false, editable: true, writeToDirectory: true, required: true },
                { attribute: "givenName", label: "First Name", inputType: "text", hidden: false, editable: true, writeToDirectory: true, required: false },
              ],
            }],
          },
        },
      });
    }
    throw new Error(`Unexpected mocked Graph call on rerun: ${method} ${url}`);
  }) as typeof fetch;

  const reused = await executeApply(["create-native-app", "create-user-flow-emailpassword"], cfg, "test-token");
  assert.deepEqual(reused.applied.map((step) => step.status), ["reused", "reused"]);
  assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
}

async function main(): Promise<void> {
  try {
    await testAnalyzeContext();
    testBrandingIntent();
    await testGraphRetry();
    await testAuthenticationMethodVerification();
    await testInlineBrandingAsset();
    testPowerShellEscaping();
    await testCreateAndReuseFlow();
    console.log("Web-proto regression: 7 checks passed.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
