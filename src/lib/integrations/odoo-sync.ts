import { prisma } from "../db";
import { logger } from "../logger";
import { odooExecuteKw, OdooConfig } from "./odoo-client";
import { askAI, AiNotConfiguredError, AiRequestError } from "../ai";
import type { Product } from "@prisma/client";

/**
 * Pulls real data from a connected Odoo instance and overwrites the KPIs,
 * chart, and insight text of the five built-in cells that Odoo can
 * genuinely speak to — matching what OdooProvider's snapshot already
 * advertises as readable (inventory, invoices/accounts, sales orders, CRM
 * contacts, purchase orders). Every other cell (ads, competitors, site
 * health, dev quality, decision quality) has no real Odoo-backed data source
 * and is left untouched — see cell-insight.ts for the ones that instead get
 * a real insight from data already in our own DB (decision/automation
 * history), and src/app/api/competitors for the merchant-driven one.
 *
 * This module also (see the bottom of the file): syncs the store's real
 * name from Odoo's res.company record, syncs a lightweight product catalog
 * (src/lib/integrations/... Product table) used by the "المنتجات" page and
 * by the stagnant/overpriced-product discount-decision generator below —
 * all still real Odoo data, never AI output.
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
 *  - KPI numbers are always the real, deterministically-computed Odoo
 *    aggregates — never AI output. The insight sentence is then handed to
 *    the store's configured AI provider (see aiInsight() below, and
 *    src/lib/ai.ts for how OpenAI vs. Anthropic is chosen) to turn into a
 *    short, genuinely-written analytical note grounded strictly in those
 *    same numbers; if the AI isn't configured or the call fails, the plain
 *    factual template sentence is used instead — a sync must never fail or
 *    stall over this.
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

/**
 * Upgrades the plain factual template sentence (e.g. "3 products are out of
 * stock, out of 40 total") into a short, genuinely-written analytical note
 * — same real numbers, an actual model reasoning about what they mean and
 * what to do about them, instead of a fixed sentence shape. Best-effort: if
 * the AI isn't configured (no OPENAI_API_KEY/ANTHROPIC_API_KEY yet) or the
 * call fails for any reason, this quietly falls back to the factual
 * template so a sync never breaks or stalls over it.
 */
async function aiInsight(cellName: string, factualInsight: string, kpis: CellUpdate["kpis"]): Promise<string> {
  try {
    const kpiLines = kpis.map((k) => `- ${k.label}: ${k.value}`).join("\n");
    return await askAI({
      system:
        "أنت محلل بيانات تجاري تكتب ملاحظة تحليلية قصيرة وصادقة بالعربية الفصحى المبسطة، بناءً فقط على الأرقام الحقيقية المُعطاة لك أدناه. لا تخترع أي رقم أو حقيقة غير مذكورة. جملتان كحد أقصى. اكتب الملاحظة مباشرة (بدون مقدمات مثل \"بناءً على البيانات\")، وإن أمكن اقترح إجراءً عملياً واحداً واضحاً.",
      userMessage: `الخلية: ${cellName}\nالأرقام الحقيقية من أودو:\n${kpiLines}`,
      maxTokens: 220,
    });
  } catch (err) {
    if (err instanceof AiNotConfiguredError || err instanceof AiRequestError) {
      return factualInsight;
    }
    throw err;
  }
}

async function syncPurchasing(cfg: OdooConfig, uid: number): Promise<CellUpdate> {
  const confirmed = [["state", "in", ["purchase", "done"]]];
  const { sum: sum30, count: count30 } = await sumAndCount(
    cfg,
    uid,
    "purchase.order",
    [...confirmed, ["date_order", ">=", odooDateTime(daysAgo(30))]],
    "amount_total"
  );
  const avg30 = count30 > 0 ? sum30 / count30 : 0;
  const pendingApproval = await count(cfg, uid, "purchase.order", [["state", "=", "draft"]]);

  const chart: Array<{ l: string; v: number }> = [];
  for (const bucket of lastMonthBuckets(6)) {
    const { sum } = await sumAndCount(
      cfg,
      uid,
      "purchase.order",
      [...confirmed, ["date_order", ">=", odooDateTime(bucket.start)], ["date_order", "<", odooDateTime(bucket.end)]],
      "amount_total"
    );
    chart.push({ l: bucket.label, v: Math.round(sum) });
  }

  return {
    kpis: [
      { label: "أوامر شراء مؤكدة (آخر ٣٠ يوم)", value: `${count30} أمر`, delta: null },
      { label: "إجمالي قيمة المشتريات (٣٠ يوم)", value: `${formatSar(sum30)} ر.س`, delta: null },
      { label: "طلبات عروض أسعار بانتظار الاعتماد", value: `${pendingApproval} طلب`, delta: null },
    ],
    chart,
    insight: `بيانات حقيقية من أودو: ${count30} أمر شراء مؤكد بقيمة إجمالية ${formatSar(sum30)} ر.س خلال آخر ٣٠ يوماً، بمتوسط ${formatSar(avg30)} ر.س للأمر، و${pendingApproval} طلب عرض سعر بانتظار اعتمادك.`,
  };
}

