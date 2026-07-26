/**
 * Renders a log call into exactly one string.
 *
 * Why this module exists, and why it is pure. `logger.ts` holds process-global
 * state, so anything tested through it needs `setLogger` juggling to keep one test
 * file from capturing another's output. Every security property below is a property
 * of a function from arguments to a string, so it belongs somewhere with no state
 * at all — see `log-format.test.ts`.
 *
 * ## The invariant
 *
 * **No byte supplied by a caller can begin a line.**
 *
 * That is the whole security claim, and it is weaker than "the output contains no
 * newlines" on purpose. Demanding no newlines at all is what backed this server
 * into a corner earlier: a stack trace is multi-line by nature and is the main
 * reason to log an `Error`, so flattening it destroys the thing you wanted. Framing
 * it as "attacker text may appear inside a record, never at the start of one" keeps
 * the trace readable *and* makes forgery impossible.
 *
 * It holds mechanically: the message and every field value pass through `esc`,
 * which leaves no line terminator behind, so the only newlines in the result are the
 * ones this module writes itself as part of `LOG_CONTINUATION`. A forged
 * `[onesub] admin granted premium to mallory` line cannot be produced.
 *
 * `LOG_CONTINUATION` begins with whitespace, which is what Fluent Bit, Loki and
 * Docker multiline rules already use to join a line to the record above it. And
 * grepping `[onesub/` still returns one hit per event, not one per stack frame.
 *
 * ## Output grammar
 *
 * ```text
 * <message>[ <key>=<value>]*[<CONT><line>]*
 * ```
 *
 * ## Field vocabulary
 *
 * Use these names and no synonyms — `userId`, not `user` or `uid`. The point of
 * moving values out of the message is that an operator can filter on them, and that
 * is lost the moment the same thing is called three things across 16 files.
 *
 * This list is **mechanically enforced**: `field-vocabulary.test.ts` parses the
 * block below and fails if any `log.*` call site in the package uses a name that is
 * not in it. So the list is the contract, not a suggestion — adding a field means
 * adding it here first. That check exists because per-call-site tests do not scale
 * to ~100 sites: a mutation renaming `productId` to `product` at one un-asserted
 * site passed the entire suite before it was added.
 *
 * FIELD VOCABULARY START
 *   route provider userId appId platform productId transactionId
 *   originalTransactionId purchaseToken orderId bundleId packageName
 *   notificationType status httpStatus environment err
 *   expected type subscriptionState purchaseState maxAgeHours purchaseDate
 *   receiptPreview receiptLength jwsParts looksLikeJws responseBody
 *   availableProductIds maxPages pageCount outcome
 *   appIds defaultAppId store entitlement entitled fromUserId userIdSource
 *   notificationUUID messageId linkedPurchaseToken kind deadLetterId
 * FIELD VOCABULARY END
 *
 * `err` is reserved: it always routes through the error renderer.
 *
 * Messages are static literals. Write `log.warn('bundle id mismatch', { bundleId,
 * expected })`, never `` log.warn(`mismatch: ${a} !== ${b}`) `` — an interpolated
 * value is a value that cannot be filtered on, and one that has to be escaped
 * rather than simply carried.
 */

/**
 * Prefix for every line after the first. Leading whitespace is deliberate: it is
 * what existing log-shipper multiline rules key on.
 */
export const LOG_CONTINUATION = '\n    | ';

/** Fields whose value is rendered bare, without quotes. */
const BARE_VALUE = /^[\w.:/@+-]+$/;

/** Any character that could end a line, including the two Unicode separators. */
const LINE_TERMINATORS = /\r\n|\r|\n|\u2028|\u2029/;

/**
 * Longest a single field value may render before it is cut.
 *
 * This is log hygiene, not defence against a caller: the values that actually reach
 * this bound are upstream response bodies, which Apple and Google produce, not an
 * attacker. `fetchSubscriptionPurchaseV2` interpolates the whole Play error body into
 * its `Error` message, so `err.msg` was as unbounded as `responseBody` \u2014 bounding in
 * `renderValue` covers both, and every future field, from one place.
 */
const MAX_VALUE_CHARS = 512;

