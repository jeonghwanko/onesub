# Claude Code Instructions

@AGENTS.md

`AGENTS.md` is the canonical repository guide shared with Codex. Update that file instead of
duplicating project structure, commands, or coding rules here. This file holds only notes about
using Claude Code *in* this repository.

## Working here with Claude Code

- **Orient before editing.** `AGENTS.md` → *Source Map* tells you which file to open; *Start Here by
  Task* tells you what a given task touches. Prefer that over a repo-wide grep.
- **Plan first for cross-package work.** Anything that touches `packages/shared/src`, a route, or a
  persisted field fans out into several files — sketch the file set from the *Contract Change
  Checklist* before the first edit.
- **Long commands.** `npm ci` and a full `npm run build` take minutes; raise the Bash timeout rather
  than letting them be killed. `npm test -- <path>` is the fast inner loop.
- **Verify what you changed, not everything.** Use the "Touched → Run" table in *Change Workflow*.
  Say explicitly which checks you ran and which you could not (this checkout may have no `pwsh`, no
  network, and no store credentials).
- **Never commit, push, or release unless asked.** See *Do Not Do These Without Being Asked*.
  The working tree often carries the user's own in-progress changes — leave them intact.
- **Reviews.** `/code-review` covers your working diff; `/security-review` is worth running on any
  change to receipt validation, webhooks, admin routes, or secret handling.
