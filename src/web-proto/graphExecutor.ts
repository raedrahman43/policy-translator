/**
 * graphExecutor — the PROTOTYPE "real apply" engine.
 *
 * Turns the deterministic plan (a list of StepKinds) into real Microsoft Graph
 * calls, mirroring the exact payloads and idempotency guards used by the proven
 * PowerShell templates in src/generators/templates. Every write first checks
 * whether the resource already exists ("create-or-reuse"), so re-running lands
 * the same final state without duplicates (idempotent / convergent).
 *
 * Steps that genuinely can't be auto-applied safely yet (Apple's .p8 client-
 * secret generation, custom OIDC, claims mapping, SSPR flow edits, custom
 * attributes) are reported with status "manual" and a clear reason, so they
 * surface in the gap report instead of failing silently.
 */

import { graph, GraphError } from "./graphClient";
import {
  writeTargetBranding,
  BrandingWriteResult,
  ImportedBranding,
} from "./branding";
import { withEmailPasswordBaseline } from "../parsers/policyContextParser";

export type StepStatus = "created" | "reused" | "skipped" | "manual" | "failed";

export interface StepResult {
  kind: string;
  label: string;
  status: StepStatus;
  resource?: Record<string, unknown>;
  message?: string;
  requiresFollowUp?: boolean;
}

export interface ClaimMap { source: string; jwtName: string; }
export interface CustomAttr { name: string; displayName: string; dataType: string; required: boolean; }
export interface StandardAttr { id: string; displayName: string; dataType: string; required: boolean; }

export interface ApplyConfig {
  tenantId: string;
  appName?: string;
  flowName?: string;
  flowDescription?: string;
  bundleId?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  facebookAppId?: string;
  facebookAppSecret?: string;
  caResourceAppId?: string;
  attributes?: StandardAttr[];
  claims?: ClaimMap[];
  customAttributes?: CustomAttr[];
  branding?: ImportedBranding;
  [key: string]: unknown;
}

interface ApplyState {
  appId?: string;
  objectId?: string;
  servicePrincipalId?: string;
  flowId?: string;
  flowName?: string;
}

const LABELS: Record<string, string> = {
  "create-native-app": "Native app registration",
  "create-user-flow-emailpassword": "Sign-up / sign-in user flow",
  "smoke-test-native-auth": "Native-auth smoke test",
  "add-google-idp": "Google identity provider",
  "add-facebook-idp": "Facebook identity provider",
  "add-oidc-idp": "Custom OIDC identity provider",
  "add-apple-idp": "Apple identity provider",
  "enable-email-otp": "Email one-time-passcode method",
  "enable-sms-mfa": "SMS one-time-passcode (MFA) method",
  "create-ca-policy": "Conditional Access policy (report-only)",
  "enable-passkey": "Passkey (FIDO2) method",
  "claims-mapping-policy": "Claims mapping policy",
  "enable-sspr": "Self-service password reset",
  "create-custom-attributes": "Custom user attributes",
  "migrate-company-branding": "Company branding",
};

/** Safe label lookup (satisfies noUncheckedIndexedAccess). */
const lbl = (k: string): string => LABELS[k] ?? k;

// Same canonical order as the 01..14 script numbering / the front-end ALL_ORDER.
// Company branding runs last (it's tenant-wide and independent of the app/flow).
const ALL_ORDER = [
  "create-native-app", "create-user-flow-emailpassword", "smoke-test-native-auth",
  "add-google-idp", "add-facebook-idp", "add-oidc-idp", "enable-email-otp",
  "claims-mapping-policy", "enable-sspr", "add-apple-idp", "enable-sms-mfa",
  "create-ca-policy", "enable-passkey", "create-custom-attributes",
  "migrate-company-branding",
];

/** Short Graph scopes required by each StepKind (union feeds the consent prompt). */
const SCOPES: Record<string, string[]> = {
  "create-native-app": ["Application.ReadWrite.All"],
  "create-user-flow-emailpassword": ["EventListener.ReadWrite.All", "IdentityUserFlow.ReadWrite.All"],
  "smoke-test-native-auth": ["Organization.Read.All", "EventListener.Read.All"],
  "add-google-idp": ["IdentityProvider.ReadWrite.All", "EventListener.ReadWrite.All", "Organization.Read.All"],
  "add-facebook-idp": ["IdentityProvider.ReadWrite.All", "EventListener.ReadWrite.All"],
  "add-oidc-idp": [],
  "add-apple-idp": [],
  "enable-email-otp": ["Policy.ReadWrite.AuthenticationMethod"],
  "enable-sms-mfa": ["Policy.ReadWrite.AuthenticationMethod"],
  "create-ca-policy": ["Policy.Read.All", "Policy.ReadWrite.ConditionalAccess"],
  "enable-passkey": ["Policy.ReadWrite.AuthenticationMethod"],
  "claims-mapping-policy": ["Policy.ReadWrite.ApplicationConfiguration", "Application.ReadWrite.All"],
  "enable-sspr": ["EventListener.ReadWrite.All", "Policy.ReadWrite.AuthenticationMethod"],
  "create-custom-attributes": ["IdentityUserFlow.ReadWrite.All", "EventListener.ReadWrite.All"],
  "migrate-company-branding": ["OrganizationalBranding.ReadWrite.All"],
};

/** Union of the short scopes needed for the selected steps (+ Org read for app reg). */
export function scopesForKinds(kinds: string[]): string[] {
  const set = new Set<string>();
  for (const k of kinds) (SCOPES[k] || []).forEach((s) => set.add(s));
  return [...set];
}

const GRAPH_RESOURCE_APP_ID = "00000003-0000-0000-c000-000000000000";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const odataString = (value: string) => value.replace(/'/g, "''");

function desiredSubsetMatches(current: unknown, desired: unknown): boolean {
  if (Array.isArray(desired)) {
    if (!Array.isArray(current) || current.length !== desired.length) return false;
    return desired.every((item, index) => desiredSubsetMatches(current[index], item));
  }
  if (desired && typeof desired === "object") {
    if (!current || typeof current !== "object" || Array.isArray(current)) return false;
    return Object.entries(desired as Record<string, unknown>)
      .every(([key, value]) => desiredSubsetMatches((current as Record<string, unknown>)[key], value));
  }
  return current === desired;
}

/** True for transient "the thing I just created isn't visible yet" errors. */
export function isReplicationError(e: unknown): boolean {
  if (e instanceof GraphError) {
    const m = e.message.toLowerCase();
    return e.status === 404 || (
      e.status === 400 &&
      (
        m.includes("is invalid") ||
        m.includes("does not exist") ||
        m.includes("not found") ||
        m.includes("cannot find") ||
        m.includes("not visible") ||
        m.includes("replicat")
      )
    );
  }
  return false;
}

/** Retry with linear backoff (2s, 4s, 6s, 8s) — used for post-create replication lag. */
async function withRetry<T>(fn: () => Promise<T>, retries = 4, baseMs = 2000, retryOn: (e: unknown) => boolean = isReplicationError): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (attempt === retries || !retryOn(e)) throw e;
      await delay(baseMs * (attempt + 1));
    }
  }
  throw lastErr;
}

