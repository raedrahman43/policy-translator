# Community metrics

Policy Translator uses GitHub's aggregate repository metrics rather than runtime product
telemetry.

## Feature coverage

`npm run docs:features` generates:

- `docs/FEATURE-MATRIX.md`
- `docs/feature-coverage.json`

The chart is derived from all known Analyzer feature keys and the real mapper. A PR that
adds a feature or script automatically changes the dashboard. CI ensures the generated
files are committed and that no feature is unaccounted.

## Repository interaction

`.github/workflows/community-metrics.yml` runs daily and on demand. It captures:

- stars, forks, watchers;
- issues and pull requests;
- contributor count;
- release-asset downloads;
- 14-day views, unique visitors, clones, and unique cloners;
- top paths/referrers;
- community health score.

Each run publishes a 90-day workflow artifact and a GitHub Actions summary.

GitHub only exposes traffic history for the previous 14 days. Daily snapshots provide a
lightweight historical record without adding telemetry to the product or daily bot
commits to `main`.

## Enable views, clones, and referrers

GitHub's default Actions token cannot read repository traffic endpoints. To include
traffic in snapshots:

1. Create a token from an account with push access, scoped only to this repository.
2. Store it as the Actions secret `METRICS_TOKEN`.
3. Run **Community metrics snapshot** manually once.
4. Confirm `traffic.views`, `traffic.clones`, `referrers`, and `popularPaths` are no
   longer marked unavailable in the artifact.

Do not commit the token or place it in workflow YAML. Rotate it if repository ownership
changes.

## Limits

- Clones do not prove successful product use.
- Views may include maintainers and bots.
- Private-repository traffic may depend on token permissions.
- Metrics are directional community signals, not customer adoption telemetry.
