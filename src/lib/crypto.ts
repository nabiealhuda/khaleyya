import crypto from "node:crypto";
import { env } from "./env";

/**
 * At-rest encryption for integration credentials (Odoo API keys, and any
 * future provider's secrets) stored in IntegrationConnection.config. That
 * column is a plain Json field — never store secrets there in plaintext.
 *
 * Deliberately reuses SESSION_SECRET (already required in production, see
 * env.ts) instead of introducing a brand-new required env var: one fewer
 * thing to configure on Railway, and SESSION_SECRET is already a
 * high-entropy 32+ char secret unique per deployment. scryptSync derives an
 * independent 32-byte key from it so this encryption key is not literally
 * the session-signing secret.
 */
const ALGORITHM = "aes-256-gcm";
const KEY_INFO = "khaleyya-integration-config-v1";

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (!cachedKey) {
    cachedKey = crypto.scryptSync(env.SESSION_SECRET, KEY_INFO, 32);
  }
  return cachedKey;
}

export type EncryptedConfig = { enc: string };

export function encryptJson(value: Record<string, unknown>): EncryptedConfig {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? {}), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Pack iv + authTag + ciphertext into one base64 blob so the Json column
  // only ever needs to hold a single opaque string.
  return { enc: Buffer.concat([iv, authTag, ciphertext]).toString("base64") };
}

/** Returns {} for anything that isn't a validly-shaped encrypted blob (e.g. an empty/disconnected config) rather than throwing, since callers treat "no config" as a normal state. */
export function decryptJson(stored: unknown): Record<string, unknown> {
  if (!stored || typeof stored !== "object") return {};
  const enc = (stored as { enc?: unknown }).enc;
  if (typeof enc !== "string" || !enc) return {};
  try {
    const raw = Buffer.from(enc, "base64");
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    // Corrupt blob or wrong key (e.g. SESSION_SECRET rotated) — treat as no
    // usable config rather than crashing the request.
    return {};
  }
}
