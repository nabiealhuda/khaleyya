import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { INTEGRATION_CATALOG } from "../src/lib/integrations/catalog";
import seedData from "./seed-data.json";

const prisma = new PrismaClient();

// Demo content extracted verbatim from the published خَلِيّة dashboard, so the
// first-run experience after a fresh deploy looks exactly like the artifact
// the merchant already reviewed and approved — just now backed by a real,
// persistent database instead of in-memory arrays that reset on reload.
const { CELLS, DECISIONS, AUTOMATIONS, ACTIVITY_FEED, CELL_TASKS } = seedData as {
  CELLS: Array<{
    id: string;
    name: string;
    tagline: string;
    icon: string;
    color: string;
    score: number;
    kpis: unknown;
    chart: unknown;
    sources: unknown;
    insight: string;
  }>;
  DECISIONS: Array<{
    id: string;
    title: string;
    cellId: string;
    category: string;
    desc: string;
    reason: string;
    evidence: string[];
    impact: number;
    impactLabel: string;
    confidence: number;
    risk: string;
    date: string;
    support: string[];
    oppose: string[];
    status: string;
    auto: boolean;
    steps: string[];
    result?: string;
    resultNote?: string;
  }>;
  AUTOMATIONS: Array<{
    id: string;
    decisionId: string;
    title: string;
    changes: string[];
    expected: string;
    risk: string;
    reversible: boolean;
    perms: string[];
    status: string;
    result?: string;
  }>;
  ACTIVITY_FEED: Array<{ cellId: string; text: string }>;
  CELL_TASKS: Array<{ id: string; cellId: string; title: string; freq: string; source: string }>;
};

const DECISION_STATUS_MAP: Record<string, "PENDING" | "IN_PROGRESS" | "DONE" | "FAILED" | "REJECTED"> = {
  "ينتظر الموافقة": "PENDING",
  "قيد التنفيذ": "IN_PROGRESS",
  "تم التنفيذ": "DONE",
  "لم يحقق النتيجة": "FAILED",
  "مرفوض": "REJECTED",
};

