import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { createCellSchema } from "@/lib/validators";

export const POST = withRoute(async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = createCellSchema.safeParse(body);
  if (!parsed.success) return jsonError("بيانات الخلية غير صالحة", 422, parsed.error.flatten());

  const { name, tagline, color, icon } = parsed.data;
  const displayName = `خلية ${name}`;
  const slug = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const count = await prisma.cell.count({ where: { storeId: ctx.storeId } });

  const cell = await prisma.cell.create({
    data: {
      storeId: ctx.storeId,
      slug,
      name: displayName,
      tagline: tagline || "خلية جديدة أضافها التاجر — بانتظار تحديد مصادر بياناتها.",
      icon,
      color,
      score: 70,
      isCustom: true,
      sortOrder: count,
      kpis: [
        { label: "حالة البيانات", value: "قيد الربط", delta: null },
        { label: "أول تقرير متوقع", value: "خلال أسبوع", delta: null },
        { label: "مصادر مرتبطة", value: "0 مصدر", delta: null },
      ],
      chart: [
        { l: "الأسبوع 1", v: 0 },
        { l: "الأسبوع 2", v: 0 },
        { l: "الأسبوع 3", v: 0 },
        { l: "الأسبوع 4", v: 0 },
      ],
      sources: [],
      insight: "لم تُجمع بيانات كافية بعد لهذه الخلية — ستبدأ بعرض ملاحظاتها فور ربطها بمصادر البيانات المناسبة.",
    },
  });

  return NextResponse.json({ cell }, { status: 201 });
});
