import { DemoProvider } from "./demo-provider";
import { OdooProvider } from "./odoo-provider";
import { MarketSearchProvider } from "./marketsearch-provider";
import { IntegrationProvider } from "./types";
import { INTEGRATION_CATALOG } from "./catalog";

/**
 * OdooProvider and MarketSearchProvider are implemented against real
 * services (Odoo JSON-RPC, SerpApi — see odoo-provider.ts and
 * marketsearch-provider.ts) — enabled. Every other provider still resolves
 * to DemoProvider until wired the same way.
 */
const ODOO_PROVIDER_ENABLED = true;
const MARKETSEARCH_PROVIDER_ENABLED = true;

const providers = new Map<string, IntegrationProvider>();

for (const entry of INTEGRATION_CATALOG) {
  providers.set(entry.id, new DemoProvider(entry.id));
}

if (ODOO_PROVIDER_ENABLED) {
  providers.set("odoo", new OdooProvider());
}
if (MARKETSEARCH_PROVIDER_ENABLED) {
  providers.set("marketsearch", new MarketSearchProvider());
}

export function getIntegrationProvider(providerId: string): IntegrationProvider | undefined {
  return providers.get(providerId);
}
