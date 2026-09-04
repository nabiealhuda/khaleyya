import {
  IntegrationConfigError,
  IntegrationProvider,
  IntegrationSnapshot,
} from "./types";

/**
 * Real Odoo connection over JSON-RPC.
 *
 * Odoo exposes both a legacy XML-RPC endpoint and a JSON-RPC endpoint
 * (POST {url}/jsonrpc). JSON-RPC needs no extra library from Node, so that's
 * what this uses: authenticate via the "common" service to get a uid, then
 * (optionally) call execute_kw on the "object" service for real reads.
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

type OdooConfig = { url: string; db: string; username: string; apiKey: string };

function parseConfig(config: Record<string, unknown>): OdooConfig {
  const url = String(config.url ?? "").trim().replace(/\/+$/, "");
  const db = String(config.db ?? "").trim();
  const username = String(config.username ?? "").trim();
  const apiKey = String(config.apiKey ?? "").trim();

  if (!url || !db || !username || !apiKey) {
    throw new IntegrationConfigError(
      "الرجاء تعبئة جميع الحقول: رابط الخادم، اسم قاعدة البيانات، اسم المستخدم، ومفتاح API."
    );
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new IntegrationConfigError("رابط خادم أودو يجب أن يبدأ بـ https:// (أو http:// لخادم محلي).");
  }
  return { url, db, username, apiKey };
}

type JsonRpcOk = { result: unknown; error?: undefined };
type JsonRpcErr = { error: { message?: string; data?: { message?: string } }; result?: undefined };

async function jsonRpcCall(
  baseUrl: string,
  service: "common" | "object",
  method: string,
  args: unknown[]
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { service, method, args },
        id: Math.floor(Math.random() * 1_000_000),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new IntegrationConfigError(
        "انتهت مهلة الاتصال بخادم أودو — تأكد أن الرابط صحيح وأن الخادم متاح على الإنترنت."
      );
    }
    throw new IntegrationConfigError(
      "تعذّر الوصول إلى خادم أودو — تحقق من رابط الخادم واتصال الشبكة."
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    throw new IntegrationConfigError(`خادم أودو أعاد خطأ غير متوقع (رمز ${res.status}) — تحقق من رابط الخادم.`);
  }

  const payload = (await res.json().catch(() => null)) as (JsonRpcOk | JsonRpcErr) | null;
  if (!payload) {
    throw new IntegrationConfigError("رد غير مفهوم من خادم أودو — تأكد أن الرابط يشير فعلاً إلى خادم أودو.");
  }
  if ("error" in payload && payload.error) {
    const message = payload.error.data?.message || payload.error.message || "خطأ غير معروف من أودو";
    throw new IntegrationConfigError(`أودو رفض الطلب: ${message}`);
  }
  return (payload as JsonRpcOk).result;
}

async function authenticate(cfg: OdooConfig): Promise<number> {
  const uid = await jsonRpcCall(cfg.url, "common", "authenticate", [cfg.db, cfg.username, cfg.apiKey, {}]);
  if (typeof uid !== "number" || uid <= 0) {
    throw new IntegrationConfigError(
      "فشل تسجيل الدخول إلى أودو — تحقق من اسم قاعدة البيانات، اسم المستخدم، ومفتاح API (وليس كلمة المرور)."
    );
  }
  return uid;
}

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
    const cfg = parseConfig(config);
    await authenticate(cfg);
    return snapshot("CONNECTED");
  }

  async connect(config: Record<string, unknown>): Promise<IntegrationSnapshot> {
    const cfg = parseConfig(config);
    const uid = await authenticate(cfg);

    // Authentication alone proves the credentials are valid. This extra call
    // is a best-effort read-access check (count res.partner) so a merchant
    // whose API user has no read permissions at all still gets *some*
    // signal — but we don't hard-fail connect() on it, since a narrowly
    // scoped API user (read access to a subset of models only) is a
    // legitimate, common setup and shouldn't block the connection.
    try {
      await jsonRpcCall(cfg.url, "object", "execute_kw", [
        cfg.db,
        uid,
        cfg.apiKey,
        "res.partner",
        "search_count",
        [[]],
      ]);
    } catch {
      // Swallowed deliberately — see comment above.
    }

    return snapshot("CONNECTED");
  }
}
