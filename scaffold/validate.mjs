import { readFileSync } from "node:fs";
const 读取 = (路径) => JSON.parse(readFileSync(`/workspace/${路径}`, "utf8"));
const 契约 = 读取("contracts/request.schema.json");
const 样例 = 读取("fixtures/sample-requests.json");
const 规则 = 读取("fixtures/rules.json");
const 车次 = 读取("fixtures/trains.json");
const 口岸 = 读取("fixtures/ports.json");
const 权限 = 读取("fixtures/permissions.json");
if (契约.type !== "object" || !Array.isArray(样例) || !样例.length || !规则.version) throw new Error("领域输入无效");
const 必需 = 契约.required ?? [];
for (const 事件 of 样例) {
  for (const 字段 of 必需) if (!(字段 in 事件)) throw new Error(`样例缺少必需字段: ${字段}`);
  if (!规则.events.includes(事件.kind)) throw new Error(`样例事件类型不在规则内: ${事件.kind}`);
  if (!权限.sources[事件.source]?.kinds.includes(事件.kind)) throw new Error(`来源无权上报: ${事件.source}/${事件.kind}`);
}
for (const 车 of 车次.trains) {
  if (!车.train_no || !Array.isArray(车.route) || 车.route.length < 2) throw new Error(`车次路线无效: ${车.train_no}`);
}
for (const 口 of 口岸.ports) {
  if (!口.code || !口.timezone || !Array.isArray(口.windows) || !口.windows.length) throw new Error(`口岸窗口无效: ${口.code}`);
  try { new Intl.DateTimeFormat("en-US", { timeZone: 口.timezone }); } catch { throw new Error(`口岸时区无效: ${口.code}`); }
}
for (const 角色 of 规则.roles) {
  if (!权限.roles[角色]) throw new Error(`角色缺少字段权限: ${角色}`);
}
console.log("领域输入校验通过");
