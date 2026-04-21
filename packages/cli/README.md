# @onesub/cli

Scaffolds a ready-to-run [onesub](https://github.com/jeonghwanko/onesub) server project.

```bash
npx @onesub/cli init my-onesub-server
cd my-onesub-server
cp .env.example .env
npm install
npm run dev
```

Or full stack (Postgres + server) in one command:

```bash
docker compose up
```

## What it generates

| File | Purpose |
|------|---------|
| `server.ts` | Express app with `createOneSubMiddleware()` wired up |
| `.env.example` | Apple / Google / Postgres / admin placeholders |
| `docker-compose.yml` | Postgres + server, schema auto-initialized from `@onesub/server/sql/schema.sql` |
| `package.json`, `tsconfig.json`, `.gitignore`, `README.md` | Standard project shell |

That's it. No prompts, no interactive questionnaire — same scaffold every time, tweak it yourself afterward.

## Commands

```
onesub init [directory]   Scaffold into <directory> (default: .)
onesub --help             Show help
```

MIT.
