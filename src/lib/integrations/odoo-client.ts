import { IntegrationConfigError } from "./types";

/**
 * Low-level Odoo JSON-RPC client, shared by odoo-provider.ts (connect/auth
 * check) and odoo-sync.ts (pulling real cell data). Kept separate from both
 * so neither has to reach into the other's internals.
 */

export type OdooConfig = { url: string; db: string; username: string; apiKey: string };

export function parseOdooConfig(config: Record<string, unknown>): OdooConfig {
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
    throw new IntegrationConfigError("تعذّر الوصول إلى خادم أودو — تحقق من رابط الخادم واتصال الشبكة.");
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

export async function odooAuthenticate(cfg: OdooConfig): Promise<number> {
  const uid = await jsonRpcCall(cfg.url, "common", "authenticate", [cfg.db, cfg.username, cfg.apiKey, {}]);
  if (typeof uid !== "number" || uid <= 0) {
    throw new IntegrationConfigError(
      "فشل تسجيل الدخول إلى أودو — تحقق من اسم قاعدة البيانات، اسم المستخدم، ومفتاح API (وليس كلمة المرور)."
    );
  }
  return uid;
}

/** Thin wrapper over the object/execute_kw RPC — the workhorse for every real read (search_count, search_read, read_group, ...). */
export async function odooExecuteKw(
  cfg: OdooConfig,
  uid: number,
  model: string,
  method: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {}
): Promise<unknown> {
  return jsonRpcCall(cfg.url, "object", "execute_kw", [cfg.db, uid, cfg.apiKey, model, method, args, kwargs]);
}
