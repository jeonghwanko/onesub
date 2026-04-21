---
'@onesub/server': patch
---

express 4 → 5 upgrade. Internal: admin DELETE route now validates params via zod (Express 5 types route params as `string | string[]`). No public API change.
