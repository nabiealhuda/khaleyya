import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { refreshQualityInsight } from "@/lib/cell-insight";

/**
 * Recomputes the "جودة القرار والأثر" cell's insight from this store's real
 * Decision/Automation history (see src/lib/cell-insight.ts) — no external
 * integration needed, since the data already lives in our own DB.
 */
export const POST = withRoute(
  async (_req, ctx) => {
    const result = await refreshQualityInsight(ctx.storeId);
    if (!result.ok) return jsonError(result.message, 422);
    return NextResponse.json({ ok: true });
  },
  { rateLimit: { limit: 10, windowMs: 60_000 } }
);
