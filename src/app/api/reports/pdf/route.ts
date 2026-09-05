import { NextResponse } from "next/server";
import { withRoute, jsonError } from "@/lib/api";
import { prisma } from "@/lib/db";
import { buildCellReportPdf, buildOverviewReportPdf } from "@/lib/pdf/report-pdf";

/**
 * Real downloadable PDF reports (user request #7).
 * - GET /api/reports/pdf?cellId=<slug>  -> a detailed report for one cell
 * - GET /api/reports/pdf                -> an overview of every cell
 * Both are built from the store's real, current data (see report-pdf.ts) —
 * nothing here is a template with placeholder numbers.
 */
export const GET = withRoute(async (req, ctx) => {
  const url = new URL(req.url);
  const cellSlug = url.searchParams.get("cellId");

  const store = await prisma.store.findUnique({ where: { id: ctx.storeId } });
  if (!store) return jsonError("المتجر غير موجود", 404);

  let buffer: Buffer;
  let filename: string;

  if (cellSlug) {
    const cell = await prisma.cell.findFirst({ where: { storeId: ctx.storeId, slug: cellSlug } });
    if (!cell) return jsonError("الخلية غير موجودة", 404);
    const decisions = await prisma.decision.findMany({
      where: { storeId: ctx.storeId, cellId: cell.id },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    buffer = await buildCellReportPdf(store.name, cell, decisions);
    filename = `tagrir-${cell.slug}.pdf`;
  } else {
    const cells = await prisma.cell.findMany({ where: { storeId: ctx.storeId }, orderBy: { sortOrder: "asc" } });
    buffer = await buildOverviewReportPdf(store.name, cells);
    filename = "tagrir-adaa-alkhalaya.pdf";
  }

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
});
