/**
 * Every integration (Salla, Zid, Odoo, WhatsApp, ...) is accessed through
 * this one interface. The rest of the app (API routes, UI) never talks to a
 * specific platform's API directly — it talks to whatever IntegrationProvider
 * is registered for that provider id. Today every provider id resolves to
 * DemoProvider (src/lib/integrations/demo-provider.ts), which returns the
 * same illustrative data the original prototype used. Wiring a real
 * connection later — starting with Odoo — means implementing one class that
 * satisfies this interface and registering it in registry.ts; nothing else
 * in the app changes.
 */

export type IntegrationStatus =
  | "CONNECTED"
  | "DISCONNECTED"
  | "NEEDS_UPDATE"
  | "ISSUE";

export type IntegrationSnapshot = {
  status: IntegrationStatus;
  lastSyncLabel: string;
  reads: string[];
  actions: string[];
};

export interface IntegrationProvider {
  readonly id: string;
  /** Fetches current connection status + capability summary for one store. */
  getSnapshot(config: Record<string, unknown>): Promise<IntegrationSnapshot>;
  /**
   * Attempts to establish/refresh the connection using merchant-supplied
   * config (URL, API key, etc). Throws IntegrationConfigError with a
   * user-facing message on failure.
   */
  connect(config: Record<string, unknown>): Promise<IntegrationSnapshot>;
}

export class IntegrationConfigError extends Error {}
