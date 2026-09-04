import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthContext, AuthError, requireAuth } from "./auth";
import { clientIp, rateLimit } from "./rate-limit";
import { logger } from "./logger";

export function jsonError(message: string, status: number, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status });
}

/**
 * Wraps a route handler with: auth enforcement, per-IP rate limiting, and a
 * single place that turns thrown errors (auth, validation, unexpected) into
 * consistent JSON responses instead of leaking stack traces to clients.
 */
export function withRoute<RouteCtx = unknown>(
  handler: (req: Request, ctx: AuthContext, routeCtx: RouteCtx) => Promise<NextResponse>,
  opts: { rateLimit?: { limit: number; windowMs: number } } = {}
) {
  return async (req: Request, routeCtx: RouteCtx) => {
    const limitConfig = opts.rateLimit ?? { limit: 60, windowMs: 60_000 };
    const ip = clientIp(req);
    const rl = rateLimit(`${req.method}:${new URL(req.url).pathname}:${ip}`, limitConfig);
    if (!rl.allowed) {
      return jsonError("Too many requests", 429);
    }

    try {
      const authCtx = await requireAuth();
      return await handler(req, authCtx, routeCtx);
    } catch (err) {
      if (err instanceof AuthError) {
        return jsonError("Unauthorized", 401);
      }
      if (err instanceof ZodError) {
        return jsonError("Invalid request body", 422, err.flatten());
      }
      logger.error({ err }, "unhandled route error");
      return jsonError("Internal server error", 500);
    }
  };
}
