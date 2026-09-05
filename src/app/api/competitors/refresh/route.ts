import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api";
import { prisma } from "@/lib/db";
import { decryptJson } from "@/lib/crypto";
import { fetchCompetitorPage } from "@/lib/integrations/competitor-fetch";
import { parseMarketSearchConfig, searchShopping } from "@/lib/integrations/marketsearch-client";
import { askAI, AiNotConfiguredError, AiRequestError } from "@/lib/ai";
import { logger } from "@/lib/logger";
import type { CompetitorEntry } from "@prisma/client";

/**
 * Real work for the "رصد وتحليل السوق" cell: for every competitor entry the
 * merchant tracks, tries a direct fetch of the URL they gave us first; if
 * that fails to yield a title/price (dead link, JS-only page, blocked
 * request) and the merchant has connected the SerpApi market-search
 * integration, falls back to a real shopping search using the entry's own
 * label as the query. Only after every entry has been (best-effort)
 * refreshed does it ask the AI to summarize — grounded strictly in the
 * entries' own lastTitle/lastPrice snapshots, never inventing a competitor
 * or price that wasn't actually found.
 *
 * Rate-limited low: each call can make one outbound request per tracked
 * entry (up to 30) plus an AI call.
 */
export const POST = withRoute(
  async (_req, ctx) => {
    const entries = await prisma.competitorEntry.findMany({ where: { storeId: ctx.storeId } });
    if (!entries.length) {
      return NextResponse.json({ checked: 0, found: 0 });
    }

    const marketConnection = await prisma.integrationConnection.findUnique({
      where: { storeId_providerId: { storeId: ctx.storeId, providerId: "marketsearch" } },
    });
    let marketApiKey: string | null = null;
    if (marketConnection && marketConnection.status === "CONNECTED") {
      try {
        marketApiKey = parseMarketSearchConfig(decryptJson(marketConnection.config)).apiKey;
      } catch {
        marketApiKey = null;
      }
    }

    let found = 0;
    for (const entry of entries) {
      let snapshot = await fetchCompetitorPage(entry.url);
      let sourceNote = "";

      if (!snapshot && marketApiKey) {
        try {
          const results = await searchShopping(marketApiKey, entry.label);
          if (results.length) {
            snapshot = { title: results[0].title, price: results[0].price };
            sourceNote = results[0].source ? ` (عبر بحث السوق — ${results[0].source})` : " (عبر بحث السوق)";
          }
        } catch (err) {
          logger.error({ err, storeId: ctx.storeId, entryId: entry.id }, "marketsearch fallback failed");
        }
      }

      if (snapshot) found++;
      await prisma.competitorEntry.update({
        where: { id: entry.id },
        data: {
          lastCheckedAt: new Date(),
          lastTitle: snapshot?.title ? `${snapshot.title}${sourceNote}` : null,
          lastPrice: snapshot?.price ?? null,
          lastError: snapshot ? null : "تعذّر قراءة الصفحة أو إيجاد نتيجة بحث — تحقّق من الرابط أو اربط خدمة بحث الأسعار.",
        },
      });
    }

    // Write a real, grounded AI insight for the competitors cell — only if
    // at least one entry actually yielded something real to reason about.
    const cell = await prisma.cell.findFirst({ where: { storeId: ctx.storeId, slug: "competitors" } });
    if (cell && found > 0) {
      const refreshed = await prisma.competitorEntry.findMany({ where: { storeId: ctx.storeId } });
      const lines = refreshed
        .filter((e: CompetitorEntry) => e.lastTitle || e.lastPrice)
        .map((e: CompetitorEntry) => `- ${e.label}: ${e.lastTitle || "بلا عنوان"} — السعر: ${e.lastPrice || "غير مذكور"}`)
        .join("\n");

      let insight = `تمت متابعة ${found} من أصل ${entries.length} منافساً بنجاح. راجع القائمة أدناه للتفاصيل.`;
      try {
        insight = await askAI({
          system:
            "أنت محلل سوق تجاري تكتب ملاحظة قصيرة وصادقة بالعربية الفصحى المبسطة عن منافسي متجر، بناءً فقط على المعلومات الحقيقية المُعطاة لك أدناه (عناوين وأسعار فعلية جُلبت من الإنترنت). لا تخترع أي منافس أو سعر أو منتج غير مذكور. جملتان إلى ثلاث كحد أقصى. إن أمكن اقترح إجراءً عملياً واحداً (مثال: مراجعة سعر منتج مشابه لديك).",
          userMessage: `منافسون تمت متابعتهم:\n${lines}`,
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
            insight,
            sources: (sources.includes("متابعة منافسين يدوية") ? sources : [...sources, "متابعة منافسين يدوية"]) as never,
            kpis: [
              { label: "منافسون متابَعون", value: `${entries.length} منافس`, delta: null },
              { label: "آخر تحديث ناجح", value: `${found} من ${entries.length}`, delta: null },
            ] as never,
          },
        }),
        prisma.activityItem.create({
          data: { storeId: ctx.storeId, cellId: cell.id, text: `تم تحديث بيانات ${found} منافس متابَع` },
        }),
      ]);
    }

    return NextResponse.json({ checked: entries.length, found });
  },
  { rateLimit: { limit: 10, windowMs: 60_000 } }
);
