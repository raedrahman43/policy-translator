import assert from "assert";

import { executeApply } from "../web-proto/graphExecutor";
import { fetchBytes, graph } from "../web-proto/graphClient";
import { analyze, buildFinalBranding } from "../web-proto/server";
import { generate } from "../web/server";

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
  assert.equal(enrichedResult.body.readiness.score, "Medium");
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
      return jsonResponse({ id: "flow-1", conditions: { applications: { includeApplications: [] } } });
    }
    if (method === "POST" && url.endsWith("/conditions/applications/includeApplications")) {
      assert.equal(body.appId, "app-client-1");
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
    await testInlineBrandingAsset();
    testPowerShellEscaping();
    await testCreateAndReuseFlow();
    console.log("Web-proto regression: 6 checks passed.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
