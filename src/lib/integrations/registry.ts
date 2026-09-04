import { DemoProvider } from "./demo-provider";
import { OdooProvider } from "./odoo-provider";
import { IntegrationProvider } from "./types";
import { INTEGRATION_CATALOG } from "./catalog";

/**
 * Flip this to true once OdooProvider.connect/getSnapshot are actually
 * implemented against a real Odoo instance. Until then every provider,
 * Odoo included, resolves to DemoProvider so the UI stays fully functional
 * with illustrative data.
 */
const ODOO_PROVIDER_ENABLED = false;

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
