---
'@onesub/server': patch
---

Cache successful Apple x5c chain verification instead of redoing it per request.

`decodeJws` backs every receipt validation and every Apple webhook, and it
re-ran the whole verification each time: an `X509Certificate` parse per cert in
the chain, an ECDSA signature check per link, the bundled-root comparison, and a
fresh `importX509` of the leaf key. All of it is synchronous CPU work on the
event loop, and Apple's leaf certificates are stable for weeks, so the same
chain was re-verified continuously to reach the same answer.

Successful verifications are now memoised per process, keyed on the full `x5c`
chain plus the JWS `alg`. Rejection behaviour is unchanged:

- A failed verification is never cached, positive or negative — an untrusted
  chain is rejected on every attempt.
- An entry's lifetime is capped by the earliest `notAfter` in the chain that
  produced it, so an expired certificate is never served from cache, and by a
  1-hour ceiling on top of that.
- `alg` is part of the entry identity, so a chain claiming a different algorithm
  can never be served a key imported for another one.

The cache is deliberately process-local rather than going through the pluggable
`CacheAdapter`: an imported key is not JSON-serialisable (a Redis-backed adapter
would round-trip it to `{}`), and what is avoided here is local CPU rather than
a rate-limited network call — a Redis round-trip could cost more than the
verification it replaces. Certificate revocation is not checked, unchanged from
before.
