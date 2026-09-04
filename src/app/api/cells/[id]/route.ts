import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { updateCellSchema } from "@/lib/validators";

type RouteCtx = { params: Promise<{ id: string }> };

export const PATCH = withRoute<RouteCtx>(async (req, ctx, routeCtx) => {
  const { id } = await routeCtx.params;
  const cell = await prisma.cell.findFirst({ where: { id, storeId: ctx.storeId } });
  if (!cell) return jsonError("الخلية غير موجودة", 404);
  if (!cell.isCustom) return jsonError("هذه الخلية ثابتة ولا يمكن تعديلها", 403);

  const body = await req.json().catch(() => null);
  const parsed = updateCellSchema.safeParse(body);
  if (!parsed.success) return jsonError("بيانات غير صالحة", 422, parsed.error.flatten());

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = `خلية ${parsed.data.name}`;
  if (parsed.data.tagline !== undefined) data.tagline = parsed.data.tagline || cell.tagline;
  if (parsed.data.color !== undefined) data.color = parsed.data.color;
  if (parsed.data.icon !== undefined) data.icon = parsed.data.icon;

  const updated = await prisma.cell.update({ where: { id: cell.id }, data });
  return NextResponse.json({ cell: updated });
});

export const DELETE = withRoute<RouteCtx>(async (_req, ctx, routeCtx) => {
  const { id } = await routeCtx.params;
  const cell = await prisma.cell.findFirst({ where: { id, storeId: ctx.storeId } });
  if (!cell) return jsonError("الخلية غير موجودة", 404);
  if (!cell.isCustom) return jsonError("هذه الخلية ثابتة ولا يمكن حذفها", 403);

  // onDelete: Cascade on Cell's relations (tasks, activity, decisions,
  // automations) means this one call cleans up everything referencing it.
  await prisma.cell.delete({ where: { id: cell.id } });
  return NextResponse.json({ ok: true });
});
