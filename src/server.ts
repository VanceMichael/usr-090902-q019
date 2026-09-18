import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Db } from "./db.js";
import type { DomainData } from "./domain.js";
import { ingestOne, HttpError } from "./ingest.js";
import {
  getWatermarks,
  getTrainDifferences,
  getTimeline,
  listConflicts,
  decodeCursor,
} from "./reports.js";

interface Ctx {
  db: Db;
  domain: DomainData;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new HttpError(413, "body_too_large", "请求体过大");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "请求体不是合法 JSON");
  }
}

function requireRole(req: IncomingMessage, domain: DomainData): string {
  const role = req.headers["x-role"];
  const value = Array.isArray(role) ? role[0] : role;
  if (!value || !domain.rules.roles.includes(value)) {
    throw new HttpError(401, "role_required", "需要有效的 X-Role 头（operator / border / auditor）");
  }
  return value;
}

export function createApp(ctx: Ctx) {
  const { db, domain } = ctx;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/healthz") {
        await db.query("SELECT 1");
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && path === "/events") {
        const body = await readBody(req);
        const result = await ingestOne(db, domain, body);
        if (!result.ok) {
          sendError(res, result.status, result.code, result.message);
          return;
        }
        sendJson(res, 200, result);
        return;
      }

      if (method === "POST" && path === "/events/batch") {
        const body = await readBody(req);
        if (!Array.isArray(body)) throw new HttpError(400, "invalid_batch", "批量请求应为数组");
        if (body.length === 0) throw new HttpError(400, "empty_batch", "批量请求为空");
        if (body.length > domain.rules.maximum_batch) {
          throw new HttpError(400, "batch_too_large", `批量上限为 ${domain.rules.maximum_batch}`);
        }
        const results = [];
        for (const item of body) {
          // 每个事件独立事务：单条失败不影响批次内其他事件
          results.push(await ingestOne(db, domain, item));
        }
        sendJson(res, 200, { results });
        return;
      }

      if (method === "GET" && path === "/sources/watermarks") {
        requireRole(req, domain);
        sendJson(res, 200, { sources: await getWatermarks(db) });
        return;
      }

      if (method === "GET" && path === "/reports/train-differences") {
        const role = requireRole(req, domain);
        const trainNo = url.searchParams.get("train_no");
        if (trainNo && !domain.trains.has(trainNo)) {
          throw new HttpError(404, "unknown_train", `未知车次: ${trainNo}`);
        }
        sendJson(res, 200, await getTrainDifferences(db, domain, role, trainNo));
        return;
      }

      const timelineMatch = /^\/travelers\/([^/]+)\/timeline$/.exec(path);
      if (method === "GET" && timelineMatch) {
        const role = requireRole(req, domain);
        sendJson(res, 200, await getTimeline(db, domain, role, decodeURIComponent(timelineMatch[1]!)));
        return;
      }

      if (method === "GET" && path === "/conflicts") {
        const role = requireRole(req, domain);
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new HttpError(400, "invalid_limit", "limit 应为 1..100");
        }
        const cursorRaw = url.searchParams.get("cursor");
        let afterId: number | null = null;
        if (cursorRaw) {
          try {
            afterId = decodeCursor(cursorRaw);
          } catch {
            throw new HttpError(400, "invalid_cursor", "游标无效");
          }
        }
        sendJson(
          res,
          200,
          await listConflicts(db, domain, role, {
            status: url.searchParams.get("status"),
            reason: url.searchParams.get("reason"),
            trainNo: url.searchParams.get("train_no"),
            afterId,
            limit,
          }),
        );
        return;
      }

      const resolveMatch = /^\/conflicts\/(\d+)\/resolve$/.exec(path);
      if (method === "POST" && resolveMatch) {
        const role = requireRole(req, domain);
        if (role !== "operator") {
          throw new HttpError(403, "forbidden", "仅 operator 可处理冲突");
        }
        const body = (await readBody(req)) as { resolution?: unknown } | undefined;
        if (!body || typeof body.resolution !== "string" || body.resolution.length === 0) {
          throw new HttpError(400, "resolution_required", "需要 resolution 字段");
        }
        const id = Number(resolveMatch[1]);
        const updated = await db.query(
          `UPDATE conflicts SET status = 'resolved', resolved_at = now(), resolution = $2
           WHERE id = $1 AND status = 'pending' RETURNING id`,
          [id, body.resolution],
        );
        if (updated.rowCount === 0) {
          const exists = await db.query(`SELECT 1 FROM conflicts WHERE id = $1`, [id]);
          if (exists.rowCount === 0) throw new HttpError(404, "not_found", `冲突 ${id} 不存在`);
          throw new HttpError(409, "already_resolved", `冲突 ${id} 已处理`);
        }
        sendJson(res, 200, { id, status: "resolved" });
        return;
      }

      sendError(res, 404, "not_found", `${method} ${path} 不存在`);
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message);
        return;
      }
      console.error("未处理异常:", err);
      sendError(res, 500, "internal_error", "服务内部错误");
    }
  });
}
