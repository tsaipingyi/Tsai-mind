import postgres from 'postgres';

export type Sql = postgres.Sql;
/** The `sql` handle inside a transaction. */
export type Tx = postgres.TransactionSql;

/**
 * Postgres client with the type mappings this app relies on:
 * - `date` columns come back as 'YYYY-MM-DD' strings (never Date objects)
 * - int8 (bigserial server_seq / activity id) comes back as a number
 * - numeric comes back as a number
 */
export function createDb(url: string): Sql {
  return postgres(url, {
    max: 5,
    onnotice: () => {},
    types: {
      date: { to: 1082, from: [1082], serialize: (v: string) => v, parse: (v: string) => v },
      bigint: { to: 20, from: [20], serialize: (v: number | bigint) => String(v), parse: (v: string) => Number(v) },
      numeric: { to: 1700, from: [1700], serialize: (v: number) => String(v), parse: (v: string) => Number(v) },
    },
  });
}
