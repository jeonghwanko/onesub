# @onesub/mcp-server

[Model Context Protocol](https://modelcontextprotocol.io) server for [onesub](https://github.com/jeonghwanko/onesub) — AI-assisted setup for Apple + Google subscriptions from Claude Code / Cursor / any MCP-compatible client.

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
| `onesub_create_product` | Create a subscription product on App Store Connect + Google Play via API |
| `onesub_list_products` | List registered products from both stores |
| `onesub_view_subscribers` | Query subscriber status from your onesub server |

## Example prompts

> "Add a monthly subscription to my Expo app."
>
> "Create a $9.99/month subscription on both App Store Connect and Google Play."
>
> "Why is my receipt validation returning 400?"

The MCP server runs over stdio; no network port is opened.

## Links

- Repo: <https://github.com/jeonghwanko/onesub>

MIT © onesub contributors.
