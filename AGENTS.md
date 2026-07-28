# AI Agent Guide

Use this file as the starting context for AI-assisted development in Policy
Translator. It summarizes the repository's architecture, invariants, extension
points, and validation requirements. The code, current Microsoft documentation,
and the linked repository documentation remain the source of truth.

## Suggested prompt

Give an AI coding assistant this instruction before asking it to change the project:

```text
Read AGENTS.md, ARCHITECTURE.md, CONTRIBUTING.md,
docs/ADDING-A-FEATURE.md, docs/TESTING.md, and SECURITY.md before editing.
Trace the requested capability across the mapper, generator, web inputs,
Graph executor, PowerShell templates, manual guidance, tests, and feature
dashboard. Preserve deterministic output, idempotency, least privilege,
simulation-first behavior, and honest gap reporting. Do not use real tenant
data, credentials, or unsupported B2C-only APIs.
```

## Project purpose

Policy Translator converts Azure AD B2C Policy Analyzer JSON into an inspectable
Microsoft Entra External ID migration plan:

- deterministic, ordered PowerShell scripts;
- an opt-in live Microsoft Graph apply path;
- a hosted sign-in branding preview;
- and a gap report with manual recreation steps.

The project is an early community preview. It is not an official Microsoft
support channel. Runtime translation does not use AI.

## System map

```text
Policy Analyzer JSON
        |
        v
validate -> extract context -> map features -> order steps
        |                                  |
        |                                  +-> gap/manual guidance
        v
PowerShell package                    Port 4001 Graph executor
```

| Area | Primary paths |
| --- | --- |
| Input validation | `src/parsers/inputValidator.ts` |
| App, flow, claim, and attribute context | `src/parsers/policyContextParser.ts` |
| Analyzer feature mapping | `src/mappers/featureMap.ts` |
| Step ordering and PowerShell generation | `src/generators/scriptGenerator.ts` |
| PowerShell actions | `src/generators/templates/` |
| Manual recreation guidance | `src/generators/manualRecreation.ts` |
| Guided local server | `src/web-proto/server.ts` |
| Live Graph operations | `src/web-proto/graphExecutor.ts` |
| Graph authentication and requests | `src/web-proto/graphClient.ts` |
| Branding import/write behavior | `src/web-proto/branding.ts` |
| Port-4001 browser experience | `src/web-proto/public/` |
| Script-only web experience | `src/web/` |
| CLI generation | `src/index.ts` |

## Entry points

| Command | Purpose |
| --- | --- |
| `npm run web:proto` | Guided local experience on `http://localhost:4001` |
| `npm run web` | Script-generation-only experience on port 4000 |
| `npm run translate -- .\data\sample.json` | Generate a package from the CLI |
| `npm run doctor` | Check customer prerequisites |
| `npm run check` | Run the repository's consolidated validation gate |

The port-4001 server is intentionally local-only. Do not bind it publicly, remove
Host/Origin/CSRF checks, or persist its tokens without an explicit hosted-service
architecture, threat model, privacy review, and tenant-isolation design.

## Non-negotiable invariants

1. **Determinism:** equivalent input and configuration produce equivalent plans.
2. **Dependency order:** app -> flow -> providers/settings -> validation/follow-up.
3. **Convergence:** reruns reuse matching state, repair supported drift, or report
   a conflict without creating unsafe duplicates.
4. **Honesty:** unsupported, partial, or unverified work never returns a
   success-shaped result.
5. **Least privilege:** request only scopes required by selected operations.
6. **Safe defaults:** simulation is the default and Conditional Access starts in
   report-only mode.
7. **Parity:** PowerShell and live Graph paths target the same result where both
   paths exist.
8. **Local privacy:** Analyzer JSON, tokens, credentials, and generated state are
   not uploaded or persisted by the application.

Do not broadly catch Graph 400/403 errors and continue. Surface permission,
licensing, unsupported API, conflict, and incomplete-result failures explicitly.

## Feature lifecycle

Every known Analyzer feature must resolve to one of these categories:

- **Automated:** a supported API can safely converge the target state.
- **Partial automation:** the tool can configure a safe portion, but customer
  rollout or live verification remains.
- **Guided manual:** External ID supports the behavior, but no safe supported API
  is available.
- **No generated action:** External ID provides the behavior by default or outside
  the migration package, with a documented `noopReason`.

Never silently drop a feature.

## Adding or changing a feature

Before implementing:

