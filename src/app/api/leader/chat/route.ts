import { NextResponse } from "next/server";
import { z } from "zod";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { askClaude, AiNotConfiguredError, AiRequestError, type AiMessage } from "@/lib/ai";
import type { Cell, Decision, MeetingMessage } from "@prisma/client";

/**
 * Real AI-backed replacement for what used to be a client-side keyword
 * matcher (meetingRespond() in dashboard.html) and a fixed list of
 * pre-written Q&A (LEADER_QA). Every "قائد الخلية" quick question and every
 * message sent in "غرفة الاجتماعات" now goes through here.
 *
 * The merchant's message and the AI's reply are both persisted as
 * MeetingMessage rows (reusing the existing table — no schema change), so
 * the meeting history keeps working exactly as before.
 */

const bodySchema = z.object({
  text: z.string().trim().min(1).max(2000),
  // Cell slugs the merchant has toggled "on" in the meeting room's
  // participant list — passed through as a steer, not a hard filter, since
  // the model can decide for itself what's relevant to a given question.
  focusCellSlugs: z.array(z.string()).max(20).optional().default([]),
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

// Turns the store's saved MeetingMessage history (oldest first) plus the
// merchant's newest message into a valid Anthropic messages array: roles
// must alternate starting with "user", so consecutive same-role entries
// (e.g. two merchant messages in a row after a failed/unanswered turn) are
// merged rather than sent as-is. Without real history here, the model has
// no legitimate way to resolve a reference like "هذا المنتج" ("this
// product") from an earlier turn — it would have to guess.
function toConversation(history: MeetingMessage[], newUserText: string): AiMessage[] {
  const raw: AiMessage[] = [
    ...history.map((m) => ({ role: m.role === "MERCHANT" ? ("user" as const) : ("assistant" as const), content: m.text })),
    { role: "user" as const, content: newUserText },
  ];
  const merged: AiMessage[] = [];
  for (const m of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n${m.content}`;
    } else {
      merged.push({ ...m });
    }
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  return merged;
}

function buildSystemPrompt(storeName: string, cells: Cell[], decisions: Decision[], focusSlugs: string[]): string {
  const cellLines = cells
    .map((c) => {
      const hasRealData = sourcesOf(c.sources).includes("أودو");
      return `- ${c.name} — ${c.tagline}\n  الحالة: ${hasRealData ? "متصلة ببيانات حقيقية من أودو" : "لا يوجد مصدر بيانات حقيقي مرتبط بها بعد"}\n  المؤشرات: ${kpiSummary(c.kpis)}\n  آخر ملاحظة مسجّلة: ${c.insight}`;
    })
    .join("\n");

  const pending = decisions.filter((d) => d.status === "PENDING").slice(0, 10);
  const decisionLines = pending.length
    ? pending.map((d) => `- ${d.title} (الأثر المتوقع: ${d.impactLabel}، نسبة الثقة: ${d.confidence}%)`).join("\n")
    : "لا توجد قرارات معلّقة بانتظار الموافقة حالياً.";

  // focusSlugs is only a meaningful signal when it's a genuine, deliberate
  // subset of the cells. The meeting room defaults every cell to "present",
  // so a full-attendance list (or an empty one) is not the merchant singling
  // anything out — treating it as such was causing the AI to invent that the
  // merchant's question was about a specific cell/product when it wasn't.
  const isRealNarrowing = focusSlugs.length > 0 && focusSlugs.length < cells.length;
  const focusNote = isRealNarrowing
    ? `\nالتاجر ضيّق التركيز خصوصاً على هذه الخلايا في هذا الاجتماع (بإزالة البقية من الحضور): ${focusSlugs.join("، ")}. هذا لا يعني أن سؤاله يتحدث عنها تلقائياً — استخدم هذا فقط كمرشّح لو كان السؤال بالفعل يخص إحداها.`
    : "";

  return [
    `أنت "قائد الخلية" — المساعد التنفيذي الذكي داخل منصة "خَلِيّة" لإدارة متجر "${storeName}".`,
    `دورك تنسيق فريق من "خلايا" متخصصة (كل خلية تراقب جانباً من المتجر: المخزون، المبيعات، الحسابات المالية، العملاء، وغيرها)، وتقديم إجابات وتوصيات واضحة وصادقة للتاجر بالعربية الفصحى المبسّطة.`,
    ``,
    `قواعد صارمة لا تخرج عنها أبداً:`,
    `1. لا تختلق أرقاماً أو حقائق غير موجودة في البيانات المُعطاة لك أدناه. إذا سُئلت عن خلية ليس لها بيانات حقيقية مرتبطة، صرّح بوضوح أن بياناتها الفعلية غير مربوطة بعد، ولا تخترع أرقاماً بديلة.`,
    `2. لا تفترض أو تخترع تفاصيل لم يذكرها التاجر صراحةً — لا في هذا السؤال ولا في أي رسالة سابقة ضمن هذه المحادثة المعروضة لك أدناه. إذا كان السؤال عاماً أو غامضاً (مثل: "هل أطلق حملة خصم؟" بلا تحديد أي منتج)، أجب بشكل عام مبني على الصورة الكلية للبيانات المتوفرة، أو اسأل التاجر عن التوضيح المطلوب بدل افتراض إجابة محددة.`,
    `3. انتبه خصوصاً لعبارات الإشارة مثل "هذا المنتج"، "هذه الحملة"، "نفس الخلية" — هذه العبارات تشير إلى شيء افترض التاجر أنه مفهوم من سياق المحادثة. إن لم يكن هناك منتج أو حملة أو خلية محددة بالاسم في السؤال الحالي أو في الرسائل السابقة الفعلية أدناه، فلا يوجد "هذا" واضح لديك — لا تختر أي عنصر من بيانات الخلايا وتفترض أنه المقصود. بدلاً من ذلك، صرّح بأنك لا تعرف أي منتج/حملة يقصد واطلب منه تحديد الاسم.`,
    `4. كن مختصراً ومباشراً — فقرة أو فقرتين كحد أقصى، بلا مقدمات طويلة أو حشو.`,
    `5. إن وُجدت توصية عملية واضحة مبنية على البيانات الحقيقية المتوفرة، اذكرها صراحةً — لكن فقط عندما ترتبط فعلاً بما سأل عنه التاجر.`,
    `6. تحدث بثقة ومهنية كقائد فريق حقيقي، لا كروبوت يكرر نفس الصياغات.`,
    ``,
    `بيانات الخلايا الحالية:`,
    cellLines,
    ``,
    `القرارات المعلّقة حالياً:`,
    decisionLines,
    focusNote,
  ].join("\n");
}

export const POST = withRoute(
  async (req, ctx) => {
    const body = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return jsonError("رسالة غير صالحة", 422, parsed.error.flatten());

    const [store, cells, decisions, recentHistory] = await Promise.all([
      prisma.store.findUnique({ where: { id: ctx.storeId } }),
      prisma.cell.findMany({ where: { storeId: ctx.storeId }, orderBy: { sortOrder: "asc" } }),
      prisma.decision.findMany({ where: { storeId: ctx.storeId } }),
      // Real prior turns, oldest first — without this the model has no
      // legitimate way to resolve "هذا المنتج" ("this product") or similar
      // references to something said earlier, and would have to guess.
      prisma.meetingMessage.findMany({
        where: { storeId: ctx.storeId },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
    ]);
    if (!store) return jsonError("المتجر غير موجود", 404);

    // Persist the merchant's message immediately — it's real regardless of
    // whether the AI call below succeeds.
    await prisma.meetingMessage.create({
      data: { storeId: ctx.storeId, role: "MERCHANT", text: parsed.data.text },
    });

    const system = buildSystemPrompt(store.name, cells, decisions, parsed.data.focusCellSlugs);
    const messages = toConversation(recentHistory.reverse(), parsed.data.text);

    let replyText: string;
    try {
      replyText = await askClaude({ system, messages });
    } catch (err) {
      if (err instanceof AiNotConfiguredError || err instanceof AiRequestError) {
        return jsonError(err.message, 503);
      }
      throw err;
    }

    const saved = await prisma.meetingMessage.create({
      data: { storeId: ctx.storeId, role: "LEADER", text: replyText },
    });

    return NextResponse.json({ message: saved });
  },
  { rateLimit: { limit: 20, windowMs: 60_000 } }
);
