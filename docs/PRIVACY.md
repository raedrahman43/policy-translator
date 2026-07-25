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

## Telemetry

Policy Translator does not emit runtime product telemetry.

The repository includes an optional GitHub Actions workflow that collects aggregate
repository/community metrics such as stars, forks, contributors, views, clones, issues,
pull requests, and release downloads. It does not receive Analyzer JSON, tenant IDs,
feature selections, credentials, or user identity data from the application.

Traffic metrics require an optional repository secret named `METRICS_TOKEN`. The token
is used only inside GitHub Actions and must be scoped to this repository.

Any future runtime telemetry proposal must be:

- explicitly opt-in;
- documented before collection;
- disabled by default;
- limited to non-sensitive aggregate events;
- and reviewed for privacy/security implications.

## Public issue hygiene

Do not attach:

- customer Analyzer exports;
- generated packages;
- tenant/application IDs;
- Graph responses containing identifiers;
- credentials, tokens, or private keys;
- screenshots with tenant/account details.

Use synthetic data when reporting bugs.
