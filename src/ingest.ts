import type { PoolClient } from "pg";
import { withTx, type Db } from "./db.js";
import type { DomainData, Train } from "./domain.js";
import { validateAgainstContract, ContractError, type SchemaNode } from "./contract.js";
import { withinPortWindow } from "./timezones.js";

export interface EventPayload {
  source_event_id: string;
  source: string;
  source_seq: number;
  traveler_ref: string;
  kind: string;
  occurred_at: string;
  train_no?: string;
  seat?: { car: string; no: string };
  from_station?: string;
  to_station?: string;
  port?: string;
  replaces_event_id?: string;
  identity?: Record<string, string>;
}

export type Disposition = "applied" | "duplicate" | "conflict" | "manual";

export interface IngestSuccess {
  ok: true;
  source_event_id: string;
  disposition: Disposition;
  conflict_ids: number[];
}

export interface IngestFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
}

export type IngestResult = IngestSuccess | IngestFailure;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const TERMINAL_STATUSES = new Set(["exited", "denied"]);

/** 契约之外的领域校验：事件类型、来源权限、车次/座位/口岸引用与必填字段。 */
function validateDomain(payload: EventPayload, domain: DomainData): void {
  if (!domain.rules.events.includes(payload.kind)) {
    throw new HttpError(422, "unknown_kind", `事件类型不在规则内: ${payload.kind}`);
  }
  const sourceCfg = domain.permissions.sources[payload.source];
  if (!sourceCfg) throw new HttpError(422, "unknown_source", `未知来源: ${payload.source}`);
  if (!sourceCfg.kinds.includes(payload.kind)) {
    throw new HttpError(422, "source_kind_not_permitted", `来源 ${payload.source} 无权上报 ${payload.kind}`);
  }
  const occurred = new Date(payload.occurred_at);
  if (Number.isNaN(occurred.getTime())) throw new HttpError(422, "invalid_occurred_at", "occurred_at 无法解析");

  if (payload.kind === "entered" || payload.kind === "rebooked") {
    const train = payload.train_no ? domain.trains.get(payload.train_no) : undefined;
    if (!train) throw new HttpError(422, "unknown_train", `未知车次: ${payload.train_no ?? "缺失"}`);
    if (!payload.seat) throw new HttpError(422, "missing_seat", "缺少座位");
    if (!train.cars.some((c) => c.car === payload.seat!.car)) {
      throw new HttpError(422, "unknown_car", `车次 ${train.trainNo} 无车厢 ${payload.seat.car}`);
    }
    const fromIdx = stationIndex(train, payload.from_station);
    const toIdx = stationIndex(train, payload.to_station);
    if (fromIdx === undefined || toIdx === undefined) {
      throw new HttpError(422, "station_not_on_route", `区间不在车次 ${train.trainNo} 径路上`);
    }
    if (fromIdx >= toIdx) throw new HttpError(422, "invalid_segment", "上车站必须早于下车站");
    if (payload.kind === "rebooked" && !payload.replaces_event_id) {
      throw new HttpError(422, "missing_replaces", "改签必须携带 replaces_event_id");
    }
  } else {
    const port = payload.port ? domain.ports.get(payload.port) : undefined;
    if (!port) throw new HttpError(422, "unknown_port", `未知口岸: ${payload.port ?? "缺失"}`);
  }
}

function stationIndex(train: Train, station: string | undefined): number | undefined {
  if (!station) return undefined;
  const idx = train.route.findIndex((s) => s.station === station);
  return idx >= 0 ? idx : undefined;
}

async function insertConflict(
  client: PoolClient,
  fields: {
    reason: string;
    travelerRef: string;
    trainNo: string | null;
    sourceEventId: string;
    details: Record<string, unknown>;
  },
): Promise<number> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO conflicts(reason, traveler_ref, train_no, source_event_id, details)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [fields.reason, fields.travelerRef, fields.trainNo, fields.sourceEventId, JSON.stringify(fields.details)],
  );
  return Number(res.rows[0]!.id);
}

interface JourneyRow {
  traveler_ref: string;
  status: string;
  last_occurred_at: Date | null;
  last_event_id: string | null;
}

