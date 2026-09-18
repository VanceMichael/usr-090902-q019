import { loadConfig } from "./config.js";
import { loadDomain } from "./domain.js";
import { createPool, migrate } from "./db.js";
import { createApp } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const domain = loadDomain(config.fixturesDir, config.contractsDir);
  const db = createPool(config.databaseUrl);

  // 等待数据库就绪（compose 健康检查之外再兜一层）
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await migrate(db);
      break;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const app = createApp({ db, domain });
  app.listen(config.port, () => {
    console.log(`对账服务已启动: port=${config.port} rules=${domain.rules.version}`);
  });

  const shutdown = () => {
    app.close(() => {
      void db.end().then(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