const AUTOMATION_STATUS_MAP: Record<string, "IN_PROGRESS" | "DONE" | "FAILED"> = {
  "قيد التنفيذ": "IN_PROGRESS",
  "تم التنفيذ": "DONE",
  "لم يحقق النتيجة": "FAILED",
};

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@khaleyya.local";
  const password = process.env.SEED_ADMIN_PASSWORD ?? "change-me-now-12345";
  const storeName = process.env.SEED_STORE_NAME ?? "متجر أثارة للعطور";
  const adminName = process.env.SEED_ADMIN_NAME ?? "عبدالإله";

  const store = await prisma.store.upsert({
    where: { id: "seed-store" },
    update: {},
    create: { id: "seed-store", name: storeName },
  });

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      storeId: store.id,
      name: adminName,
      email,
      passwordHash,
      role: "OWNER",
    },
  });

  // ---- Cells (10 built-in) ----------------------------------------------
  const cellIdBySlug = new Map<string, string>();
  for (const [index, c] of CELLS.entries()) {
    const cell = await prisma.cell.upsert({
      where: { storeId_slug: { storeId: store.id, slug: c.id } },
      update: {},
      create: {
        storeId: store.id,
        slug: c.id,
        name: c.name,
        tagline: c.tagline,
        icon: c.icon,
        color: c.color,
        score: c.score,
        isCustom: false,
        sortOrder: index,
        kpis: c.kpis as never,
        chart: c.chart as never,
        sources: c.sources as never,
        insight: c.insight,
      },
    });
    cellIdBySlug.set(c.id, cell.id);
  }

  // ---- Decisions (full demo set) -----------------------------------------
  const decisionIdByOldId = new Map<string, string>();
  const existingDecisions = await prisma.decision.count({ where: { storeId: store.id } });
  if (existingDecisions === 0) {
    for (const d of DECISIONS) {
      const cellId = cellIdBySlug.get(d.cellId);
      if (!cellId) continue; // skip if a decision references a cell that no longer exists
      const status = DECISION_STATUS_MAP[d.status] ?? "PENDING";
      const resultNote = d.resultNote ?? null;
      const created = await prisma.decision.create({
        data: {
          storeId: store.id,
          cellId,
          title: d.title,
          category: d.category,
          description: d.desc,
          reason: d.reason,
          evidence: d.evidence,
          impact: d.impact,
          impactLabel: d.impactLabel,
          confidence: d.confidence,
          risk: d.risk,
          status,
          autoEligible: d.auto,
          supportCells: d.support,
          opposeCells: d.oppose,
          steps: d.steps,
          resultNote,
          occurredLabel: d.date,
        },
      });
      decisionIdByOldId.set(d.id, created.id);
    }
  } else {
    // Re-running the seed later (e.g. redeploy): recover the id map so
    // automations can still link up if this block is ever re-entered.
    const existing = await prisma.decision.findMany({ where: { storeId: store.id } });
    for (const d of existing) decisionIdByOldId.set(d.title, d.id);
  }

  // ---- Automations (execution log tied to decisions) ---------------------
  const existingAutomations = await prisma.automation.count({ where: { storeId: store.id } });
  if (existingAutomations === 0) {
    for (const a of AUTOMATIONS) {
      const decisionId = decisionIdByOldId.get(a.decisionId);
      if (!decisionId) continue;
      const decision = await prisma.decision.findUnique({ where: { id: decisionId } });
      if (!decision) continue;
      await prisma.automation.create({
        data: {
          storeId: store.id,
          decisionId,
          cellId: decision.cellId,
          title: a.title,
          changes: a.changes,
          expected: a.expected,
          risk: a.risk,
          reversible: a.reversible,
          perms: a.perms,
          status: AUTOMATION_STATUS_MAP[a.status] ?? "IN_PROGRESS",
          result: a.result ?? null,
        },
      });
    }
  }

  // ---- Cell tasks (full demo set, ~30 system tasks) -----------------------
  const existingTasks = await prisma.cellTask.count({ where: { storeId: store.id } });
  if (existingTasks === 0) {
    const rows = CELL_TASKS.map((t) => {
      const cellId = cellIdBySlug.get(t.cellId);
      if (!cellId) return null;
      return {
        storeId: store.id,
        cellId,
        title: t.title,
        freq: t.freq,
        source: t.source,
      };
    }).filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length) await prisma.cellTask.createMany({ data: rows });
  }

  // ---- Activity feed -------------------------------------------------------
  const existingActivity = await prisma.activityItem.count({ where: { storeId: store.id } });
  if (existingActivity === 0) {
    const rows = ACTIVITY_FEED.map((a) => {
      const cellId = cellIdBySlug.get(a.cellId);
      if (!cellId) return null;
      return { storeId: store.id, cellId, text: a.text };
    }).filter((r): r is NonNullable<typeof r> => r !== null);
    if (rows.length) await prisma.activityItem.createMany({ data: rows });
  }

  // ---- Meeting room welcome message ----------------------------------------
  const existingMeeting = await prisma.meetingMessage.count({ where: { storeId: store.id } });
  if (existingMeeting === 0) {
    await prisma.meetingMessage.create({
      data: {
        storeId: store.id,
        role: "LEADER",
        text: "أهلاً بك في غرفة الاجتماعات. اختر أعضاء الاجتماع من الخلايا أدناه، ثم اكتب موضوعك، وسأنسّق الرد بينك وبين الخلايا المعنية.",
      },
    });
  }

  // ---- Integration connection rows (all disconnected until the merchant
  // connects a real platform; Odoo stays a stub until later per plan) -------
  for (const entry of INTEGRATION_CATALOG) {
    await prisma.integrationConnection.upsert({
      where: { storeId_providerId: { storeId: store.id, providerId: entry.id } },
      update: {},
      create: { storeId: store.id, providerId: entry.id, status: "DISCONNECTED", config: {} },
    });
  }

  console.log(`Seed complete. Store: ${store.name} (${store.id}). Admin login: ${email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
