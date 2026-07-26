---
'@onesub/server': patch
---

Stop a caller from forging log lines.

Much of what this server logs is attacker-influenced: `userId` arrives in the
request body, and bundle ids, package names and receipt previews come out of
submitted receipts. A newline in any of those let a caller end the current log line
and write an entry of their own — a `userId` of `alice\n[onesub] admin granted
premium to mallory` forges an audit record. These logs are what support and fraud
decisions get read from.

`log.info/warn/error` now escape `\r`, `\n`, U+2028 and U+2029 in top-level string
arguments. Escaped rather than stripped, so the substitution stays visible instead
of quietly merging two lines into one plausible-looking line. Tabs and other
characters are untouched, and non-string arguments — objects, `Error`s — pass
through unchanged, since a structured logger serialises those itself and rewriting
them would corrupt what the operator asked to see.
