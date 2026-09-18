#!/usr/bin/env node
/**
 * 端到端核对脚本（只发 HTTP，不依赖铁路/边检外部接口）。
 *
 *   node scripts/e2e.mjs --phase=1 --base=http://127.0.0.1:8080
 *   node scripts/e2e.mjs --phase=2 --base=http://127.0.0.1:8080
 *
 * phase=1：制造序号缺口与并发改签，校验水位/差异表/时间线/冲突游标；
 * phase=2：（数据库重启后）先核对旧状态仍在，再补回晚到事件并复核。
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "true"];
  }),
);
const BASE = (args.base ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const PHASE = args.phase ?? "all";

let failures = 0;
function check(cond, label, extra) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${extra !== undefined ? ` —— ${JSON.stringify(extra)}` : ""}`);
  }
}

async function api(method, path, { role, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (role) headers["x-role"] = role;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json };
}

const post = (body, role) => api("POST", "/events", { body, role });

function ev(overrides) {
  return {
    source_event_id: "rail-1",
    source: "rail",
    source_seq: 1,
    traveler_ref: "trv-a",
    kind: "entered",
    occurred_at: "2026-09-09T20:00:00+08:00",
    train_no: "K27",
    seat: { car: "05", no: "12A" },
    from_station: "BJS",
    to_station: "ERL",
    identity: { name: "An Wei", document_no: "P1001", nationality: "CN" },
    ...overrides,
  };
}

async function waitHealthy(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      /* 尚未就绪 */
    }
    if (Date.now() > deadline) throw new Error("等待服务健康超时");
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function getWatermarks() {
  const { json } = await api("GET", "/sources/watermarks", { role: "operator" });
  return Object.fromEntries(json.sources.map((s) => [s.source, s]));
}

