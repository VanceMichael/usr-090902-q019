export interface AppConfig {
  port: number;
  databaseUrl: string;
  fixturesDir: string;
  contractsDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL ?? "postgres://reconcile:reconcile@127.0.0.1:5432/reconcile";
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT 无效: ${env.PORT}`);
  return {
    port,
    databaseUrl,
    fixturesDir: env.FIXTURES_DIR ?? "fixtures",
    contractsDir: env.CONTRACTS_DIR ?? "contracts",
  };
}
