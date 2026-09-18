import type { Db } from "./db.js";
import type { DomainData } from "./domain.js";
import { filterIdentity } from "./roles.js";

export interface SourceWatermark {
  source: string;
  watermark: number;
  max_seq: number;
  received_count: number;
  missing: number[];
}

export async function getWatermarks(db: Db): Promise<SourceWatermark[]> {
  const wm = await db.query<{
    source: string;
    watermark: string;
    max_seq: string;
    received_count: string;
  }>(`SELECT source, watermark, max_seq, received_count FROM source_watermarks ORDER BY source`);
  const out: SourceWatermark[] = [];
  for (const row of wm.rows) {
    const watermark = Number(row.watermark);
    const maxSeq = Number(row.max_seq);
    const present = await db.query<{ seq: string }>(
      `SELECT seq FROM source_seqs WHERE source = $1 AND seq > $2 ORDER BY seq`,
      [row.source, watermark],
    );
    const presentSet = new Set(present.rows.map((r) => Number(r.seq)));
    const missing: number[] = [];
    for (let s = watermark + 1; s <= maxSeq; s += 1) {
      if (!presentSet.has(s)) missing.push(s);
    }
    out.push({
      source: row.source,
      watermark,
      max_seq: maxSeq,
      received_count: Number(row.received_count),
      missing,
    });
  }
  return out;
}

export interface SeatIntervalConflict {
  train_no: string;
  car: string;
  seat_no: string;
  holders: {
    traveler_ref: string;
    identity: Record<string, unknown>;
    from_station: string;
    to_station: string;
    held_by_event: string;
  }[];
}

export interface TrainDifferenceReport {
  train_no: string | null;
  generated_at: string;
  seat_interval_conflicts: SeatIntervalConflict[];
  source_gaps: { source: string; watermark: number; max_seq: number; missing: number[] }[];
  open_conflicts: number;
}

