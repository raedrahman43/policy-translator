# Architecture

Policy Translator has a deterministic translation core and two local web experiences.

## System boundaries

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

Optional telemetry is outside the migration-data path:

```text
Allowlisted anonymous event
        |
        v
local sanitizer -> configured Azure Function -> Application Insights -> Workbook

Analyzer JSON, tenant data, credentials, and Graph payloads never enter this path.
```

### Deterministic core

| Path | Responsibility |
| --- | --- |
| `src/parsers/inputValidator.ts` | Validate and normalize Analyzer input |
| `src/parsers/policyContextParser.ts` | Derive app/flow names, claims, and sign-up attributes |
| `src/mappers/featureMap.ts` | Feature key to automated/no-action/gap mapping |
| `src/generators/scriptGenerator.ts` | Canonical step ordering and PowerShell rendering |
| `src/generators/templates/` | Relocatable PowerShell templates |
| `src/generators/manualRecreation.ts` | Deterministic manual recreation knowledge base |

The translation core performs no AI inference. Output differs only by supplied config
and generation time.

### Port 4001 guided apply

| Path | Responsibility |
| --- | --- |
| `src/web-proto/server.ts` | Analyze, scripts, device-code sessions, simulation, real apply |
| `src/web-proto/graphExecutor.ts` | Ordered idempotent Graph operations |
| `src/web-proto/graphClient.ts` | Device code, Graph requests, retry/throttling, binary streams |
| `src/web-proto/branding.ts` | Read/copy Company Branding |
| `src/web-proto/public/` | Five-step browser workflow |

The server binds to `127.0.0.1`, validates Host and Origin, and requires a per-page CSRF
token for state-changing API calls. Access tokens stay in a short-lived in-memory map.

### Port 4000 and CLI

- `src/web/server.ts`: script-generation-only web UI at port 4000.
- `src/index.ts`: CLI package generation.

Both reuse the same validator, mapper, context parser, and script generator.

## Execution invariants

1. **Dependency order:** app -> flow -> providers/settings -> validation/follow-up.
2. **Convergence:** reruns create missing state, repair supported drift, or report a
   conflict without duplicating resources.
3. **Honesty:** unsupported APIs and unverified provider secrets never return success.
4. **Least privilege:** requested scopes are the union of selected operations.
5. **Safe defaults:** simulation and report-only Conditional Access are default.
6. **Parity:** PowerShell and live Graph paths target the same outcome where both exist.

## Feature lifecycle

A feature begins as one Analyzer key and ends in one of three paths:

- **Automated:** one or more `StepKind` values.
- **Guided manual:** a gap entry plus manual recreation steps.
- **No generated action:** External ID handles it by default or outside this package.

`npm run docs:features` reads all Analyzer feature keys and produces
`docs/FEATURE-MATRIX.md` plus `docs/feature-coverage.json`. CI rejects uncommitted chart
changes and any unaccounted feature.

## Graph API policy

Automated writes require current, supported External ID or Microsoft Graph
documentation. B2C-only beta models are not treated as external-tenant APIs.

This is why:

- Google/Facebook are automated;
- Apple/custom OIDC are guided manual;
- Conditional Access requires a protected resource ID;
- passkey, SMS, and SSPR report required rollout validation.

## Security and privacy

- Browser requests are local-only and CSRF protected.
- Graph 429/5xx responses use bounded retries and `Retry-After`.
- Branding URL fetches block private/local networks and enforce HTTPS/type/size limits.
- PowerShell substitutions escape quotes, dollar signs, backticks, and newlines.
- Runtime state and customer exports are ignored from Git.
- Runtime telemetry is inactive unless an endpoint is explicitly configured.
- Configured telemetry uses an allowlisted anonymous schema and a visible opt-out.
- Telemetry delivery failure never affects migration behavior.

See [SECURITY.md](SECURITY.md), [docs/PRIVACY.md](docs/PRIVACY.md), and
[docs/TELEMETRY.md](docs/TELEMETRY.md).

## Tests

- `npm test`: translator determinism, accounting, synthetic, and fixture coverage.
- `npm run test:web-proto`: mocked Graph/backend/security regression checks.
- `npm run check:powershell`: parses every template.
- `npm run typecheck`: strict TypeScript compile.

See [docs/TESTING.md](docs/TESTING.md).
