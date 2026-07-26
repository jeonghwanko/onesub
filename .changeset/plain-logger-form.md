---
'@onesub/server': patch
---

Rewrite the log line-break escaping so a taint analyser can see it.

Behaviour is unchanged — the same four characters are escaped to the same output,
and the tests are untouched. The single regex with a callback is now one literal
replacement per character, because CodeQL's `js/log-injection` sanitiser
recognition could not prove the line terminator was removed through the callback
form, and an unrecognised sanitiser is indistinguishable from an absent one to
anyone reading an alert list.
