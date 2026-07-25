/**
 * Input Requirements Deriver
 *
 * Given the steps a policy maps to, determine exactly which inputs the
 * customer must provide. This drives the dynamic configuration form in the UI:
 * we only ask for Google credentials if the policy actually uses Google, etc.
 *
 * Deterministic — same input always yields the same required-input set.
 */

import { MappingResult, StepKind } from "../mappers/featureMap";

export type InputType = "text" | "password" | "guid" | "url";

export interface InputField {
  key: string;          // matches TenantConfig field name
  label: string;
  type: InputType;
  required: boolean;
  group: string;        // section header in the UI
  placeholder: string;
  help: string;
}

// Inputs that are needed whenever we create an app registration (essentially always).
const CORE_INPUTS: InputField[] = [
  {
    key: "tenantId",
    label: "Tenant ID",
    type: "guid",
    required: true,
    group: "External ID Tenant",
    placeholder: "00000000-0000-0000-0000-000000000000",
    help: "The Directory (tenant) ID of your Microsoft Entra External ID tenant. Found in the Entra admin center under Overview.",
  },
  {
    key: "bundleId",
    label: "App Bundle ID",
    type: "text",
    required: false,
    group: "External ID Tenant",
    placeholder: "com.contoso.yourapp",
    help: "Your mobile app's bundle identifier (iOS) or package name (Android). Used for the native app registration. Defaults to com.contoso.yourapp if left blank.",
  },
];

// Per-step credential requirements. Only emitted when the step is present.
const STEP_INPUTS: Partial<Record<StepKind, InputField[]>> = {
  "add-google-idp": [
    {
      key: "googleClientId",
      label: "Google Client ID",
      type: "text",
      required: true,
      group: "Google Identity Provider",
      placeholder: "xxxxxx.apps.googleusercontent.com",
      help: "From your Google Cloud Console OAuth 2.0 credentials. Required to federate Google sign-in.",
    },
    {
      key: "googleClientSecret",
      label: "Google Client Secret",
      type: "password",
      required: true,
      group: "Google Identity Provider",
      placeholder: "<GOOGLE_CLIENT_SECRET>",
      help: "The OAuth client secret paired with the Client ID above.",
    },
  ],
  "add-facebook-idp": [
    {
      key: "facebookAppId",
      label: "Facebook App ID",
      type: "text",
      required: true,
      group: "Facebook Identity Provider",
      placeholder: "1234567890123456",
      help: "From your Facebook App dashboard (developers.facebook.com). Required to federate Facebook sign-in.",
    },
    {
      key: "facebookAppSecret",
      label: "Facebook App Secret",
      type: "password",
      required: true,
      group: "Facebook Identity Provider",
      placeholder: "abc123...",
      help: "The App Secret paired with the App ID above.",
    },
  ],
  "create-ca-policy": [
    {
      key: "caResourceAppId",
      label: "Conditional Access resource application ID",
      type: "guid",
      required: true,
      group: "Conditional Access",
      placeholder: "00000000-0000-0000-0000-000000000000",
      help: "The application (client) ID of the protected API/resource that Conditional Access evaluates. Do not use the public/native client app ID unless it is also the resource audience.",
    },
  ],
};

/**
 * Collect the set of StepKinds present across all mapped results.
 */
export function collectStepKinds(results: MappingResult[]): Set<StepKind> {
  const kinds = new Set<StepKind>();
  for (const result of results) {
    for (const step of result.steps) {
      kinds.add(step.kind);
    }
  }
  return kinds;
}

/**
 * IdP credential steps whose inputs are OPTIONAL at generation time. Each of
 * these maps to a script that guards on unfilled "<EDIT_ME_*>" values and
 * skips itself (exit 0) until real credentials are provided. So we must not
 * block package generation on them: the customer can generate now and fill the
 * IdP credentials later, then re-run just that one script.
 */
const SKIPPABLE_IDP_KINDS = new Set<StepKind>([
  "add-google-idp",
  "add-facebook-idp",
]);

/**
 * Derive the ordered list of input fields the customer must supply,
 * based on which steps their policy actually requires.
 */
export function deriveRequiredInputs(results: MappingResult[], additionalKinds: Iterable<StepKind> = []): InputField[] {
  const kinds = collectStepKinds(results);
  for (const kind of additionalKinds) kinds.add(kind);
  const fields: InputField[] = [];

  // Core inputs are needed whenever any app/flow is created.
  const needsCore =
    kinds.has("create-native-app") ||
    kinds.has("create-user-flow-emailpassword") ||
    kinds.size > 0;

  if (needsCore) {
    fields.push(...CORE_INPUTS);
  }

  for (const kind of kinds) {
    const stepFields = STEP_INPUTS[kind];
    if (!stepFields) continue;

    if (SKIPPABLE_IDP_KINDS.has(kind)) {
      // IdP credentials are optional: the generated script no-ops until filled.
      fields.push(
        ...stepFields.map((f) => ({
          ...f,
          required: false,
          help:
            f.help +
            " Leave blank to skip this provider for now; the generated script will no-op until you fill it in and re-run that script.",
        }))
      );
    } else {
      fields.push(...stepFields);
    }
  }

  return fields;
}
