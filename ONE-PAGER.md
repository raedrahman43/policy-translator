# Policy Translator quick evaluation

## What it does

Converts Azure AD B2C Policy Analyzer JSON into an External ID migration plan,
PowerShell package, live Graph apply option, branding preview, and gap report.

## Start

```powershell
npm ci
npm run web:proto
```

Open <http://localhost:4001>.

## Get the input

Existing B2C custom-policy customers can use:

**Azure portal -> B2C tenant -> Identity Experience Framework -> Migration Policy
Analyzer -> Analyze Policies**.

Include an RP policy and use the JSON result. The required role is B2C IEF Policy
Administrator or Global Administrator. Without B2C access, use `data/sample.json`.

## Recommended customer-admin flow

1. Use a non-production External ID tenant.
2. Upload a sanitized Analyzer export.
3. Review platform support and manual gaps.
4. Choose closest 1:1 or modernize.
5. Import or configure branding.
6. Simulate and inspect the scripts.
7. Apply with a tenant administrator only after reviewing scopes.
8. Download the final gap report.
9. Validate every configured feature in the Entra admin center and with a real sign-in.

## Important limitations

- Apple/custom OIDC are guided manual setup.
- Google/Facebook secrets require live provider sign-in validation.
- Conditional Access needs the protected resource app ID and starts report-only.
- SMS, SSPR, passkey, claims, and branding require explicit follow-up validation.
- The project does not migrate users or passwords.

## Quality gates

```powershell
npm run typecheck
npm test
npm run test:web-proto
npm run check:powershell
npm run docs:features
```

See [USER-GUIDE.md](USER-GUIDE.md) for details.
