# Policy Translator

[![CI](https://github.com/raedrahman43/policy-translator/actions/workflows/ci.yml/badge.svg)](https://github.com/raedrahman43/policy-translator/actions/workflows/ci.yml)
[![CodeQL](https://github.com/raedrahman43/policy-translator/actions/workflows/codeql.yml/badge.svg)](https://github.com/raedrahman43/policy-translator/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Policy Translator converts Azure AD B2C Policy Analyzer JSON into an inspectable
migration plan for Microsoft Entra External ID:

- ordered, idempotent PowerShell scripts;
- an opt-in Microsoft Graph apply workflow;
- a hosted sign-in branding preview;
- and an honest gap report for everything that still needs manual work.

The translation engine is deterministic. There is no AI dependency at runtime and the
same Analyzer input produces the same migration package.

> **Project status:** early community preview. Use a non-production External ID tenant,
> start with simulation, inspect every generated script, and validate all follow-ups.
> This project is not an official Microsoft support channel.

## Quick start

Prerequisites:

- Node.js 22 or later;
- npm;
- PowerShell 7 and the Microsoft Graph PowerShell module if you plan to run the
  generated scripts.

See [docs/PREREQUISITES.md](docs/PREREQUISITES.md) for Analyzer access, target-tenant
roles, and feature-specific requirements.

```powershell
git clone https://github.com/raedrahman43/policy-translator.git
Set-Location policy-translator
npm ci
npm run doctor
npm run web:proto
```

Open <http://localhost:4001>.

## Get Policy Analyzer JSON

For an existing Azure AD B2C tenant with custom policies:

1. Open the Azure portal and switch to the B2C tenant.
2. Go to **Identity Experience Framework**.
3. Open **Migration Policy Analyzer**.
4. Select the policy files, including at least one relying-party (RP) policy.
5. Select **Analyze Policies**.
6. Download/copy the JSON result from the analyzer API response and use it as the
   Policy Translator input.

You need **B2C IEF Policy Administrator** or **Global Administrator**. The analyzer is
for custom policies; standard user flows do not require analysis.

Microsoft documentation:
[Analyze Azure AD B2C custom policies](https://learn.microsoft.com/entra/external-id/customers/how-to-analyze-azure-ad-b2c-custom-policies).

If you do not have an existing B2C custom-policy tenant, use
[`data/sample.json`](data/sample.json) to evaluate Policy Translator. Migration Policy
Analyzer is an in-tenant B2C feature, not a standalone public CLI.

The port-4001 experience guides you through:

1. Uploading or pasting Policy Analyzer JSON.
2. Reviewing detected features and unsupported behavior.
3. Choosing **closest 1:1 migration** or **modernize in External ID**.
4. Previewing/importing Company Branding.
5. Reviewing scripts, Graph permissions, and required administrator roles.
6. Simulating the plan or explicitly signing in for a real Graph apply.
7. Previewing or downloading the final gap report.

See [USER-GUIDE.md](USER-GUIDE.md) for the full customer-administrator walkthrough.

## What is automated

| Capability | Current path | Verification expectation |
| --- | --- | --- |
| Native app registration and service principal | Script + live Graph | Live verified; reruns converge |
| Email/password sign-up and sign-in user flow | Script + live Graph | Live verified; reruns repair app/attribute bindings |
| Native-auth smoke test | Read-only live endpoint check | Live verified |
| Standard and custom sign-up attributes | Script + live Graph | Verify page layout and directory writes |
| Google and Facebook federation | Script + live Graph | Provider creation is automated; live provider sign-in is required |
| Email OTP | Script + live Graph | Live verified |
| Claims mapping | Script + live Graph | Decode a real token and verify each claim |
| SSPR prerequisites | Script + live Graph | Complete a real password reset |
| SMS policy | Script + live Graph | Requires phone registration and tenant telephony readiness |
| Conditional Access | Report-only policy | Requires the protected resource app ID and sign-in-log validation |
| FIDO2/passkey policy | Tenant policy only | Custom domain and registration experience still required |
| Company Branding | Port-4001 live Graph path | Verify hosted page assets and custom CSS |

Apple and custom OIDC are **guided manual** paths. External ID supports them, but
Microsoft does not currently publish a supported external-tenant Graph create API for
those provider types. The tool does not use the B2C-only beta model and does not report
a fake success.

The generated [feature coverage dashboard](docs/FEATURE-MATRIX.md) tracks all known
Analyzer feature keys and is regenerated from the mapper on every pull request.

## Other entry points

Generate a migration package from the command line:

```powershell
npm run translate -- .\data\sample.json
```

Run the script-generation-only web experience:

```powershell
npm run web
```

Then open <http://localhost:4000>.

## Safety model

- Simulation is the default; real tenant changes require an explicit selection and
  device-code administrator sign-in.
- The port-4001 server binds to loopback only and enforces Host, Origin, and CSRF checks.
- Access tokens remain in server memory and are never returned to the browser.
- Generated state, tenant IDs, provider secrets, customer exports, and private keys are
  excluded by `.gitignore`.
- Logo downloads enforce HTTPS, image size/type limits, redirect limits, and private
  network blocking.
- There is no runtime product telemetry. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Development

```powershell
npm ci
npm run typecheck
npm test
npm run test:web-proto
npm run check:powershell
npm run docs:features
```

- `npm test`: deterministic translator, fixture, and full-feature accounting suite.
- `npm run test:web-proto`: mocked-Graph coverage for the port-4001 backend.
- `npm run docs:features`: regenerates the feature chart and JSON dashboard.

For AI-assisted development, start with [AGENTS.md](AGENTS.md). It provides a compact
architecture map, non-negotiable safety rules, feature extension points, validation
requirements, known limitations, and a reusable prompt for coding assistants.

See:

- [AGENTS.md](AGENTS.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [docs/ADDING-A-FEATURE.md](docs/ADDING-A-FEATURE.md)
- [docs/PREREQUISITES.md](docs/PREREQUISITES.md)
- [docs/TESTING.md](docs/TESTING.md)
- [SECURITY.md](SECURITY.md)
- [SUPPORT.md](SUPPORT.md)
- [GOVERNANCE.md](GOVERNANCE.md)

## License

Licensed under the [MIT License](LICENSE).
