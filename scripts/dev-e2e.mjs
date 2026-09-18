#!/usr/bin/env node
/**
 * 无 docker 环境下的本地端到端核对：
 * 使用 embedded-postgres（真实 PostgreSQL 二进制，持久化数据目录）
 * 模拟 compose 中的 db，并真实重启数据库进程验证持久化。
 *
 *   node scripts/dev-e2e.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import EmbeddedPostgres from "embedded-postgres";

const PG_PORT = 15432;
const APP_PORT = 18080;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DB_DIR = "data/dev-e2e-pg";

rmSync(DB_DIR, { recursive: true, force: true });
mkdirSync(DB_DIR, { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir: DB_DIR,
  user: "reconcile",
  password: "reconcile",
  port: PG_PORT,
  persistent: true,
  // 沙箱镜像只有 C/C.utf8 locale，覆盖库默认的 en_US.UTF-8
  initdbFlags: ["--lc-messages=C"],
});

console.log("== 初始化本地 PostgreSQL ==");
await pg.initialise();
await pg.start();

const env = {
  ...process.env,
  DATABASE_URL: `postgres://reconcile:reconcile@127.0.0.1:${PG_PORT}/postgres`,
  PORT: String(APP_PORT),
};
const app = spawn(process.execPath, ["dist/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
app.stderr.on("data", (d) => process.stderr.write(`[app] ${d}`));
app.stdout.on("data", (d) => process.stdout.write(`[app] ${d}`));

async function runPhase(phase) {
  const child = spawn(process.execPath, ["scripts/e2e.mjs", `--phase=${phase}`, `--base=${BASE}`], {
    stdio: "inherit",
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 0) throw new Error(`阶段 ${phase} 失败 (exit=${code})`);
}

async function waitHealthz() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      /* 重试 */
    }
    if (Date.now() > deadline) throw new Error("等待 app 健康超时");
    await delay(500);
  }
}

try {
  await waitHealthz();
  await runPhase(1);

  console.log("== 重启数据库进程（数据目录保留） ==");
  await pg.stop();
  await pg.start();
  await waitHealthz();

  await runPhase(2);
  console.log("== 本地端到端核对全部通过 ==");
} finally {
  app.kill("SIGTERM");
  await pg.stop().catch(() => undefined);
}
