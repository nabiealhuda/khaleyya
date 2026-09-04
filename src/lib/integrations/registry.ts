import { DemoProvider } from "./demo-provider";
import { OdooProvider } from "./odoo-provider";
import { IntegrationProvider } from "./types";
import { INTEGRATION_CATALOG } from "./catalog";

/**
 * OdooProvider.connect/getSnapshot are now implemented against a real Odoo
 * instance over JSON-RPC (see odoo-provider.ts) — enabled. Every other
 * provider still resolves to DemoProvider until wired the same way.
 */
const ODOO_PROVIDER_ENABLED = true;

const providers = new Map<string, IntegrationProvider>();

for (const entry of INTEGRATION_CATALOG) {
  providers.set(entry.id, new DemoProvider(entry.id));
}

if (ODOO_PROVIDER_ENABLED) {
  providers.set("odoo", new OdooProvider());
}

export function getIntegrationProvider(providerId: string): IntegrationProvider | undefined {
  return providers.get(providerId);
}
