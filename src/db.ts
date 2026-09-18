import pg from "pg";
import type { PoolClient } from "pg";

const { Pool } = pg;

export type Db = pg.Pool;

export function createPool(databaseUrl: string): Db {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    keepAlive: true,
    connectionTimeoutMillis: 5000,
  });
  // 数据库重启时空闲连接被服务端断开：丢弃即可，连接池会按需重建，
  // 不能让该事件成为未捕获异常打挂服务。
  pool.on("error", (err) => {
    console.warn(`空闲数据库连接已断开（连接池将重建）: ${err.message}`);
  });
  return pool;
}

/** 在单事务中执行：原始事件、来源水位、当前行程、冲突原因的写入必须同生共死。 */
export async function withTx<T>(db: Db, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function migrate(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS raw_events (
      source_event_id TEXT PRIMARY KEY,
      source          TEXT NOT NULL,
      source_seq      BIGINT NOT NULL,
      traveler_ref    TEXT NOT NULL,
      kind            TEXT NOT NULL,
      occurred_at     TIMESTAMPTZ NOT NULL,
      payload         JSONB NOT NULL,
      disposition     TEXT NOT NULL,
      received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS raw_events_source_seq_key ON raw_events(source, source_seq);
    CREATE INDEX IF NOT EXISTS raw_events_traveler_idx ON raw_events(traveler_ref);

    CREATE TABLE IF NOT EXISTS source_seqs (
      source TEXT NOT NULL,
      seq    BIGINT NOT NULL,
      PRIMARY KEY (source, seq)
    );

    CREATE TABLE IF NOT EXISTS source_watermarks (
      source         TEXT PRIMARY KEY,
      watermark      BIGINT NOT NULL DEFAULT 0,
      max_seq        BIGINT NOT NULL DEFAULT 0,
      received_count BIGINT NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS travelers (
      traveler_ref TEXT PRIMARY KEY,
      identity     JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS journeys (
      traveler_ref      TEXT PRIMARY KEY,
      status            TEXT NOT NULL,
      last_occurred_at  TIMESTAMPTZ,
      last_event_id     TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS journey_segments (
      id                BIGSERIAL PRIMARY KEY,
      traveler_ref      TEXT NOT NULL,
      train_no          TEXT NOT NULL,
      car               TEXT NOT NULL,
      seat_no           TEXT NOT NULL,
      from_station      TEXT NOT NULL,
      to_station        TEXT NOT NULL,
      from_idx          INT NOT NULL,
      to_idx            INT NOT NULL,
      state             TEXT NOT NULL,
      held_by_event     TEXT NOT NULL,
      released_by_event TEXT,
      held_at           TIMESTAMPTZ NOT NULL,
      released_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS segments_occupancy_idx
      ON journey_segments(train_no, car, seat_no) WHERE state = 'held';
    CREATE INDEX IF NOT EXISTS segments_traveler_idx ON journey_segments(traveler_ref);

    CREATE TABLE IF NOT EXISTS conflicts (
      id              BIGSERIAL PRIMARY KEY,
      reason          TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      traveler_ref    TEXT,
      train_no        TEXT,
      source_event_id TEXT,
      details         JSONB NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at     TIMESTAMPTZ,
      resolution      TEXT
    );
    CREATE INDEX IF NOT EXISTS conflicts_status_idx ON conflicts(status, id);
    CREATE INDEX IF NOT EXISTS conflicts_train_idx ON conflicts(train_no);
  `);
}