// ─── Individual step implementations (faithful ports of the templates) ───────

async function createNativeApp(cfg: ApplyConfig, token: string, state: ApplyState): Promise<StepResult> {
  const displayName = cfg.appName || "migrated-app";
  const bundleId = cfg.bundleId || "com.contoso.yourapp";
  const redirectUri = `msauth://${bundleId}/callback`;
  const requiredGraphScopes = [
    { id: "37f7f235-527c-4136-accd-4a02d197296e", type: "Scope" },
    { id: "7427e0e9-2fba-42fe-b0c0-848c9e6a8182", type: "Scope" },
    { id: "14dad69e-099b-42c9-810b-d002981feec1", type: "Scope" },
  ];

  // Idempotent: reuse an existing app with the same displayName.
  const existing = await graph<any>(
    "GET",
    `/v1.0/applications?$filter=displayName eq '${odataString(displayName)}'&$select=id,appId,displayName`,
    token,
  );
  let app = existing.value?.[0];
  let created = false;
  let reconciled = false;

  if (!app) {
    const body = {
      displayName,
      signInAudience: "AzureADMyOrg",
      isFallbackPublicClient: true,
      publicClient: { redirectUris: [redirectUri] },
      nativeAuthenticationApisEnabled: "all",
      api: { requestedAccessTokenVersion: 2 },
      requiredResourceAccess: [
        {
          resourceAppId: GRAPH_RESOURCE_APP_ID,
          resourceAccess: requiredGraphScopes,
        },
      ],
    };
    app = await graph<any>("POST", "/v1.0/applications", token, body);
    created = true;
  } else {
    const current = await graph<any>(
      "GET",
      `/v1.0/applications/${app.id}?$select=id,appId,displayName,isFallbackPublicClient,publicClient,nativeAuthenticationApisEnabled,api,requiredResourceAccess`,
      token,
    );
    const existingRedirects: string[] = current.publicClient?.redirectUris || [];
    const existingGraphAccess = (current.requiredResourceAccess || [])
      .find((r: any) => r.resourceAppId === GRAPH_RESOURCE_APP_ID)?.resourceAccess || [];
    const scopeById = new Map<string, { id: string; type: string }>();
    for (const access of [...existingGraphAccess, ...requiredGraphScopes]) {
      if (access?.id) scopeById.set(String(access.id), { id: String(access.id), type: String(access.type || "Scope") });
    }
    const otherResourceAccess = (current.requiredResourceAccess || [])
      .filter((r: any) => r.resourceAppId !== GRAPH_RESOURCE_APP_ID);
    const desired = {
      isFallbackPublicClient: true,
      nativeAuthenticationApisEnabled: "all",
      publicClient: { redirectUris: [...new Set([...existingRedirects, redirectUri])] },
      api: { ...(current.api || {}), requestedAccessTokenVersion: 2 },
      requiredResourceAccess: [
        ...otherResourceAccess,
        { resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [...scopeById.values()] },
      ],
    };
    if (!desiredSubsetMatches(current, desired)) {
      await graph("PATCH", `/v1.0/applications/${app.id}`, token, desired);
      reconciled = true;
    }
    app = { ...current, displayName };
  }

  state.appId = app.appId;
  state.objectId = app.id;

  // Ensure a service principal exists for the app.
  const spList = await graph<any>(
    "GET",
    `/v1.0/servicePrincipals?$filter=appId eq '${encodeURIComponent(app.appId)}'&$select=id,appId`,
    token,
  );
  let sp = spList.value?.[0];
  if (!sp) {
    sp = await withRetry(
      () => graph<any>("POST", "/v1.0/servicePrincipals", token, { appId: app.appId }),
      5,
      2000,
    );
  }
  state.servicePrincipalId = sp.id;

  return {
    kind: "create-native-app",
    label: lbl("create-native-app"),
    status: created ? "created" : "reused",
    resource: { appId: app.appId, objectId: app.id, servicePrincipalId: sp.id, displayName },
    ...(!created ? {
      message: reconciled
        ? "Existing app registration was reused and reconciled to the required native-auth configuration."
        : "Existing app registration already matched the required native-auth configuration.",
    } : {}),
  };
}

function buildFlowAttributes(cfg: ApplyConfig) {
  const byId = new Map<string, StandardAttr & { hidden?: boolean; editable?: boolean }>();
  for (const attr of withEmailPasswordBaseline(cfg.attributes || [])) {
    if (!attr?.id) continue;
    const existing = byId.get(attr.id);
    byId.set(attr.id, {
      ...(existing || {}),
      ...attr,
      hidden: attr.id === "email",
      editable: attr.id !== "email",
    });
  }
  const defs = [...byId.values()];
  const attributes = defs.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    description: `${a.displayName} of the user`,
    userFlowAttributeType: "builtIn",
    dataType: a.dataType,
  }));
  const inputs = defs.map((a) => ({
    attribute: a.id,
    label: a.displayName,
    inputType: "text",
    hidden: a.hidden,
    editable: a.editable,
    writeToDirectory: true,
    required: a.required,
  }));
  return { attributes, inputs };
}

export function userFlowReadPath(flowId: string): string {
  return `/v1.0/identity/authenticationEventsFlows/${flowId}`;
}