const CELL_SYNCERS: Record<string, (cfg: OdooConfig, uid: number) => Promise<CellUpdate>> = {
  inventory: syncInventory,
  pricing: syncSalesOrders,
  profit: syncFinancials,
  customers: syncCustomers,
  purchasing: syncPurchasing,
};

/** The built-in cell slugs that have a real Odoo-backed data source — used by the demo-data reset (src/app/api/settings/reset-demo-data/route.ts) to know which cells to leave alone. */
export const ODOO_LINKED_CELL_SLUGS = Object.keys(CELL_SYNCERS);

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
      const insight = await aiInsight(cell.name, update.insight, update.kpis);
      const existingSources = Array.isArray(cell.sources) ? (cell.sources as unknown[]) : [];
      const sources = existingSources.includes("أودو") ? existingSources : [...existingSources, "أودو"];

      await prisma.$transaction([
        prisma.cell.update({
          where: { id: cell.id },
          data: {
            kpis: update.kpis as never,
            chart: update.chart as never,
            insight,
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

/**
 * Pulls the store's real legal/trading name from Odoo (res.company) and
 * updates Store.name to match — this is what keeps the merchant's real
 * business name showing everywhere in the app (topbar, settings) instead of
 * the generic placeholder every store starts with, without ever asking the
 * merchant to type it in twice. Best-effort: a failure here must never break
 * a connect/sync — the store keeps whatever name it already had.
 */
export async function syncOdooStoreName(storeId: string, cfg: OdooConfig, uid: number): Promise<string | null> {
  try {
    const rows = (await odooExecuteKw(cfg, uid, "res.company", "search_read", [[]], {
      fields: ["name"],
      limit: 1,
    })) as Array<{ name?: string }>;
    const name = rows?.[0]?.name?.trim();
    if (!name) return null;
    await prisma.store.update({ where: { id: storeId }, data: { name } });
    return name;
  } catch (err) {
    logger.error({ err, storeId }, "odoo store-name sync failed");
    return null;
  }
}

const PRODUCT_SYNC_LIMIT = 200;

/** Best-effort sniff of an Odoo base64 image field's real format, so the data: URI's declared mime type actually matches the bytes instead of being guessed wrong and failing to render. */
function sniffImageDataUri(base64: string | false | undefined | null): string | null {
  if (!base64 || typeof base64 !== "string") return null;
  const mime = base64.startsWith("/9j/")
    ? "image/jpeg"
    : base64.startsWith("iVBORw0KGgo")
      ? "image/png"
      : base64.startsWith("R0lGOD")
        ? "image/gif"
        : "image/jpeg"; // Odoo's product thumbnail fields are JPEG-encoded by default
  return `data:${mime};base64,${base64}`;
}

async function salesVelocityByProduct(
  cfg: OdooConfig,
  uid: number,
  productIds: number[]
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (!productIds.length) return map;
  const rows = (await odooExecuteKw(cfg, uid, "sale.order.line", "read_group", [
    [
      ["product_id", "in", productIds],
      ["order_id.state", "in", ["sale", "done"]],
      ["order_id.create_date", ">=", odooDateTime(daysAgo(30))],
    ],
    ["product_uom_qty:sum"],
    ["product_id"],
  ])) as Array<{ product_id?: [number, string]; product_uom_qty?: number }>;
  for (const r of rows) {
    const pid = Array.isArray(r.product_id) ? r.product_id[0] : undefined;
    if (typeof pid === "number") map.set(pid, Math.round(r.product_uom_qty || 0));
  }
  return map;
}

export type ProductSyncOutcome = { ok: boolean; count: number; message: string };

/**
 * Syncs a real, lightweight product catalog from Odoo into our own Product
 * table — name, SKU, price, stock on hand, real 30-day sales velocity, and
 * a thumbnail image when Odoo has one. This feeds the "المنتجات" page and
 * the stagnant/overpriced-product discount generator below. Capped at
 * PRODUCT_SYNC_LIMIT products per sync to keep this bounded and fast
 * regardless of catalog size — a merchant with a larger catalog can ask for
 * this cap to be raised or paginated later.
 */
export async function syncProducts(storeId: string, cfg: OdooConfig, uid: number): Promise<ProductSyncOutcome> {
  try {
    const rows = (await odooExecuteKw(cfg, uid, "product.product", "search_read", [[["type", "!=", "service"]]], {
      fields: ["id", "display_name", "default_code", "list_price", "qty_available", "image_128"],
      limit: PRODUCT_SYNC_LIMIT,
    })) as Array<{
      id: number;
      display_name?: string;
      default_code?: string | false;
      list_price?: number;
      qty_available?: number;
      image_128?: string | false;
    }>;

    const productIds = rows.map((r) => r.id);
    const velocity = await salesVelocityByProduct(cfg, uid, productIds);

    for (const r of rows) {
      const data = {
        name: r.display_name || "منتج بلا اسم",
        sku: typeof r.default_code === "string" ? r.default_code : null,
        price: typeof r.list_price === "number" ? r.list_price : 0,
        qtyAvailable: typeof r.qty_available === "number" ? Math.round(r.qty_available) : 0,
        salesLast30: velocity.get(r.id) || 0,
        imageDataUrl: sniffImageDataUri(r.image_128),
      };
      await prisma.product.upsert({
        where: { storeId_odooId: { storeId, odooId: r.id } },
        update: data,
        create: { storeId, odooId: r.id, ...data },
      });
    }

    // Drop products that no longer exist (deleted/archived) in Odoo — this
    // table always mirrors Odoo's current catalog, never accumulates stale
    // rows for products the merchant removed there.
    await prisma.product.deleteMany({
      where: { storeId, odooId: { notIn: productIds.length ? productIds : [-1] } },
    });

    return { ok: true, count: rows.length, message: `تمت مزامنة ${rows.length} منتج` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "خطأ غير معروف";
    logger.error({ err, storeId }, "odoo product sync failed");
    return { ok: false, count: 0, message };
  }
}

/**
 * Real, non-AI product-level analysis: a product with zero sales in the
 * last 30 days AND a price above the store's own average is a concrete,
 * grounded discount candidate — no invented numbers, no AI call needed for
 * the detection itself. Creates a real pending Decision (never
 * auto-executed — status PENDING, autoEligible false) for the pricing cell.
 * Capped at 5 new decisions per run, and skips a product that already has
 * an open pending decision, so a store with many stagnant products doesn't
 * get flooded with dozens of decisions in one sync.
 */
export async function generatePricingDecisions(storeId: string): Promise<number> {
  const products = await prisma.product.findMany({ where: { storeId } });
  if (!products.length) return 0;

  const avgPrice = products.reduce((a: number, p: Product) => a + p.price, 0) / products.length;
  const candidates = products.filter((p: Product) => p.salesLast30 === 0 && p.price > avgPrice && p.qtyAvailable > 0);
  if (!candidates.length) return 0;

  const pricingCell = await prisma.cell.findFirst({ where: { storeId, slug: "pricing" } });
  if (!pricingCell) return 0;

  let created = 0;
  for (const p of candidates.slice(0, 5)) {
    const existing = await prisma.decision.findFirst({
      where: { storeId, cellId: pricingCell.id, status: "PENDING", title: { contains: p.name } },
    });
    if (existing) continue;

    await prisma.decision.create({
      data: {
        storeId,
        cellId: pricingCell.id,
        title: `تخفيض سعر "${p.name}" الراكد`,
        category: "فرصة",
        description: `منتج "${p.name}" سعره ${formatSar(p.price)} ر.س — أعلى من متوسط أسعار متجرك (${formatSar(avgPrice)} ر.س) — ولم يُسجَّل له أي مبيعات خلال آخر ٣٠ يوماً، رغم توفر ${p.qtyAvailable} قطعة في المخزون.`,
        reason: "منتج راكد المبيعات وسعره أعلى من متوسط المتجر — خصم مدروس أقرب لتحريك مبيعاته من بقائه مجمّداً في المخزون.",
        evidence: [
          "0 مبيعات خلال آخر 30 يوماً",
          `السعر ${formatSar(p.price)} ر.س مقابل متوسط المتجر ${formatSar(avgPrice)} ر.س`,
          `${p.qtyAvailable} قطعة متوفرة في المخزون حالياً`,
        ],
        impact: 0,
        impactLabel: "الأثر المالي يعتمد على نسبة الخصم التي تختارها",
        confidence: 60,
        risk: "منخفض",
        status: "PENDING",
        autoEligible: false,
        supportCells: ["pricing", "inventory"],
        opposeCells: [],
        steps: [
          `مراجعة سعر "${p.name}" الحالي (${formatSar(p.price)} ر.س)`,
          "تحديد نسبة خصم مناسبة (مثال: ١٥–٢٥٪)",
          "تفعيل الخصم من أودو أو من متجرك الإلكتروني",
        ],
      },
    });
    created++;
  }
  return created;
}

export type OdooFullSyncResult = {
  cellOutcomes: CellSyncOutcome[];
  storeName: string | null;
  products: ProductSyncOutcome;
  newPricingDecisions: number;
};

/**
 * The single entry point both the connect route and the manual "sync now"
 * button call: real cell KPIs, the store's real name, a real product
 * catalog, and real stagnant-product discount candidates — all from the
 * same Odoo credentials, in one pass. Every step is independently
 * best-effort (see each function's own try/catch) so one failing step never
 * blocks the others.
 */
export async function syncOdooEverything(storeId: string, cfg: OdooConfig, uid: number): Promise<OdooFullSyncResult> {
  const cellOutcomes = await syncOdooCells(storeId, cfg, uid);
  const storeName = await syncOdooStoreName(storeId, cfg, uid);
  const products = await syncProducts(storeId, cfg, uid);
  const newPricingDecisions = products.ok ? await generatePricingDecisions(storeId) : 0;
  return { cellOutcomes, storeName, products, newPricingDecisions };
}
