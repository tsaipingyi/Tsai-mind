export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  tzName: string;
  publicUrl: string;
  accountEmail: string;
  accountName: string;
  corsOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://localhost:5432/tsaimind',
    port,
    host: env.HOST ?? '127.0.0.1',
    tzName: env.TZ_NAME ?? 'Asia/Taipei',
    publicUrl: env.PUBLIC_URL ?? `http://localhost:${port}`,
    accountEmail: env.ACCOUNT_EMAIL ?? 'owner@tsaimind.local',
    accountName: env.ACCOUNT_NAME ?? '蔡',
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
