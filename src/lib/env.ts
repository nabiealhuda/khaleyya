import { z } from "zod";

/**
 * Fail-fast environment validation. Importing this module anywhere throws
 * immediately (at boot) if a required variable is missing or malformed,
 * instead of surfacing a confusing runtime error later inside a request.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  // Railway injects PORT; Next's own start script reads it directly, but we
  // validate it here too so a missing/invalid PORT fails loudly in prod.
  PORT: z.string().optional(),
  // Power the real AI features (src/lib/ai.ts — leader chat, meeting room,
  // council decision study, AI-written cell insights). Both deliberately
  // optional rather than required: the app must still boot and serve
  // everything else if neither has been set on Railway yet. src/lib/ai.ts
  // prefers OPENAI_API_KEY when both are present (this store's merchant is
  // subscribed to OpenAI, not Anthropic) and falls back to ANTHROPIC_API_KEY.
  // Callers check for absence of both themselves and return a friendly
  // Arabic "AI not configured" error instead of crashing.
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `- ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`Invalid environment configuration:\n${issues}`);
    throw new Error("Invalid environment configuration. See logs above.");
  }
  return parsed.data;
}

export const env = loadEnv();
