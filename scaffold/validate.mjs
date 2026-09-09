import { readFileSync } from "node:fs";
const 读取 = (路径) => JSON.parse(readFileSync(`/workspace/${路径}`, "utf8"));
const 契约 = 读取("contracts/request.schema.json");
const 样例 = 读取("fixtures/sample-requests.json");
const 规则 = 读取("fixtures/rules.json");
if (契约.type !== "object" || !Array.isArray(样例) || !样例.length || !规则.version) throw new Error("领域输入无效");
console.log("领域输入校验通过");
