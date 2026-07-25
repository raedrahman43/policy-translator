# Contributing

Thank you for helping make Policy Translator safer and more complete.

## Before contributing

Read:

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [docs/ADDING-A-FEATURE.md](docs/ADDING-A-FEATURE.md)
- [docs/TESTING.md](docs/TESTING.md)
- [SECURITY.md](SECURITY.md)

By submitting a contribution, you confirm that you have the right to submit it and
license it under this repository's MIT License. Contribution terms may be updated if
the repository later moves to an organization with a formal CLA process.

## Local setup

```powershell
npm ci
npm run typecheck
npm test
npm run test:web-proto
npm run check:powershell
npm run docs:features
```

Use `npm run web:proto` for the guided port-4001 experience.

## Contribution rules

- Use current official Microsoft Learn / Graph documentation as evidence.
- Keep generation deterministic; no runtime AI dependency.
- Make every write idempotent or conflict-safe.
- Never return success for an unsupported, partially completed, or unverified action.
- Keep PowerShell and live Graph behavior aligned.
- Request only scopes required by the selected operation.
- Provide a deterministic manual path when safe automation is unavailable.
- Do not include customer exports, tenant/app IDs, credentials, tokens, `.last-*.json`,
  generated packages, private keys, internal links, or screenshots with identifiers.
- Do not reintroduce B2C-only beta Apple/custom-OIDC APIs as External ID automation.

## Adding a feature

The short version:

1. Identify the Analyzer feature key.
2. Verify the External ID equivalent and API support.
3. Add mapper/step/input/scope/executor/template changes.
4. Add honest manual guidance.
5. Add deterministic and mocked/live evidence.
6. Regenerate the feature dashboard.

The complete checklist is in [docs/ADDING-A-FEATURE.md](docs/ADDING-A-FEATURE.md).

## Pull requests

Keep PRs focused. Include:

- Analyzer feature keys;
- official documentation links;
- security/permission impact;
- idempotency behavior;
- test evidence;
- live validation status;
- and documentation changes.

CI must be green. Maintainers may ask for a smaller PR when a change mixes unrelated
feature, UI, and infrastructure work.

## Community conduct

This project follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
