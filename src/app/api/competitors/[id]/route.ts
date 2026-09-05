import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";

type RouteCtx = { params: Promise<{ id: string }> };

export const DELETE = withRoute<RouteCtx>(async (_req, ctx, routeCtx) => {
  const { id } = await routeCtx.params;
  const existing = await prisma.competitorEntry.findFirst({ where: { id, storeId: ctx.storeId } });
  if (!existing) return jsonError("لم يُعثر على هذا المنافس", 404);

  await prisma.competitorEntry.delete({ where: { id } });
  return NextResponse.json({ ok: true });
});
