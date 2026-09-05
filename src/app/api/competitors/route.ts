import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { createCompetitorEntrySchema } from "@/lib/validators";

/**
 * The merchant's own list of competitor products/stores to track for the
 * "رصد وتحليل السوق" cell (see /api/competitors/refresh for the fetch/search
 * step, and /api/competitors/[id] for deletion). Listing and creating are
 * plain CRUD against CompetitorEntry — no external call happens here.
 */
export const GET = withRoute(async (_req, ctx) => {
  const entries = await prisma.competitorEntry.findMany({
    where: { storeId: ctx.storeId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ entries });
});

export const POST = withRoute(
  async (req, ctx) => {
    const body = await req.json().catch(() => null);
    const parsed = createCompetitorEntrySchema.safeParse(body);
    if (!parsed.success) return jsonError("بيانات غير صالحة", 422, parsed.error.flatten());

    const count = await prisma.competitorEntry.count({ where: { storeId: ctx.storeId } });
    if (count >= 30) {
      return jsonError("وصلت إلى الحد الأقصى (30) من المنافسين المتابَعين — احذف بعضها لإضافة جديد.", 422);
    }

    const entry = await prisma.competitorEntry.create({
      data: { storeId: ctx.storeId, label: parsed.data.label, url: parsed.data.url },
    });
    return NextResponse.json({ entry });
  },
  { rateLimit: { limit: 20, windowMs: 60_000 } }
);
