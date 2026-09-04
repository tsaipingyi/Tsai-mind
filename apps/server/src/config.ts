export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  tzName: string;
  publicUrl: string;
  accountEmail: string;
  accountName: string;
  corsOrigins: string[];
  /** Optional Expo push access token (Expo dashboard → Access tokens); pushes work without it. */
  expoAccessToken: string | undefined;
  /** Set to false to disable the 09:00 / Monday 08:00 scheduler (tests). */
  scheduler: boolean;
  /** Claude API key for the in-app assistant and the weekly digest; unset = assistant disabled. */
  anthropicApiKey: string | undefined;
  /** Model used by the assistant and the digest. */
  assistantModel: string;
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
    expoAccessToken: env.EXPO_ACCESS_TOKEN || undefined,
    scheduler: env.SCHEDULER !== 'off',
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    assistantModel: env.ASSISTANT_MODEL || 'claude-opus-5',
  };
}
