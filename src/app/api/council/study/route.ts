import { NextResponse } from "next/server";
import { z } from "zod";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { askAI, AiNotConfiguredError, AiRequestError } from "@/lib/ai";
import type { Cell } from "@prisma/client";

/**
 * Real AI-backed replacement for what used to be a fully hardcoded,
 * client-side "council" scenario generator (COUNCIL_SCENARIOS /
 * genericCouncilScenario() in dashboard.html) — including a generic
 * fallback that literally called Math.random() to invent a financial
 * "impact" figure for any question not in the fixed scenario list, and a
 * subtitle that assumed a specific product ("تشكيلة الشتاء الراكدة") even
 * when the merchant's question never named one.
 *
 * Every decision studied in "المجلس الاستشاري للخلايا" now goes through
 * this endpoint: the model picks which real cells are relevant, has each
 * one "vote" using only that cell's real KPI/insight data, and produces a
 * final verdict — or, if the question references something unnamed (like
 * "هذا المنتج" with no product ever specified), asks for clarification
 * instead of inventing a subject.
 */

const bodySchema = z.object({
  question: z.string().trim().min(1).max(500),
});

const opinionSchema = z.object({
  cellId: z.string(),
  stance: z.enum(["يؤيد", "يعارض", "محايد"]),
  highlight: z.string(),
  text: z.string(),
  evidence: z.array(z.string()).default([]),
  benefits: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  impact: z.number().nullable().default(null),
  confidence: z.number().min(0).max(100),
  conditions: z.array(z.string()).default([]),
  alternative: z.string().nullable().default(null),
});

const verdictSchema = z.object({
  decision: z.string(),
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(100),
  expectedProfit: z.string(),
  risks: z.array(z.string()).default([]),
  stopCondition: z.string(),
  timing: z.string(),
  kpis: z.array(z.string()).default([]),
  plan: z.array(z.string()).default([]),
});