async function reconcileStandardFlowAttributes(flowId: string, cfg: ApplyConfig, token: string): Promise<number> {
  const { attributes: desiredAttributes, inputs: desiredInputs } = buildFlowAttributes(cfg);
  const castPath = `/v1.0/identity/authenticationEventsFlows/${flowId}/microsoft.graph.externalUsersSelfServiceSignUpEventsFlow`;
  const refPath = `${castPath}/onAttributeCollection/microsoft.graph.onAttributeCollectionExternalUsersSelfServiceSignUp/attributes/$ref`;
  let flow = await graph<any>("GET", userFlowReadPath(flowId), token);
  let currentIds: string[] = (flow.onAttributeCollection?.attributes || []).map((a: any) => String(a.id));
  let added = 0;

  for (const attribute of desiredAttributes) {
    if (currentIds.includes(attribute.id)) continue;
    await graph("POST", refPath, token, {
      "@odata.id": `https://graph.microsoft.com/v1.0/identity/userFlowAttributes/${attribute.id}`,
    });
    added++;
  }

  if (added) {
    flow = await withRetry(
      async () => {
        const updated = await graph<any>("GET", userFlowReadPath(flowId), token);
        const ids: string[] = (updated.onAttributeCollection?.attributes || []).map((a: any) => String(a.id));
        if (desiredAttributes.some((attribute) => !ids.includes(attribute.id))) {
          throw new Error("User-flow attributes have not replicated yet.");
        }
        return updated;
      },
      4,
      1500,
      () => true,
    );
    currentIds = (flow.onAttributeCollection?.attributes || []).map((a: any) => String(a.id));
  }

  const currentInputs: any[] = flow.onAttributeCollection?.attributeCollectionPage?.views?.[0]?.inputs || [];
  const currentViews: any[] = flow.onAttributeCollection?.attributeCollectionPage?.views || [];
  const desiredById = new Map(desiredInputs.map((input) => [input.attribute, input]));
  const mergedInputs = currentInputs.map((input) => {
    const desired = desiredById.get(input.attribute);
    return desired ? { ...input, ...desired } : { ...input };
  });
  for (const desired of desiredInputs) {
    if (!mergedInputs.some((input) => input.attribute === desired.attribute)) mergedInputs.push(desired);
  }

  const desiredInputsMatch = desiredInputs.every((desired) => {
    const current = currentInputs.find((input) => input.attribute === desired.attribute);
    return current && desiredSubsetMatches(current, desired);
  });
  if (!desiredInputsMatch) {
    const mergedViews = currentViews.length
      ? currentViews.map((view, index) => index === 0 ? { ...view, inputs: mergedInputs } : { ...view })
      : [{ inputs: mergedInputs }];
    await graph("PATCH", `/v1.0/identity/authenticationEventsFlows/${flowId}`, token, {
      "@odata.type": "#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow",
      onAttributeCollection: {
        "@odata.type": "#microsoft.graph.onAttributeCollectionExternalUsersSelfServiceSignUp",
        attributeCollectionPage: { views: mergedViews },
      },
    });
    await withRetry(
      async () => {
        const verified = await graph<any>("GET", userFlowReadPath(flowId), token);
        const verifiedInputs: any[] =
          verified.onAttributeCollection?.attributeCollectionPage?.views?.[0]?.inputs || [];
        const converged = desiredInputs.every((desired) => {
          const current = verifiedInputs.find((input) => input.attribute === desired.attribute);
          return current && desiredSubsetMatches(current, desired);
        });
        if (!converged) {
          throw new GraphError(404, {
            error: {
              code: "ReplicationPending",
              message: "User-flow page input settings have not converged yet.",
            },
          });
        }
        return verified;
      },
      4,
      1500,
    );
  }
  return added;
}

async function createUserFlow(cfg: ApplyConfig, token: string, state: ApplyState): Promise<StepResult> {
  const flowName = cfg.flowName || "SignUpSignIn";
  const description = cfg.flowDescription || `Sign-up and sign-in flow (${flowName})`;
  state.flowName = flowName;
  if (!state.appId) {
    return {
      kind: "create-user-flow-emailpassword",
      label: lbl("create-user-flow-emailpassword"),
      status: "skipped",
      message: "Requires the native app registration to succeed first.",
    };
  }

  const all = await graph<any>("GET", "/v1.0/identity/authenticationEventsFlows", token);
  const existing = (all.value || []).find((f: any) => f.displayName === flowName);
  if (existing) {
    state.flowId = existing.id;
    try {
      await bindAppToFlow(existing.id, state.appId!, token);
      const attributesAdded = await reconcileStandardFlowAttributes(existing.id, cfg, token);
      return {
        kind: "create-user-flow-emailpassword",
        label: lbl("create-user-flow-emailpassword"),
        status: "reused",
        resource: { id: existing.id, name: existing.displayName, appLinked: true, attributesAdded },
        message: attributesAdded
          ? `Existing user flow was reused; its app binding was verified and ${attributesAdded} missing sign-up attribute(s) were added.`
          : "Existing user flow was reused; its application binding and sign-up attributes were verified.",
      };
    } catch (err) {
      return {
        kind: "create-user-flow-emailpassword",
        label: lbl("create-user-flow-emailpassword"),
        status: "failed",
        resource: { id: existing.id, name: existing.displayName },
        message: `The existing user flow was found, but its app binding or sign-up attributes could not be reconciled: ${explainError("create-user-flow-emailpassword", err)}`,
      };
    }
  }

  const { attributes, inputs } = buildFlowAttributes(cfg);
  const body: any = {
    "@odata.type": "#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow",
    displayName: flowName,
    description,
    priority: 500,
    onAuthenticationMethodLoadStart: {
      "@odata.type": "#microsoft.graph.onAuthenticationMethodLoadStartExternalUsersSelfServiceSignUp",
      identityProviders: [{ id: "EmailPassword-OAUTH" }],
    },
    onInteractiveAuthFlowStart: {
      "@odata.type": "#microsoft.graph.onInteractiveAuthFlowStartExternalUsersSelfServiceSignUp",
      isSignUpAllowed: true,
    },
    onAttributeCollection: {
      "@odata.type": "#microsoft.graph.onAttributeCollectionExternalUsersSelfServiceSignUp",
      attributes,
      attributeCollectionPage: { views: [{ inputs }] },
    },
  };

  // NOTE: don't include the app in `conditions` at creation time — a just-created
  // app registration can take several seconds to replicate to the user-flow
  // service, which returns 400 "The application id … is invalid". Create the flow
  // first (so it always lands and IdPs can bind), then link the app with retry.
  const flow = await graph<any>("POST", "/v1.0/identity/authenticationEventsFlows", token, body);
  state.flowId = flow.id;

  const appId = state.appId;
  let appLinked = false;
  let linkNote: string | undefined;
  if (appId) {
    try {
      await bindAppToFlow(flow.id, appId, token);
      appLinked = true;
    } catch (err) {
      linkNote = isReplicationError(err)
        ? "User flow created, but linking your app is still replicating in the tenant. Re-run this step in ~30s to finish the link."
        : `User flow created, but the application binding failed: ${explainError("create-user-flow-emailpassword", err)}`;
    }
  }

  return {
    kind: "create-user-flow-emailpassword",
    label: lbl("create-user-flow-emailpassword"),
    status: appLinked ? "created" : "failed",
    resource: { id: flow.id, name: flow.displayName, appLinked },
    ...(linkNote ? { message: linkNote } : {}),
  };
}

