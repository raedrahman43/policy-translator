# Adding a feature

This is the required path for adding support for another Policy Analyzer feature.

## 1. Establish evidence

Record:

- the exact Analyzer feature key;
- a synthetic Analyzer example;
- the intended External ID behavior;
- current Microsoft Learn / Microsoft Graph documentation;
- required delegated scopes and directory roles;
- whether the API is GA, preview, tenant-specific, or unsupported.

Do not automate an Azure AD B2C-only provider model in an External ID external tenant.

## 2. Choose the migration category

### Automated

Use when a supported API can safely converge the target state.

### Partial automation

Use when a safe tenant setting can be configured but rollout still needs customer work,
such as passkey registration, report-only CA validation, or third-party sign-in testing.

### Guided manual

Use when the platform supports the capability but no supported safe API exists.

### No generated action

Use only when External ID genuinely provides the behavior by default or outside the
migration package. A portal toggle is not a no-op.

## 3. Update the mapper

Edit `src/mappers/featureMap.ts`.

- Add the feature key.
- Reuse existing `StepKind` values where possible.
- Add a deterministic `gapReport` for incomplete/manual paths.
- Never silently return no steps without a `noopReason` or gap.

## 4. Add an action when required

For a new automated action:

1. Add the `StepKind`.
2. Add canonical ordering in `src/generators/scriptGenerator.ts`.
3. Add required fields in `src/web/inputRequirements.ts`.
4. Add delegated scopes and role hints in `src/web-proto/graphExecutor.ts`.
5. Implement the live Graph operation.
6. Add a PowerShell template.
7. Keep payloads and idempotency behavior aligned.

## 5. Idempotency and safety

Every write must:

- find existing target state;
- compare meaningful configuration, not only display name;
- reuse matching state;
- safely repair supported drift;
- refuse unsafe same-name conflicts;
- verify bindings/writes after eventual consistency;
- return a non-success status when incomplete.

Do not broadly catch 400/403 responses and continue.

## 6. Manual guidance

Update `src/generators/manualRecreation.ts`.

Guidance must include:

- exact admin-center location;
- prerequisites;
- ordered steps;
- definitive validation;
- and a clear no-equivalent statement where appropriate.

## 7. Tests

Add:

- a synthetic case in `src/test/regression.ts`;
- mocked Graph coverage in `src/test/webProtoRegression.ts` for backend changes;
- a sanitized fixture only when it adds meaningful coverage;
- PowerShell parse coverage through the existing template check.

Run:

```powershell
npm run typecheck
npm test
npm run test:web-proto
npm run check:powershell
npm run docs:features
```

## 8. Documentation and dashboard

Update customer/admin documentation and regenerate:

```powershell
npm run docs:features
```

CI fails when generated feature files are stale or a feature is unaccounted.

## Pull-request evidence

The PR must state:

- source feature;
- target behavior;
- API documentation;
- permissions/roles;
- idempotency strategy;
- test results;
- live validation state;
- limitations and rollback/follow-up.
