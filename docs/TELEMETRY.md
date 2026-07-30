# Optional anonymous telemetry

Policy Translator includes an optional telemetry system for aggregate product usage and
reliability metrics.

## Default behavior

No events are sent when `POLICY_TRANSLATOR_TELEMETRY_ENDPOINT` is absent. This is the
default for source checkouts and ordinary releases.

When maintainers configure an official build:

- telemetry is enabled by default;
- users can disable it from the port-4001 footer;
- `POLICY_TRANSLATOR_TELEMETRY=off` disables it process-wide;
- and failures are ignored so analysis, generation, Simulation, and Real Apply continue.

## Data flow

```text
Port-4001 server
  -> typed event allowlist
  -> property sanitizer and count/duration buckets
  -> Azure Function with Function key
  -> receiver-side allowlist
  -> Application Insights traces
  -> Azure Workbook
```

The browser never sends events directly to Azure. Browser-only actions call a
CSRF-protected localhost endpoint, which then uses the same server-side sanitizer.

## Events

| Event | Purpose |
| --- | --- |
| `app_started` | Count a configured, enabled local session |
| `analysis_completed` / `analysis_failed` | Measure analysis funnel and failure category |
| `simulation_completed` / `simulation_failed` | Measure safe-plan completion |
| `scripts_previewed` / `scripts_downloaded` | Measure generated-package engagement |
| `gap_report_previewed` / `gap_report_downloaded` | Measure manual-guidance engagement |
| `real_apply_started` | Count explicit live-apply attempts |
| `real_apply_completed` / `real_apply_failed` | Measure aggregate outcome and error category |

Properties are restricted to:

- surface/version/runtime family;
- bucketed durations;
- bucketed feature, action, gap, file, and outcome counts;
- and predefined error categories.

The authoritative event/property contract is in
`src/telemetry/telemetryClient.ts` and is independently enforced by
`infra/telemetry/function/TelemetryIngest/index.js`.

## Prohibited data

Do not add:

- policy contents or names;
- individual feature keys;
- tenant/application/object identifiers;
- claims, attributes, or values;
- identities, emails, machine names, or file paths;
- credentials, secrets, tokens, or certificates;
- Graph payloads or raw error text;
- branding or external API payloads;
- free-form user text.

## Configuration

After deploying `infra/telemetry`:

```powershell
$env:POLICY_TRANSLATOR_TELEMETRY_ENDPOINT = "https://<function>.azurewebsites.net/api/telemetry"
$env:POLICY_TRANSLATOR_TELEMETRY_KEY = "<function-key>"
npm run web:proto
```

Disable for a launch:

```powershell
$env:POLICY_TRANSLATOR_TELEMETRY = "off"
npm run web:proto
```

## Azure dashboard

The Bicep deployment creates a workbook named **Policy Translator usage** with:

- 30-day unique session and funnel counts;
- daily event trends;
- sanitized error-category counts;
- and application-version adoption.

## Security and operations

- Keep the Function key out of source control.
- Rotate it after exposure or ownership changes.
- Limit Azure workspace and workbook access.
- Configure budgets and alerts before broad distribution.
- Keep Application Insights IP masking enabled.
- Add API Management or Front Door rate limiting before high-volume use.
- Keep raw telemetry retention short; the template defaults to 30 days.

The Function key is an ingestion control, not a user identity. A key distributed with a
client can be extracted, so schema validation, budget controls, monitoring, and
rotation remain necessary.
