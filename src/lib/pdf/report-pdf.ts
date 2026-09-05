import path from "path";
import PDFDocument from "pdfkit";
import type { Cell, Decision } from "@prisma/client";

/**
 * PDF report generation.
 *
 * IMPORTANT (validated empirically before writing this file — do not "fix"):
 * pdfkit + its bundled fontkit renders Arabic correctly (contextual letter
 * joining, correct right-to-left order, embedded Latin numbers/currency
 * staying in the right internal order) as long as we hand it PLAIN,
 * UNPROCESSED, logical-order Unicode text with a proper Arabic font
 * registered and `align: "right"`. Manually reshaping (arabic-reshaper) or
 * reversing the text before drawing it BREAKS rendering — it was tried and
 * visually confirmed broken. So every text-drawing helper below must keep
 * passing raw strings straight through.
 */

const ARABIC_FONT_PATH = path.join(process.cwd(), "public/fonts/NotoNaskhArabic-Regular.ttf");
const PAGE_MARGIN = 50;
const CONTENT_WIDTH = 495; // A4 (595pt) minus 2*50 margin

type KpiItem = { label?: unknown; value?: unknown; delta?: unknown; up?: unknown };

function asKpis(kpis: unknown): KpiItem[] {
  return Array.isArray(kpis) ? (kpis as KpiItem[]) : [];
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function newDoc(): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });
  doc.registerFont("arabic", ARABIC_FONT_PATH);
  doc.font("arabic");
  return doc;
}

function bufferFromDoc(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

function drawHeading(doc: PDFKit.PDFDocument, text: string, size = 20) {
  ensureSpace(doc, size + 14);
  doc.fontSize(size).fillColor("#111111").text(text, PAGE_MARGIN, doc.y, {
    width: CONTENT_WIDTH,
    align: "right",
  });
  doc.moveDown(0.4);
}

function drawSubheading(doc: PDFKit.PDFDocument, text: string) {
  ensureSpace(doc, 26);
  doc.fontSize(13).fillColor("#333333").text(text, PAGE_MARGIN, doc.y, {
    width: CONTENT_WIDTH,
    align: "right",
  });
  doc.moveDown(0.3);
}

function drawParagraph(doc: PDFKit.PDFDocument, text: string, opts: { size?: number; color?: string } = {}) {
  const size = opts.size ?? 11;
  ensureSpace(doc, size + 10);
  doc.fontSize(size).fillColor(opts.color ?? "#333333").text(text, PAGE_MARGIN, doc.y, {
    width: CONTENT_WIDTH,
    align: "right",
  });
  doc.moveDown(0.5);
}

function drawDivider(doc: PDFKit.PDFDocument) {
  ensureSpace(doc, 16);
  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y)
    .strokeColor("#dddddd")
    .stroke();
  doc.moveDown(0.6);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
  }
}

function drawKpiRow(doc: PDFKit.PDFDocument, kpi: KpiItem) {
  ensureSpace(doc, 20);
  const label = String(kpi.label ?? "");
  const value = String(kpi.value ?? "");
  const delta = kpi.delta;
  const deltaText = delta != null ? ` (${kpi.up ? "▲" : "▼"} ${Math.abs(Number(delta))}%)` : "";
  doc.fontSize(11).fillColor("#111111").text(`${label}:  ${value}${deltaText}`, PAGE_MARGIN, doc.y, {
    width: CONTENT_WIDTH,
    align: "right",
  });
  doc.moveDown(0.3);
}

function drawBulletList(doc: PDFKit.PDFDocument, items: string[]) {
  for (const item of items) {
    ensureSpace(doc, 18);
    doc.fontSize(10.5).fillColor("#333333").text(`• ${item}`, PAGE_MARGIN, doc.y, {
      width: CONTENT_WIDTH,
      align: "right",
    });
    doc.moveDown(0.25);
  }
}

