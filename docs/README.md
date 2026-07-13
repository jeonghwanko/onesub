# OneSub Documentation

Use this page to find the canonical document for a task. The root [`README.md`](../README.md) is the
product overview and quick start; package directories contain package-specific API and setup notes.

## Operate and Deploy

| Document | Use it for |
|---|---|
| [`POSTGRES.md`](POSTGRES.md) | PostgreSQL schema, indexing, initialization, and read replicas |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Production topologies, Redis/BullMQ, webhooks, secrets, shutdown, and recovery |
| [`CONFIGURATION.md`](CONFIGURATION.md) | Server, middleware, SDK, multi-app, and environment-variable options |
| [`SECURITY.md`](SECURITY.md) | Trust boundaries, credential handling, webhook verification, and vulnerability reporting |
| [`RECEIPT-ERRORS.md`](RECEIPT-ERRORS.md) | Mapping structured receipt-validation errors to causes and fixes |
| [`../packages/dashboard/README.md`](../packages/dashboard/README.md) | Dashboard Docker deployment, configuration, authentication, and pages |
| [`../bench/README.md`](../bench/README.md) | Status and webhook load tests |

## Understand and Upgrade

| Document | Use it for |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Package dependencies, server flow, stores, lifecycle state, and hooks |
| [`MIGRATION.md`](MIGRATION.md) | Version-specific upgrade notes and breaking changes |
| [`MIGRATE-FROM-REVENUECAT.md`](MIGRATE-FROM-REVENUECAT.md) | Moving an existing app and data from RevenueCat |
| [`UNITY-PRO.md`](UNITY-PRO.md) | Public Unity Core versus private Unity Pro responsibilities |
| [`UNITY-INTEGRATION.md`](UNITY-INTEGRATION.md) | Install and integrate Unity Core, purchases, restore, events, and entitlements |
| [`AI-WORKFLOW.md`](AI-WORKFLOW.md) | Copy-ready Codex/Claude prompts, local simulation, and store-product safety |
| [`LOCAL-DEVELOPMENT.md`](LOCAL-DEVELOPMENT.md) | Clean clone, baseline checks, mock server, dashboard, and Unity setup |
| [`TESTING.md`](TESTING.md) | Vitest, mock receipts, MCP lifecycle tests, real E2E, dashboard, and Unity checks |

## Integrate a Package

| Package | Documentation |
|---|---|
| Server | [`../packages/server/README.md`](../packages/server/README.md) |
| React Native SDK | [`../packages/sdk/README.md`](../packages/sdk/README.md) |
| App Store/Google Play providers | [`../packages/providers/README.md`](../packages/providers/README.md) |
| MCP server | [`../packages/mcp-server/README.md`](../packages/mcp-server/README.md) |
| CLI | [`../packages/cli/README.md`](../packages/cli/README.md) |
| Dashboard | [`../packages/dashboard/README.md`](../packages/dashboard/README.md) |
| Unity Core | [`../packages/unity/README.md`](../packages/unity/README.md) |
| Unity platform services | [`../packages/unity-platform-services/README.md`](../packages/unity-platform-services/README.md) |

## Contribute or Use an Agent

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): contributor workflow, validation, and releases.
- [`../AGENTS.md`](../AGENTS.md): canonical repository instructions for Codex and Claude.
- [`../SKILL.md`](../SKILL.md): portable context for an agent integrating OneSub into another project.
- [`AI-WORKFLOW.md`](AI-WORKFLOW.md): prompts for repository work and application integration.
