---
'@onesub/mcp-server': patch
---

Fix escaping in the generated paywall's feature list.

`add-paywall` built the feature array by escaping `'` and nothing else, so a feature
string containing a backslash escaped its own closing quote — breaking the generated
component, or extending it with whatever followed. Feature names reach this from tool
input, so the input that triggers it is not hypothetical.

Now uses `JSON.stringify` per entry, which escapes quotes, backslashes and control
characters correctly.
