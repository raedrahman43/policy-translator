# Governance

## Current stage

Policy Translator is a public community preview. The current personal-account
repository is the contribution and release location while future organizational
ownership is evaluated.

## Maintainer

- Founding maintainer: [@raedrahman43](https://github.com/raedrahman43)

Additional maintainers and CODEOWNERS can be added as the contributor community grows.

## Decision making

- Routine fixes use normal pull-request review.
- New automated feature support requires API evidence, security review, tests, and
  feature-matrix updates.
- Changes to licensing, ownership, telemetry, customer-data handling, or support
  commitments require explicit maintainer/organizational approval.
- Unsupported APIs must remain guided manual paths until current official support is
  documented and validated.

## Repository controls

The default branch requires:

- pull requests;
- passing CI and CodeQL;
- resolved review conversations;
- no force pushes or branch deletion.

Required approving reviews are not enabled while there is only one active maintainer,
to avoid locking the repository. Enable at least one approval plus CODEOWNER review for
security-sensitive areas after a second maintainer accepts access.

## Ownership transition

If the repository transfers to an approved organization, Git history and contributor
attribution should be preserved. Governance, CLA, security reporting, and support files
must be updated as part of the transfer.
