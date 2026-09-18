# 国际列车旅客事件对账

铁路与口岸多来源旅客事件及座位段对账服务。网络恢复后各来源集中补报，值班员需要回答两件事：**哪一来源缺了哪一个序号**、**哪些座位区间被重复占用**。本服务摄取补报事件，维护来源连续水位、旅客当前行程与冲突队列，并提供对账接口。

纯后台服务：Node.js 22 + TypeScript + PostgreSQL，不依赖铁路或边检任何外部接口，全部规则来自仓库内契约与夹具。

## 目录

- `contracts/`：HTTP 请求结构约束（`request.schema.json`，运行时按此校验）。
- `fixtures/`：`rules.json`（事件类型/角色/批量上限）、`trains.json`（车次径路与车厢）、`ports.json`（口岸时区与通行窗口，支持跨午夜）、`permissions.json`（来源可报事件类型、角色可读身份字段）。
- `src/`：对账服务源码。
- `scripts/`：`e2e.sh`（compose 一键端到端）、`e2e.mjs`（HTTP 核对）、`dev-e2e.mjs`（无 docker 本地核对）。
- `scaffold/`：领域输入完整性检查。
- `compose.yaml`：db（健康检查 + 持久卷）与 app。

## 对账语义

- **幂等**：`source_event_id` 重投只计一次（唯一约束，重投放回 `duplicate`）；同一 `(source, source_seq)` 不得被两个事件占用（409）。
- **来源水位**：每个来源维护连续水位，缺口持续保留到补报到达；`GET /sources/watermarks` 返回 `watermark / max_seq / missing[]`。
- **旧事件不污染现状**：`occurred_at` 早于行程最后已应用事件（含已确认离境）时，事件进入待人工处理冲突（`stale_event_*`），行程保持不变。
- **改签守恒**：`rebooked` 必须携带 `replaces_event_id`，在同一事务里恰好释放被替换区间并占用新区间；目标区间不在持有态（如并发改签竞争失败）即记 `rebook_conservation_violation`，不产生任何状态变更。
- **口岸窗口**：`exit_confirmed` / `passage_denied` 按 `fixtures/ports.json` 的口岸时区解释窗口；`open > close` 表示跨午夜窗口（如扎门乌德 21:30–02:30）。窗口外事件记 `outside_port_window` 冲突，不改变行程。
- **同事务写入**：原始事件、来源水位、当前行程、冲突原因在同一个 PostgreSQL 事务中提交。
- **角色字段**：`operator` 只见姓名，`border` 可见姓名/证件号/国籍，`auditor` 不见身份字段；读取接口一律要求 `X-Role` 头，冲突处理仅 `operator`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/events` | 摄取单个事件，返回 `applied / duplicate / conflict / manual` |
| POST | `/events/batch` | 批量摄取（上限 `rules.maximum_batch`，每条独立事务） |
| GET | `/sources/watermarks` | 各来源连续水位与缺口序号 |
| GET | `/reports/train-differences?train_no=K27` | 列车差异表：重复占用座位区间 + 来源缺口 |
| GET | `/travelers/{ref}/timeline` | 旅客行程时间线（当前状态 + 事件流水 + 关联冲突） |
| GET | `/conflicts?status=&reason=&train_no=&limit=&cursor=` | 冲突队列，游标分页（`next_cursor` 续页） |
| POST | `/conflicts/{id}/resolve` | 人工处理冲突（仅 operator） |
| GET | `/healthz` | 健康检查（含数据库连通） |

## 运行

```sh
# 本地检查（只读仓库文件）
docker compose run --rm --no-deps domain-check

# 启动服务（postgres 健康检查 + 持久卷 pgdata）
docker compose up -d --build db app

# 一键端到端：从空库制造序号缺口与并发改签，
# 重启数据库后补回晚到事件，核对水位、冲突与游标
sh scripts/e2e.sh

# 无 docker 的本地核对（embedded PostgreSQL，同样覆盖重启）
npm install && npm run build && npm run e2e:local
```

## 开发

```sh
npm install
npm run build        # tsc -> dist/
npm start            # DATABASE_URL=... PORT=8080
```
