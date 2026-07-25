# Policy Translator user guide

This guide is for a customer administrator evaluating a B2C-to-External-ID
configuration migration.

## 1. Start safely

Use a test External ID tenant first. Policy Translator changes tenant configuration; it
does not migrate users, passwords, sessions, or application data.

Install and start the guided experience:

```powershell
npm ci
npm run doctor
npm run web:proto
```

Open <http://localhost:4001>.

The service is local-only. Keep the terminal open while using the browser.
See [docs/PREREQUISITES.md](docs/PREREQUISITES.md) for the complete environment,
role, provider, and tenant checklist.

## 2. Obtain Policy Analyzer input

For an existing Azure AD B2C custom-policy tenant:

1. Open the Azure portal and switch to the B2C directory.
2. Open **Identity Experience Framework**.
3. Select **Migration Policy Analyzer**.
4. Select the uploaded policy files and include an RP policy.
5. Select **Analyze Policies**.
6. Download the JSON from the analyzer API response or copy the formatted portal
   result.

Required role: **B2C IEF Policy Administrator** or **Global Administrator**.

The analyzer is for custom policies. Standard B2C user flows do not need analysis. New
users without an existing B2C tenant should use the repository's synthetic
[`data/sample.json`](data/sample.json) for evaluation.

Official instructions:
<https://learn.microsoft.com/entra/external-id/customers/how-to-analyze-azure-ad-b2c-custom-policies>.

## 3. Provide Analyzer input

Upload or paste a Policy Analyzer JSON export. Do not use a customer export when
reporting a public issue; create a synthetic minimum reproduction instead.

The review page separates:

- platform availability in External ID;
- automated configuration;
- partial automation requiring validation;
- guided manual work;
- and capabilities with no direct equivalent.

## 4. Choose the migration approach

### Move my policy as-is

This is the default. Only capabilities detected in the source policy are selected.
Imported or detected branding is preserved as closely as External ID supports.

### Modernize in External ID

Detected capabilities stay selected and additional supported options become available.
Branding controls are unlocked so you can intentionally change the sign-in experience.

The preview is representative of the hosted External ID page, not a pixel-perfect
browser renderer.

## 5. Branding

Policy Analyzer often tells the tool that branding exists without including the actual
image files or colors.

For an exact source read:

1. Enter the source B2C tenant ID or `onmicrosoft.com` domain.
2. Select **Import branding**.
3. Complete device-code sign-in to the source tenant.
4. Review the logo, background, text, and custom CSS detected by Graph.

For modernization, you can upload a local image or supply a public HTTPS image URL.
Uploaded files remain in the request and are not written to disk.

## 6. Configure the target tenant

The form asks only for selected automated features.

Always required:

- target External ID tenant ID or `onmicrosoft.com` domain;
- app and user-flow names (defaults are generated);
- native app bundle/package ID when applicable.

Feature-specific inputs:

- Google: OAuth client ID and secret;
- Facebook: app ID and secret;
- Conditional Access: the application ID of the **protected API/resource**, not the
  generated public/native client unless that client is also the resource.

Apple and custom OIDC appear in the gap report with admin-center instructions rather
than unsupported Graph writes.

## 7. Review permissions

Before apply, the consent dialog shows the exact delegated Graph scopes and likely
administrator roles.

Common roles include:

- Application Administrator;
- External ID User Flow Administrator;
- External Identity Provider Administrator;
- Authentication Policy Administrator;
- Conditional Access Administrator;
- Organizational Branding Administrator.

Microsoft Graph permissions do not replace directory roles. A 403 result normally means
the signed-in account lacks a required role or admin-consented delegated scope.

## 8. Simulate first

Simulation creates no resources and fabricates no success IDs. It shows the planned
actions, final preview, and analyzer gaps.

Use simulation to:

- inspect selected operations;
- open the equivalent scripts;
- confirm requested permissions;
- and review the expected follow-up report.

## 9. Apply for real

Select **Apply to my tenant**, acknowledge the warning, and complete device-code sign-in.
The server stores the token in memory for the short-lived apply session.

Each result is one of:

- **created**: the resource or setting was changed;
- **reused**: the target already matched;
- **manual**: no supported safe automation exists;
- **skipped**: a prerequisite or source value was absent;
- **failed**: Graph rejected the operation or validation failed.

The executor continues through independent steps so you receive a complete follow-up
list, but dependent operations do not claim success after a prerequisite failure.

## 10. Use the result page

The final page shows:

- every selected operation and its result;
- a hosted-page preview;
- created app/user-flow identifiers;
- and **Still needs manual work**.

Use **Preview gap report** for a full-width, wrapped report containing analyzer gaps,
Graph failures, skipped steps, and required validation work. Use **Download .md** to
keep that report with the migration record.

## 11. Inspect or run the scripts

At any point, select **View the scripts**. The package uses the same mapper and payload
intent as the live backend.

To run a downloaded package:

```powershell
Set-Location <downloaded-package>
pwsh ./01-create-native-app.ps1
pwsh ./02-create-user-flow.ps1
# Continue in numeric order.
```

Scripts keep local state in `$PSScriptRoot\.last-*.json`, are safe to move as a folder,
and fail non-zero when required configuration is missing or a write cannot be verified.

## 12. Validate the tenant

Do not treat a Graph 2xx response as the only proof.

- App registration: verify native-auth manifest values and redirect URI.
- User flow: verify the app, identity providers, and sign-up attributes.
- Google/Facebook: complete a real provider sign-in.
- Email OTP/SSPR/SMS: complete the end-user flow.
- Claims mapping: decode a real token and inspect every expected claim.
- Conditional Access: review report-only sign-in logs before enabling.
- Passkey: verify custom domain plus registration and browser sign-in.
- Branding: open the real hosted sign-in page.

## Troubleshooting

### Port 4001 does not open

Confirm the terminal still shows the server running, then open
<http://localhost:4001> directly in Edge or Chrome.

### A step returns 403

Expand the follow-up item. It identifies the likely role and Graph scope. Acquire the
role, sign in again, and rerun. Existing resources are reused.

### A provider was created but sign-in fails

Graph cannot validate third-party secrets. Confirm the provider's redirect URI, active
secret, consent configuration, and claims by completing a browser sign-in.

### The user flow rejects an attribute

Use a current build and rerun. The mapper only derives built-in sign-up attributes from
the actual sign-up attribute feature; MFA features do not inject sign-up fields.

### The generated package contains sensitive values

That is expected after you enter tenant/provider configuration. Do not commit or attach
generated packages to public issues.
