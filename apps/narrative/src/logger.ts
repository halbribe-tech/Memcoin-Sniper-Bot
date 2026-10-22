import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const isDev = (process.env.NODE_ENV ?? "development") !== "production";

export const logger = pino({
  level,
  base: { app: "narrative" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ["*.NARRATIVE_LLM_API_KEY", "*.NARRATIVE_METAS_URL_TOKEN", "headers.authorization"], censor: "[REDACTED]" },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname,app" },
        },
      }
    : {}),
});

export const childLogger = (component: string) => logger.child({ component });
