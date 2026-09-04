import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { decisionStatusSchema } from "@/lib/validators";

type RouteCtx = { params: Promise<{ id: string }> };

export const POST = withRoute<RouteCtx>(async (req, ctx, routeCtx) => {
  const { id } = await routeCtx.params;
  const decision = await prisma.decision.findFirst({ where: { id, storeId: ctx.storeId } });
  if (!decision) return jsonError("القرار غير موجود", 404);

  const body = await req.json().catch(() => null);
  const parsed = decisionStatusSchema.safeParse(body);
  if (!parsed.success) return jsonError("حالة غير صالحة", 422, parsed.error.flatten());

  const updated = await prisma.decision.update({
    where: { id: decision.id },
    data: { status: parsed.data.status },
  });

  return NextResponse.json({ decision: updated });
});
