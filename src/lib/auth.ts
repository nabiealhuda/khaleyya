import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { prisma } from "./db";
import { env } from "./env";
import { logger } from "./logger";

const COOKIE_NAME = "khaleyya_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const secretKey = new TextEncoder().encode(env.SESSION_SECRET);

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

type SessionPayload = {
  sid: string; // Session row id — lets us revoke server-side
  uid: string;
  storeId: string;
};

/**
 * Creates a DB-backed session row plus a signed, httpOnly JWT cookie that
 * references it. The JWT alone proves who signed it; the DB row is what lets
 * us revoke a session (logout, password change, suspicious activity) before
 * its natural expiry — a plain stateless JWT can't do that.
 */
export async function createSession(userId: string, storeId: string) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const session = await prisma.session.create({
    data: { userId, storeId, expiresAt },
  });

  const token = await new SignJWT({
    sid: session.id,
    uid: userId,
    storeId,
  } satisfies SessionPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secretKey);

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });

  return session;
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  store.delete(COOKIE_NAME);
  if (!token) return;
  try {
    const { payload } = await jwtVerify(token, secretKey);
    const sid = (payload as SessionPayload).sid;
    if (sid) {
      await prisma.session.update({
        where: { id: sid },
        data: { revokedAt: new Date() },
      });
    }
  } catch {
    // Token already invalid — nothing to revoke.
  }
}

export type AuthContext = {
  userId: string;
  storeId: string;
  userName: string;
  userEmail: string;
};

/**
 * Resolves the current request's session, checking both JWT validity and
 * the backing DB row (not revoked, not expired). Returns null rather than
 * throwing so callers can decide how to respond (redirect vs. 401 JSON).
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  let payload: SessionPayload;
  try {
    const verified = await jwtVerify(token, secretKey);
    payload = verified.payload as unknown as SessionPayload;
  } catch {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { id: payload.sid },
    include: { user: true },
  });

  if (
    !session ||
    session.revokedAt ||
    session.expiresAt.getTime() < Date.now()
  ) {
    return null;
  }

  return {
    userId: session.userId,
    storeId: session.storeId,
    userName: session.user.name,
    userEmail: session.user.email,
  };
}

export async function requireAuth(): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) {
    logger.warn("unauthorized request rejected");
    throw new AuthError();
  }
  return ctx;
}

export class AuthError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "AuthError";
  }
}
