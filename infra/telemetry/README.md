# Policy Translator telemetry infrastructure

This directory contains an optional Azure deployment for anonymous Policy Translator
usage metrics.

Nothing is deployed automatically. The application sends no runtime telemetry unless
`POLICY_TRANSLATOR_TELEMETRY_ENDPOINT` is configured.

## Resources

`main.bicep` creates:

- a consumption-plan Azure Function;
- Application Insights backed by Log Analytics;
- a 30-day telemetry workbook;
- and the storage account required by Azure Functions.

The Function accepts only the versioned, allowlisted event schema implemented in
`src/telemetry/telemetryClient.ts`. It does not store request headers, Analyzer JSON,
tenant identifiers, policy names, claims, credentials, feature keys, Graph payloads,
or free-form errors in the custom event record.

## Deploy

```powershell
az login
pwsh ./infra/telemetry/deploy.ps1 `
  -ResourceGroup policy-translator-telemetry `
  -Location westus2
```

The deployment prints:

- `POLICY_TRANSLATOR_TELEMETRY_ENDPOINT`
- `POLICY_TRANSLATOR_TELEMETRY_KEY`

Set both variables before starting an official Policy Translator build:

```powershell
$env:POLICY_TRANSLATOR_TELEMETRY_ENDPOINT = "https://<function>.azurewebsites.net/api/telemetry"
$env:POLICY_TRANSLATOR_TELEMETRY_KEY = "<function-key>"
npm run web:proto
```

Source checkouts and releases that do not set the endpoint remain telemetry-free.

## Dashboard

Open the deployed Azure Workbook named **Policy Translator usage**. It contains:

- 30-day unique session and funnel counts;
- daily event trends;
- sanitized failure categories;
- and version adoption.

## Operational controls

- Rotate the Function key if it is exposed.
- Configure Azure budgets and alerts before broad distribution.
- Keep Application Insights IP masking enabled.
- Review access to the Log Analytics workspace and workbook.
- Do not add new fields without updating both allowlists, tests, and privacy docs.
- Telemetry failures must remain non-blocking.

The Function key prevents casual unauthenticated ingestion but is not a user identity or
authorization mechanism. A broadly distributed client key can be extracted, so use
schema validation, budgets, monitoring, and key rotation. Add API Management or Front
Door rate limiting before high-volume distribution.