async function collectAllConflicts(limit, extra = "") {
  const ids = [];
  let cursor = null;
  for (;;) {
    const qs = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${extra}`;
    const { status, json } = await api("GET", `/conflicts${qs}`, { role: "auditor" });
    if (status !== 200) throw new Error(`冲突列表请求失败: ${status}`);
    ids.push(...json.items.map((i) => i.id));
    cursor = json.next_cursor;
    if (!cursor) break;
  }
  return ids;
}

async function phase1() {
  console.log("== 阶段 1：制造序号缺口与并发改签 ==");
  await waitHealthy();

  // 正常进站：A、B
  let r = await post(ev({}));
  check(r.status === 200 && r.json.disposition === "applied", "rail-1 A 进站 applied", r);
  r = await post(
    ev({
      source_event_id: "rail-2",
      source_seq: 2,
      traveler_ref: "trv-b",
      occurred_at: "2026-09-09T20:05:00+08:00",
      seat: { car: "06", no: "02A" },
      from_station: "TJP",
      identity: { name: "Baatar", document_no: "P2002", nationality: "MN" },
    }),
  );
  check(r.status === 200 && r.json.disposition === "applied", "rail-2 B 进站 applied", r);

  // 跳过 rail-3 制造缺口；A 先改签一次
  r = await post(
    ev({
      source_event_id: "rail-4",
      source_seq: 4,
      kind: "rebooked",
      occurred_at: "2026-09-09T20:30:00+08:00",
      seat: { car: "05", no: "20C" },
      replaces_event_id: "rail-1",
    }),
  );
  check(r.status === 200 && r.json.disposition === "applied", "rail-4 A 改签 applied", r);

  // 并发改签：两个来源事件同时替换同一区间，必须恰好一个成功
  const rebook = (id, seq, seat) =>
    post(
      ev({
        source_event_id: id,
        source_seq: seq,
        kind: "rebooked",
        occurred_at: "2026-09-09T21:00:00+08:00",
        seat,
        replaces_event_id: "rail-4",
      }),
    );
  const [c1, c2] = await Promise.all([
    rebook("rail-5", 5, { car: "07", no: "08B" }),
    rebook("rail-6", 6, { car: "07", no: "09C" }),
  ]);
  const dispositions = [c1.json?.disposition, c2.json?.disposition].sort();
  check(
    dispositions.join(",") === "applied,conflict",
    "并发改签恰好一个 applied 一个 conflict",
    { c1: c1.json, c2: c2.json },
  );

  // A 在跨午夜窗口内确认离境（扎门乌德 21:30–02:30，按夹具时区 Asia/Ulaanbaatar）
  r = await post({
    source_event_id: "border-1",
    source: "border",
    source_seq: 1,
    traveler_ref: "trv-a",
    kind: "exit_confirmed",
    occurred_at: "2026-09-10T01:45:00+08:00",
    port: "ZMK",
  });
  check(r.status === 200 && r.json.disposition === "applied", "border-1 A 跨午夜窗口内离境 applied", r);

  // C 在窗口外（当地 03:10）离境：进入冲突，不改变现状
  r = await post({
    source_event_id: "border-2",
    source: "border",
    source_seq: 2,
    traveler_ref: "trv-c",
    kind: "exit_confirmed",
    occurred_at: "2026-09-10T03:10:00+08:00",
    port: "ZMK",
  });
  check(
    r.status === 200 && r.json.disposition === "conflict",
    "border-2 窗口外离境记录冲突",
    r,
  );

  // D 在二连浩特窗口内被拒绝通行
  r = await post({
    source_event_id: "border-3",
    source: "border",
    source_seq: 3,
    traveler_ref: "trv-d",
    kind: "passage_denied",
    occurred_at: "2026-09-10T08:00:00+08:00",
    port: "ERL",
  });
  check(r.status === 200 && r.json.disposition === "applied", "border-3 D 拒绝通行 applied", r);

  // 晚到的旧事件（occurred_at 早于已确认离境）：待人工处理，不得推翻离境
  r = await post(
    ev({
      source_event_id: "rail-7",
      source_seq: 7,
      occurred_at: "2026-09-09T19:30:00+08:00",
      seat: { car: "05", no: "33F" },
    }),
  );
  check(r.status === 200 && r.json.disposition === "manual", "rail-7 旧事件进入待人工处理", r);

  // source_event_id 重投只计一次（即使载荷不同）
  r = await post(ev({ occurred_at: "2026-09-09T23:59:00+08:00" }));
  check(r.status === 200 && r.json.disposition === "duplicate", "rail-1 重投判重", r);

  // 来源权限与契约校验
  r = await post({
    source_event_id: "border-bad-1",
    source: "border",
    source_seq: 90,
    traveler_ref: "trv-x",
    kind: "entered",
    occurred_at: "2026-09-09T20:00:00+08:00",
    train_no: "K27",
    seat: { car: "05", no: "01A" },
    from_station: "BJS",
    to_station: "ERL",
  });
  check(r.status === 422 && r.json.error.code === "source_kind_not_permitted", "border 无权上报 entered", r);
  r = await post(
    ev({ source_event_id: "rail-bad-2", source_seq: 91, kind: "exit_confirmed", port: "ERL" }),
  );
  check(r.status === 422 && r.json.error.code === "source_kind_not_permitted", "rail 无权上报 exit_confirmed", r);
  r = await post(ev({ source_event_id: "rail-bad-3", source_seq: 92, unexpected: 1 }));
  check(r.status === 400 && r.json.error.code === "contract_violation", "契约外字段被拒绝", r);
  r = await post(
    ev({ source_event_id: "rail-dup-seq", source_seq: 1, traveler_ref: "trv-z" }),
  );
  check(r.status === 409 && r.json.error.code === "seq_already_used", "同来源同序号不同事件被拒", r);
  r = await post(
    ev({ source_event_id: "rail-bad-4", source_seq: 93, train_no: "X999" }),
  );
  check(r.status === 422 && r.json.error.code === "unknown_train", "未知车次被拒", r);

  // 批量上限（rules.maximum_batch = 100）
  const oversize = Array.from({ length: 101 }, (_, i) =>
    ev({ source_event_id: `rail-bulk-${i}`, source_seq: 1000 + i }),
  );
  r = await api("POST", "/events/batch", { body: oversize });
  check(r.status === 400 && r.json.error.code === "batch_too_large", "批量超限被拒", r);

  // 来源水位：rail 缺 3，border 连续
  const wm = await getWatermarks();
  check(
    wm.rail?.watermark === 2 && wm.rail?.max_seq === 7 && JSON.stringify(wm.rail?.missing) === "[3]",
    "rail 水位=2 缺口=[3]",
    wm.rail,
  );
  check(
    wm.border?.watermark === 3 && wm.border?.missing?.length === 0,
    "border 水位=3 无缺口",
    wm.border,
  );

  // 列车差异表：缺口可见，暂无重复占用
  r = await api("GET", "/reports/train-differences?train_no=K27", { role: "operator" });
  check(
    r.json.source_gaps.some((g) => g.source === "rail" && JSON.stringify(g.missing) === "[3]"),
    "差异表指出 rail 缺序号 3",
    r.json.source_gaps,
  );
  check(r.json.seat_interval_conflicts.length === 0, "差异表暂无重复占用", r.json);

  // 时间线与角色字段过滤
  r = await api("GET", "/travelers/trv-a/timeline", { role: "operator" });
  check(
    r.json.journey.status === "exited" && r.json.journey.held_segments.length === 0,
    "A 行程保持已离境（旧事件未推翻）",
    r.json.journey,
  );
  check(
    r.json.identity.name === "An Wei" && !("document_no" in r.json.identity),
    "operator 只见姓名不见证件号",
    r.json.identity,
  );
  check(
    r.json.events.find((e) => e.source_event_id === "rail-7")?.disposition === "manual",
    "时间线中 rail-7 标记 manual",
  );
  r = await api("GET", "/travelers/trv-a/timeline", { role: "border" });
  check(r.json.identity.document_no === "P1001", "border 可见证件号", r.json.identity);
  r = await api("GET", "/travelers/trv-a/timeline", { role: "auditor" });
  check(Object.keys(r.json.identity).length === 0, "auditor 不见身份字段", r.json.identity);
  r = await api("GET", "/travelers/trv-a/timeline");
  check(r.status === 401, "缺角色头被拒", r);

  // 冲突队列游标分页：3 条，两页取全
  const ids = await collectAllConflicts(2);
  check(ids.length === 3 && new Set(ids).size === 3, "冲突 3 条且游标翻页无重叠", ids);
  r = await api("GET", "/conflicts?reason=stale_event_after_terminal", { role: "operator" });
  check(
    r.json.items.length === 1 && r.json.items[0].needs_manual === true,
    "stale 冲突标记待人工处理",
    r.json.items,
  );
  r = await api("GET", "/conflicts?cursor=%%%", { role: "operator" });
  check(r.status === 400, "坏游标被拒", r);
}

async function phase2() {
  console.log("== 阶段 2：数据库重启后核对，再补回晚到事件 ==");
  await waitHealthy();

  // 重启后水位与冲突仍在
  const wm = await getWatermarks();
  check(
    wm.rail?.watermark === 2 && JSON.stringify(wm.rail?.missing) === "[3]",
    "重启后 rail 水位与缺口保持",
    wm.rail,
  );
  const idsBefore = await collectAllConflicts(2);
  check(idsBefore.length === 3, "重启后冲突 3 条且游标结果一致", idsBefore);

  // 补回晚到的 rail-3：C 进站，与 B 座位区间重叠
  let r = await post(
    ev({
      source_event_id: "rail-3",
      source_seq: 3,
      traveler_ref: "trv-c",
      occurred_at: "2026-09-09T20:10:00+08:00",
      seat: { car: "06", no: "02A" },
      from_station: "SHE",
      identity: { name: "Chen Li", document_no: "P3003", nationality: "CN" },
    }),
  );
  check(
    r.status === 200 && r.json.disposition === "applied" && r.json.conflict_ids.length === 1,
    "rail-3 补报 applied 并检出重叠冲突",
    r,
  );

  const wm2 = await getWatermarks();
  check(
    wm2.rail?.watermark === 7 && wm2.rail?.missing?.length === 0,
    "补报后 rail 水位=7 缺口闭合",
    wm2.rail,
  );

  // 差异表：06车02A 被 B、C 重复占用
  r = await api("GET", "/reports/train-differences?train_no=K27", { role: "border" });
  const dup = r.json.seat_interval_conflicts.find((s) => s.car === "06" && s.seat_no === "02A");
  check(
    dup && dup.holders.map((h) => h.traveler_ref).sort().join(",") === "trv-b,trv-c",
    "差异表指出 06车02A 被 trv-b/trv-c 重复占用",
    r.json.seat_interval_conflicts,
  );
  check(
    dup && dup.holders.every((h) => h.identity.document_no),
    "差异表中 border 角色可见证件号",
    dup,
  );
  check(r.json.source_gaps.length === 0, "差异表无来源缺口", r.json.source_gaps);

  // 冲突总数变为 4，游标翻页取全
  const ids = await collectAllConflicts(3);
  check(ids.length === 4 && new Set(ids).size === 4, "补报后冲突 4 条游标取全", ids);

  // 人工处理冲突：auditor 无权，operator 可处理，重复处理 409
  r = await api("POST", `/conflicts/${ids[0]}/resolve`, { role: "auditor", body: { resolution: "x" } });
  check(r.status === 403, "auditor 无权处理冲突", r);
  r = await api("POST", `/conflicts/${ids[0]}/resolve`, {
    role: "operator",
    body: { resolution: "已与车站电话确认" },
  });
  check(r.status === 200 && r.json.status === "resolved", "operator 处理冲突成功", r);
  r = await api("POST", `/conflicts/${ids[0]}/resolve`, {
    role: "operator",
    body: { resolution: "重复操作" },
  });
  check(r.status === 409, "重复处理返回 409", r);
  r = await api("GET", "/conflicts?status=pending", { role: "operator" });
  check(r.json.items.length === 3, "待处理冲突剩 3 条", r.json.items.length);

  // 批量补报：E 进站 + 离境
  r = await api("POST", "/events/batch", {
    body: [
      ev({
        source_event_id: "rail-8",
        source_seq: 8,
        traveler_ref: "trv-e",
        occurred_at: "2026-09-09T20:20:00+08:00",
        seat: { car: "05", no: "30D" },
        from_station: "BJS",
        to_station: "TJP",
      }),
      {
        source_event_id: "border-4",
        source: "border",
        source_seq: 4,
        traveler_ref: "trv-e",
        kind: "exit_confirmed",
        occurred_at: "2026-09-10T10:00:00+08:00",
        port: "ERL",
      },
    ],
  });
  check(
    r.status === 200 && r.json.results.every((x) => x.ok && x.disposition === "applied"),
    "批量补报 E 进站+离境 applied",
    r.json,
  );
  r = await api("GET", "/travelers/trv-e/timeline", { role: "operator" });
  check(r.json.journey.status === "exited", "E 行程已离境", r.json.journey);

  // 重启后重投仍然幂等
  r = await post(
    ev({
      source_event_id: "rail-3",
      source_seq: 3,
      traveler_ref: "trv-c",
      occurred_at: "2026-09-09T20:10:00+08:00",
      seat: { car: "06", no: "02A" },
      from_station: "SHE",
    }),
  );
  check(r.status === 200 && r.json.disposition === "duplicate", "重启后 rail-3 重投判重", r);

  const wm3 = await getWatermarks();
  check(
    wm3.rail?.watermark === 8 && wm3.border?.watermark === 4 &&
      wm3.rail?.missing?.length === 0 && wm3.border?.missing?.length === 0,
    "最终水位 rail=8 border=4 均无缺口",
    wm3,
  );
}

if (PHASE === "1" || PHASE === "all") await phase1();
if (PHASE === "2" || PHASE === "all") await phase2();

if (failures > 0) {
  console.error(`\n${failures} 项核对失败`);
  process.exit(1);
}
console.log("\n全部核对通过");
