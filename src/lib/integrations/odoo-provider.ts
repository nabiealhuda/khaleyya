import {
  IntegrationConfigError,
  IntegrationProvider,
  IntegrationSnapshot,
} from "./types";

/**
 * Real Odoo connection — NOT YET WIRED UP.
 *
 * Per the merchant's request, the real Salla/Zid/Odoo integrations are
 * intentionally deferred until after the site itself is complete. This
 * class exists so the plug-in point is obvious and ready: once Odoo
 * credentials are available, implement the two methods below and flip
 * `ODOO_PROVIDER_ENABLED` in src/lib/integrations/registry.ts to swap this
 * in for the DemoProvider — no other file in the app needs to change.
 *
 * Expected config shape (to be entered by the merchant in Settings once this
 * is enabled):
 *   {
 *     url: string;      // e.g. https://mycompany.odoo.com
 *     db: string;        // Odoo database name
 *     username: string;  // Odoo login (usually an email)
 *     apiKey: string;    // Odoo API key (Settings → Users → API Keys) — must
 *                        // be stored encrypted at rest, never in plaintext
 *                        // JSON like the current IntegrationConnection.config
 *                        // column; add an encryption layer before enabling.
 *   }
 *
 * Odoo exposes both a legacy XML-RPC endpoint (/xmlrpc/2/common,
 * /xmlrpc/2/object) and a JSON-RPC endpoint (/jsonrpc). JSON-RPC is the
 * simpler one to consume from Node without an XML-RPC library — recommend
 * starting there: authenticate via `call` on the `common` service to get a
 * uid, then call `execute_kw` on the `object` service for reads/writes
 * against models like `product.product`, `sale.order`, `res.partner`, etc.
 */
export class OdooProvider implements IntegrationProvider {
  readonly id = "odoo";

  async getSnapshot(config: Record<string, unknown>): Promise<IntegrationSnapshot> {
    void config;
    throw new IntegrationConfigError(
      "الربط الفعلي مع أودو غير مُفعّل بعد. هذا المزوّد جاهز من الناحية البرمجية وينتظر بيانات الدخول (رابط الخادم، قاعدة البيانات، مفتاح API) لإكمال التنفيذ."
    );
  }

  async connect(config: Record<string, unknown>): Promise<IntegrationSnapshot> {
    void config;
    // TODO once credentials are provided:
    // 1. POST to `${url}/jsonrpc` with method "call", service "common",
    //    method "authenticate", args [db, username, apiKey, {}] → uid
    // 2. Store the uid alongside the (encrypted) config.
    // 3. Implement getSnapshot() to call execute_kw against a cheap model
    //    (e.g. count res.partner) as a connectivity check, and surface real
    //    read/action capabilities based on what the API key's user can access.
    throw new IntegrationConfigError(
      "الربط الفعلي مع أودو غير مُفعّل بعد."
    );
  }
}
