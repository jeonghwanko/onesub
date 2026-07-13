# AI-Assisted Workflow

This guide provides copy-ready prompts for working with OneSub from Codex, Claude Code, or another
MCP-capable coding agent. Use `AGENTS.md` for repository rules and `SKILL.md` when integrating OneSub
into a different application.

## Choose the Right Interface

| Interface | Use it for |
|---|---|
| `@onesub/cli` | Deterministic commands: scaffold a server or run a fully mocked development server |
| Codex or Claude in this repository | Read, diagnose, change, test, and document the OneSub source |
| `@onesub/mcp-server` | Integrate an app, manage store products, inspect users, and simulate purchase lifecycles through natural-language prompts |

`@onesub/cli` is not conversational. Its commands are:

```bash
npx @onesub/cli init my-onesub-server
npx @onesub/cli dev --port 4100
npx @onesub/cli --help
```

## First Prompt After Cloning

Run `npm ci`, open the repository in Codex or Claude, and start with a read-only orientation:

```text
Read AGENTS.md and docs/README.md first. Inspect package.json, the CI workflow, and the package
dependency graph. Explain how to develop and validate this repository locally. Do not modify files
yet; report the current state, relevant commands, and likely risks.
```

Claude reads `CLAUDE.md`, which imports the same canonical `AGENTS.md` used by Codex.

## Repository Work Prompts

### Implement a focused change

```text
Follow AGENTS.md and implement <feature or issue>.

Scope:
- Change only <packages or files> unless a dependency requires more.
- Preserve unrelated working-tree changes.
- Add or update tests for behavior changes.
- Update public documentation if the API, configuration, or package boundary changes.

Validation:
- Run the closest focused tests while iterating.
- Run the package build/type-check appropriate to the changed surface.
- Report changed files, commands run, results, and remaining risks.
```

### Diagnose without changing code

```text
Diagnose why <request, test, or workflow> fails. Trace the relevant route, validation schema,
provider, store, and tests. Reproduce the failure if it is safe to do so. Do not implement a fix;
report the root cause, evidence, affected behavior, and the smallest safe fix.
```

### Review documentation against code

```text
Compare the documentation with package.json, public exports, registered routes, MCP tools, CI, and
tests. Identify stale commands, feature claims, package names, and security behavior. Update only the
documentation, validate local links, and list every claim that changed.
```

## App Integration Prompts

Connect `@onesub/mcp-server`, then run prompts from the application repository—not from the OneSub
source repository.

### Plan an integration

```text
Analyze this application and determine whether it uses Expo, React Native CLI, or another client.
Plan a OneSub integration for product <product-id> using server <server-url>. Do not modify files yet.
List the client files, server configuration, environment variables, native dependencies, webhook
setup, and validation steps that will be required.
```

### Implement an Expo/React Native subscription

```text
Integrate OneSub into this Expo/React Native app.

Requirements:
- Subscription product: <product-id>
- OneSub server: <server-url>
- Use OneSubProvider and useOneSub.
- Handle cancellation, structured OneSub errors, restore, loading, and offline states.
- Do not place Apple, Google, database, or admin credentials in client code.
- Run type-check and the relevant tests after the change.
```

### Test locally without store credentials

Start the mocked server first:

```bash
npx @onesub/cli dev --port 4100
```

Then prompt the MCP-enabled agent:

```text
Against the OneSub mock server at http://localhost:4100, simulate a Google subscription purchase for
user <user-id> and product <product-id>. Transition it to grace_period with a simulated webhook, then
inspect the user's subscription and purchase state. Report each request and the observed status.
```

### Troubleshoot receipt validation

```text
The OneSub validation request returns <status/error code>. Inspect the request shape, appId routing,
bundle/package configuration, sandbox/production environment, provider logs, and receipt format.
Do not weaken signature verification or enable mock mode in production. Report the likely cause and
exact verification steps before changing code.
```

## Store Product Safety

Product-management tools can change App Store Connect or Google Play. Use a read-before-write and
approval workflow:

```text
List the existing products on <apple, google, or both>. Prepare a proposal for product <product-id>
with type, period, base price, currency, localization, and regional prices. Detect ID or pricing
conflicts. Do not create, update, or delete anything until I explicitly approve the proposal.
```

Never paste private keys, service-account JSON, receipts, purchase tokens, database URLs, or admin
secrets into a prompt. Provide them through the host environment or the MCP client's secret handling.

## Prompt Checklist

A useful task prompt normally specifies:

- Context: repository/app type and relevant package.
- Goal: one observable outcome.
- Scope: files or systems the agent may change.
- Constraints: compatibility, security, and actions requiring approval.
- Validation: tests, builds, type-checks, or API scenarios.
- Handoff: the evidence and remaining risks to report.
