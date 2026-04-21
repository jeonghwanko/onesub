---
'@onesub/cli': patch
---

Fix: scaffolded projects missing `.gitignore`.

npm publish strips `.gitignore` files from published tarballs, so `templates/.gitignore` never shipped and `onesub init` crashed with `ENOENT` at the last step. Template file renamed to `templates/_gitignore` and `copyTemplate` now supports a destination rename — the scaffolded project gets a real `.gitignore` again.
