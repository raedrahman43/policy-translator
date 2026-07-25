# Customer administrator validation walkthrough

This walkthrough validates the port-4001 experience in a non-production External ID
tenant.

## Prepare

- Node.js 18+ and npm
- A synthetic or approved Analyzer JSON file
- An External ID test tenant
- An account with the roles required by selected features
- Optional Google/Facebook test-provider credentials

```powershell
npm ci
npm run web:proto
```

Open <http://localhost:4001>.

To obtain a real export:

**Azure portal -> B2C tenant -> Identity Experience Framework -> Migration Policy
Analyzer -> select policies including an RP policy -> Analyze Policies**.

Use the JSON from the analyzer API response. If you do not have an existing B2C
custom-policy tenant, use `data/sample.json`.

## 1. Analyze

Upload the Analyzer JSON. Confirm:

- feature count is plausible;
- unsupported behavior appears under manual follow-ups;
- Apple/custom OIDC do not appear as automated writes;
- branding detection is labeled honestly.

## 2. Select and preview

Test both migration approaches:

- closest 1:1 selects only detected capabilities;
- modernize reveals safe optional additions.

Import source branding only with an approved test tenant. Confirm the preview changes
without exposing tokens or secrets in the browser.

## 3. Simulate

Enter a target tenant ID, then choose simulation.

Confirm:

- no fake resource IDs are shown;
- actions are labeled planned;
- Graph scopes and roles match selected features;
- scripts open and download;
- the gap report previews full-width and wraps without horizontal scrolling.

## 4. Apply for real

Use the test tenant and complete device-code sign-in.

Expected core behavior:

1. Native app registration is created or reused.
2. Service principal is created or reused.
3. User flow is created, app-bound, and attribute-bound.
4. Native-auth smoke test reaches `/initiate`.
5. Independent selected settings execute.
6. Failures and validation requirements appear in the final report.

## 5. Verify

- App registration manifest and redirect URI
- Service principal
- User flow application binding
- Sign-up attributes and required flags
- Google/Facebook provider button and real sign-in
- Email OTP and password reset
- SMS with a registered test phone
- Claims in a decoded token
- Conditional Access report-only logs
- Passkey custom-domain/registration requirements
- Hosted Company Branding

## 6. Rerun

Run the same migration again. The final state should converge:

- resources are reused;
- bindings are not duplicated;
- branding is skipped when bytes/properties already match;
- conflicts fail safely instead of overwriting unrelated configuration.

Keep the downloaded gap report with the test evidence.
