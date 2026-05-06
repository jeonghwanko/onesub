---
title: I built my own IAP backend instead of using RevenueCat — what 3 weeks of pain taught me
published: true
description: A post-mortem on shipping React Native subscriptions without RevenueCat. StoreKit 2 JWS verification, Google Play v3, webhook lifecycle states, and the 3-day refund trap.
tags: reactnative, expo, opensource, javascript
canonical_url: https://github.com/jeonghwanko/onesub/blob/master/docs/blog/why-i-built-onesub.md
cover_image: https://raw.githubusercontent.com/jeonghwanko/onesub/master/docs/blog/cover-why-i-built-onesub.png
---

I'm shipping a subscription-based React Native app and went through the
"do I use RevenueCat or roll my own?" question that probably every solo
RN dev hits. I ended up rolling my own, ran into more edge cases than I
expected, and eventually pulled the working backend into an MIT package.
Sharing the post-mortem in case it saves someone else the same weeks.

## Why not RevenueCat

To be clear — RevenueCat is good. For a lot of apps it's the right call.
Two things pushed me off it:

1. **Revenue share scales with you.** 1% after $2.5K MRR is fair pricing,
   but it's a surface I want to own for the lifetime of the product, not
   rent.
2. **My subscription state lives in their DB.** I still need to mirror
   "user X is subscribed" into my own Postgres to join with the rest of
   my data, which means I'm running a webhook handler from them either
   way. Felt like I was paying to add a hop.

So I started writing it myself. Here's where the time actually went.

## Where the time went

### Apple StoreKit 2 JWS verification (~2 days)

You don't just trust the JWT. You walk the `x5c` chain in the JWT
header, verify each certificate against Apple Root CA G3, then verify
the JWT signature against the leaf cert's public key. None of the
tutorials I found did the full chain — most just decoded the payload
and hoped.

### Google Play Developer API v3 (~1 day)

OAuth2 service account is fine. The non-obvious bit: use
`purchases.subscriptionsv2.get` — it returns a `subscriptionState`
enum that maps cleanly to lifecycle states. The v1 API doesn't, and
most Stack Overflow answers still reference v1. Don't infer state from
`expiryTimeMillis` + `cancelReason`, just read the enum.

### Lifecycle state classification (~3 days)

This is where it got nasty. Apple's `DID_FAIL_TO_RENEW` with subtype
`GRACE_PERIOD` vs `GRACE_PERIOD_EXPIRED`. Google's `IN_GRACE_PERIOD`,
`ON_HOLD`, `SUBSCRIPTION_PAUSED`. I needed an `active: boolean` for
gating but also the raw state for UX (showing "your card failed but
you still have access" is a legitimately different message than "your
subscription is on hold"). Collapsing both vendor's events into one
state machine took a few rewrites.

### The 3-day refund trap

Google auto-refunds any purchase you don't `acknowledgePurchase` within
3 days. My first version didn't call it. None of the RN tutorials I
followed mentioned it. Lost a handful of test purchases before I
noticed pattern in the dashboard. Subscriptions need acknowledgement
too, not just one-time IAP.

### Webhook miss recovery

Apple's App Store Server Notifications V2 are reliable but not
guaranteed. If you miss one, the user's status drifts. Solution:
direct fetch via App Store Server API on `/status` checks, treat
webhooks as "fast path" not "only path." Same for Google — RTDN can
drop, fall back to `subscriptionsv2.get`.

## What I extracted

Once it was working in production, none of the above was app-specific.
So I pulled it out: [github.com/jeonghwanko/onesub](https://github.com/jeonghwanko/onesub)

One line:

```ts
app.use(createOneSubMiddleware(config));
```

MIT licensed. Pluggable subscription store (PostgreSQL built-in,
implement the interface for Redis / whatever). Optional RN SDK
(`useOneSub()` hook + paywall component) but the server works with any
client — Flutter, native, plain fetch.

## Honest limitations

- **No analytics dashboard yet.** RevenueCat's actual moat is cohort
  retention / LTV / experiments, not the receipt validation. There's a
  self-hosted Docker dashboard but it's operational (active counts,
  failed webhooks) — not cohort analysis.
- **No hosted version.** You run your own server. If "I want to ship
  an MVP without running infra" is the goal, RevenueCat still wins.
- **Apple Family Sharing and Promotional Offers** aren't implemented
  yet.

## Things I think turned out interesting

- An MCP server is bundled — point Claude Code or Cursor at it and you
  can say "add a monthly subscription to this Expo app" and it
  generates the App Store Connect product, the Play Console product,
  and the client integration. Not the main feature but it's the part
  that surprised me with how much friction it removed.
- 296+ tests, including multi-notification e2e scenarios for the
  lifecycle stuff above. That's where most of the bugs live.

## What I'm asking

If you've shipped IAP yourself in RN — what edge case tripped you up
that I haven't listed? Curious if there's a class of bug I haven't
hit yet. Especially interested in hearing from anyone who's dealt with
Family Sharing or upgrade/downgrade chains in production.

---

*Repo: [github.com/jeonghwanko/onesub](https://github.com/jeonghwanko/onesub) — MIT licensed. Issues and PRs welcome.*
