---
"@onesub/mcp-server": patch
"@onesub/cli": patch
---

Dev-flow fixes for the simulate/setup tooling.

- `onesub_simulate_webhook` defaults (`bundleId`, `packageName`) now match the `npx @onesub/cli dev` server config (`mock.onesub.dev`), and the CLI dev server sets `skipJwsVerification` — the documented simulate-against-dev-server flow works end-to-end again.
- Simulate tools parse JSON error bodies, so `errorCode` highlighting and remediation hints render for non-2xx responses; Google `skippedRegions` are surfaced in `onesub_create_product` output; Apple price failures show the underlying `priceError`.
- `onesub_setup`/`onesub_troubleshoot` no longer recommend the deprecated `expo-in-app-purchases` (the SDK uses `react-native-iap`).
- CLI validates `--port` and rejects flag-like `init` directory names.
