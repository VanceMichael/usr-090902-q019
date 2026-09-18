import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface TrainRouteStop {
  station: string;
  name: string;
}

export interface Train {
  trainNo: string;
  route: TrainRouteStop[];
  cars: { car: string; capacity: number }[];
}

export interface PortWindow {
  open: string; // "HH:MM" 口岸当地时间
  close: string; // open > close 表示跨午夜窗口
}

export interface Port {
  code: string;
  name: string;
  timezone: string; // IANA 时区，窗口判断以此为准
  windows: PortWindow[];
}

export interface Permissions {
  sources: Record<string, { kinds: string[] }>;
  roles: Record<string, { identity_fields: string[] }>;
}

export interface Rules {
  version: string;
  events: string[];
  roles: string[];
  maximum_batch: number;
}

export interface DomainData {
  rules: Rules;
  trains: Map<string, Train>;
  ports: Map<string, Port>;
  permissions: Permissions;
  requestSchema: Record<string, unknown>;
}

function readJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

export function loadDomain(fixturesDir: string, contractsDir: string): DomainData {
  const rulesRaw = readJson(fixturesDir, "rules.json") as {
    version: string;
    events: string[];
    roles: string[];
    maximum_batch: number;
  };
  const trainsRaw = readJson(fixturesDir, "trains.json") as {
    trains: { train_no: string; route: TrainRouteStop[]; cars: { car: string; capacity: number }[] }[];
  };
  const portsRaw = readJson(fixturesDir, "ports.json") as {
    ports: { code: string; name: string; timezone: string; windows: PortWindow[] }[];
  };
  const permissions = readJson(fixturesDir, "permissions.json") as Permissions;
  const requestSchema = readJson(contractsDir, "request.schema.json") as Record<string, unknown>;

  const rules: Rules = {
    version: rulesRaw.version,
    events: rulesRaw.events,
    roles: rulesRaw.roles,
    maximum_batch: rulesRaw.maximum_batch,
  };

  const trains = new Map<string, Train>();
  for (const t of trainsRaw.trains) {
    if (!t.train_no || t.route.length < 2) throw new Error(`车次路线无效: ${t.train_no}`);
    trains.set(t.train_no, { trainNo: t.train_no, route: t.route, cars: t.cars });
  }

  const ports = new Map<string, Port>();
  for (const p of portsRaw.ports) {
    // 启动即校验时区可用，避免运行期静默误判窗口
    new Intl.DateTimeFormat("en-US", { timeZone: p.timezone });
    ports.set(p.code, { code: p.code, name: p.name, timezone: p.timezone, windows: p.windows });
  }

  for (const role of rules.roles) {
    if (!permissions.roles[role]) throw new Error(`角色缺少字段权限: ${role}`);
  }
  for (const [source, cfg] of Object.entries(permissions.sources)) {
    for (const kind of cfg.kinds) {
      if (!rules.events.includes(kind)) throw new Error(`来源 ${source} 配置了未知事件类型: ${kind}`);
    }
  }

  return { rules, trains, ports, permissions, requestSchema };
}