/** Add an application to the flow through the dedicated GA endpoint (idempotent). */
async function bindAppToFlow(flowId: string, appId: string, token: string): Promise<void> {
  await withRetry(async () => {
    const current = await graph<any>(
      "GET",
      `/v1.0/identity/authenticationEventsFlows/${flowId}`,
      token,
    );
    if (flowHasAppBinding(current, appId)) return current;
    try {
      await graph(
        "POST",
        `/v1.0/identity/authenticationEventsFlows/${flowId}/conditions/applications/includeApplications`,
        token,
        { appId },
      );
    } catch (err) {
      if (!(err instanceof GraphError) || err.status !== 400) throw err;
      if (isReplicationError(err)) throw err;
      const message = err.message.toLowerCase();
      const benignDuplicate =
        /already (?:exist|exists|included|added)/.test(message) &&
        !/another|different/.test(message);
      if (!benignDuplicate) throw err;
    }
    const verified = await graph<any>(
      "GET",
      `/v1.0/identity/authenticationEventsFlows/${flowId}`,
      token,
    );
    if (!flowHasAppBinding(verified, appId)) {
      throw new GraphError(404, {
        error: {
          code: "ReplicationPending",
          message: "The application binding is not visible on the user flow yet.",
        },
      });
    }
    return verified;
  }, 5, 2000);
}

export function flowHasAppBinding(flow: any, appId: string): boolean {
  const current: string[] = (flow?.conditions?.applications?.includeApplications || [])
    .map((application: any) => String(application.appId || ""));
  return current.includes(appId);
}

/** Add an identity provider to the flow through the dedicated GA $ref endpoint. */
async function bindIdpToFlow(flowId: string, idpId: string, token: string): Promise<void> {
  const flow = await graph<any>("GET", `/v1.0/identity/authenticationEventsFlows/${flowId}`, token);
  const existingIds: string[] = (flow.onAuthenticationMethodLoadStart?.identityProviders || []).map((p: any) => p.id);
  if (existingIds.includes(idpId)) return;

  const refPath = `/v1.0/identity/authenticationEventsFlows/${flowId}` +
    "/microsoft.graph.externalUsersSelfServiceSignUpEventsFlow" +
    "/onAuthenticationMethodLoadStart" +
    "/microsoft.graph.onAuthenticationMethodLoadStartExternalUsersSelfServiceSignUp" +
    "/identityProviders/$ref";
  await graph("POST", refPath, token, {
    "@odata.id": `https://graph.microsoft.com/v1.0/identity/identityProviders/${idpId}`,
  });
  await withRetry(
    async () => {
      const updated = await graph<any>("GET", `/v1.0/identity/authenticationEventsFlows/${flowId}`, token);
      const ids: string[] = (updated.onAuthenticationMethodLoadStart?.identityProviders || []).map((p: any) => p.id);
      if (!ids.includes(idpId)) throw new Error("Identity-provider binding has not replicated yet.");
      return undefined;
    },
    4,
    1500,
    () => true,
  );
}

async function addSocialIdp(
  kind: "add-google-idp" | "add-facebook-idp",
  cfg: ApplyConfig,
  token: string,
  state: ApplyState,
): Promise<StepResult> {
  const isGoogle = kind === "add-google-idp";
  const providerType = isGoogle ? "Google" : "Facebook";
  const clientId = isGoogle ? cfg.googleClientId : cfg.facebookAppId;
  const clientSecret = isGoogle ? cfg.googleClientSecret : cfg.facebookAppSecret;
  const displayName = providerType;

  if (!state.flowId) {
    return { kind, label: lbl(kind), status: "skipped", message: "Requires the sign-up / sign-in user flow to succeed first." };
  }
  if (!clientId || !clientSecret) {
    return {
      kind,
      label: lbl(kind),
      status: "manual",
      message: `Provide the ${providerType} client ID and secret from the ${providerType} developer console, then re-run this step.`,
    };
  }

  // Idempotent: reuse an existing IdP of this type.
  const existing = await graph<any>("GET", "/v1.0/identity/identityProviders", token);
  let idp = (existing.value || []).find((p: any) => p.identityProviderType === providerType);
  let created = false;
  if (!idp) {
    idp = await graph<any>(
      "POST",
      "/v1.0/identity/identityProviders",
      token,
      socialIdentityProviderPayload(providerType, displayName, clientId, clientSecret),
    );
    created = true;
  } else {
    await graph(
      "PATCH",
      `/v1.0/identity/identityProviders/${idp.id}`,
      token,
      socialIdentityProviderPayload(providerType, displayName, clientId, clientSecret),
    );
  }

  await bindIdpToFlow(state.flowId, idp.id, token);
  const bound = true;

  return {
    kind,
    label: lbl(kind),
    status: created ? "created" : "reused",
    resource: { id: idp.id, displayName: idp.displayName, boundToFlow: bound },
    message: `${providerType} provider ${created ? "created" : "reused with the supplied credentials refreshed"}${bound ? " and bound to the flow" : ""}. Graph can't validate the client secret — confirm with a live "Continue with ${providerType}" sign-in.`,
    requiresFollowUp: true,
  };
}

export function socialIdentityProviderPayload(
  providerType: string,
  displayName: string,
  clientId: string,
  clientSecret: string,
): Record<string, string> {
  return {
    "@odata.type": "#microsoft.graph.socialIdentityProvider",
    displayName,
    identityProviderType: providerType,
    clientId,
    clientSecret,
  };
}

async function patchAuthMethod(
  kind: string,
  methodId: "Email" | "Sms" | "Fido2",
  body: Record<string, unknown>,
  token: string,
): Promise<StepResult> {
  const base = `/v1.0/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/${methodId}`;
  // Idempotent: skip only when the complete desired sub-shape already matches.
  try {
    const current = await graph<any>("GET", base, token);
    if (desiredSubsetMatches(current, body)) {
      return { kind, label: lbl(kind), status: "reused", resource: { method: methodId, state: "enabled" } };
    }
  } catch (err) {
    if (!(err instanceof GraphError) || err.status !== 404) throw err;
  }
  await graph("PATCH", base, token, body);
  await withRetry(async () => {
    const verified = await graph<any>("GET", base, token);
    if (!desiredSubsetMatches(verified, body)) {
      throw new GraphError(404, {
        error: {
          code: "ReplicationPending",
          message: `${methodId} authentication-method settings are not visible yet.`,
        },
      });
    }
    return verified;
  }, 4, 1000);
  return { kind, label: lbl(kind), status: "created", resource: { method: methodId, state: "enabled" } };
}

function sortedStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).sort() : [];
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isEmptyCondition(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isEmptyCondition);
  }
  return false;
}

