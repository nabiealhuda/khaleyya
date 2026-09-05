import { prisma } from "./db";
import { askAI, AiNotConfiguredError, AiRequestError } from "./ai";
import type { Automation } from "@prisma/client";

/**
 * Real AI insight for the "جودة القرار والأثر" (quality) cell — the one
 * built-in cell besides the Odoo-linked ones that has real data to reason
 * about without any external integration: this store's own Decision and
 * Automation history already sitting in the DB. Every number fed to the AI
 * here is a real, deterministically-computed count/average from that
 * history — never invented, same discipline as odoo-sync.ts's aiInsight().
 */
export async function refreshQualityInsight(storeId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const cell = await prisma.cell.findFirst({ where: { storeId, slug: "quality" } });
  if (!cell) return { ok: false, message: "خلية جودة القرار غير موجودة" };

  const [decisions, automations] = await Promise.all([
    prisma.decision.findMany({ where: { storeId } }),
    prisma.automation.findMany({ where: { storeId } }),
  ]);

  if (decisions.length === 0) {
    return { ok: false, message: "لا توجد قرارات مسجّلة بعد لتحليلها" };
  }

  const total = decisions.length;
  const byStatus = { PENDING: 0, IN_PROGRESS: 0, DONE: 0, FAILED: 0, REJECTED: 0 } as Record<string, number>;
  let confidenceSum = 0;
  for (const d of decisions) {
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    confidenceSum += d.confidence;
  }
  const avgConfidence = Math.round(confidenceSum / total);
  const resolved = byStatus.DONE + byStatus.FAILED;
  const successRate = resolved > 0 ? Math.round((byStatus.DONE / resolved) * 100) : null;
  const automationFailures = automations.filter((a: Automation) => a.status === "FAILED").length;

  const kpis = [
    { label: "إجمالي القرارات المسجّلة", value: `${total} قرار`, delta: null },
    {
      label: "نسبة نجاح القرارات المنفَّذة",
      value: successRate !== null ? `${successRate}%` : "لا يوجد قرار منفَّذ بعد",
      delta: null,
    },
    { label: "متوسط مستوى الثقة في القرارات", value: `${avgConfidence}%`, delta: null },
  ];

  const factualLines = [
    `إجمالي القرارات: ${total} (منها ${byStatus.PENDING} بانتظار الموافقة، ${byStatus.IN_PROGRESS} قيد التنفيذ، ${byStatus.DONE} تم تنفيذها بنجاح، ${byStatus.FAILED} لم تحقق النتيجة، ${byStatus.REJECTED} مرفوضة)`,
    successRate !== null ? `نسبة نجاح القرارات المنفَّذة: ${successRate}%` : "لا يوجد بعد قرار مكتمل لقياس نسبة النجاح",
    `متوسط مستوى الثقة المُعلن عند اقتراح القرارات: ${avgConfidence}%`,
    `عمليات تنفيذ آلي فاشلة: ${automationFailures} من ${automations.length}`,
  ].join("\n");

  let insight = `بيانات حقيقية من سجل قراراتك: ${factualLines.split("\n")[0]}.`;
  try {
    insight = await askAI({
      system:
        "أنت محلل جودة قرارات تجارية تكتب ملاحظة قصيرة وصادقة بالعربية الفصحى المبسطة، بناءً فقط على الأرقام الحقيقية المُعطاة لك أدناه من سجل قرارات متجر حقيقي. لا تخترع أي رقم غير مذكور. جملتان كحد أقصى، واقترح تحسيناً عملياً واحداً إن أمكن.",
      userMessage: factualLines,
      maxTokens: 220,
    });
  } catch (err) {
    if (!(err instanceof AiNotConfiguredError || err instanceof AiRequestError)) throw err;
  }

  const sources = Array.isArray(cell.sources) ? (cell.sources as unknown[]) : [];
  await prisma.$transaction([
    prisma.cell.update({
      where: { id: cell.id },
      data: {
        kpis: kpis as never,
        insight,
        sources: (sources.includes("سجل القرارات الحقيقي") ? sources : [...sources, "سجل القرارات الحقيقي"]) as never,
      },
    }),
    prisma.activityItem.create({
      data: { storeId, cellId: cell.id, text: `تم تحديث تحليل "${cell.name}" من سجل القرارات الحقيقي` },
    }),
  ]);

  return { ok: true };
}
