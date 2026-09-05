import { NextResponse } from "next/server";
import { z } from "zod";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { askAI, AiNotConfiguredError, AiRequestError } from "@/lib/ai";
import type { Cell, Decision } from "@prisma/client";

/**
 * "مراجعة كاملة للموقع" — the Leader reviews every cell's real current data
 * in one pass and proposes brand-new candidate decisions, instead of only
 * ranking decisions that already exist. Every proposal must be grounded in
 * the real kpis/insight/sources given below and must not repeat an existing
 * open decision; nothing here is auto-executed — every proposal lands as a
 * normal PENDING Decision the merchant reviews like any other.
 */

const proposalSchema = z.object({
  cellId: z.string(),
  title: z.string().min(1).max(160),
  category: z.enum(["عاجل", "فرصة", "تحذير", "تحسين"]),
  description: z.string().min(1),
  reason: z.string().min(1),
  evidence: z.array(z.string()).max(6).default([]),
  impactLabel: z.string().min(1),
  confidence: z.number().min(0).max(100),
  risk: z.enum(["منخفض", "متوسط", "مرتفع"]),
  steps: z.array(z.string()).max(6).default([]),
});

const reviewResultSchema = z.object({
  summary: z.string(),
  proposals: z.array(proposalSchema).max(5).default([]),
});

function kpiSummary(kpis: unknown): string {
  if (!Array.isArray(kpis) || kpis.length === 0) return "لا توجد مؤشرات";
  return kpis
    .map((raw) => {
      const item = raw as { label?: unknown; value?: unknown };
      return `${String(item?.label ?? "")}: ${String(item?.value ?? "")}`;
    })
    .join("، ");
}

const RESPONSE_SHAPE = `{
  "summary": string,
  "proposals": [
    {
      "cellId": string,
      "title": string,
      "category": "عاجل" أو "فرصة" أو "تحذير" أو "تحسين",
      "description": string,
      "reason": string,
      "evidence": string[],
      "impactLabel": string,
      "confidence": number,
      "risk": "منخفض" أو "متوسط" أو "مرتفع",
      "steps": string[]
    }
  ]
}`;

function buildSystemPrompt(storeName: string, cells: Cell[], existing: Decision[]): string {
  const cellLines = cells
    .map(
      (c) =>
        `- id: "${c.slug}" — ${c.name} (${c.tagline})\n  المؤشرات: ${kpiSummary(c.kpis)}\n  آخر ملاحظة: ${c.insight}`
    )
    .join("\n");

  const existingTitles = existing
    .filter((d) => d.status === "PENDING" || d.status === "IN_PROGRESS")
    .map((d) => `- ${d.title}`)
    .join("\n") || "لا يوجد";

  return [
    `أنت "قائد الخلية" في منصة "خَلِيّة" لمتجر "${storeName}"، وتقوم الآن بمراجعة كاملة لكل الخلايا لاقتراح قرارات جديدة فعلاً تدعم المتجر.`,
    `مهمتك: اقترح من 2 إلى 5 قرارات جديدة ومحددة، كل قرار مبني حصراً على بيانات خلية واحدة حقيقية من القائمة أدناه (مؤشراتها وملاحظتها فقط) — لا تخترع منتجاً أو رقماً أو حقيقة غير مذكورة في هذه البيانات.`,
    ``,
    `قواعد صارمة:`,
    `1. لا تكرر أي قرار موجود بالفعل في القائمة "قرارات مطروحة حالياً" أدناه — اقترح شيئاً جديداً فقط.`,
    `2. اختر cellId فقط من المعرّفات المذكورة حرفياً أدناه.`,
    `3. لا تضع رقماً مالياً مؤكداً في impactLabel إن لم يكن مبنياً على رقم حقيقي مذكور في بيانات الخلية — استخدم عبارة وصفية بدل رقم مختلق عند الشك.`,
    `4. إذا لم تجد بيانات كافية في أي خلية لاقتراح قرار مفيد وغير مكرر، أعد proposals كمصفوفة فارغة [] واشرح ذلك في summary — لا تخترع قراراً لمجرد ملء العدد.`,
    `5. أعد الإجابة بصيغة JSON صالحة فقط مطابقة تماماً لهذا الشكل، بدون أي نص قبلها أو بعدها وبدون أسوار markdown:`,
    RESPONSE_SHAPE,
    ``,
    `الخلايا المتاحة فعلياً:`,
    cellLines,
    ``,
    `قرارات مطروحة حالياً (لا تكررها):`,
    existingTitles,
  ].join("\n");
}

export const POST = withRoute(
  async (_req, ctx) => {
    const [store, cells, existingDecisions] = await Promise.all([
      prisma.store.findUnique({ where: { id: ctx.storeId } }),
      prisma.cell.findMany({ where: { storeId: ctx.storeId }, orderBy: { sortOrder: "asc" } }),
      prisma.decision.findMany({ where: { storeId: ctx.storeId } }),
    ]);
    if (!store) return jsonError("المتجر غير موجود", 404);

    const system = buildSystemPrompt(store.name, cells, existingDecisions);

    let raw: string;
    try {
      raw = await askAI({ system, userMessage: "راجع كل الخلايا الآن واقترح قرارات جديدة.", maxTokens: 1800 });
    } catch (err) {
      if (err instanceof AiNotConfiguredError || err instanceof AiRequestError) {
        return jsonError(err.message, 503);
      }
      throw err;
    }

    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let json: unknown;
    try {
      json = JSON.parse(cleaned);
    } catch {
      return jsonError("تعذّر فهم رد الذكاء الاصطناعي — حاول مرة أخرى.", 502);
    }

    const resultParsed = reviewResultSchema.safeParse(json);
    if (!resultParsed.success) {
      return jsonError("رد الذكاء الاصطناعي لم يطابق الصيغة المتوقعة — حاول مرة أخرى.", 502);
    }

    const validSlugs = new Map(cells.map((c: Cell) => [c.slug, c.id]));
    const created: string[] = [];
    for (const p of resultParsed.data.proposals) {
      const cellId = validSlugs.get(p.cellId);
      if (!cellId) continue; // defense in depth — never write a decision against a cell id the model invented

      await prisma.decision.create({
        data: {
          storeId: ctx.storeId,
          cellId,
          title: p.title,
          category: p.category,
          description: p.description,
          reason: p.reason,
          evidence: p.evidence,
          impact: 0, // never a fabricated financial figure — impactLabel carries the real-language description
          impactLabel: p.impactLabel,
          confidence: p.confidence,
          risk: p.risk,
          status: "PENDING",
          autoEligible: false,
          supportCells: [p.cellId],
          opposeCells: [],
          steps: p.steps,
        },
      });
      created.push(p.title);
    }

    return NextResponse.json({ summary: resultParsed.data.summary, created });
  },
  { rateLimit: { limit: 5, windowMs: 60_000 } }
);
