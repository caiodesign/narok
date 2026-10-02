/**
 * The town screens' extra sprite symbols, beside the HUD's `SpriteSheet`.
 *
 * Copied from the references' own symbol defs (`codex-examples/realm-refined/
 * bag.html`, `character.html`, `away.html`) for the ids the HUD sheet lacks:
 * it-mpotion, it-ring, it-helm, it-chest, it-shield, it-sword, it-mace, it-staff, it-boots, it-amulet, it-ember, i-lock, i-search, i-pin, i-caret, i-sort, i-grip, i-plus, i-warn, i-anvil, i-figure, i-tri, i-check, i-cross, it-hood, it-jerkin, it-quiver, it-charm, i-sunrise, it-mail.
 * Left out on purpose: the material icons (no Materials in B), the mockup's
 * fixture skills and the shop scales (no shop while prices are deferred).
 * Inline path data only: no image, font or network request.
 */
import { memo } from 'react';

const SYMBOLS = `
<symbol id="it-mpotion" viewBox="0 0 24 24"><path d="M10 3h4M10.5 3v5.5L6 15a5.5 5.5 0 1 0 12 0l-4.5-6.5V3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M7 15.5h10a5 5 0 0 1-10 0Z" fill="#4f92e6"/></symbol>
<symbol id="it-ring" viewBox="0 0 24 24"><circle cx="12" cy="14.5" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3 15 6.3 12 9.6 9 6.3Z" fill="currentColor" fill-opacity=".45" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
<symbol id="it-helm" viewBox="0 0 24 24"><path d="M4 16a8 8 0 0 1 16 0v4.5h-5.5V16h-5v4.5H4Z" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 5v6.5M4 16h5.5M14.5 16H20" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>
<symbol id="it-chest" viewBox="0 0 24 24"><path d="M8.5 3 4.5 5 3 11.5l3 .8V21h12v-8.7l3-.8L19.5 5l-4-2c-.8 1.8-2 2.8-3.5 2.8S9.3 4.8 8.5 3Z" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M6 15h12M12 6v15" stroke="currentColor" stroke-width="1.3"/></symbol>
<symbol id="it-shield" viewBox="0 0 24 24"><path d="M12 2.5 19.5 5v6.2c0 5-3.4 8.8-7.5 10.3C7.9 20 4.5 16.2 4.5 11.2V5Z" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 5.5v13M8 10h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>
<symbol id="it-sword" viewBox="0 0 24 24"><path d="M19.5 3 21 4.5 9.5 16 8 14.5Z" fill="currentColor" fill-opacity=".3" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M5.5 12.5l6 6M7.3 16.7 3.5 20.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></symbol>
<symbol id="it-mace" viewBox="0 0 24 24"><circle cx="15.5" cy="8.5" r="4" fill="currentColor" fill-opacity=".3" stroke="currentColor" stroke-width="1.7"/><path d="M15.5 2.5v2M21.5 8.5h-2M19.8 4.2l-1.4 1.4M12.6 11.4 4 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="it-staff" viewBox="0 0 24 24"><path d="M5 21 15.5 8.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="17.5" cy="6" r="3" fill="currentColor" fill-opacity=".4" stroke="currentColor" stroke-width="1.6"/><path d="M13.5 4c-.5-1 0-2 1-2.3M21.5 10c-.4 1-1.5 1.4-2.4 1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></symbol>
<symbol id="it-boots" viewBox="0 0 24 24"><path d="M7.5 3h5.5v10h4.5a3 3 0 0 1 3 3v4.5H5.5V14Z" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M5.5 18h15M7.5 7.5H13" stroke="currentColor" stroke-width="1.4"/></symbol>
<symbol id="it-amulet" viewBox="0 0 24 24"><path d="M5.5 3c0 5.5 3 9 6.5 10.5C15.5 12 18.5 8.5 18.5 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12 13.5 15.5 17.5 12 21.5 8.5 17.5Z" fill="currentColor" fill-opacity=".4" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></symbol>
<symbol id="it-ember" viewBox="0 0 24 24"><path d="M12 2 17.5 9 12 22 6.5 9Z" fill="#ff8a3d" fill-opacity=".35" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M6.5 9h11M12 2l-2 7 2 13 2-13Z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></symbol>
<symbol id="i-lock" viewBox="0 0 24 24"><path d="M7.5 11V8a4.5 4.5 0 0 1 9 0v3" fill="none" stroke="currentColor" stroke-width="2"/><rect x="5" y="11" width="14" height="10" rx="1.5" fill="currentColor" fill-opacity=".3" stroke="currentColor" stroke-width="1.8"/><path d="M12 14.5v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 15l5.5 5.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></symbol>
<symbol id="i-pin" viewBox="0 0 24 24"><path d="M9 3h6l-1 6 3.5 3.5V14h-11v-1.5L10 9Z" fill="currentColor" fill-opacity=".35" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M12 14v7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></symbol>
<symbol id="i-caret" viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-sort" viewBox="0 0 24 24"><path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-grip" viewBox="0 0 24 24"><g fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></symbol>
<symbol id="i-warn" viewBox="0 0 24 24"><path d="M12 3 22 20H2Z" fill="currentColor" fill-opacity=".2" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9.5v5M12 17.2v.3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></symbol>
<symbol id="i-anvil" viewBox="0 0 24 24"><path d="M3 7h13c0 2.5 2 4 5 4-1 2-3.5 3-6.5 3L13 17h3v3H6v-3h3l-1.5-3C4.5 14 3 11 3 7Z" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 3.5l1 2M12 2.5v2.5M16 3.5l-1 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
<symbol id="i-figure" viewBox="0 0 24 24"><circle cx="12" cy="6.5" r="3.5" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="1.7"/><path d="M4.5 21c.5-5.5 3.5-9 7.5-9s7 3.5 7.5 9Z" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></symbol>
<symbol id="i-tri" viewBox="0 0 10 10"><path d="M5 1 9.5 9h-9Z" fill="currentColor"/></symbol>
<symbol id="i-check" viewBox="0 0 12 12"><path d="M2 6.5 5 9.5 10.5 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-cross" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3 3 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>
<symbol id="it-hood" viewBox="0 0 24 24"><path d="M12 2.5c-5 0-8 4-8 9.5V20l3-1.5V13a5 5 0 0 1 10 0v5.5l3 1.5v-8c0-5.5-3-9.5-8-9.5Z" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></symbol>
<symbol id="it-jerkin" viewBox="0 0 24 24"><path d="M8.5 3 12 5.5 15.5 3 21 6l-2 5-2-1v11H7V10l-2 1-2-5Z" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 5.5V21M7 14h10" stroke="currentColor" stroke-width="1.3"/></symbol>
<symbol id="it-quiver" viewBox="0 0 24 24"><path d="M7 9.5 15 6l3.5 12L10.5 21.5Z" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 9 6.5 2.5M11.5 8 10.5 1.5M14 7l.5-5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5 1.8l2.6.4M9 1.2l2.6-.1M13 1.6l2.6.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></symbol>
<symbol id="it-charm" viewBox="0 0 24 24"><path d="M5 3c2 4 12 4 14 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="12" cy="14" r="6.5" fill="currentColor" fill-opacity=".2" stroke="currentColor" stroke-width="1.6"/><path d="M12 9.5v9M12 9.5l2.2 3.5M12 14l-2.2 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M12 5.5v2" stroke="currentColor" stroke-width="1.4"/></symbol>
<symbol id="i-sunrise" viewBox="0 0 48 48"><path d="M6 32h36M11 38h26" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M13 32a11 11 0 0 1 22 0" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="2.2"/><path d="M24 7v6M9.5 13l4 4.3M38.5 13l-4 4.3M3.5 24.5h5M39.5 24.5h5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M24 17l2 5-2 1.5-2-1.5Z" fill="currentColor"/></symbol>
<symbol id="it-mail" viewBox="0 0 24 24"><path d="M8 3 4 5.5l1 6.5 2-1V21h10V11l2 1 1-6.5L16 3c-.5 2-2 3-4 3S8.5 5 8 3Z" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 14h10M7 17.5h10" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.5"/></symbol>
`;

export const TownSprites = memo(function TownSprites(): React.JSX.Element {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs dangerouslySetInnerHTML={{ __html: SYMBOLS }} />
    </svg>
  );
});