/** 列车差异表：哪些座位区间被重复占用 + 哪一来源缺了哪一个序号。 */
export async function getTrainDifferences(
  db: Db,
  domain: DomainData,
  role: string,
  trainNo: string | null,
): Promise<TrainDifferenceReport> {
  const params: unknown[] = [];
  let trainFilter = "";
  if (trainNo) {
    params.push(trainNo);
    trainFilter = "AND a.train_no = $1";
  }
  const overlaps = await db.query<{
    train_no: string;
    car: string;
    seat_no: string;
    a_ref: string;
    a_from: string;
    a_to: string;
    a_evt: string;
    b_ref: string;
    b_from: string;
    b_to: string;
    b_evt: string;
  }>(
    `SELECT a.train_no, a.car, a.seat_no,
            a.traveler_ref AS a_ref, a.from_station AS a_from, a.to_station AS a_to, a.held_by_event AS a_evt,
            b.traveler_ref AS b_ref, b.from_station AS b_from, b.to_station AS b_to, b.held_by_event AS b_evt
     FROM journey_segments a
     JOIN journey_segments b
       ON a.train_no = b.train_no AND a.car = b.car AND a.seat_no = b.seat_no AND a.id < b.id
     WHERE a.state = 'held' AND b.state = 'held'
       AND a.from_idx < b.to_idx AND b.from_idx < a.to_idx
       ${trainFilter}
     ORDER BY a.train_no, a.car, a.seat_no`,
    params,
  );

  const refs = new Set<string>();
  for (const row of overlaps.rows) {
    refs.add(row.a_ref);
    refs.add(row.b_ref);
  }
  const identities = await loadIdentities(db, [...refs]);

  const seatConflicts: SeatIntervalConflict[] = overlaps.rows.map((row) => ({
    train_no: row.train_no,
    car: row.car,
    seat_no: row.seat_no,
    holders: [
      {
        traveler_ref: row.a_ref,
        identity: filterIdentity(domain, role, identities.get(row.a_ref)),
        from_station: row.a_from,
        to_station: row.a_to,
        held_by_event: row.a_evt,
      },
      {
        traveler_ref: row.b_ref,
        identity: filterIdentity(domain, role, identities.get(row.b_ref)),
        from_station: row.b_from,
        to_station: row.b_to,
        held_by_event: row.b_evt,
      },
    ],
  }));

  const watermarks = await getWatermarks(db);
  const sourceGaps = watermarks
    .filter((w) => w.missing.length > 0)
    .map((w) => ({ source: w.source, watermark: w.watermark, max_seq: w.max_seq, missing: w.missing }));

  const openParams: unknown[] = [];
  let openFilter = "";
  if (trainNo) {
    openParams.push(trainNo);
    openFilter = "AND train_no = $1";
  }
  const open = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM conflicts WHERE status = 'pending' ${openFilter}`,
    openParams,
  );

  return {
    train_no: trainNo,
    generated_at: new Date().toISOString(),
    seat_interval_conflicts: seatConflicts,
    source_gaps: sourceGaps,
    open_conflicts: Number(open.rows[0]!.count),
  };
}

async function loadIdentities(db: Db, refs: string[]): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (refs.length === 0) return map;
  const res = await db.query<{ traveler_ref: string; identity: Record<string, unknown> }>(
    `SELECT traveler_ref, identity FROM travelers WHERE traveler_ref = ANY($1)`,
    [refs],
  );
  for (const row of res.rows) map.set(row.traveler_ref, row.identity);
  return map;
}

export interface Timeline {
  traveler_ref: string;
  identity: Record<string, unknown>;
  journey: {
    status: string | null;
    last_occurred_at: string | null;
    held_segments: SegmentJson[];
    released_segments: SegmentJson[];
  };
  events: {
    source_event_id: string;
    source: string;
    source_seq: number;
    kind: string;
    occurred_at: string;
    disposition: string;
    conflict_ids: number[];
  }[];
}

interface SegmentJson {
  train_no: string;
  car: string;
  seat_no: string;
  from_station: string;
  to_station: string;
  held_by_event: string;
  released_by_event: string | null;
}

export async function getTimeline(db: Db, domain: DomainData, role: string, travelerRef: string): Promise<Timeline> {
  const journeyRes = await db.query<{
    status: string;
    last_occurred_at: Date | null;
  }>(`SELECT status, last_occurred_at FROM journeys WHERE traveler_ref = $1`, [travelerRef]);
  const journey = journeyRes.rows[0] ?? null;

  const segRes = await db.query<{
    train_no: string;
    car: string;
    seat_no: string;
    from_station: string;
    to_station: string;
    state: string;
    held_by_event: string;
    released_by_event: string | null;
  }>(
    `SELECT train_no, car, seat_no, from_station, to_station, state, held_by_event, released_by_event
     FROM journey_segments WHERE traveler_ref = $1 ORDER BY id`,
    [travelerRef],
  );
  const toJson = (r: (typeof segRes.rows)[number]): SegmentJson => ({
    train_no: r.train_no,
    car: r.car,
    seat_no: r.seat_no,
    from_station: r.from_station,
    to_station: r.to_station,
    held_by_event: r.held_by_event,
    released_by_event: r.released_by_event,
  });

  const eventRes = await db.query<{
    source_event_id: string;
    source: string;
    source_seq: string;
    kind: string;
    occurred_at: Date;
    disposition: string;
  }>(
    `SELECT source_event_id, source, source_seq, kind, occurred_at, disposition
     FROM raw_events WHERE traveler_ref = $1 ORDER BY occurred_at, received_at, source_event_id`,
    [travelerRef],
  );
  const conflictRes = await db.query<{ id: string; source_event_id: string }>(
    `SELECT id, source_event_id FROM conflicts WHERE traveler_ref = $1 ORDER BY id`,
    [travelerRef],
  );
  const conflictsByEvent = new Map<string, number[]>();
  for (const c of conflictRes.rows) {
    const list = conflictsByEvent.get(c.source_event_id) ?? [];
    list.push(Number(c.id));
    conflictsByEvent.set(c.source_event_id, list);
  }

  const identities = await loadIdentities(db, [travelerRef]);

  return {
    traveler_ref: travelerRef,
    identity: filterIdentity(domain, role, identities.get(travelerRef)),
    journey: {
      status: journey?.status ?? null,
      last_occurred_at: journey?.last_occurred_at?.toISOString() ?? null,
      held_segments: segRes.rows.filter((r) => r.state === "held").map(toJson),
      released_segments: segRes.rows.filter((r) => r.state === "released").map(toJson),
    },
    events: eventRes.rows.map((e) => ({
      source_event_id: e.source_event_id,
      source: e.source,
      source_seq: Number(e.source_seq),
      kind: e.kind,
      occurred_at: e.occurred_at.toISOString(),
      disposition: e.disposition,
      conflict_ids: conflictsByEvent.get(e.source_event_id) ?? [],
    })),
  };
}

export interface ConflictListOptions {
  status: string | null;
  reason: string | null;
  trainNo: string | null;
  afterId: number | null;
  limit: number;
}

export interface ConflictListResult {
  items: Record<string, unknown>[];
  next_cursor: string | null;
}

export function encodeCursor(id: number): string {
  return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id?: unknown };
    if (typeof parsed.id !== "number" || !Number.isInteger(parsed.id) || parsed.id < 0) throw new Error("bad");
    return parsed.id;
  } catch {
    throw new Error("游标无效");
  }
}

const MANUAL_REASONS = new Set(["stale_event_after_terminal", "stale_event_manual"]);

export async function listConflicts(
  db: Db,
  domain: DomainData,
  role: string,
  opts: ConflictListOptions,
): Promise<ConflictListResult> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (opts.status) {
    params.push(opts.status);
    clauses.push(`status = $${params.length}`);
  }
  if (opts.reason) {
    params.push(opts.reason);
    clauses.push(`reason = $${params.length}`);
  }
  if (opts.trainNo) {
    params.push(opts.trainNo);
    clauses.push(`train_no = $${params.length}`);
  }
  if (opts.afterId !== null) {
    params.push(opts.afterId);
    clauses.push(`id > $${params.length}`);
  }
  params.push(opts.limit + 1);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const res = await db.query<{
    id: string;
    reason: string;
    status: string;
    traveler_ref: string | null;
    train_no: string | null;
    source_event_id: string | null;
    details: Record<string, unknown>;
    created_at: Date;
    resolved_at: Date | null;
    resolution: string | null;
  }>(
    `SELECT id, reason, status, traveler_ref, train_no, source_event_id, details, created_at, resolved_at, resolution
     FROM conflicts ${where} ORDER BY id ASC LIMIT $${params.length}`,
    params,
  );

  const hasMore = res.rows.length > opts.limit;
  const page = hasMore ? res.rows.slice(0, opts.limit) : res.rows;
  const identities = await loadIdentities(
    db,
    [...new Set(page.map((r) => r.traveler_ref).filter((r): r is string => r !== null))],
  );

  const items = page.map((row) => ({
    id: Number(row.id),
    reason: row.reason,
    status: row.status,
    needs_manual: MANUAL_REASONS.has(row.reason),
    traveler_ref: row.traveler_ref,
    identity: row.traveler_ref ? filterIdentity(domain, role, identities.get(row.traveler_ref)) : {},
    train_no: row.train_no,
    source_event_id: row.source_event_id,
    details: row.details,
    created_at: row.created_at.toISOString(),
    resolved_at: row.resolved_at?.toISOString() ?? null,
    resolution: row.resolution,
  }));

  const last = page[page.length - 1];
  return {
    items,
    next_cursor: hasMore && last ? encodeCursor(Number(last.id)) : null,
  };
}
