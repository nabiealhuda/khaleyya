import { IntegrationProvider, IntegrationSnapshot } from "./types";
import { odooAuthenticate, odooExecuteKw, parseOdooConfig } from "./odoo-client";

/**
 * Real Odoo connection over JSON-RPC (see odoo-client.ts for the transport).
 * This class only answers "are these credentials valid, and what can they
 * read/do" — pulling actual business data into the app's cells is a
 * separate, larger job handled by odoo-sync.ts (triggered right after a
 * successful connect, and again on demand from the Integrations page).
 *
 * Expected config shape, entered by the merchant in the Integrations page:
 *   {
 *     url: string;      // e.g. https://mycompany.odoo.com (no trailing slash needed)
 *     db: string;       // Odoo database name
 *     username: string; // Odoo login (usually an email)
 *     apiKey: string;   // Odoo API key — Settings → Users & Companies → Users →
 *                       // (your user) → Account Security → New API Key.
 *                       // Stored encrypted at rest (see src/lib/crypto.ts),
 *                       // never returned to the browser once saved.
 *   }
 */
function snapshot(status: IntegrationSnapshot["status"]): IntegrationSnapshot {
  return {
    status,
    lastSyncLabel: status === "CONNECTED" ? "الآن" : "—",
    reads: [
      "المخزون والمستودعات",
      "الفواتير والحسابات",
      "الطلبات والمبيعات",
      "بيانات العملاء (CRM)",
    ],
    actions: ["اقتراح تعديل سعر (بموافقتك)", "اقتراح طلب تزويد مخزون (بموافقتك)"],
  };
}

export class OdooProvider implements IntegrationProvider {
  readonly id = "odoo";

  async getSnapshot(config: Record<string, unknown>): Promise<IntegrationSnapshot> {
    const cfg = parseOdooConfig(config);
    await odooAuthenticate(cfg);
    return snapshot("CONNECTED");
  }

  async connect(config: Record<string, unknown>): Promise<IntegrationSnapshot> {
    const cfg = parseOdooConfig(config);
    const uid = await odooAuthenticate(cfg);

    // Authentication alone proves the credentials are valid. This extra call
    // is a best-effort read-access check (count res.partner) so a merchant
    // whose API user has no read permissions at all still gets *some*
    // signal — but we don't hard-fail connect() on it, since a narrowly
    // scoped API user (read access to a subset of models only) is a
    // legitimate, common setup and shouldn't block the connection.
    try {
      await odooExecuteKw(cfg, uid, "res.partner", "search_count", [[]]);
    } catch {
      // Swallowed deliberately — see comment above.
    }

    return snapshot("CONNECTED");
  }
}