function drawFooterDate(doc: PDFKit.PDFDocument, storeName: string) {
  const generatedAt = new Date().toLocaleString("ar-SA");
  doc.moveDown(0.4);
  doc.fontSize(9).fillColor("#999999").text(`منصة خَلِيّة — ${storeName} — تم إنشاء هذا التقرير في ${generatedAt}`, PAGE_MARGIN, doc.y, {
    width: CONTENT_WIDTH,
    align: "right",
  });
}

const RISK_LABEL: Record<string, string> = {
  منخفض: "منخفض",
  متوسط: "متوسط",
  مرتفع: "مرتفع",
};

export async function buildCellReportPdf(
  storeName: string,
  cell: Cell,
  decisions: Decision[]
): Promise<Buffer> {
  const doc = newDoc();

  drawHeading(doc, `تقرير ${cell.name}`);
  drawParagraph(doc, cell.tagline, { size: 11.5, color: "#555555" });
  drawParagraph(doc, `الدرجة العامة للخلية: ${cell.score} / 100`, { size: 12 });
  drawDivider(doc);

  drawSubheading(doc, "أبرز المؤشرات");
  const kpis = asKpis(cell.kpis);
  if (kpis.length === 0) {
    drawParagraph(doc, "لا توجد مؤشرات مسجلة بعد.");
  } else {
    for (const k of kpis) drawKpiRow(doc, k);
  }
  doc.moveDown(0.4);

  drawSubheading(doc, "ملاحظة الخلية");
  drawParagraph(doc, cell.insight || "لا توجد ملاحظة مسجلة بعد.");

  const sources = asStringList(cell.sources);
  if (sources.length > 0) {
    drawSubheading(doc, "مصادر البيانات");
    drawBulletList(doc, sources);
  }

  drawDivider(doc);
  drawSubheading(doc, "القرارات المرتبطة بهذه الخلية");
  if (decisions.length === 0) {
    drawParagraph(doc, "لا توجد قرارات مسجلة لهذه الخلية بعد.");
  } else {
    for (const d of decisions) {
      ensureSpace(doc, 60);
      doc.fontSize(12).fillColor("#111111").text(d.title, PAGE_MARGIN, doc.y, {
        width: CONTENT_WIDTH,
        align: "right",
      });
      doc.moveDown(0.15);
      doc
        .fontSize(9.5)
        .fillColor("#777777")
        .text(
          `الحالة: ${d.status} — الفئة: ${d.category} — الأثر: ${d.impactLabel} — الثقة: ${d.confidence}% — المخاطرة: ${RISK_LABEL[d.risk] ?? d.risk}`,
          PAGE_MARGIN,
          doc.y,
          { width: CONTENT_WIDTH, align: "right" }
        );
      doc.moveDown(0.2);
      doc.fontSize(10.5).fillColor("#444444").text(d.description, PAGE_MARGIN, doc.y, {
        width: CONTENT_WIDTH,
        align: "right",
      });
      doc.moveDown(0.5);
    }
  }

  drawFooterDate(doc, storeName);
  return bufferFromDoc(doc);
}

export async function buildOverviewReportPdf(storeName: string, cells: Cell[]): Promise<Buffer> {
  const doc = newDoc();

  drawHeading(doc, "تقرير أداء الخلايا");
  drawParagraph(doc, `متجر ${storeName} — نظرة عامة على كل الخلايا ودرجاتها ومؤشراتها الرئيسية.`, {
    size: 11.5,
    color: "#555555",
  });
  drawDivider(doc);

  const sorted = [...cells].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const c of sorted) {
    drawSubheading(doc, `${c.name} — الدرجة: ${c.score}/100`);
    drawParagraph(doc, c.tagline, { size: 10, color: "#777777" });
    const kpis = asKpis(c.kpis).slice(0, 4);
    for (const k of kpis) drawKpiRow(doc, k);
    if (c.insight) {
      doc.fontSize(10).fillColor("#444444").text(c.insight, PAGE_MARGIN, doc.y, {
        width: CONTENT_WIDTH,
        align: "right",
      });
      doc.moveDown(0.4);
    }
    drawDivider(doc);
  }

  drawFooterDate(doc, storeName);
  return bufferFromDoc(doc);
}
