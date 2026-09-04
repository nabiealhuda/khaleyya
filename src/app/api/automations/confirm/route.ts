import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { confirmAutomationSchema } from "@/lib/validators";

/**
 * Mirrors confirmAutomation() in the dashboard: approving a decision's
 * automatic execution moves the decision to IN_PROGRESS and logs a new
 * automation run row. Nothing here calls a real external system yet — that
 * is exactly what the integration adapters (src/lib/integrations) will do
 * once a real provider (e.g. Odoo) is wired in.
 */
export const POST = withRoute(async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = confirmAutomationSchema.safeParse(body);
  if (!parsed.success) return jsonError("بيانات غير صالحة", 422, parsed.error.flatten());

  const decision = await prisma.decision.findFirst({
    where: { id: parsed.data.decisionId, storeId: ctx.storeId },
  });
  if (!decision) return jsonError("القرار غير موجود", 404);

  const steps = decision.steps as string[];

  const [, automation] = await prisma.$transaction([
    prisma.decision.update({ where: { id: decision.id }, data: { status: "IN_PROGRESS" } }),
    prisma.automation.create({
      data: {
        storeId: ctx.storeId,
        decisionId: decision.id,
        cellId: decision.cellId,
        title: decision.title,
        changes: [steps[0] ?? ""],
        expected: decision.impactLabel,
        risk: decision.risk,
        reversible: true,
        perms: ["تعديل البيانات المرتبطة"],
        status: "IN_PROGRESS",
        result: "بدأ التنفيذ للتو — القياس جارٍ",
      },
    }),
  ]);

  return NextResponse.json({ automation }, { status: 201 });
});
