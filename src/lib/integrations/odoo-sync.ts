import { prisma } from "../db";
import { logger } from "../logger";
import { odooExecuteKw, OdooConfig } from "./odoo-client";

/**
 * Pulls real data from a connected Odoo instance and overwrites the KPIs,
 * chart, and insight text of the four built-in cells that Odoo can
 * genuinely speak to — matching what OdooProvider's snapshot already
 * advertises as readable (inventory, invoices/accounts, sales orders, CRM
 * contacts). Every other cell (ads, competitors, site health, dev quality,
 * decision quality, purchasing) has no real Odoo-backed data source and is
 * left untouched.
 *
 * Design choices, made because this runs against merchants' real Odoo
 * instances that were never available to test against here:
 *  - Each cell syncs independently and fails independently (try/catch per
 *    cell). One cell's ACL restriction, missing module, or API quirk must
 *    never take down the other three or the whole "connect" flow.
 *  - Aggregates (sums, counts) are computed server-side in Odoo via
 *    search_count / read_group rather than fetching every record and
 *    summing client-side, so this stays fast and bounded regardless of
 *    store size.
 *  - Only real numbers go into KPIs/insight text — no fabricated analysis.
 *    The insight strings are plainly-worded factual summaries of the pulled
 *    numbers, not AI-generated commentary.
 */

export type CellSyncOutcome = { slug: string; cellName: string; ok: boolean; message: string };

const ARABIC_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

function odooDateTime(d: Date): string {
  // Odoo expects naive UTC "YYYY-MM-DD HH:MM:SS" strings in domain filters.
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Last `n` calendar months (UTC), oldest first, ending with the current month. */
function lastMonthBuckets(n: number): { start: Date; end: Date; label: string }[] {
  const now = new Date();
  const buckets: { start: Date; end: Date; label: string }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    buckets.push({ start, end, label: ARABIC_MONTHS[start.getUTCMonth()] });
  }
  return buckets;
}

