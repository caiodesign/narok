/**
 * Build-time feature flags.
 *
 * Ruling R185: `VITE_FEATURE_SHOP` gates every sale control — the item tip's
 * Sell and the bag's bulk sale — and defaults off, because prices are
 * deferred (spec §4.0), `/api/inventory/sell` is unimplemented and B-15
 * stays open behind prices. The NPC shop and potion purchase ship no route, no component
 * and no price key at all. `apps/client/test/shop-flag.test.ts` builds the
 * bundle and asserts no sale entry point is in it while the flag is off.
 */
export const SHOP_ENABLED: boolean = import.meta.env.VITE_FEATURE_SHOP === 'true';
