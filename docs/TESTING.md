# Testing

## Required local gate

```powershell
npm ci
npm run typecheck
npm test
npm run test:web-proto
npm run check:powershell
node --check src/web-proto/public/app.js
npm run docs:features
```

## Test layers

### Translator regression

`npm test` exercises the deterministic translator suite:

- valid/invalid input;
- expected scripts;
- no dangling placeholders;
- deterministic output;
- gap honesty;
- web/CLI parity;
- all known Analyzer feature keys.

### Port-4001 backend

`npm run test:web-proto` uses mocked fetch/Graph behavior to cover:

- analyzer context and attribute extraction;
- honest Apple/OIDC gaps;
- branding intent;
- throttling retry;
- private-network branding URL blocking;
- PowerShell escaping;
- app/flow creation and zero-write reruns.

### PowerShell

`npm run check:powershell` parses every template using the PowerShell AST parser.

### Feature dashboard

`npm run docs:features` generates the Markdown/JSON coverage dashboard. CI runs the
generator and fails if the committed files differ.

## Live-tenant validation

Mocked tests do not replace live validation. Use a non-production tenant and capture:

- tenant type and prerequisites;
- selected feature;
- first-run result;
- second-run/idempotency result;
- admin-center verification;
- real user-flow/provider/token behavior;
- cleanup or rollback notes.

Never commit the tenant identifiers, access tokens, generated state, or screenshots.

## Baseline rule

A feature is not "fully working" merely because Graph returned 2xx. Validate the
customer-visible outcome and record any required follow-up in the feature matrix.
