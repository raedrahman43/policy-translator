# Prerequisites

## Repository access

While the repository is private, the GitHub account cloning it must be an invited
collaborator. This requirement disappears when the repository is made public.

## Run Policy Translator

Required:

- Node.js 22 or later;
- npm (included with Node.js);
- Edge, Chrome, Firefox, or another modern browser;
- outbound HTTPS access to npm, GitHub, Microsoft identity endpoints, and Microsoft
  Graph;
- an available local TCP port (4001 by default).

Verify:

```powershell
node --version
npm --version
npm ci
npm run doctor
```

## Obtain Policy Analyzer input

For real migration input:

- an existing Azure AD B2C tenant;
- custom policies uploaded to Identity Experience Framework;
- B2C IEF Policy Administrator or Global Administrator;
- at least one relying-party policy selected in Migration Policy Analyzer.

Portal path:

**Azure portal -> B2C tenant -> Identity Experience Framework -> Migration Policy
Analyzer -> Analyze Policies**.

Without B2C access, use `data/sample.json`.

## Simulate a migration

Simulation requires no Graph administrator sign-in and makes no tenant changes. A
synthetic tenant GUID is sufficient for walking through the plan.

## Apply to an External ID tenant

Required:

- a Microsoft Entra External ID external tenant;
- a signed-in account in that tenant;
- ability to grant the delegated Graph scopes shown by the consent page;
- directory roles required by selected operations.

Potential roles:

- Application Administrator;
- External ID User Flow Administrator;
- External Identity Provider Administrator;
- Authentication Policy Administrator;
- Conditional Access Administrator or Security Administrator;
- Organizational Branding Administrator.

Role requirements are feature-dependent. Microsoft Graph consent and directory roles
are separate requirements.

## Run generated PowerShell

Additional requirements:

- PowerShell 7 or later;
- Microsoft Graph PowerShell SDK.

```powershell
Install-Module Microsoft.Graph -Scope CurrentUser
npm run doctor:scripts
```

Run scripts from inside the extracted package so `$PSScriptRoot` state chaining works.

## Feature-specific prerequisites

### Google

- Google Cloud project;
- OAuth consent configuration;
- Web application client ID and secret;
- redirect URIs printed by the generated script.

### Facebook

- Meta/Facebook developer app;
- Facebook Login product;
- app ID and active app secret;
- required redirect URI.

### Conditional Access

- the application ID of the protected API/resource;
- Conditional Access licensing for the external tenant;
- report-only validation before enforcement.

### SMS

- tenant billing/telephony readiness;
- a test customer with a registered phone method.

### Passkey

- a custom URL domain;
- a credential registration/removal experience;
- browser-delegated authentication (not native-auth APIs).

### Branding import

- access to the source B2C tenant;
- permission to read Company Branding;
- Organizational Branding Administrator on the target for writes.

### Claims

- Application Administrator or equivalent permissions;
- a real token validation plan;
- a custom claims provider for claims sourced from external systems.

## Recommended environment

- Start with a non-production External ID tenant.
- Use simulation before real apply.
- Keep Conditional Access report-only.
- Do not paste customer exports or secrets into public issues.