async function loadJourney(client: PoolClient, travelerRef: string): Promise<JourneyRow | null> {
  const res = await client.query<JourneyRow>(
    `SELECT traveler_ref, status, last_occurred_at, last_event_id FROM journeys WHERE traveler_ref = $1 FOR UPDATE`,
    [travelerRef],
  );
  return res.rows[0] ?? null;
}

async function upsertJourney(
  client: PoolClient,
  travelerRef: string,
  status: string,
  occurredAt: Date,
  eventId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO journeys(traveler_ref, status, last_occurred_at, last_event_id, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (traveler_ref) DO UPDATE
       SET status = $2, last_occurred_at = $3, last_event_id = $4, updated_at = now()`,
    [travelerRef, status, occurredAt, eventId],
  );
}

async function checkSeatOverlap(
  client: PoolClient,
  payload: EventPayload,
  fromIdx: number,
  toIdx: number,
): Promise<number[]> {
  const res = await client.query<{
    traveler_ref: string;
    from_station: string;
    to_station: string;
    held_by_event: string;
  }>(
    `SELECT traveler_ref, from_station, to_station, held_by_event
     FROM journey_segments
     WHERE state = 'held' AND traveler_ref <> $1 AND train_no = $2 AND car = $3 AND seat_no = $4
       AND from_idx < $6 AND $5 < to_idx`,
    [payload.traveler_ref, payload.train_no, payload.seat!.car, payload.seat!.no, fromIdx, toIdx],
  );
  const conflictIds: number[] = [];
  for (const other of res.rows) {
    conflictIds.push(
      await insertConflict(client, {
        reason: "seat_interval_overlap",
        travelerRef: payload.traveler_ref,
        trainNo: payload.train_no!,
        sourceEventId: payload.source_event_id,
        details: {
          seat: payload.seat,
          this_segment: { from_station: payload.from_station, to_station: payload.to_station },
          other_traveler_ref: other.traveler_ref,
          other_segment: { from_station: other.from_station, to_station: other.to_station },
          other_event_id: other.held_by_event,
        },
      }),
    );
  }
  return conflictIds;
}

async function holdSegment(
  client: PoolClient,
  payload: EventPayload,
  train: Train,
  occurredAt: Date,
): Promise<number[]> {
  const fromIdx = stationIndex(train, payload.from_station)!;
  const toIdx = stationIndex(train, payload.to_station)!;
  await client.query(
    `INSERT INTO journey_segments(
       traveler_ref, train_no, car, seat_no, from_station, to_station,
       from_idx, to_idx, state, held_by_event, held_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'held',$9,$10)`,
    [
      payload.traveler_ref,
      train.trainNo,
      payload.seat!.car,
      payload.seat!.no,
      payload.from_station,
      payload.to_station,
      fromIdx,
      toIdx,
      payload.source_event_id,
      occurredAt,
    ],
  );
  return checkSeatOverlap(client, payload, fromIdx, toIdx);
}

async function releaseSegmentByEvent(
  client: PoolClient,
  travelerRef: string,
  heldByEvent: string,
  releasedByEvent: string,
  releasedAt: Date,
): Promise<boolean> {
  const res = await client.query(
    `UPDATE journey_segments
       SET state = 'released', released_by_event = $3, released_at = $4
     WHERE traveler_ref = $1 AND held_by_event = $2 AND state = 'held'`,
    [travelerRef, heldByEvent, releasedByEvent, releasedAt],
  );
  return (res.rowCount ?? 0) > 0;
}

async function releaseAllHeld(
  client: PoolClient,
  travelerRef: string,
  releasedByEvent: string,
  releasedAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE journey_segments
       SET state = 'released', released_by_event = $2, released_at = $3
     WHERE traveler_ref = $1 AND state = 'held'`,
    [travelerRef, releasedByEvent, releasedAt],
  );
}

/**
 * 摄取单个事件。原始事件、来源水位、当前行程、冲突原因在同一事务写入；
 * source_event_id 重投只计一次。
 */
