# Governance

## Current stage

Policy Translator is in private personal-account staging while documentation,
publication approval, and future organizational ownership are finalized.

## Maintainer

- Founding maintainer: [@raedrahman43](https://github.com/raedrahman43)

Additional maintainers and CODEOWNERS can be added before public contribution intake.

## Decision making

- Routine fixes use normal pull-request review.
- New automated feature support requires API evidence, security review, tests, and
  feature-matrix updates.
- Changes to licensing, ownership, telemetry, customer-data handling, or support
  commitments require explicit maintainer/organizational approval.
- Unsupported APIs must remain guided manual paths until current official support is
  documented and validated.

## Repository controls

The default branch should require:

- pull requests;
- passing CI and CodeQL;
- resolved review conversations;
- CODEOWNER review for security-sensitive areas;
- no force pushes or branch deletion.

## Ownership transition

If the repository transfers to an approved organization, Git history and contributor
attribution should be preserved. Governance, CLA, security reporting, and support files
must be updated as part of the transfer.
