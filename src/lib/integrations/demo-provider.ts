import { IntegrationProvider, IntegrationSnapshot } from "./types";
import { findIntegrationCatalogEntry } from "./catalog";

/**
 * The default provider for every integration until a real one is wired in.
 * Returns realistic, clearly-labelled illustrative data — this is what lets
 * a brand-new store see a fully-populated Integrations page on day one
 * without any real platform connected yet.
 */
export class DemoProvider implements IntegrationProvider {
  constructor(public readonly id: string) {}

  async getSnapshot(): Promise<IntegrationSnapshot> {
    const entry = findIntegrationCatalogEntry(this.id);
    return {
      status: "DISCONNECTED",
      lastSyncLabel: "—",
      reads: entry ? demoReadsFor(entry.id) : [],
      actions: entry ? demoActionsFor(entry.id) : [],
    };
  }

  async connect(): Promise<IntegrationSnapshot> {
    return {
      status: "CONNECTED",
      lastSyncLabel: "الآن",
      reads: demoReadsFor(this.id),
      actions: demoActionsFor(this.id),
    };
  }
}

function demoReadsFor(id: string): string[] {
  switch (id) {
    case "salla":
      return ["المنتجات والمخزون", "الطلبات والمبيعات", "بيانات العملاء"];
    case "zid":
      return ["المنتجات والمخزون", "الطلبات والمبيعات"];
    case "odoo":
      return [
        "المخزون والمستودعات",
        "الفواتير والحسابات",
        "الطلبات والمبيعات",
        "بيانات العملاء (CRM)",
      ];
    case "accounting":
      return ["الفواتير والمصروفات", "الضرائب والتكاليف التشغيلية"];
    case "payment":
      return ["عمليات الدفع والرسوم", "العمليات المرفوضة"];
    case "whatsapp":
      return ["محادثات الدعم"];
    default:
      return [];
  }
}

function demoActionsFor(id: string): string[] {
  switch (id) {
    case "salla":
      return ["تعديل الأسعار", "تحديث المخزون", "تفعيل العروض"];
    case "odoo":
      return ["اقتراح تعديل سعر (بموافقتك)", "اقتراح طلب تزويد مخزون (بموافقتك)"];
    case "payment":
      return ["تفعيل وسيلة دفع جديدة"];
    case "whatsapp":
      return ["إرسال رسائل تلقائية"];
    default:
      return ["لا يوجد تنفيذ آلي — قراءة فقط"];
  }
}