1. Identify the exact Analyzer feature key and add a synthetic example.
2. Verify the current External ID behavior in official Microsoft Learn and
   Microsoft Graph documentation.
3. Record API availability, delegated scopes, directory roles, licensing, tenant
   prerequisites, and whether the capability is GA, preview, or unsupported.
4. Search for an existing `StepKind` or related implementation before adding one.

For a new automated or partially automated action, inspect and update all relevant
surfaces:

1. `src/mappers/featureMap.ts`
2. `src/generators/scriptGenerator.ts`
3. `src/web/inputRequirements.ts`
4. `src/web-proto/graphExecutor.ts`
5. `src/generators/templates/`
6. `src/generators/manualRecreation.ts`
7. `src/test/regression.ts`
8. `src/test/webProtoRegression.ts`
9. customer/admin documentation
10. `docs/FEATURE-MATRIX.md` and `docs/feature-coverage.json` via
    `npm run docs:features`

Every write operation must:

- find and inspect existing state;
- compare meaningful configuration, not only display names;
- reuse an exact match;
- repair only supported drift;
- refuse unsafe same-name conflicts;
- account for eventual consistency;
- verify the resulting state;
- and report required customer follow-up.

## Current capability boundaries

Keep these limitations explicit unless current official documentation and live
validation justify a change:

- Apple and custom OIDC federation are guided manual paths because a supported
  external-tenant Graph create API is not used.
- Passkey automation enables tenant policy only; custom domains, passkey profiles,
  credential management, registration, and real sign-in still require follow-up.
- Conditional Access requires the protected resource application ID and is created
  in report-only mode.
- SMS requires subscription/telephony readiness, applicable charges, user phone
  registration, and a real MFA test.
- SSPR configures prerequisites; a real Forgot password flow must still be tested.
- A Graph 2xx response alone is not proof that the customer-visible experience works.
- Company Branding is tenant-level. B2C custom HTML cannot always be recreated
  one-to-one in External ID.

## Validation

Use the smallest relevant checks while iterating, then run the complete gate before
merging a feature or behavior change:

```powershell
npm ci
npm run typecheck
npm test
npm run test:web-proto
npm run check:powershell
node --check src/web-proto/public/app.js
npm run docs:features
```

`npm run docs:features` generates the feature matrix. Do not hand-edit generated
coverage output without updating the source mapping.

Mocked tests do not replace live-tenant validation. For a live test, use a
non-production tenant and record:

- prerequisites and tenant type;
- first-run result;
- second-run/idempotency result;
- admin-center verification;
- customer-visible sign-in, provider, token, reset, or branding behavior;
- cleanup or rollback;
- and remaining follow-up.

Never put live identifiers or screenshots into the repository.

## Security and privacy rules

Never commit or paste into issues, pull requests, fixtures, or documentation:

- customer Policy Analyzer exports;
- tenant, app, object, service-principal, flow, or policy IDs;
- provider secrets, tokens, device codes, private keys, or certificates;
- generated `.last-*.json` state or migration packages;
- internal links or screenshots containing identifiers.

Use synthetic fixtures. Keep access tokens server-side and in memory. Preserve HTTPS,
SSRF, redirect, file type, and size controls for branding assets. Escape untrusted
values in generated PowerShell.

If a secret is exposed, removal is not enough: revoke or rotate it.

## Pull-request expectations

Keep changes focused. A feature PR should state:

- Analyzer keys and target External ID behavior;
- official documentation evidence;
- permissions, roles, licensing, and security impact;
- idempotency and conflict behavior;
- tests and live-validation status;
- limitations, follow-up, and rollback;
- and documentation/feature-matrix changes.

CI must be green. Unsupported or unverified behavior must remain manual or partial.

## Reference documents

- [README.md](README.md): customer overview and quick start
- [ARCHITECTURE.md](ARCHITECTURE.md): system boundaries and invariants
- [CONTRIBUTING.md](CONTRIBUTING.md): contribution rules
- [docs/ADDING-A-FEATURE.md](docs/ADDING-A-FEATURE.md): complete extension checklist
- [docs/TESTING.md](docs/TESTING.md): validation strategy
- [docs/PREREQUISITES.md](docs/PREREQUISITES.md): customer prerequisites
- [SECURITY.md](SECURITY.md): vulnerability and sensitive-data policy
- [docs/PRIVACY.md](docs/PRIVACY.md): runtime data handling
- [GOVERNANCE.md](GOVERNANCE.md): maintainership and ownership