export function caPolicyMatches(policy: any, resourceAppId: string): boolean {
  const applications = policy?.conditions?.applications || {};
  const users = policy?.conditions?.users || {};
  const grant = policy?.grantControls || {};
  const clientAppTypes = sortedStrings(policy?.conditions?.clientAppTypes);

  const knownConditionKeys = new Set(["applications", "users", "clientAppTypes"]);
  const hasAdditionalConditions = Object.entries(policy?.conditions || {})
    .some(([key, value]) => !knownConditionKeys.has(key) && !isEmptyCondition(value));

  return (
    arraysEqual(
      sortedStrings(applications.includeApplications).map((value) => value.toLowerCase()),
      [resourceAppId.toLowerCase()],
    ) &&
    sortedStrings(applications.excludeApplications).length === 0 &&
    sortedStrings(applications.includeUserActions).length === 0 &&
    sortedStrings(applications.includeAuthenticationContextClassReferences).length === 0 &&
    isEmptyCondition(applications.applicationFilter) &&
    arraysEqual(sortedStrings(users.includeUsers), ["All"]) &&
    sortedStrings(users.excludeUsers).length === 0 &&
    sortedStrings(users.includeGroups).length === 0 &&
    sortedStrings(users.excludeGroups).length === 0 &&
    sortedStrings(users.includeRoles).length === 0 &&
    sortedStrings(users.excludeRoles).length === 0 &&
    isEmptyCondition(users.includeGuestsOrExternalUsers) &&
    isEmptyCondition(users.excludeGuestsOrExternalUsers) &&
    (clientAppTypes.length === 0 || arraysEqual(clientAppTypes, ["all"])) &&
    grant.operator === "OR" &&
    arraysEqual(sortedStrings(grant.builtInControls), ["mfa"]) &&
    isEmptyCondition(grant.customAuthenticationFactors) &&
    isEmptyCondition(grant.termsOfUse) &&
    isEmptyCondition(grant.authenticationStrength) &&
    isEmptyCondition(policy?.sessionControls) &&
    !hasAdditionalConditions
  );
}

async function createCaPolicy(cfg: ApplyConfig, token: string, state: ApplyState): Promise<StepResult> {
  if (!cfg.caResourceAppId) {
    return {
      kind: "create-ca-policy",
      label: lbl("create-ca-policy"),
      status: "manual",
      message: "Conditional Access needs the application ID of the protected API/resource. A public/native client ID is not a safe default.",
    };
  }
  const displayName = `Require MFA - ${cfg.appName || "migrated-app"}`;
  const body = {
    displayName,
    state: "enabledForReportingButNotEnforced",
    conditions: {
      applications: { includeApplications: [cfg.caResourceAppId] },
      users: { includeUsers: ["All"] },
    },
    grantControls: { operator: "OR", builtInControls: ["mfa"] },
  };
  const existing = await graph<any>("GET", "/v1.0/identity/conditionalAccess/policies", token);
  const found = (existing.value || []).find((p: any) => p.displayName === displayName);
  if (found) {
    const configurationMatches = caPolicyMatches(found, cfg.caResourceAppId);
    if (!configurationMatches) {
      return {
        kind: "create-ca-policy",
        label: lbl("create-ca-policy"),
        status: "failed",
        resource: { id: found.id, state: found.state },
        message: "A Conditional Access policy with the generated name already exists but targets different resources or grant controls. It was left unchanged for safety.",
      };
    }

    if (found.state !== "enabledForReportingButNotEnforced") {
      return {
        kind: "create-ca-policy",
        label: lbl("create-ca-policy"),
        status: "manual",
        resource: { id: found.id, state: found.state, resourceAppId: cfg.caResourceAppId },
        message: `An existing policy with the requested resource and MFA controls is '${found.state}', not report-only. It was left unchanged; review its impact before continuing.`,
        requiresFollowUp: true,
      };
    }
    return {
      kind: "create-ca-policy",
      label: lbl("create-ca-policy"),
      status: "reused",
      resource: { id: found.id, state: found.state, resourceAppId: cfg.caResourceAppId },
      message: "Existing report-only Conditional Access policy already matches.",
      requiresFollowUp: true,
    };
  }
  const policy = await graph<any>("POST", "/v1.0/identity/conditionalAccess/policies", token, body);
  return {
    kind: "create-ca-policy",
    label: lbl("create-ca-policy"),
    status: "created",
    resource: { id: policy.id, state: policy.state, resourceAppId: cfg.caResourceAppId },
    message: "Created in report-only mode. Validate the result against the protected resource before enabling enforcement.",
    requiresFollowUp: true,
  };
}

// ─── Claims mapping policy (script 08) ───────────────────────────────────────
async function configureClaimsMapping(cfg: ApplyConfig, token: string, state: ApplyState): Promise<StepResult> {
  const kind = "claims-mapping-policy";
  if (!state.objectId || !state.appId) {
    return { kind, label: lbl(kind), status: "skipped", message: "Requires the app registration (step 1) to succeed first." };
  }
  // Ensure a service principal id.
  let spId: string | undefined = state.servicePrincipalId;
  if (!spId) {
    const spList = await graph<any>("GET", `/v1.0/servicePrincipals?$filter=appId eq '${encodeURIComponent(state.appId)}'&$select=id`, token);
    spId = String(spList.value?.[0]?.id || (await graph<any>("POST", "/v1.0/servicePrincipals", token, { appId: state.appId })).id);
    state.servicePrincipalId = spId;
  }

  const displayName = `${cfg.flowName || "SignUpSignIn"}-claims-mapping`;
  const claims = (cfg.claims && cfg.claims.length ? cfg.claims : [{ source: "displayname", jwtName: "name" }, { source: "mail", jwtName: "email" }]);
  const definition = JSON.stringify({
    ClaimsMappingPolicy: {
      Version: 1,
      IncludeBasicClaimSet: "true",
      ClaimsSchema: claims.map((c) => ({ Source: "user", ID: c.source, JwtClaimType: c.jwtName })),
    },
  });

  // Create (or find existing) claims mapping policy.
  let policyId: string;
  let policyChanged = false;
  const existingPolicies = await graph<any>("GET", "/v1.0/policies/claimsMappingPolicies", token);
  const foundPolicy = (existingPolicies.value || []).find((p: any) => p.displayName === displayName);
  if (foundPolicy) {
    policyId = foundPolicy.id;
    const currentPolicy = await graph<any>("GET", `/v1.0/policies/claimsMappingPolicies/${policyId}`, token);
    const currentDefinition = Array.isArray(currentPolicy.definition) ? currentPolicy.definition : [];
    if (!desiredSubsetMatches(currentDefinition, [definition])) {
      await graph("PATCH", `/v1.0/policies/claimsMappingPolicies/${policyId}`, token, {
        definition: [definition],
        displayName,
        isOrganizationDefault: false,
      });
      policyChanged = true;
    }
  } else {
    const policy = await graph<any>("POST", "/v1.0/policies/claimsMappingPolicies", token, {
      definition: [definition],
      displayName,
      isOrganizationDefault: false,
    });
    policyId = policy.id;
    policyChanged = true;
  }

  // Enable acceptMappedClaims without replacing the app's other API settings.
  const currentApp = await graph<any>(
    "GET",
    `/v1.0/applications/${state.objectId}?$select=api,signInAudience`,
    token,
  );
  if (currentApp.signInAudience !== "AzureADMyOrg") {
    return {
      kind,
      label: lbl(kind),
      status: "failed",
      message: "acceptMappedClaims must not be enabled on a multitenant app without a custom signing key. The app was left unchanged.",
    };
  }
  if (currentApp.api?.acceptMappedClaims !== true) {
    await graph("PATCH", `/v1.0/applications/${state.objectId}`, token, {
      api: { ...(currentApp.api || {}), acceptMappedClaims: true },
    });
  }

  // Assign the policy to the SP (idempotent — skip if already assigned).
  const assigned = await graph<any>("GET", `/v1.0/servicePrincipals/${spId}/claimsMappingPolicies`, token);
  const already = (assigned.value || []).some((p: any) => p.id === policyId);
  if (!already) {
    await graph("POST", `/v1.0/servicePrincipals/${spId}/claimsMappingPolicies/$ref`, token, {
      "@odata.id": `https://graph.microsoft.com/v1.0/policies/claimsMappingPolicies/${policyId}`,
    });
  }
  return {
    kind,
    label: lbl(kind),
    status: !policyChanged && already ? "reused" : "created",
    resource: { policyId, displayName },
    message: "Claims mapping is application/token-audience based. Verify the issued token contains each mapped claim; external-data claims still require a custom claims provider.",
    requiresFollowUp: true,
  };
}