function formatSar(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** read_group with an empty groupby returns one aggregate row for the whole domain — {amount_total, __count}. */
async function sumAndCount(
  cfg: OdooConfig,
  uid: number,
  model: string,
  domain: unknown[],
  sumField: string
): Promise<{ sum: number; count: number }> {
  const rows = (await odooExecuteKw(cfg, uid, model, "read_group", [domain, [`${sumField}:sum`], []])) as Array<
    Record<string, unknown>
  >;
  const row = rows?.[0];
  const sum = typeof row?.[sumField] === "number" ? (row[sumField] as number) : 0;
  const count = typeof row?.["__count"] === "number" ? (row["__count"] as number) : 0;
  return { sum, count };
}

async function count(cfg: OdooConfig, uid: number, model: string, domain: unknown[]): Promise<number> {
  const result = await odooExecuteKw(cfg, uid, model, "search_count", [domain]);
  return typeof result === "number" ? result : 0;
}

type CellUpdate = {
  kpis: Array<{ label: string; value: string; delta: number | null; up?: boolean }>;
  chart: Array<{ l: string; v: number }>;
  insight: string;
};

async function syncInventory(cfg: OdooConfig, uid: number): Promise<CellUpdate> {
  const baseDomain = [["type", "!=", "service"]];
  const total = await count(cfg, uid, "product.product", baseDomain);
  const outOfStock = await count(cfg, uid, "product.product", [...baseDomain, ["qty_available", "<=", 0]]);
  const lowStock = await count(cfg, uid, "product.product", [
    ...baseDomain,
    ["qty_available", ">", 0],
    ["qty_available", "<=", 5],
  ]);
  const healthy = Math.max(total - outOfStock - lowStock, 0);

  return {
    kpis: [
      { label: "منتجات نفدت من المخزون", value: `${outOfStock} منتج`, delta: null },
      { label: "منتجات بمخزون منخفض (٥ قطع أو أقل)", value: `${lowStock} منتج`, delta: null },
      { label: "إجمالي المنتجات في أودو", value: `${total} منتج`, delta: null },
    ],
    chart: [
      { l: "نفدت", v: outOfStock },
      { l: "منخفض", v: lowStock },
      { l: "متوفر", v: healthy },
    ],
    insight: `بيانات حقيقية من أودو: ${outOfStock} منتج نفد من المخزون، و${lowStock} منتج بمخزون منخفض (٥ قطع أو أقل)، من إجمالي ${total} منتج.`,
  };
}

async function syncSalesOrders(cfg: OdooConfig, uid: number): Promise<CellUpdate> {
  const confirmed = [["state", "in", ["sale", "done"]]];
  const { sum: sum30, count: count30 } = await sumAndCount(
    cfg,
    uid,
    "sale.order",
    [...confirmed, ["create_date", ">=", odooDateTime(daysAgo(30))]],
    "amount_total"
  );
  const avg30 = count30 > 0 ? sum30 / count30 : 0;

  const chart: Array<{ l: string; v: number }> = [];
  for (const bucket of lastMonthBuckets(6)) {
    const { sum } = await sumAndCount(
      cfg,
      uid,
      "sale.order",
      [...confirmed, ["create_date", ">=", odooDateTime(bucket.start)], ["create_date", "<", odooDateTime(bucket.end)]],
      "amount_total"
    );
    chart.push({ l: bucket.label, v: Math.round(sum) });
  }

  return {
    kpis: [
      { label: "طلبات مبيعات (آخر ٣٠ يوم)", value: `${count30} طلب`, delta: null },
      { label: "إجمالي قيمة الطلبات (٣٠ يوم)", value: `${formatSar(sum30)} ر.س`, delta: null },
      { label: "متوسط قيمة الطلب", value: `${formatSar(avg30)} ر.س`, delta: null },
    ],
    chart,
    insight: `بيانات حقيقية من أودو: ${count30} طلب مبيعات بقيمة إجمالية ${formatSar(sum30)} ر.س خلال آخر ٣٠ يوماً، بمتوسط ${formatSar(avg30)} ر.س للطلب.`,
  };
}

async function syncFinancials(cfg: OdooConfig, uid: number): Promise<CellUpdate> {
  const baseDomain = [
    ["move_type", "=", "out_invoice"],
    ["state", "=", "posted"],
  ];
  const { sum: sum30, count: count30 } = await sumAndCount(
    cfg,
    uid,
    "account.move",
    [...baseDomain, ["invoice_date", ">=", odooDateTime(daysAgo(30)).slice(0, 10)]],
    "amount_total"
  );
  const unpaid = await count(cfg, uid, "account.move", [...baseDomain, ["payment_state", "in", ["not_paid", "partial"]]]);

  const chart: Array<{ l: string; v: number }> = [];
  for (const bucket of lastMonthBuckets(6)) {
    const { sum } = await sumAndCount(
      cfg,
      uid,
      "account.move",
      [...baseDomain, ["invoice_date", ">=", odooDateTime(bucket.start).slice(0, 10)], ["invoice_date", "<", odooDateTime(bucket.end).slice(0, 10)]],
      "amount_total"
    );
    chart.push({ l: bucket.label, v: Math.round(sum) });
  }

  return {
    kpis: [
      { label: "إجمالي الفواتير الصادرة (٣٠ يوم)", value: `${formatSar(sum30)} ر.س`, delta: null },
      { label: "عدد الفواتير الصادرة (٣٠ يوم)", value: `${count30} فاتورة`, delta: null },
      { label: "فواتير غير مسددة بالكامل", value: `${unpaid} فاتورة`, delta: null },
    ],
    chart,
    insight: `بيانات حقيقية من أودو: صدرت فواتير بقيمة ${formatSar(sum30)} ر.س (${count30} فاتورة) خلال آخر ٣٠ يوماً، ويوجد حالياً ${unpaid} فاتورة غير مسددة بالكامل.`,
  };
}

async function syncCustomers(cfg: OdooConfig, uid: number): Promise<CellUpdate> {
  const baseDomain = [["customer_rank", ">", 0]];
  const total = await count(cfg, uid, "res.partner", baseDomain);
  const new30 = await count(cfg, uid, "res.partner", [...baseDomain, ["create_date", ">=", odooDateTime(daysAgo(30))]]);
  const growthPct = total > 0 ? (new30 / total) * 100 : 0;

  const chart: Array<{ l: string; v: number }> = [];
  for (const bucket of lastMonthBuckets(6)) {
    const v = await count(cfg, uid, "res.partner", [
      ...baseDomain,
      ["create_date", ">=", odooDateTime(bucket.start)],
      ["create_date", "<", odooDateTime(bucket.end)],
    ]);
    chart.push({ l: bucket.label, v });
  }

  return {
    kpis: [
      { label: "إجمالي العملاء في أودو", value: `${total} عميل`, delta: null },
      { label: "عملاء جدد (آخر ٣٠ يوم)", value: `${new30} عميل`, delta: null },
      { label: "نسبة نمو قاعدة العملاء", value: `${growthPct.toFixed(1)}%`, delta: null },
    ],
    chart,
    insight: `بيانات حقيقية من أودو: ${total} عميل مسجّل إجمالاً في أودو، منهم ${new30} عميل جديد خلال آخر ٣٠ يوماً.`,
  };
}

const CELL_SYNCERS: Record<string, (cfg: OdooConfig, uid: number) => Promise<CellUpdate>> = {
  inventory: syncInventory,
  pricing: syncSalesOrders,
  profit: syncFinancials,
  customers: syncCustomers,
};

export async function syncOdooCells(storeId: string, cfg: OdooConfig, uid: number): Promise<CellSyncOutcome[]> {
  const outcomes: CellSyncOutcome[] = [];

  for (const [slug, syncFn] of Object.entries(CELL_SYNCERS)) {
    const cell = await prisma.cell.findFirst({ where: { storeId, slug } });
    if (!cell) {
      outcomes.push({ slug, cellName: slug, ok: false, message: "الخلية غير موجودة" });
      continue;
    }

    try {
      const update = await syncFn(cfg, uid);
      const existingSources = Array.isArray(cell.sources) ? (cell.sources as unknown[]) : [];
      const sources = existingSources.includes("أودو") ? existingSources : [...existingSources, "أودو"];

      await prisma.$transaction([
        prisma.cell.update({
          where: { id: cell.id },
          data: {
            kpis: update.kpis as never,
            chart: update.chart as never,
            insight: update.insight,
            sources: sources as never,
          },
        }),
        prisma.activityItem.create({
          data: {
            storeId,
            cellId: cell.id,
            text: `تمت مزامنة "${cell.name}" ببيانات حقيقية من أودو`,
          },
        }),
      ]);

      outcomes.push({ slug, cellName: cell.name, ok: true, message: "تمت المزامنة" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "خطأ غير معروف";
      logger.error({ err, slug, storeId }, "odoo cell sync failed");
      outcomes.push({ slug, cellName: cell.name, ok: false, message });
    }
  }

  return outcomes;
}
