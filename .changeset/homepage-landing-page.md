---
'@onesub/cli': patch
'@onesub/mcp-server': patch
'@onesub/providers': patch
'@onesub/server': patch
'@onesub/shared': patch
'@jeonghwanko/onesub-sdk': patch
---

Point each package's `homepage` at https://onesub.pryzm.gg

npm renders `homepage` as the package's headline link, and every package pointed it at the
GitHub repository — the same destination npm already derives from `repository`, so the two
links were redundant and neither introduced the project. They now separate: `homepage` goes
to the landing page, `repository` still goes to the source. No `repository`, `bugs`, or
`files` entry changes, and nothing in the shipped code or type surface is affected.
