---
'@onesub/server': patch
---

Escape backslashes before line terminators when logging.

The line-break escaping added in 0.23.1 rewrote `\n` to a backslash followed by
`n` without first escaping backslashes, so two different inputs produced identical
output: a real line terminator, and the two characters a caller typed. An operator
reading the log could not tell which one they were looking at — which costs exactly
the forensic value the escaping exists to provide, on values like `userId` that
arrive straight from a request body.

A real newline now renders as `\n` and a submitted backslash-n as `\\n`, so the two
stay distinguishable. Log output changes only for strings that contain a backslash;
messages this server composes do not.
