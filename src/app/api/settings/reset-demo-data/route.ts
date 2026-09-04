import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api";
import { prisma } from "@/lib/db";
import { ODOO_LINKED_CELL_SLUGS } from "@/lib/integrations/odoo-sync";
import type { Cell } from "@prisma/client";

/**
 * One-click cleanup for merchants who no longer want the illustrative demo
 * content the app ships with on first deploy (see prisma/seed-data.json):
 *
 *  - Every Decision is deleted outright. Automation rows cascade-delete with
 *    their Decision (onDelete: Cascade in schema.prisma) — no explicit
 *    automation.deleteMany() needed.
 *  - Every built-in cell that has no real data source wired up yet (i.e.
 *    every cell except the four Odoo-linked ones — see odoo-sync.ts) is
 *    reset to the same "awaiting a data source" placeholder shape the app
 *    already uses for a brand-new merchant-created cell (POST /api/cells),
 *    so this doesn't invent a new visual state — it reuses one that's
 *    already designed and tested.
 *  - Odoo-linked cells (inventory, pricing/sales, profit/financials,
 *    customers) are left untouched — their numbers are real, not demo data.
 *  - Custom (merchant-created) cells are left untouched — deleting or
 *    resetting a merchant's own work is out of scope here.
 */
const PLACEHOLDER_KPIS = [
  { label: "حالة البيانات", value: "بانتظار الربط", delta: null },
  { label: "مصدر بيانات حقيقي", value: "غير متوفر حالياً", delta: null },
  { label: "مصادر مرتبطة", value: "0 مصدر", delta: null },
];
const PLACEHOLDER_CHART = [
  { l: "الأسبوع 1", v: 0 },
  { l: "الأسبوع 2", v: 0 },
  { l: "الأسبوع 3", v: 0 },
  { l: "الأسبوع 4", v: 0 },
];
const PLACEHOLDER_INSIGHT =
  "لا توجد بيانات حقيقية مرتبطة بهذه الخلية بعد — الأرقام التجريبية أُزيلت. سيتم عرض تحليل حقيقي هنا فور ربط مصدر بيانات مناسب.";

export const POST = withRoute(async (_req, ctx) => {
  const [deletedDecisions, cellsToReset] = await Promise.all([
    prisma.decision.deleteMany({ where: { storeId: ctx.storeId } }),
    prisma.cell.findMany({
      where: { storeId: ctx.storeId, isCustom: false, slug: { notIn: ODOO_LINKED_CELL_SLUGS } },
    }),
  ]);

  await prisma.$transaction(
    cellsToReset.map((cell: Cell) =>
      prisma.cell.update({
        where: { id: cell.id },
        data: {
          kpis: PLACEHOLDER_KPIS as never,
          chart: PLACEHOLDER_CHART as never,
          sources: [] as never,
          insight: PLACEHOLDER_INSIGHT,
        },
      })
    )
  );

  return NextResponse.json({
    deletedDecisions: deletedDecisions.count,
    resetCells: cellsToReset.map((c: Cell) => c.slug),
  });
});
