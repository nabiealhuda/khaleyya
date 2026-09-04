import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { createTaskSchema } from "@/lib/validators";

export const POST = withRoute(async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = createTaskSchema.safeParse(body);
  if (!parsed.success) return jsonError("بيانات المهمة غير صالحة", 422, parsed.error.flatten());

  const cell = await prisma.cell.findFirst({
    where: { id: parsed.data.cellId, storeId: ctx.storeId },
  });
  if (!cell) return jsonError("الخلية المحددة غير موجودة", 404);

  const task = await prisma.cellTask.create({
    data: {
      storeId: ctx.storeId,
      cellId: cell.id,
      title: parsed.data.title,
      freq: parsed.data.freq,
      source: "merchant",
    },
  });

  return NextResponse.json({ task }, { status: 201 });
});
