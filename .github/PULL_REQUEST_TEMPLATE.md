## Summary

Describe the problem and the change.

## Feature evidence

- Analyzer feature key(s):
- Official External ID / Microsoft Graph documentation:
- Automated, partial, guided manual, or no generated action:
- Live-tenant verification performed:

## Safety and correctness

- [ ] No tenant IDs, customer policy data, credentials, tokens, or generated `.last-*.json` files are included.
- [ ] Writes are idempotent or safely detect existing configuration.
- [ ] Failures are surfaced honestly; there is no success-shaped fallback.
- [ ] The PowerShell and port-4001 Graph paths remain behaviorally aligned.
- [ ] Required Graph scopes and administrator roles are documented.
- [ ] A manual recreation path exists when automation is incomplete.

## Validation

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:web-proto`
- [ ] `npm run check:powershell`
- [ ] `npm run docs:features`
- [ ] Documentation and feature matrix updated