// ─── SSPR (script 09) — External ID uses Email OTP as the reset verifier ─────
export function flowHasEmailPasswordProvider(flow: any): boolean {
  const providers = flow?.onAuthenticationMethodLoadStart?.identityProviders || [];
  return providers.some((provider: any) => String(provider.id || "") === "EmailPassword-OAUTH");
}

async function enableSspr(token: string, state: ApplyState): Promise<StepResult> {
  const kind = "enable-sspr";
  if (!state.flowId || !state.appId) {
    return {
      kind,
      label: lbl(kind),
      status: "skipped",
      message: "SSPR requires the Email + Password user flow and application binding to be created or reused in this run.",
    };
  }
  const flow = await graph<any>("GET", userFlowReadPath(state.flowId), token);
  if (!flowHasAppBinding(flow, state.appId) || !flowHasEmailPasswordProvider(flow)) {
    return {
      kind,
      label: lbl(kind),
      status: "failed",
      message: "The target flow is not both bound to this application and configured with Email + Password. SSPR was not reported as ready.",
    };
  }
  const r = await patchAuthMethod(
    kind, "Email",
    { "@odata.type": "#microsoft.graph.emailAuthenticationMethodConfiguration", state: "enabled", allowExternalIdToUseEmailOtp: "enabled" },
    token,
  );
  return {
    ...r,
    message: "SSPR prerequisites are configured: Email + Password user flow and Email OTP. Verify the Forgot password link and complete one real reset.",
    requiresFollowUp: true,
  };
}

// ─── Custom user attributes (script 14) ──────────────────────────────────────
async function createCustomAttributes(cfg: ApplyConfig, token: string, state: ApplyState): Promise<StepResult> {
  const kind = "create-custom-attributes";
  const attrs = cfg.customAttributes || [];
  if (!attrs.length) {
    return { kind, label: lbl(kind), status: "skipped", message: "No custom attributes were detected in this policy." };
  }
  if (!state.flowId) {
    return { kind, label: lbl(kind), status: "skipped", message: "Requires the sign-up / sign-in user flow to succeed first." };
  }
  const existing = await graph<any>("GET", "/v1.0/identity/userFlowAttributes", token);
  const existingList: any[] = existing.value || [];

  const resolvedIds: string[] = [];
  let createdCount = 0;
  for (const attr of attrs) {
    const match = existingList.find(
      (a: any) => a.userFlowAttributeType === "custom" && (a.displayName === attr.displayName || String(a.id).match(new RegExp(`extension_.*_${attr.name}$`))),
    );
    if (match) { resolvedIds.push(match.id); continue; }
    const created = await graph<any>("POST", "/v1.0/identity/userFlowAttributes", token, {
      displayName: attr.displayName,
      description: `${attr.displayName} (migrated custom attribute)`,
      dataType: attr.dataType || "string",
      userFlowAttributeType: "custom",
    });
    resolvedIds.push(created.id);
    createdCount++;
  }

  // Attach each attribute to the flow via the dedicated $ref endpoint (if a flow exists).
  let addedToFlow = 0;
  if (state.flowId) {
    // Read the attributes already on the flow so we can skip them. `onAttributeCollection`
    // lives on the derived type, so cast before expanding (a bare $expand 400s). This is a
    // best-effort optimization — if it fails, fall through and rely on the POST loop's
    // 400 "already added" tolerance below.
    let onFlow: string[] = [];
    try {
      const flow = await graph<any>(
        "GET",
        userFlowReadPath(state.flowId),
        token,
      );
      onFlow = (flow.onAttributeCollection?.attributes || []).map((a: any) => a.id);
    } catch {
      /* couldn't read current list — proceed and tolerate 400s on add */
    }
    const refUri = `/v1.0/identity/authenticationEventsFlows/${state.flowId}/microsoft.graph.externalUsersSelfServiceSignUpEventsFlow/onAttributeCollection/microsoft.graph.onAttributeCollectionExternalUsersSelfServiceSignUp/attributes/$ref`;
    for (const id of resolvedIds) {
      if (onFlow.includes(id)) continue;
      try {
        await graph("POST", refUri, token, { "@odata.id": `https://graph.microsoft.com/v1.0/identity/userFlowAttributes/${id}` });
        addedToFlow++;
      } catch (err) {
        if (!(err instanceof GraphError) || err.status !== 400) throw err;
        const verify = await graph<any>(
          "GET",
          userFlowReadPath(state.flowId),
          token,
        );
        const verifiedIds: string[] = (verify.onAttributeCollection?.attributes || []).map((a: any) => String(a.id));
        if (!verifiedIds.includes(id)) throw err;
      }
    }
  }

  let pageSettingsChanged = false;
  if (state.flowId && resolvedIds.length) {
    const flow = await graph<any>("GET", userFlowReadPath(state.flowId), token);
    const currentInputs: any[] = flow.onAttributeCollection?.attributeCollectionPage?.views?.[0]?.inputs || [];
    const desiredById = new Map<string, CustomAttr>();
    resolvedIds.forEach((id, index) => {
      const attr = attrs[index];
      if (attr) desiredById.set(id, attr);
    });
    const mergedInputs = currentInputs.map((input) => {
      const desired = desiredById.get(String(input.attribute));
      const clean = {
        attribute: input.attribute,
        label: input.label,
        inputType: input.inputType,
        hidden: Boolean(input.hidden),
        editable: input.editable !== false,
        writeToDirectory: input.writeToDirectory !== false,
        required: Boolean(input.required),
      };
      return desired
        ? { ...clean, label: desired.displayName, writeToDirectory: true, required: desired.required }
        : clean;
    });
    for (const [id, desired] of desiredById) {
      if (mergedInputs.some((input) => String(input.attribute) === id)) continue;
      mergedInputs.push({
        attribute: id,
        label: desired.displayName,
        inputType: "text",
        hidden: false,
        editable: true,
        writeToDirectory: true,
        required: desired.required,
      });
    }
    const settingsMatch = [...desiredById].every(([id, desired]) => {
      const current = currentInputs.find((input) => String(input.attribute) === id);
      return current &&
        current.label === desired.displayName &&
        current.writeToDirectory === true &&
        Boolean(current.required) === desired.required;
    });
    if (!settingsMatch) {
      await graph("PATCH", `/v1.0/identity/authenticationEventsFlows/${state.flowId}`, token, {
        "@odata.type": "#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow",
        onAttributeCollection: {
          "@odata.type": "#microsoft.graph.onAttributeCollectionExternalUsersSelfServiceSignUp",
          attributeCollectionPage: { views: [{ inputs: mergedInputs }] },
        },
      });
      pageSettingsChanged = true;
    }
  }
  return {
    kind, label: lbl(kind),
    status: createdCount > 0 || addedToFlow > 0 || pageSettingsChanged ? "created" : "reused",
    resource: { attributes: resolvedIds.length, created: createdCount, addedToFlow, pageSettingsChanged },
  };
}