const councilResultSchema = z.object({
  needsClarification: z.string().nullable().default(null),
  subtitle: z.string().default(""),
  opinions: z.array(opinionSchema).default([]),
  verdict: verdictSchema,
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

function sourcesOf(sources: unknown): string[] {
  return Array.isArray(sources) ? (sources as unknown[]).map(String) : [];
}

const RESPONSE_SHAPE = `{
  "needsClarification": string أو null,
  "subtitle": string,
  "opinions": [
    {
      "cellId": string,
      "stance": "يؤيد" أو "يعارض" أو "محايد",
      "highlight": string,
      "text": string,
      "evidence": string[],
      "benefits": string[],
      "risks": string[],
      "impact": number أو null,
      "confidence": number,
      "conditions": string[],
      "alternative": string أو null
    }
  ],
  "verdict": {
    "decision": string,
    "score": number,
    "confidence": number,
    "expectedProfit": string,
    "risks": string[],
    "stopCondition": string,
    "timing": string,
    "kpis": string[],
    "plan": string[]
  }
}`;

function buildSystemPrompt(storeName: string, cells: Cell[]): string {
  const cellLines = cells
    .map((c) => {
      const hasRealData = sourcesOf(c.sources).includes("أودو");
      return `- id: "${c.slug}" — الاسم: ${c.name} (${c.tagline})\n  الحالة: ${hasRealData ? "متصلة ببيانات حقيقية من أودو" : "لا يوجد مصدر بيانات حقيقي مرتبط بها بعد"}\n  المؤشرات: ${kpiSummary(c.kpis)}\n  آخر ملاحظة مسجّلة: ${c.insight}`;
    })
    .join("\n");

  return [
    `أنت "قائد الخلية" وتدير الآن اجتماع "المجلس الاستشاري للخلايا" داخل منصة "خَلِيّة" لمتجر "${storeName}".`,
    `التاجر يعرض عليك قراراً تجارياً يريد دراسته. مهمتك: استدعاء 2 إلى 4 من الخلايا (الأقسام) الأكثر صلة فعلياً من القائمة أدناه فقط، وجعل كل واحدة منها "تصوّت" (تؤيد/تعارض/محايد) برأي مبني حصراً على بياناتها الحقيقية المتاحة، ثم إصدار توصية نهائية موحدة.`,
    ``,
    `قواعد صارمة لا تخرج عنها أبداً:`,
    `1. لا تختلق أرقاماً مالية أو حقائق غير موجودة في بيانات الخلايا المُعطاة لك أدناه. إن لم تتوفر بيانات حقيقية كافية لتقدير رقم مالي لخلية معينة، استخدم null لحقل impact في تلك الخلية بدل اختراع رقم. وإن لم يكن ممكناً تقدير أثر مالي إجمالي موثوق، اكتب في expectedProfit عبارة صريحة مثل "لا يمكن تقدير الأثر المالي بدقة بالبيانات الحالية" بدل رقم مختلق.`,
    `2. لا تفترض أو تخترع منتجاً أو حملة أو تفصيلاً محدداً لم يذكره التاجر صراحةً في نص سؤاله. إذا كان السؤال يشير إلى شيء غير محدد (مثل "هذا المنتج" أو "هذا الإعلان" دون تسمية أي منتج أو حملة بعينها في السؤال نفسه)، ضع في الحقل needsClarification سؤال توضيح واضح ومباشر (مثل: "ما اسم المنتج الذي تقصده بالضبط؟")، واجعل opinions مصفوفة فارغة [] واملأ حقول verdict بأقل قدر ممكن (decision تشرح أن التحليل ينتظر التوضيح، score و confidence = 0). أما إذا كان السؤال استراتيجياً عاماً بشكل مشروع وليس عن عنصر بعينه (مثل: "هل أطلق حملة خصم؟" كسؤال سياسة عامة)، فاترك needsClarification = null وقدّم تحليلاً عاماً مبنياً على الصورة الكلية لبيانات الخلايا.`,
    `3. اختر فقط من معرّفات الخلايا (id) المذكورة حرفياً في القائمة أدناه لحقل cellId في كل رأي — لا تخترع معرّفاً جديداً، ولا تدرج خلية غير مذكورة في القائمة.`,
    `4. أعد الإجابة بصيغة JSON صالحة فقط، مطابقة تماماً لهذا الشكل، بدون أي نص أو شرح قبلها أو بعدها، وبدون أسوار كود markdown من نوع \`\`\`:`,
    RESPONSE_SHAPE,
    ``,
    `قائمة الخلايا المتاحة فعلياً في هذا المتجر:`,
    cellLines,
  ].join("\n");
}

export const POST = withRoute(
  async (req, ctx) => {
    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return jsonError("سؤال غير صالح", 422, parsed.error.flatten());

    const [store, cells] = await Promise.all([
      prisma.store.findUnique({ where: { id: ctx.storeId } }),
      prisma.cell.findMany({ where: { storeId: ctx.storeId }, orderBy: { sortOrder: "asc" } }),
    ]);
    if (!store) return jsonError("المتجر غير موجود", 404);

    const system = buildSystemPrompt(store.name, cells);

    let raw: string;
    try {
      raw = await askAI({ system, userMessage: parsed.data.question, maxTokens: 1600 });
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

    const resultParsed = councilResultSchema.safeParse(json);
    if (!resultParsed.success) {
      return jsonError("رد الذكاء الاصطناعي لم يطابق الصيغة المتوقعة — حاول مرة أخرى.", 502);
    }

    // Defense in depth: drop any opinion attributed to a cell id the model
    // invented rather than picking from the real list we gave it.
    const validSlugs = new Set(cells.map((c: Cell) => c.slug));
    const result = {
      ...resultParsed.data,
      opinions: resultParsed.data.opinions.filter((o) => validSlugs.has(o.cellId)),
    };

    return NextResponse.json({ result });
  },
  { rateLimit: { limit: 15, windowMs: 60_000 } }
);
