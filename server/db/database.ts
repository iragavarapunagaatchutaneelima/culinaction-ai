import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Client, InStatement, Transaction } from '@libsql/client/web';
import { MIGRATIONS } from './migrations';

export type Row = Record<string, unknown>;
export type Params = SQLInputValue[] | Record<string, SQLInputValue>;

/**
 * Async database interface used by the whole server. Two drivers implement it:
 * - SqliteDb: Node's built-in node:sqlite on a local file (development, tests, self-hosting)
 * - LibsqlDb: Turso / libSQL over HTTP (serverless hosting such as Vercel, where there is no persistent disk)
 * Both speak the same SQLite dialect, so all SQL and migrations are shared.
 */
export interface Db {
  readonly driver: 'node-sqlite' | 'libsql';
  all<T = Row>(sql: string, params?: Params): Promise<T[]>;
  get<T = Row>(sql: string, params?: Params): Promise<T | undefined>;
  run(sql: string, params?: Params): Promise<{ changes: number; lastId: number }>;
  /** Run fn inside a transaction; nested calls use savepoints. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  migrate(): Promise<number[]>;
  close(): Promise<void>;
}

const splitStatements = (sql: string) =>
  sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s && !/^--[^\n]*$/.test(s));

async function migrateWith(db: Db, execScript: (sql: string) => Promise<void>): Promise<number[]> {
  await db.run(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const done = new Set(
    (await db.all<{ version: number }>('SELECT version FROM schema_migrations')).map((r) =>
      Number(r.version),
    ),
  );
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    try {
      await db.tx(async () => {
        await execScript(m.sql);
        await db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
          m.version,
          m.name,
          new Date().toISOString(),
        ]);
      });
      applied.push(m.version);
    } catch (e) {
      // Another instance may have applied it concurrently (serverless cold starts).
      const now = await db.get('SELECT 1 FROM schema_migrations WHERE version = ?', [m.version]);
      if (!now) throw e;
    }
  }
  return applied;
}

// ---------------------------------------------------------------------------
// node:sqlite driver
// ---------------------------------------------------------------------------

export class SqliteDb implements Db {
  readonly driver = 'node-sqlite' as const;
  readonly raw: DatabaseSync;
  private als = new AsyncLocalStorage<{ depth: number }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    Driver: typeof DatabaseSync,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new Driver(path);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
  }

  private args(params?: Params): SQLInputValue[] {
    if (params === undefined) return [];
    return Array.isArray(params) ? params : [params as unknown as SQLInputValue];
  }

  async all<T = Row>(sql: string, params?: Params): Promise<T[]> {
    return this.raw.prepare(sql).all(...this.args(params)) as T[];
  }
  async get<T = Row>(sql: string, params?: Params): Promise<T | undefined> {
    return this.raw.prepare(sql).get(...this.args(params)) as T | undefined;
  }
  async run(sql: string, params?: Params) {
    const r = this.raw.prepare(sql).run(...this.args(params));
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  tx<T>(fn: () => Promise<T>): Promise<T> {
    const store = this.als.getStore();
    if (store) {
      const sp = `sp_${store.depth}`;
      this.raw.exec(`SAVEPOINT ${sp}`);
      return this.als.run({ depth: store.depth + 1 }, fn).then(
        (v) => {
          this.raw.exec(`RELEASE ${sp}`);
          return v;
        },
        (e) => {
          this.raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        },
      );
    }
    // Serialise top-level transactions on the single connection.
    const next = this.queue.then(async () => {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const v = await this.als.run({ depth: 1 }, fn);
        this.raw.exec('COMMIT');
        return v;
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw e;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  migrate() {
    return migrateWith(this, async (sql) => this.raw.exec(sql));
  }

  async close() {
    this.raw.close();
  }
}

// ---------------------------------------------------------------------------
// libSQL / Turso driver (HTTP — works in serverless functions)
// ---------------------------------------------------------------------------

export class LibsqlDb implements Db {
  readonly driver = 'libsql' as const;
  private als = new AsyncLocalStorage<{ tx: Transaction; depth: number }>();

  constructor(private client: Client) {}

  private stmt(sql: string, params?: Params): InStatement {
    return { sql, args: (params ?? []) as never };
  }

  private async exec(sql: string, params?: Params) {
    const t = this.als.getStore()?.tx;
    return t ? t.execute(this.stmt(sql, params)) : this.client.execute(this.stmt(sql, params));
  }

  async all<T = Row>(sql: string, params?: Params): Promise<T[]> {
    const rs = await this.exec(sql, params);
    return rs.rows.map((r) => {
      const o: Row = {};
      rs.columns.forEach((c, i) => {
        const v = r[i];
        o[c] = typeof v === 'bigint' ? Number(v) : v;
      });
      return o as T;
    });
  }
  async get<T = Row>(sql: string, params?: Params): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }
  async run(sql: string, params?: Params) {
    const rs = await this.exec(sql, params);
    return { changes: rs.rowsAffected, lastId: Number(rs.lastInsertRowid ?? 0) };
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const store = this.als.getStore();
    if (store) {
      const sp = `sp_${store.depth}`;
      await store.tx.execute(`SAVEPOINT ${sp}`);
      try {
        const v = await this.als.run({ tx: store.tx, depth: store.depth + 1 }, fn);
        await store.tx.execute(`RELEASE ${sp}`);
        return v;
      } catch (e) {
        await store.tx.execute(`ROLLBACK TO ${sp}`);
        await store.tx.execute(`RELEASE ${sp}`);
        throw e;
      }
    }
    const tx = await this.client.transaction('write');
    try {
      const v = await this.als.run({ tx, depth: 1 }, fn);
      await tx.commit();
      return v;
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    } finally {
      tx.close();
    }
  }

  migrate() {
    return migrateWith(this, async (sql) => {
      for (const s of splitStatements(sql)) await this.exec(s);
    });
  }

  async close() {
    this.client.close();
  }
}

// ---------------------------------------------------------------------------

export interface DbConfig {
  /** libsql://…, https://… (Turso) — or omitted to use a local file */
  url?: string;
  authToken?: string;
  /** local SQLite file path (used when url is not a remote URL) */
  path?: string;
}

export async function openDb(config: DbConfig | string): Promise<Db> {
  const c = typeof config === 'string' ? { path: config } : config;
  let db: Db;
  if (c.url && /^(libsql|https?|wss?):\/\//.test(c.url)) {
    const { createClient } = await import('@libsql/client/web');
    const client = createClient({ url: c.url, authToken: c.authToken, intMode: 'number' });
    await client.execute('PRAGMA foreign_keys = ON').catch(() => undefined);
    db = new LibsqlDb(client);
  } else {
    // Loaded lazily so serverless bundles that only use libSQL never touch node:sqlite.
    const { DatabaseSync } = await import('node:sqlite');
    db = new SqliteDb(c.path ?? 'data/culinaction.db', DatabaseSync);
  }
  await db.migrate();
  return db;
}

export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    url: env.TURSO_DATABASE_URL || env.DATABASE_URL || undefined,
    authToken: env.TURSO_AUTH_TOKEN || undefined,
    path: env.DATABASE_PATH || 'data/culinaction.db',
  };
}