export async function ingestOne(db: Db, domain: DomainData, raw: unknown): Promise<IngestResult> {
  try {
    validateAgainstContract(raw, domain.requestSchema as SchemaNode);
  } catch (err) {
    if (err instanceof ContractError) {
      return { ok: false, status: 400, code: "contract_violation", message: err.message };
    }
    throw err;
  }
  const payload = raw as EventPayload;
  try {
    validateDomain(payload, domain);
  } catch (err) {
    if (err instanceof HttpError) {
      return { ok: false, status: err.status, code: err.code, message: err.message };
    }
    throw err;
  }

  const occurredAt = new Date(payload.occurred_at);

  try {
    return await withTx(db, async (client) => {
      // 串行化同一旅客的并发事件（如并发改签），守恒判断基于已提交状态
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [payload.traveler_ref]);

      let inserted;
      try {
        inserted = await client.query<{ source_event_id: string }>(
          `INSERT INTO raw_events(source_event_id, source, source_seq, traveler_ref, kind, occurred_at, payload, disposition)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'processing')
         ON CONFLICT (source_event_id) DO NOTHING
         RETURNING source_event_id`,
          [
            payload.source_event_id,
            payload.source,
            payload.source_seq,
            payload.traveler_ref,
            payload.kind,
            occurredAt,
            JSON.stringify(payload),
          ],
        );
      } catch (err) {
        // 同一 (source, source_seq) 被不同 source_event_id 占用：来源协议违规
        if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
          throw new HttpError(
            409,
            "seq_already_used",
            `来源 ${payload.source} 序号 ${payload.source_seq} 已被其他事件占用`,
          );
        }
        throw err;
      }
      if (inserted.rowCount === 0) {
        const conflicts = await client.query<{ id: string }>(
          `SELECT id FROM conflicts WHERE source_event_id = $1 ORDER BY id`,
          [payload.source_event_id],
        );
        return {
          ok: true,
          source_event_id: payload.source_event_id,
          disposition: "duplicate" as const,
          conflict_ids: conflicts.rows.map((r) => Number(r.id)),
        };
      }

      // 记录序号并推进连续水位（缺口保留到补报到达）
      await client.query(
        `INSERT INTO source_seqs(source, seq) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [payload.source, payload.source_seq],
      );
      const seqRows = await client.query<{ seq: string }>(
        `SELECT seq FROM source_seqs WHERE source = $1 ORDER BY seq ASC`,
        [payload.source],
      );
      const seqSet = new Set(seqRows.rows.map((r) => Number(r.seq)));
      let watermark = 0;
      while (seqSet.has(watermark + 1)) watermark += 1;
      const maxSeq = seqRows.rows.length ? Number(seqRows.rows[seqRows.rows.length - 1]!.seq) : 0;
      await client.query(
        `INSERT INTO source_watermarks(source, watermark, max_seq, received_count)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (source) DO UPDATE SET watermark = $2, max_seq = $3, received_count = $4`,
        [payload.source, watermark, maxSeq, seqRows.rows.length],
      );

      if (payload.identity && Object.keys(payload.identity).length > 0) {
        await client.query(
          `INSERT INTO travelers(traveler_ref, identity, updated_at) VALUES ($1,$2,now())
           ON CONFLICT (traveler_ref) DO UPDATE SET identity = $2, updated_at = now()`,
          [payload.traveler_ref, JSON.stringify(payload.identity)],
        );
      }

      const conflictIds: number[] = [];
      let disposition: Disposition = "applied";
      const journey = await loadJourney(client, payload.traveler_ref);

      const isStale =
        journey !== null &&
        journey.last_occurred_at !== null &&
        occurredAt < journey.last_occurred_at;

      if (isStale) {
        // 无法衔接的旧事件：进入待人工处理，不污染现状
        const terminal = TERMINAL_STATUSES.has(journey.status);
        conflictIds.push(
          await insertConflict(client, {
            reason: terminal ? "stale_event_after_terminal" : "stale_event_manual",
            travelerRef: payload.traveler_ref,
            trainNo: payload.train_no ?? null,
            sourceEventId: payload.source_event_id,
            details: {
              kind: payload.kind,
              journey_status: journey.status,
              last_occurred_at: journey.last_occurred_at!.toISOString(),
              event_occurred_at: occurredAt.toISOString(),
            },
          }),
        );
        disposition = "manual";
      } else if (payload.kind === "entered") {
        const held = await client.query<{ id: string }>(
          `SELECT id FROM journey_segments WHERE traveler_ref = $1 AND state = 'held' LIMIT 1`,
          [payload.traveler_ref],
        );
        if (journey && journey.status === "active" && held.rows.length > 0) {
          conflictIds.push(
            await insertConflict(client, {
              reason: "entered_while_holding",
              travelerRef: payload.traveler_ref,
              trainNo: payload.train_no!,
              sourceEventId: payload.source_event_id,
              details: { held_segment_id: Number(held.rows[0]!.id) },
            }),
          );
          disposition = "conflict";
        } else {
          const train = domain.trains.get(payload.train_no!)!;
          conflictIds.push(...(await holdSegment(client, payload, train, occurredAt)));
          await upsertJourney(client, payload.traveler_ref, "active", occurredAt, payload.source_event_id);
        }
      } else if (payload.kind === "rebooked") {
        // 改签守恒：必须恰好释放 replaces_event_id 持有的区间，再占用新区间
        const released = await releaseSegmentByEvent(
          client,
          payload.traveler_ref,
          payload.replaces_event_id!,
          payload.source_event_id,
          occurredAt,
        );
        if (!released) {
          conflictIds.push(
            await insertConflict(client, {
              reason: "rebook_conservation_violation",
              travelerRef: payload.traveler_ref,
              trainNo: payload.train_no!,
              sourceEventId: payload.source_event_id,
              details: {
                replaces_event_id: payload.replaces_event_id,
                cause: "被替换区间当前并非持有状态（可能已被并发改签释放或从未持有）",
              },
            }),
          );
          disposition = "conflict";
        } else {
          const train = domain.trains.get(payload.train_no!)!;
          conflictIds.push(...(await holdSegment(client, payload, train, occurredAt)));
          await upsertJourney(client, payload.traveler_ref, "active", occurredAt, payload.source_event_id);
        }
      } else {
        // exit_confirmed / passage_denied：口岸窗口按夹具时区判断
        const port = domain.ports.get(payload.port!)!;
        const window = withinPortWindow(port, occurredAt);
        if (!window.ok) {
          conflictIds.push(
            await insertConflict(client, {
              reason: "outside_port_window",
              travelerRef: payload.traveler_ref,
              trainNo: null,
              sourceEventId: payload.source_event_id,
              details: {
                port: port.code,
                timezone: port.timezone,
                local_time: window.localTime,
                windows: port.windows,
              },
            }),
          );
          disposition = "conflict";
        } else if (payload.kind === "exit_confirmed" && (!journey || journey.status !== "active")) {
          conflictIds.push(
            await insertConflict(client, {
              reason: "exit_without_active_journey",
              travelerRef: payload.traveler_ref,
              trainNo: null,
              sourceEventId: payload.source_event_id,
              details: { journey_status: journey?.status ?? null },
            }),
          );
          disposition = "conflict";
        } else if (payload.kind === "passage_denied" && journey && TERMINAL_STATUSES.has(journey.status)) {
          conflictIds.push(
            await insertConflict(client, {
              reason: "denied_after_terminal",
              travelerRef: payload.traveler_ref,
              trainNo: null,
              sourceEventId: payload.source_event_id,
              details: { journey_status: journey.status },
            }),
          );
          disposition = "conflict";
        } else {
          const status = payload.kind === "exit_confirmed" ? "exited" : "denied";
          await releaseAllHeld(client, payload.traveler_ref, payload.source_event_id, occurredAt);
          await upsertJourney(client, payload.traveler_ref, status, occurredAt, payload.source_event_id);
        }
      }

      await client.query(`UPDATE raw_events SET disposition = $2 WHERE source_event_id = $1`, [
        payload.source_event_id,
        disposition,
      ]);
      return {
        ok: true,
        source_event_id: payload.source_event_id,
        disposition,
        conflict_ids: conflictIds,
      } satisfies IngestSuccess;
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return { ok: false, status: err.status, code: err.code, message: err.message };
    }
    throw err;
  }
}
