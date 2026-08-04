# Security policy

## Reporting a vulnerability

Do not report vulnerabilities through a public issue.

Use GitHub private vulnerability reporting:

<https://github.com/raedrahman43/policy-translator/security/advisories/new>

Repository collaborators may also contact the maintainer through an existing private
channel, but public vulnerability details must not be posted in Issues or Discussions.

Include the affected commit, reproduction steps, impact, and any proof of concept. Do
not include real customer policy data or production credentials.

## Supported versions

Security fixes are applied to the current `main` branch and the most recent release.
This project is an early preview and does not provide long-term support branches.

## Security model

- Port 4001 binds to loopback and rejects unexpected Host/Origin values.
- State-changing API calls require a local CSRF token.
- Device-code access tokens stay server-side in memory and expire with the session.
- Simulation is the default; real Graph changes require explicit administrator action.
- Graph calls use bounded retry behavior and surface permission failures.
- Remote branding assets must use HTTPS and pass SSRF, redirect, type, and size checks.
- Generated PowerShell escapes untrusted configuration values.
- Generated deployment state and customer exports are excluded from source control.

## Sensitive data

Never commit or attach:

- tenant, application, object, service-principal, flow, or policy IDs from real tenants;
- OAuth client secrets, private keys, access/refresh tokens, or device codes;
- customer Policy Analyzer exports;
- generated `.last-*.json` state;
- downloaded migration packages containing entered configuration;
- logs or screenshots containing identifiers.

If a secret is committed or shared, remove it from publication and rotate/revoke it.
Deleting the file is not a substitute for rotating the credential.

## Usage warning

Run against a non-production tenant first. Review scripts and Graph permissions, use
simulation, keep Conditional Access report-only, and follow the final validation report.

See [docs/PRIVACY.md](docs/PRIVACY.md) for data-handling details.
