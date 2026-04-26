import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SUBSCRIPTIONS_SCHEMA_SQL, PURCHASES_SCHEMA_SQL } from '../stores/schema.js';

/**
 * Parity check between the canonical SQL file (sql/schema.sql) and the
 * embedded string constants used by initSchema() at runtime. If this fails,
 * one of the two was edited without the other.
 */
describe('schema SQL parity', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // __tests__ lives under src/, so sql/schema.sql is three levels up.
  const schemaPath = join(here, '..', '..', 'sql', 'schema.sql');
  const sqlFile = readFileSync(schemaPath, 'utf8');

  // Normalize both sides to compare by semantics rather than whitespace:
  // strip SQL line comments, collapse whitespace, lowercase.
  // The leading \r normalisation matters on Windows checkouts (core.autocrlf):
  // without it, `--.*$` fails to match because `$` doesn't see `\r` as a line
  // terminator, leaving comments in place and breaking the parity check.
  const normalize = (sql: string) =>
    sql
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  it('contains both table DDLs in the canonical .sql file', () => {
    const n = normalize(sqlFile);
    expect(n).toContain('create table if not exists onesub_subscriptions');
    expect(n).toContain('create table if not exists onesub_purchases');
  });

  it('subscriptions DDL constant appears verbatim in schema.sql', () => {
    expect(normalize(sqlFile)).toContain(normalize(SUBSCRIPTIONS_SCHEMA_SQL));
  });

  it('purchases DDL constant appears verbatim in schema.sql', () => {
    expect(normalize(sqlFile)).toContain(normalize(PURCHASES_SCHEMA_SQL));
  });

  it('non-consumable partial unique index is present (0.2.0 semantics)', () => {
    const n = normalize(sqlFile);
    expect(n).toContain('create unique index if not exists idx_onesub_purchases_non_consumable');
    expect(n).toContain("where type = 'non_consumable'");
  });
});
