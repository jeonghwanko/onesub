# @onesub/mcp-server

[Model Context Protocol](https://modelcontextprotocol.io) server for [onesub](https://github.com/jeonghwanko/onesub) — AI-assisted setup, product management, diagnostics, and local lifecycle testing from Codex, Claude Code, or any MCP-compatible client.

## Install

Add to your MCP client config (Claude Code, Cursor, Zed, etc.):

```json
{
  "mcpServers": {
    "onesub": {
      "command": "npx",
      "args": ["-y", "@onesub/mcp-server"]
    }
  }
}
```

## Tools exposed

| Tool | What it does |
|------|-------------|
| `onesub_setup` | Analyze your project + generate the `createOneSubMiddleware()` integration code |
| `onesub_add_paywall` | Generate a `<Paywall />` component wired to `useOneSub()` |
| `onesub_check_status` | Query subscription status for a given `userId` |
| `onesub_troubleshoot` | Diagnose common IAP problems (receipt format, bundle ID mismatch, sandbox rejection) |
| `onesub_create_product` | Create a subscription, consumable, or non-consumable on one or both stores, including regional prices |
| `onesub_list_products` | List subscriptions and one-time products from one or both stores |
| `onesub_manage_product` | Rename or delete a store product |
| `onesub_view_subscribers` | Query one user, or fetch admin-gated aggregate and subscription-list data |
| `onesub_simulate_purchase` | Send mock receipt scenarios to a development server |
| `onesub_simulate_webhook` | Drive Apple/Google lifecycle transitions with development webhook fixtures |
| `onesub_inspect_state` | Read a user's subscription and one-time-purchase state together |

## Example prompts

> "Add a monthly subscription to my Expo app."
>
> "Create a $9.99/month subscription on both App Store Connect and Google Play."
>
> "Why is my receipt validation returning 400?"
>
> "Simulate a Google subscription entering grace period, then inspect the user's state."

The MCP server runs over stdio; no network port is opened.

For longer copy-ready prompts, local mock workflows, and a read-before-write pattern for store
product changes, see [`../../docs/AI-WORKFLOW.md`](../../docs/AI-WORKFLOW.md).

## Links

- Repo: <https://github.com/jeonghwanko/onesub>

MIT © onesub contributors.
