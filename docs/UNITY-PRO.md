# Unity Core and Pro Boundary

## Decision

The public `onesub` repository contains the MIT-licensed Core product. Commercial Unity automation
lives in a separate private repository named `onesub-unity-pro`.

No code is moved out of Core. Pro depends on a tagged Core release and adds Editor-only automation.
This keeps the free runtime fully functional while preventing commercial source from entering the
public npm, Git, or Changesets release paths.

## Core Responsibilities

- Unity IAP connection, product fetch, purchase, restore, and localized pricing
- Receipt or purchase-token submission to a self-hosted OneSub server
- Subscription, consumable, and non-consumable validation results
- Entitlement events with offline-safe `Unknown` handling
- Manual integration documentation and samples
- Public server, provider, CLI, and MCP tools shared across React Native and Unity

PenguinRun-specific sharing, review, leaderboard, and authentication helpers are public but live in
the separate optional `com.onesub.unity.platform-services` package. They are not Core responsibilities.

## Pro Responsibilities

- MCP for Unity custom tools
- Unity project, package, bundle identifier, and existing-IAP audits
- Idempotent settings and product configuration
- Project-specific authentication and entitlement adapter generation
- Paywall and purchase-button wiring
- Compile, Console, configuration, and mock-purchase verification
- Asset Store packaging and commercial documentation

Pro must not duplicate Core runtime sources. A Pro package declares the supported Core version and
tests against that exact tagged release.

## Compatibility Policy

Core and Pro use matching minor release lines whenever possible:

| Core | Pro | Support |
| --- | --- | --- |
| `0.1.x` | `0.1.x` | Initial development line |
| `0.2.x` | `0.2.x` | Settings asset and separate optional platform-services package |

Within a Core minor line, public Unity APIs consumed by Pro remain backward compatible. A breaking
Core API change requires a new minor compatibility row and a corresponding Pro release.

## Release Rules

- Core releases continue through the public `onesub` repository.
- Pro releases are built only from the private `onesub-unity-pro` repository.
- Pro development builds are distributed to private testers, not published as a temporarily free
  Asset Store SKU.
- The public repository may expose Unity detection, read-only diagnostics, and setup dry runs. Code
  generation, project mutation, and end-to-end Unity automation remain Pro features.
