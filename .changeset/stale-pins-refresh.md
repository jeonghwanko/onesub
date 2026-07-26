---
'@onesub/cli': patch
'@onesub/mcp-server': patch
---

Fix `onesub init` scaffolding a project pinned to `@onesub/server@^0.7.0`.

A caret range on a `0.x` version admits only patches, so every scaffolded project
installed `0.7.x` — twenty minors behind, without the log formatter, the conditional
Google webhook mount, or the webhook authentication requirement. Nothing caught it:
Changesets bumps workspace versions, and this is copied template content, not a
workspace. `packages/cli/src/__tests__/templates.test.ts` now fails when the pin
cannot install the current server version, so a server release that outruns the
template is caught at that release.

The template also documents that `GOOGLE_PUSH_AUDIENCE` is required in production as of
`@onesub/server@0.27.0`, and passes `pushServiceAccountEmail` through. The
`simulate_webhook` MCP tool description notes that the Google endpoint needs
`pushAudience` or `allowUnauthenticatedWebhook` against a production server.
