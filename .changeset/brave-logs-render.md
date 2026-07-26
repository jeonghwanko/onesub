---
'@onesub/server': minor
'@onesub/shared': patch
---

Render each log call into one escaped string, so a caller cannot forge a log line on
any sink.

`config.logger` now receives exactly one string per log: the message, contextual
values as `key=value` pairs, and any stack trace as `    | ` continuation lines.

The guarantee is that **no byte supplied by a caller can begin a line** — weaker
than "the output has no newlines", and deliberately so. That framing is what lets a
stack trace stay whole: attacker text may appear inside a record but never at the
start of one, so a forged `[onesub] admin granted premium to mallory` line is
impossible while `at ...` frames remain readable.

Rendering happens in the server rather than being left to the sink because leaving
it to the sink only works for some of them. `console` escapes strings inside a
trailing object, but `pino` — which this package's own docs recommend — treats that
object as a printf interpolation argument, and a JSON-serialising sink drops an
`Error` to `{}` because its properties are non-enumerable, losing the error
entirely.

Field values are quoted when they contain anything outside `[A-Za-z0-9_.:/@+-]`,
which is a control rather than cosmetics: an unquoted `userId` of
`alice productId=hacked` would otherwise be parsed as two fields.

Call sites still using printf-style arguments render sensibly, so the remaining
migration proceeds file by file with no flag day. Fields are text inside the message
for now, not typed JSON fields — a typed sink is a planned follow-up. See
`docs/MIGRATION.md`.
