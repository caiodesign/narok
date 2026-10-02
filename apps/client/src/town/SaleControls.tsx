/**
 * The sale controls (part 4 §3.3; B-15's client half; ruling R185).
 *
 * Reached only through `App.tsx`'s `SHOP_ENABLED ? SALE_KIT : null`, so with
 * `VITE_FEATURE_SHOP` off — the default — no sale control is rendered and the
 * build drops this module (`test/shop-flag.test.ts`). With it on:
 *
 * - a bulk sale selects one rarity's unequipped items and leaves out locked,
 *   bound and protected ones, saying how many it kept;
 * - a locked item's own Sell is refused until the item is unlocked through
 *   the lock command — nothing here lifts a lock;
 * - every preview counts items and slots freed. It shows no gold and reads no
 *   price: prices are deferred, and none is invented (spec §4.0);
 * - a confirmed sale is sent once; the counters that follow come from the
 *   server's next read, never from this preview.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ItemInstance, Rarity } from '@narok/data';
import { LOOT_RARITIES } from '@narok/loot';
import { bulkSaleSelection, saleRefusal, salePreview } from './model';

export interface BulkSaleProps {
  readonly items: readonly ItemInstance[];
  readonly onSell: (itemIds: readonly string[]) => Promise<void>;
}

export interface TipSaleProps {
  readonly item: ItemInstance;
  readonly onSell: (itemIds: readonly string[]) => Promise<void>;
}

export interface SaleKit {
  readonly Bulk: (props: BulkSaleProps) => React.JSX.Element;
  readonly Tip: (props: TipSaleProps) => React.JSX.Element;
}

/** The lowest rarity is the bulk tier, as the reference's "Sell all Common". */
const BULK_RARITY: Rarity = LOOT_RARITIES[0]!;

function BulkSale({ items, onSell }: BulkSaleProps): React.JSX.Element {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const selection = bulkSaleSelection(items, BULK_RARITY);
  const preview = salePreview(selection);
  const empty = preview.items === 0;

  const click = () => {
    if (empty || sending) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setSending(true);
    void onSell(selection.itemIds).finally(() => {
      setSending(false);
      setConfirming(false);
    });
  };

  return (
    <button className="bulk" type="button" data-sale="bulk" disabled={empty || sending} aria-busy={sending} onClick={click}>
      <span className="bulk-label">
        <span className="tier-swatch" aria-hidden="true" />
        {confirming ? t('bag.bulk.confirm') : t('bag.bulk.label', { rarity: t(`rarity.${BULK_RARITY}`) })}
      </span>
      <span className="bulk-meta">
        {t('bag.bulk.meta', { count: preview.items, slots: preview.slotsFreed, locked: selection.excluded.locked })}
      </span>
    </button>
  );
}

function TipSale({ item, onSell }: TipSaleProps): React.JSX.Element {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const refusal = saleRefusal(item);

  if (refusal !== null) {
    return (
      <button className="act act--sell" type="button" data-sale="item" disabled>
        {refusal === 'locked' ? t('bag.unlockToSell') : t(`bag.saleRefused.${refusal}`)}
      </button>
    );
  }
  const click = () => {
    if (sending) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setSending(true);
    void onSell([item.id]).finally(() => {
      setSending(false);
      setConfirming(false);
    });
  };
  return (
    <button className="act act--sell" type="button" data-sale="item" disabled={sending} aria-busy={sending} onClick={click}>
      {confirming ? t('bag.confirmSell') : t('bag.sell')}
    </button>
  );
}

export const SALE_KIT: SaleKit = { Bulk: BulkSale, Tip: TipSale };