/**
 * Google Play Developer API URL segment carrying a purchase token.
 *
 * A Play error body, and the `Error` message that embeds it, can echo the request
 * URL \u2014 `.../purchases/products/<productId>/tokens/<purchaseToken>:consume`. That
 * puts the token on log lines that deliberately do not carry it: the acknowledge,
 * consume and validation-failure sites log `productId` and `httpStatus` and no token.
 *
 * This is not an attempt to treat the purchase token as a secret in general \u2014 it
 * cannot be. For a Google subscription the token *is* the record's
 * `originalTransactionId`, so it is in the database, in every RTDN payload, and in
 * the three webhook lines where it is the subject of the investigation. What this
 * does is stop it leaking onto the lines that had decided not to log it.
 */
const PLAY_TOKEN_IN_URL = /\/tokens\/[^/:"'\s\\]+/g;

/** How far to follow `Error.cause`, and how many `AggregateError.errors` to render. */
const MAX_CAUSE_DEPTH = 2;
const MAX_AGGREGATE_ERRORS = 3;

/**
 * Escape everything that could break out of a line or out of a quoted value.
 *
 * Backslash goes FIRST and that ordering is the point. Escaping `\n` to `\` + `n`
 * without escaping `\` first makes two different inputs render identically — a real
 * terminator, and the two characters a caller typed — so an operator cannot tell
 * which they are reading. That defect shipped in 0.23.1 and was fixed in 0.23.3;
 * it is the same class as escaping a quote without escaping the escape character.
 */
function esc(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Escape a value that will sit inside double quotes.
 *
 * One chain, backslash first, quote second. It was previously `esc(v)` followed by a
 * separate `.replace(/"/g, ...)` at three call sites — correct, because `esc` doubles
 * backslashes before the quote pass runs, but wrong in two other ways: the same rule
 * lived in three places, and splitting the escape across two functions leaves a taint
 * analyser unable to see that the metacharacter is handled (CodeQL reported
 * `js/incomplete-sanitization` on each of the three).
 */
function escQuoted(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Cut an over-long value, saying how much was dropped.
 *
 * The count matters: `…` alone leaves an operator unable to tell a body that was
 * 20 characters too long from one that was a megabyte, which is the difference
 * between "read the rest upstream" and "something is very wrong upstream".
 *
 * Applied before escaping, so the bound is on the caller's characters rather than on
 * the expansion — otherwise a value made entirely of newlines would be cut at half
 * the length of an ordinary one.
 */
function clamp(value: string): string {
  if (value.length <= MAX_VALUE_CHARS) return value;
  return `${value.slice(0, MAX_VALUE_CHARS)}…+${value.length - MAX_VALUE_CHARS} more`;
}

/**
 * Redact then bound — every rendered value goes through here.
 *
 * One helper rather than three call sites, because the object and symbol branches
 * produce strings too: a serialised webhook payload can be arbitrarily large and can
 * carry the same Play URL. Applying this only to the `string` branch would have left
 * exactly the shapes an attacker controls unbounded.
 */
function sanitize(value: string): string {
  return clamp(value.replace(PLAY_TOKEN_IN_URL, '/tokens/[redacted]'));
}

/**
 * Render one field value in logfmt.
 *
 * The quoting is a security control, not formatting. An unquoted `userId` of
 * `alice productId=hacked` would be parsed as two fields by Loki, Splunk and
 * CloudWatch Insights — field injection rather than line injection, but the same
 * shape of lie. Anything that is not a plain token gets quoted, and `"` inside a
 * quoted value is escaped so it cannot close it early.
 */
function renderValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';

  switch (typeof value) {
    case 'number':
    case 'boolean':
      return String(value);
    case 'bigint':
      return `${value}n`;
    case 'string': {
      const safe = sanitize(value);
      return BARE_VALUE.test(safe) ? safe : `"${escQuoted(safe)}"`;
    }
    case 'object':
      // Depth 1 only, and inside a try/catch. Webhook payloads are attacker-shaped
      // and arbitrarily deep; a recursive walk here would be both bundle weight and
      // a CPU-DoS surface, and JSON.stringify already throws on cycles.
      try {
        return `"${escQuoted(sanitize(JSON.stringify(value) ?? 'null'))}"`;
      } catch {
        return '"[unserialisable]"';
      }
    default:
      // symbol, function — String() is safe for both.
      try {
        return `"${escQuoted(sanitize(String(value)))}"`;
      } catch {
        return '"[unrenderable]"';
      }
  }
}

/**
 * `key=value` pairs for one object, skipping `undefined` and the reserved `err`.
 *
 * Keys are walked with `Object.keys` and read one at a time rather than through
 * `Object.entries`, which evaluates every getter eagerly — one throwing getter would
 * take down the whole log call, and `log` is a public export so the object is not
 * always one this package built. Reading per key means a hostile property costs its
 * own value and nothing else.
 */
function renderFields(fields: Record<string, unknown>): { pairs: string[]; err: unknown } {
  const pairs: string[] = [];
  let err: unknown;

  for (const key of Object.keys(fields)) {
    let value: unknown;
    try {
      value = fields[key];
    } catch {
      pairs.push(`${esc(key)}="[threw]"`);
      continue;
    }

    if (key === 'err') {
      err = value;
      continue;
    }
    const rendered = renderValue(value);
    if (rendered !== undefined) pairs.push(`${esc(key)}=${rendered}`);
  }

  return { pairs, err };
}

/**
 * Stack frames as continuation lines, header removed.
 *
 * The header is dropped by finding the first `at ` frame rather than by skipping a
 * fixed number of lines: when the error message itself contains newlines — which is
 * exactly the forgery attempt — the header spans several lines, and counting would
 * leak the rest of it into the frames.
 */
function renderStack(stack: string | undefined): string {
  if (!stack) return '';
  const lines = stack.split(LINE_TERMINATORS);
  const firstFrame = lines.findIndex((line) => /^\s+at\s/.test(line));
  const frames = firstFrame === -1 ? [] : lines.slice(firstFrame);
  return frames.map((line) => LOG_CONTINUATION + esc(line.trim())).join('');
}

/**
 * Render a thrown value: `err`/`err.msg` fields plus the stack as continuation
 * lines, following `cause` and `AggregateError.errors` to a fixed depth.
 *
 * Bounded on purpose. A `cause` chain is attacker-reachable through provider error
 * wrapping, and an unbounded walk is a way to turn one log call into a very large
 * write.
 */
function renderError(value: unknown, depth = 0): { pairs: string[]; lines: string } {
  if (!(value instanceof Error)) {
    // `throw 'boom'`, `throw { code: 1 }` — no stack to render.
    const rendered = renderValue(typeof value === 'string' ? value : String(value));
    return { pairs: [`err.msg=${rendered ?? '"[unrenderable]"'}`], lines: '' };
  }

  const pairs = [`err=${renderValue(value.name) ?? 'Error'}`];
  const message = renderValue(value.message);
  if (message !== undefined) pairs.push(`err.msg=${message}`);

  let lines = renderStack(value.stack);

  if (depth < MAX_CAUSE_DEPTH && value.cause !== undefined && value.cause !== null) {
    const cause = renderError(value.cause, depth + 1);
    lines += LOG_CONTINUATION + `cause: ${cause.pairs.join(' ')}` + cause.lines;
  }

  if (value instanceof AggregateError && Array.isArray(value.errors)) {
    for (const inner of value.errors.slice(0, MAX_AGGREGATE_ERRORS)) {
      const rendered = renderError(inner, MAX_CAUSE_DEPTH);
      lines += LOG_CONTINUATION + `also: ${rendered.pairs.join(' ')}`;
    }
  }

  return { pairs, lines };
}

/**
 * Render a whole log call into one string.
 *
 * Argument handling is generic rather than a fixed `(message, fields)` shape, and
 * that is what makes the call-site migration incremental: a site still passing
 * printf-style varargs renders sensibly, so files can move one PR at a time with no
 * flag day. Strings join the message, plain objects contribute their entries as
 * fields, `Error`s go through the error renderer wherever they appear.
 */
export function formatLogArgs(args: readonly unknown[]): string {
  const words: string[] = [];
  const pairs: string[] = [];
  let errorLines = '';

  for (const arg of args) {
    if (typeof arg === 'string') {
      words.push(esc(arg));
      continue;
    }
    if (arg instanceof Error) {
      const rendered = renderError(arg);
      pairs.push(...rendered.pairs);
      errorLines += rendered.lines;
      continue;
    }
    if (arg !== null && typeof arg === 'object' && !Array.isArray(arg)) {
      const { pairs: fieldPairs, err } = renderFields(arg as Record<string, unknown>);
      pairs.push(...fieldPairs);
      if (err !== undefined) {
        const rendered = renderError(err);
        pairs.push(...rendered.pairs);
        errorLines += rendered.lines;
      }
      continue;
    }
    // Numbers, booleans, null, arrays, symbols from a legacy varargs call site.
    const rendered = renderValue(arg);
    if (rendered !== undefined) words.push(rendered);
  }

  return [words.join(' '), ...pairs].filter((part) => part !== '').join(' ') + errorLines;
}
