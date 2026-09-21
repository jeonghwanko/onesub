---
"@onesub/providers": patch
"@onesub/mcp-server": patch
---

Fix Google subscription creation to use the supported proration enum and explicit activation, preserving created product IDs and activation errors when setup is incomplete. Configure Apple subscription plan availability and UPFRONT pricing for the selected billing period. Report partial catalog setup rather than claiming every platform is configured.
