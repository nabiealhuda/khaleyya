import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { createSession, verifyPassword } from "@/lib/auth";
import { loginSchema } from "@/lib/validators";
import { jsonError } from "@/lib/api";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * Login is intentionally NOT wrapped in withRoute (that wrapper requires an
 * existing session). It gets its own, stricter rate limit — brute-forcing a
 * password is exactly the attack this endpoint must resist.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const rl = rateLimit(`login:${ip}`, { limit: 10, windowMs: 60_000 });
  if (!rl.allowed) {
    return jsonError("محاولات كثيرة جداً، حاول مرة أخرى بعد قليل", 429);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("طلب غير صالح", 400);
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError("البريد الإلكتروني أو كلمة المرور غير صحيحة", 422);
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });

  // Constant-shape response whether the email exists or not, so the endpoint
  // doesn't leak which emails are registered.
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    logger.warn({ email }, "failed login attempt");
    return jsonError("البريد الإلكتروني أو كلمة المرور غير صحيحة", 401);
  }

  await createSession(user.id, user.storeId);

  const store = await prisma.store.findUnique({ where: { id: user.storeId } });

  return NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email },
    store: { id: user.storeId, name: store?.name ?? "" },
  });
}