// ─── Company branding (Path A) — copy the source tenant's real branding ──────
export function brandingWriteStepResult(result: BrandingWriteResult): StepResult {
  const kind = "migrate-company-branding";
  const resource = {
    written: result.written,
    skipped: result.skipped,
    errors: result.errors,
  };
  if (result.errors.length) {
    const completed = result.written.length
      ? `Branding was only partially applied (${result.written.join(", ")}).`
      : "Branding was not applied.";
    return {
      kind,
      label: lbl(kind),
      status: "failed",
      resource,
      message: `${completed} Resolve these failures and re-run branding: ${result.errors.join("; ")}`,
    };
  }
  const completed = result.written.length
    ? `Applied ${result.written.join(", ")}.`
    : "Branding already matched the requested values.";
  return {
    kind,
    label: lbl(kind),
    status: result.written.length ? "created" : "reused",
    resource,
    message: `${completed} Verify the real browser-hosted sign-in page.`,
    requiresFollowUp: true,
  };
}

async function migrateCompanyBranding(cfg: ApplyConfig, token: string): Promise<StepResult> {
  const kind = "migrate-company-branding";
  const b = cfg.branding;
  if (!b || !b.hasBranding) {
    return { kind, label: lbl(kind), status: "manual", message: "Import your branding from the source B2C tenant first (or set it under Company Branding)." };
  }
  return brandingWriteStepResult(await writeTargetBranding(cfg.tenantId, token, b));
}

// ─── Native-auth smoke test — a REAL check (ported from 03-smoke-test) ───────
// Calls the tenant's public native-auth /initiate endpoint with a throwaway
// user. A "user_not_found"-class response proves the endpoint is live, the app
// is authorized, and the flow accepts requests. This is a genuine pass/fail —
// never a fabricated success.
async function smokeTestNativeAuth(cfg: ApplyConfig, token: string, state: ApplyState): Promise<StepResult> {
  const kind = "smoke-test-native-auth";
  const appId = state.appId || (cfg.appId as string | undefined);
  if (!appId || !state.flowId) {
    return {
      kind, label: lbl(kind), status: "manual",
      message: 'This check needs both the native app and user flow. Include those steps in this run (or re-run after they exist), then run this check again.',
    };
  }

  try {
    const flow = await graph<any>(
      "GET",
      `/v1.0/identity/authenticationEventsFlows/${state.flowId}`,
      token,
    );
    if (!flowHasAppBinding(flow, appId)) {
      return {
        kind,
        label: lbl(kind),
        status: "failed",
        message: "The target application is not bound to the specific user flow created for this run. Re-run the user-flow step before testing native auth.",
      };
    }
  } catch (err) {
    return {
      kind,
      label: lbl(kind),
      status: "failed",
      message: `Could not verify the target app-to-flow binding before the smoke test: ${explainError(kind, err)}`,
    };
  }

  // Resolve the tenant's initial (onmicrosoft.com) sign-in subdomain.
  let subdomain = "";
  let tenantDomain = "";
  try {
    const org = await graph<any>("GET", "/v1.0/organization", token);
    const initial = (org.value?.[0]?.verifiedDomains || []).find((d: any) => d.isInitial);
    if (initial?.name) {
      tenantDomain = String(initial.name);
      subdomain = tenantDomain.split(".")[0] || "";
    }
  } catch {
    /* handled below */
  }
  if (!subdomain) {
    return {
      kind, label: lbl(kind), status: "failed",
      message: "Couldn't resolve the tenant sign-in subdomain from Graph (/organization). Verify the sign-in later at https://<subdomain>.ciamlogin.com.",
    };
  }

  const url = `https://${subdomain}.ciamlogin.com/${tenantDomain}/oauth2/v2.0/initiate`;
  const testEmail = `smoketest-nobody-${Math.floor(Math.random() * 1e9)}@example.invalid`;
  const form = new URLSearchParams({
    client_id: appId,
    username: testEmail,
    challenge_type: "password redirect",
  });

  let status = 0;
  let body: any = {};
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    status = resp.status;
    try { body = await resp.json(); } catch { body = {}; }
  } catch (err) {
    return {
      kind, label: lbl(kind), status: "failed",
      message: `Couldn't reach the native-auth endpoint (${url}). ${String((err as Error)?.message || err)} — likely a subdomain/tenant mismatch. Verify the sign-in manually.`,
    };
  }

  const errCode = String(body.error || "");
  const errSub = String(body.suberror || "");
  if (status === 200 && body.continuation_token) {
    return { kind, label: lbl(kind), status: "created", resource: { verdict: "full-pass", endpoint: url }, message: "Native auth fully wired — the endpoint returned a continuation token." };
  }
  if (errCode === "user_not_found" || errSub === "user_not_found") {
    return {
      kind, label: lbl(kind), status: "created", resource: { verdict: "pass", endpoint: url },
      message: "Native auth verified — the endpoint is live, the app is authorized, and the flow accepts requests (the throwaway test user was correctly rejected).",
    };
  }
  if (errCode === "unauthorized_client") {
    return {
      kind, label: lbl(kind), status: "failed",
      message: "unauthorized_client — the app isn't bound to the user flow, or its service principal is missing. Re-run the app + user-flow steps, then re-check.",
    };
  }
  if (errCode === "invalid_client") {
    return {
      kind, label: lbl(kind), status: "failed",
      message: errSub === "nativeauthapi_disabled"
        ? "invalid_client/nativeauthapi_disabled — nativeAuthenticationApisEnabled is not active on this app. Re-run the native app step and verify the manifest."
        : `invalid_client — the endpoint rejected the app registration${errSub ? ` (${errSub})` : ""}. Verify the client ID and native-auth manifest settings.`,
    };
  }
  if (errCode === "unsupported_challenge_type") {
    return {
      kind, label: lbl(kind), status: "failed",
      message: "unsupported_challenge_type — the user flow has no Email + Password provider, or native auth isn't enabled on the app (nativeAuthenticationApisEnabled should be 'all').",
    };
  }
  return {
    kind, label: lbl(kind), status: "failed",
    message: `Unexpected native-auth response (HTTP ${status}${errCode ? `, error='${errCode}'` : ""}). ${body.error_description || "Verify the sign-in manually against the External ID native-auth docs."}`,
  };
}

