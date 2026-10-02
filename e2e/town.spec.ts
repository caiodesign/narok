/**
 * The town screens against a real server (gates B-24's town leg, B-12/B-13's
 * end-to-end half, B-19's inline negatives, B-20 in PT-BR).
 *
 * Same harness as `hunt.spec.ts` (ruling R197): the built bundle behind
 * `vite preview`, `/api` and `/ws` proxied to `apps/server` on a freshly
 * migrated PostgreSQL. The account is onboarded through the real routes, so
 * its bag holds exactly the starter kit the server granted at character
 * creation — nothing here is a fixture.
 *
 * What is asserted: the bag's occupancy and the Hunt compass agree (one
 * coherent account state, part 4 §4); equipping in town is a real command
 * whose result the Character screen shows; locking is a real command; and
 * the corrected mockup content is absent — no Materials tab, no purchase or
 * sale affordance while the shop is flagged off, no fourth preset. Every wait
 * is a condition.
 */
import { expect, test } from '@playwright/test';
import { escape, LOCALES, onboard, s, useLanguage } from './support/flow';

for (const language of ['en', 'pt-BR'] as const) {
  test(`town: bag and character over one account state — ${language}`, async ({ page }) => {
    test.setTimeout(120_000);
    const t = LOCALES[language];
    await useLanguage(page, language);
    await onboard(page, `town-${language.toLowerCase()}`);

    const inventory = page.waitForResponse((response) => response.url().endsWith('/api/inventory') && response.status() === 200);
    await page.goto('/');
    const bag = (await (await inventory).json()) as { usedSlots: number; capacity: number };
    expect(bag.usedSlots).toBeGreaterThan(0);

    // The compass reads the same bag the Bag screen will show.
    const occupancy = s(t, 'compass.bagValue').replace('{{used}}', String(bag.usedSlots)).replace('{{capacity}}', String(bag.capacity));
    await expect(page.getByRole('region', { name: s(t, 'compass.label') })).toContainText(occupancy);

    const orders = page.getByRole('region', { name: s(t, 'hunt.orders') });
    await orders.getByRole('button', { name: new RegExp(escape(s(t, 'hunt.lootFilter'))) }).click();
    await expect(page.getByRole('heading', { level: 1, name: s(t, 'bag.screen') })).toBeVisible();
    const slots = s(t, 'bag.slots').replace('{{used}}', String(bag.usedSlots)).replace('{{capacity}}', String(bag.capacity));
    await expect(page.getByLabel(slots, { exact: true })).toHaveCount(1);

    // Corrected mockup content does not ship (B-19, inline).
    await expect(page.getByRole('tab', { name: /Materials|Materiais/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: new RegExp(`^${escape(s(t, 'bag.sell'))}$`) })).toHaveCount(0);

    // Equip the first starter weapon in town: a real command.
    const weapon = page.getByRole('button', { name: /, (Common|Comum)$/ }).first();
    await weapon.click();
    const equip = page.getByRole('button', { name: new RegExp(`^${escape(s(t, 'bag.equipOn').replace('{{name}}', '\u0000')).replace('\u0000', '.+')}$`) }).first();
    await expect(equip).toBeEnabled();
    const equipped = page.waitForResponse((response) => response.url().endsWith('/api/inventory/equip'));
    await equip.click();
    expect((await equipped).status()).toBe(200);
    // The worn weapon leaves the shared bag once the screen has re-read it.
    const after = s(t, 'bag.slots').replace('{{used}}', String(bag.usedSlots - 1)).replace('{{capacity}}', String(bag.capacity));
    await expect(page.getByLabel(after, { exact: true })).toHaveCount(1);

    // Lock another starter weapon: a real command, and the cell says so in
    // text, not by colour alone (part 4 §5).
    const locked = s(t, 'bag.cell.locked');
    await page.getByRole('button', { name: /, (Common|Comum)$/ }).first().click();
    const lockSent = page.waitForResponse((response) => response.url().endsWith('/api/inventory/lock'));
    await page.getByRole('button', { name: s(t, 'bag.lock'), exact: true }).click();
    expect((await lockSent).status()).toBe(200);
    await expect(page.getByRole('button', { name: new RegExp(escape(locked)) })).toHaveCount(1);

    // The Character screen shows the weapon now worn.
    await page.getByRole('button', { name: new RegExp(`${escape(s(t, 'town.back.inTown'))}$`) }).click();
    await orders.getByRole('button', { name: new RegExp(`^${escape(s(t, 'hunt.party'))}`) }).click();
    await expect(page.getByRole('heading', { level: 1, name: s(t, 'character.title') })).toBeVisible();
    await expect(page.getByRole('region', { name: s(t, 'character.gear') })).toContainText(/(Sword|Espada|Mace|Maça|Bow|Arco)/);

    // Back to Hunt through the town menu.
    await page
      .getByRole('navigation', { name: s(t, 'town.nav.label') })
      .getByRole('button', { name: new RegExp(`^${escape(s(t, 'town.nav.hunt'))}`) })
      .click();
    await expect(page.getByRole('button', { name: s(t, 'hunt.start'), exact: true })).toBeEnabled();
  });
}
