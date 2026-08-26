# site

The static landing page served at <https://onesub.pryzm.gg>.

One self-contained HTML file. No build step, no dependencies, no framework.

| File | Role |
|---|---|
| `index.html` | The entire page — inline CSS and JS |
| `og.png` | Open Graph / Twitter card image |

## Preview locally

```bash
npx serve site
# or
python3 -m http.server 8080 --directory site
```

Then open <http://localhost:8080>. There is nothing to compile — editing `index.html` and
reloading is the whole loop.

## How it gets deployed

This directory is the **source of truth**, but it is not what the web server reads. The page is
served from a shared EC2 host that a different repository deploys:

```
onesub/site/index.html          ← you edit here
        │  copy
        ▼
findthem/apps/web/onesub/       ← committed there, deployed by its CI
        │  ci.yml: cp -r apps/web/onesub/. /var/www/onesub/
        ▼
EC2 /var/www/onesub/            ← nginx :3000 (findthem/deploy/onesub.pryzm.gg.conf)
        ▲
    pryzm unified ALB (443, SNI cert admin_alb_onesub, host-header rule admin_hosts_6)
        ▲
    Route53 CNAME onesub.pryzm.gg  (svl-devops .../pryzm/live/server/admin-alb.tf alb_2_26)
```

So publishing a change is two commits:

```bash
# 1. edit and verify here
$EDITOR site/index.html
npx serve site

# 2. copy into the deploying repo and push it
cp site/index.html site/og.png ../findthem/apps/web/onesub/
cd ../findthem && git add apps/web/onesub && git commit && git push   # CI deploys on master
```

Nothing verifies that the two copies agree — if the page looks stale in production, diff
`site/index.html` against `findthem/apps/web/onesub/index.html` first.

Response headers (CSP, `X-Frame-Options`, cache control) live in the nginx vhost at
`findthem/deploy/onesub.pryzm.gg.conf`, not in this directory. If you add an external asset host,
the CSP `img-src` / `script-src` there has to allow it or the browser will block it silently.

## Editing rules

This page is marketing copy for a product whose behaviour is defined elsewhere. Two rules keep it
from drifting into fiction:

1. **Take claims from the source, don't invent them.** Copy comes from the root
   [`README.md`](../README.md) and [`docs/blog/why-i-built-onesub.md`](../docs/blog/why-i-built-onesub.md).
   API snippets must match the real signatures — `subscribe()` takes no argument (the product id
   comes from the Provider config), and `hasEntitlement(id)` is a synchronous boolean, not a promise.
2. **No version numbers in prose.** Package versions are rendered from live shields.io npm badges,
   per the "avoid volatile claims" rule in [`AGENTS.md`](../AGENTS.md).

`site/` is deliberately **not** an npm workspace. Adding it to the root `workspaces` array would
pull it into `npm run build`, `type-check`, `package:check`, and `audit:prod` for no benefit.

Both languages are present in the DOM at once and CSS hides one, so crawlers index the English and
Korean copy from a single URL. When you add a translatable string, add both `<span lang="en">` and
`<span lang="ko">` variants — a missing half renders as a blank gap in that language.
