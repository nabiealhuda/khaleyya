import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

/**
 * /dashboard.html lives under /public, which Next.js serves as a static
 * file with no server-side logic of its own — so without this middleware,
 * anyone could open it directly with no login at all. Middleware runs
 * before static file serving for matched paths, so this is the only place
 * that can gate it.
 *
 * This is a lightweight, Edge-compatible check (valid signature + not
 * expired) — it does NOT hit the database to confirm the session hasn't
 * been revoked. That fuller check happens in getAuthContext()/requireAuth()
 * on every actual API call the dashboard makes, which is where real data
 * access is gated. A user who fails only the DB-side check (e.g. just
 * logged out) sees /api/state return 401 and the page redirects itself.
 */
const COOKIE_NAME = "khaleyya_session";

export async function proxy(req: NextRequest) {
  const token = req.cookies.get(COOKIE_NAME)?.value;

  if (!token) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  try {
    const secretKey = new TextEncoder().encode(process.env.SESSION_SECRET ?? "");
    await jwtVerify(token, secretKey);
    return NextResponse.next();
  } catch {
    return NextResponse.redirect(new URL("/login", req.url));
  }
}

export const config = {
  matcher: ["/dashboard.html"],
};