// Steps not yet wired for safe auto-apply — reported as manual with the reason.
const MANUAL_REASONS: Record<string, string> = {
  "smoke-test-native-auth": "Read-only verification — open the sign-in page and confirm the flow loads.",
};

/** Role/consent hints so a raw Graph 403 becomes an actionable next step. */
const PERMISSION_HINTS: Record<string, string> = {
  "create-native-app": "Your account needs the Application Administrator (or Cloud Application Administrator) role.",
  "create-user-flow-emailpassword": "Your account needs the External ID User Flow Administrator role.",
  "add-google-idp": "Your account needs External Identity Provider Administrator to manage Google and External ID User Flow Administrator to attach it to the flow.",
  "add-facebook-idp": "Your account needs External Identity Provider Administrator to manage Facebook and External ID User Flow Administrator to attach it to the flow.",
  "add-oidc-idp": "Your account needs the External ID User Flow Administrator role.",
  "add-apple-idp": "Your account needs the External ID User Flow Administrator role.",
  "claims-mapping-policy": "Your account needs the Cloud Application Administrator (or Application Administrator) role, plus admin consent for the Policy.ReadWrite.ApplicationConfiguration scope.",
  "create-ca-policy": "Your account needs the Conditional Access Administrator (or Security Administrator) role, plus admin consent for the Policy.ReadWrite.ConditionalAccess scope.",
  "enable-email-otp": "Your account needs the Authentication Policy Administrator role.",
  "enable-sms-mfa": "Your account needs the Authentication Policy Administrator role.",
  "enable-passkey": "Your account needs the Authentication Policy Administrator role.",
  "enable-sspr": "Your account needs the Authentication Policy Administrator role.",
  "create-custom-attributes": "Your account needs the External ID User Flow Administrator role.",
  "migrate-company-branding": "Your account needs the Organizational Branding Administrator role, plus admin consent for OrganizationalBranding.ReadWrite.All.",
};

/** Turn a raw Graph error into a specific, actionable message for the gap report. */
function explainError(kind: string, err: unknown): string {
  if (err instanceof GraphError) {
    if (err.status === 403) {
      const hint = PERMISSION_HINTS[kind] || "Your signed-in account is missing a required admin role or admin-consented scope for this step.";
      return `Permission denied by Microsoft Graph (403). ${hint} Then re-run this step.`;
    }
    if (isReplicationError(err)) {
      return "A resource this step depends on is still replicating in your tenant. Wait ~30 seconds and re-run this step.";
    }
    return err.message;
  }
  return String(err);
}

async function runStep(kind: string, cfg: ApplyConfig, token: string, state: ApplyState): Promise<StepResult> {
  switch (kind) {
    case "create-native-app": return createNativeApp(cfg, token, state);
    case "create-user-flow-emailpassword": return createUserFlow(cfg, token, state);
    case "add-google-idp":
    case "add-facebook-idp": return addSocialIdp(kind, cfg, token, state);
    case "enable-email-otp":
      return patchAuthMethod(kind, "Email", { "@odata.type": "#microsoft.graph.emailAuthenticationMethodConfiguration", state: "enabled", allowExternalIdToUseEmailOtp: "enabled" }, token);
    case "enable-sms-mfa":
      return {
        ...(await patchAuthMethod(kind, "Sms", { "@odata.type": "#microsoft.graph.smsAuthenticationMethodConfiguration", state: "enabled" }, token)),
        message: "SMS policy is enabled. Users still need a registered phone method, and the tenant may require billing/telephony setup.",
        requiresFollowUp: true,
      };
    case "enable-passkey":
      return {
        ...(await patchAuthMethod(kind, "Fido2", {
          "@odata.type": "#microsoft.graph.fido2AuthenticationMethodConfiguration",
          state: "enabled",
          isSelfServiceRegistrationAllowed: true,
        }, token)),
        message: "The FIDO2 base policy is enabled. Policy Translator intentionally leaves passkey profiles and user/group targeting unchanged; configure those manually together with local password accounts, recent MFA, Azure Front Door, a custom URL domain, and a credential-registration experience.",
        requiresFollowUp: true,
      };
    case "create-ca-policy": return createCaPolicy(cfg, token, state);
    case "add-oidc-idp":
      return {
        kind,
        label: lbl(kind),
        status: "manual",
        message: "External ID supports custom OIDC, but Microsoft does not publish a supported external-tenant Graph create API. Configure the provider in the Entra admin center and add it to the user flow.",
      };
    case "add-apple-idp":
      return {
        kind,
        label: lbl(kind),
        status: "manual",
        message: "External ID supports Apple federation, but Microsoft does not publish a supported external-tenant Graph create API. Configure Apple in the Entra admin center and add it to the user flow.",
      };
    case "claims-mapping-policy": return configureClaimsMapping(cfg, token, state);
    case "enable-sspr": return enableSspr(token, state);
    case "create-custom-attributes": return createCustomAttributes(cfg, token, state);
    case "migrate-company-branding": return migrateCompanyBranding(cfg, token);
    case "smoke-test-native-auth": return smokeTestNativeAuth(cfg, token, state);
    default:
      return { kind, label: LABELS[kind] || kind, status: "manual", message: MANUAL_REASONS[kind] || "Configure this manually in the Entra admin center." };
  }
}

/**
 * Execute the selected steps in canonical order. `onStep` (optional) is called
 * after each step completes so a caller can stream progress. Returns per-step
 * results plus the accumulated tenant state (appId, flowId, ...).
 */
export async function executeApply(
  selectedKinds: string[],
  cfg: ApplyConfig,
  token: string,
  onStep?: (r: StepResult) => void,
): Promise<{ applied: StepResult[]; state: ApplyState }> {
  const ordered = ALL_ORDER.filter((k) => selectedKinds.includes(k));
  const state: ApplyState = {};
  const applied: StepResult[] = [];

  for (const kind of ordered) {
    let result: StepResult;
    try {
      result = await runStep(kind, cfg, token, state);
    } catch (err) {
      const msg = explainError(kind, err);
      result = { kind, label: LABELS[kind] || kind, status: "failed", message: msg };
    }
    applied.push(result);
    onStep?.(result);
  }

  return { applied, state };
}

export { LABELS, ALL_ORDER };
