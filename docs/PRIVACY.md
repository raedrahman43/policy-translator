# Privacy and data handling

## Local processing

Policy Analyzer JSON is processed by the local Node.js server. The project does not
upload policy contents to a hosted Policy Translator service.

## Authentication data

- Device-code access tokens remain in server memory.
- Tokens are not returned to browser JavaScript.
- Sessions are short-lived and removed after expiry.
- Provider credentials are used for selected writes and are not persisted by the app.

Generated packages can contain entered tenant/provider configuration. Treat them as
sensitive operational artifacts.

## Runtime telemetry

Source checkouts and releases emit no runtime telemetry unless maintainers explicitly
configure `POLICY_TRANSLATOR_TELEMETRY_ENDPOINT`.

When an official build is configured with the optional Azure telemetry receiver:

- anonymous metrics are enabled by default;
- the footer provides a visible opt-out saved in browser local storage;
- `POLICY_TRANSLATOR_TELEMETRY=off` disables telemetry for the entire process;
- telemetry delivery failure never blocks product functionality;
- each server process uses a random, short-lived session ID;
- and no persistent user or machine identifier is created.

Collected events are limited to:

- application start;
- analysis success/failure;
- Simulation success/failure;
- scripts and gap-report preview/download;
- and Real Apply start/success/failure.

Properties are allowlisted and bucketed. They can include application version, operating
system family, Node.js major version, duration buckets, count buckets, and sanitized
error categories.

Runtime telemetry never includes:

- Analyzer JSON, policy names, feature keys, descriptions, notes, or recommendations;
- tenant, application, object, service-principal, flow, or policy IDs;
- claims, attributes, values, or generated scripts;
- account identities, email addresses, machine names, or file paths;
- credentials, provider secrets, API keys, tokens, or certificates;
- Graph request/response bodies or free-form errors;
- branding URLs, assets, or government API payloads.

See [TELEMETRY.md](TELEMETRY.md) for the complete event contract and deployment model.

## GitHub community metrics

The repository includes an optional GitHub Actions workflow that collects aggregate
repository/community metrics such as stars, forks, contributors, views, clones, issues,
pull requests, and release downloads. It does not receive Analyzer JSON, tenant IDs,
feature selections, credentials, or user identity data from the application.

Traffic metrics require an optional repository secret named `METRICS_TOKEN`. The token
is used only inside GitHub Actions and must be scoped to this repository.

Runtime telemetry must remain documented, failure-isolated, limited to the allowlisted
anonymous schema, and reviewed for privacy/security implications before an endpoint is
enabled for broad distribution.

## Public issue hygiene

Do not attach:

- customer Analyzer exports;
- generated packages;
- tenant/application IDs;
- Graph responses containing identifiers;
- credentials, tokens, or private keys;
- screenshots with tenant/account details.

Use synthetic data when reporting bugs.
