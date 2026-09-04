import pino from "pino";

/**
 * Structured JSON logging in production (Railway ingests stdout as logs —
 * JSON lines are far more useful there than free text), pretty-printed in
 * development for readability.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true } },
  base: { service: "khaleyya-app" },
  redact: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.passwordHash"],
});
