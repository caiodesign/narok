import { memo } from 'react';

/**
 * The HUD's inline sprite sheet.
 *
 * A verbatim port of the approved reference's symbol defs
 * (`codex-examples/realm-refined/hunt.html:777-819`): the `g-*` class and
 * monster glyphs, the `s-*` skill glyphs, the `i-*` UI icons, the `it-*` item
 * icons and the `rune-*` decorations, as one zero-sized, `aria-hidden` SVG.
 *
 * Every other component draws from it with `<use href="#id"/>`, so the ids here
 * are the contract: nothing may be renamed or dropped. It carries no data and
 * reads no state, and the whole sheet is inline path data — no image request,
 * no font request, no network of any kind.
 */
/**
 * Memoised: it takes no props and its markup is a constant, but it sits in the
 * `.realm` tree, which re-renders on every published frame.
 */
export const SpriteSheet = memo(function SpriteSheet(): React.JSX.Element {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        <symbol id="g-guardian" viewBox="0 0 24 24"><path d="M12 2.5 20 5.5V11c0 5.2-3.4 9-8 10.5C7.4 20 4 16.2 4 11V5.5Z" fill="currentColor" fillOpacity=".18" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><path d="M12 6v12M7.5 10h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></symbol>
        <symbol id="g-cleric" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2" fill="currentColor" fillOpacity=".25" stroke="currentColor" strokeWidth="1.8"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22M4.9 4.9l2.5 2.5M16.6 16.6l2.5 2.5M4.9 19.1l2.5-2.5M16.6 7.4l2.5-2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></symbol>
        <symbol id="g-ranger" viewBox="0 0 24 24"><path d="M5 19 18.5 5.5M18.5 5.5h-6M18.5 5.5v6M5 19l-1 2.5M5 19l-2.5 1M7 17l-2.2.3M7 17l-.3 2.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 9.5C4.5 6 6.5 4 10 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></symbol>
        <symbol id="g-grub" viewBox="0 0 24 24"><path d="M3 15c0-3 2.4-5 5-5 1-3 4-4.5 7-3.5 3 1 5 3.8 5 7 0 3.5-3 5.5-6 5.5H7.5C5 19 3 17.5 3 15Z" fill="currentColor" fillOpacity=".2" stroke="currentColor" strokeWidth="1.7"/><path d="M9 10.5v8M13.5 7v12M17.5 8.5v10" stroke="currentColor" strokeWidth="1.4"/><circle cx="6" cy="14.5" r="1.2" fill="currentColor"/></symbol>
        <symbol id="g-slagjaw" viewBox="0 0 24 24"><path d="M2.5 7h19l-2.5 5-2 6.5H7L5 12Z" fill="currentColor" fillOpacity=".2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M5 12l2.2 2.5L9.4 12l2.6 3 2.6-3 2.2 2.5L19 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M8 4l1.5 3M16 4l-1.5 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></symbol>
        <symbol id="g-revenant" viewBox="0 0 24 24"><path d="M12 2.5c-4.8 0-7 4.2-7 9V21l2.4-1.8L9.7 21 12 19.2l2.3 1.8 2.3-1.8L19 21v-9.5c0-4.8-2.2-9-7-9Z" fill="currentColor" fillOpacity=".2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M8.5 11l2.2 1.2M15.5 11l-2.2 1.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></symbol>

        <symbol id="s-taunt" viewBox="0 0 24 24"><path d="M3 10h4l6-4.5v13L7 14H3Z" fill="currentColor" fillOpacity=".25" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M16 8.5c1.5 2 1.5 5 0 7M19 6c2.8 3.5 2.8 8.5 0 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></symbol>
        <symbol id="s-shieldwall" viewBox="0 0 24 24"><path d="M3 5h18v10c0 3-4 5.5-9 6.5C7 20.5 3 18 3 15Z" fill="currentColor" fillOpacity=".2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M3 10.5h18M3 15.5h18M9 5v5.5M15 5v5.5M12 10.5v5M6 15.5v2.5M18 15.5v2.5" stroke="currentColor" strokeWidth="1.4"/></symbol>
        <symbol id="s-cleave" viewBox="0 0 24 24"><path d="M4 21 13.5 11.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M11 5.5c5-3 10 .5 10 6-2.5-2-5.5-2-8.5-1.5Z" fill="currentColor" fillOpacity=".35" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M3 12c1-4 4-7 7.5-8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 2"/></symbol>
        <symbol id="s-bulwark" viewBox="0 0 24 24"><path d="M5 21V10L3.5 8.5V3.5h3.5v2h2.5v-2h5v2h2.5v-2h3.5v5L19 10v11Z" fill="currentColor" fillOpacity=".2" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M10 21v-5a2 2 0 0 1 4 0v5" fill="none" stroke="currentColor" strokeWidth="1.6"/></symbol>
        <symbol id="s-heal" viewBox="0 0 24 24"><path d="M12 2.5 21.5 12 12 21.5 2.5 12Z" fill="currentColor" fillOpacity=".18" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M12 7.5v9M7.5 12h9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></symbol>
        <symbol id="s-groupheal" viewBox="0 0 24 24"><path d="M12 3v6M9 6h6M5.5 12v6M2.5 15h6M18.5 12v6M15.5 15h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M8 9.5 5.5 11M16 9.5l2.5 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></symbol>
        <symbol id="s-blessing" viewBox="0 0 24 24"><path d="M4 17c2.5-6 13.5-6 16 0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><circle cx="12" cy="10" r="3" fill="currentColor" fillOpacity=".35" stroke="currentColor" strokeWidth="1.6"/><path d="M12 3v2M6.5 5.5 8 7M17.5 5.5 16 7M3.5 20h17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></symbol>
        <symbol id="s-smite" viewBox="0 0 24 24"><path d="M13.5 2 5.5 13H11l-2 9 9.5-12.5H13Z" fill="currentColor" fillOpacity=".3" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></symbol>
        <symbol id="s-doubleshot" viewBox="0 0 24 24"><path d="M3 12 17 5M17 5l-5 .2M17 5l-2.3 4.4M5 20l14-7M19 13l-5 .2M19 13l-2.3 4.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></symbol>
        <symbol id="s-arrowrain" viewBox="0 0 24 24"><path d="M6 2.5v11M12 2.5v14M18 2.5v11M3.8 11.5 6 14.5l2.2-3M9.8 14l2.2 3 2.2-3M15.8 11.5l2.2 3 2.2-3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/><path d="M2.5 20.5c3-1.3 16-1.3 19 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></symbol>
        <symbol id="s-focus" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.7"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></symbol>
        <symbol id="s-keeneye" viewBox="0 0 24 24"><path d="M2 12c4-7 16-7 20 0-4 7-16 7-20 0Z" fill="currentColor" fillOpacity=".15" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.7"/><circle cx="12" cy="12" r="1" fill="currentColor"/></symbol>

        <symbol id="i-wind" viewBox="0 0 24 24"><path d="M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3M3 12h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></symbol>
        <symbol id="i-neutral" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" strokeWidth="2"/></symbol>
        <symbol id="i-swords" viewBox="0 0 24 24"><path d="M4 4l11 11M20 4 9 15M13 17l4 4M11 17l-4 4M15 13l3 3M9 13l-3 3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/></symbol>
        <symbol id="i-coin" viewBox="0 0 24 24"><ellipse cx="12" cy="8" rx="8" ry="4" fill="currentColor" fillOpacity=".35" stroke="currentColor" strokeWidth="1.7"/><path d="M4 8v4c0 2.2 3.6 4 8 4s8-1.8 8-4V8M4 12v4c0 2.2 3.6 4 8 4s8-1.8 8-4v-4" fill="none" stroke="currentColor" strokeWidth="1.7"/></symbol>
        <symbol id="i-bag" viewBox="0 0 24 24"><path d="M8 7c0-2.5 1.8-4 4-4s4 1.5 4 4M5 8h14l-1 12.5H6Z" fill="currentColor" fillOpacity=".2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M9 12h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></symbol>
        <symbol id="i-hourglass" viewBox="0 0 24 24"><path d="M6 3h12M6 21h12M7.5 3c0 5 4.5 6 4.5 9s-4.5 4-4.5 9M16.5 3c0 5-4.5 6-4.5 9s4.5 4 4.5 9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="M9.5 18.5c1-1.3 4-1.3 5 0l.8 2H8.7Z" fill="currentColor"/></symbol>
        <symbol id="i-skull" viewBox="0 0 24 24"><path d="M12 3c-4.5 0-7.5 3-7.5 7 0 2.4 1.2 4 2.5 5v3.5h10V15c1.3-1 2.5-2.6 2.5-5 0-4-3-7-7.5-7Z" fill="currentColor" fillOpacity=".2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><circle cx="9" cy="10.5" r="1.7" fill="currentColor"/><circle cx="15" cy="10.5" r="1.7" fill="currentColor"/><path d="M10 18.5V21M14 18.5V21" stroke="currentColor" strokeWidth="1.5"/></symbol>
        <symbol id="i-quill" viewBox="0 0 24 24"><path d="M20 3C12 4 7 9 5.5 17.5L4 21M20 3c-1 6-5 11-11.5 12.5M14 7.5l-3.5 1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></symbol>
        <symbol id="i-star" viewBox="0 0 24 24"><path d="M12 1.5 14.5 9.5 22.5 12 14.5 14.5 12 22.5 9.5 14.5 1.5 12 9.5 9.5Z" fill="currentColor"/></symbol>

        <symbol id="it-bow" viewBox="0 0 24 24"><path d="M6 3c9 2 13 9 11.5 18M6 3l11.5 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><path d="M3 12h13M16 12l-3-2.5M16 12l-3 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></symbol>
        <symbol id="it-cloak" viewBox="0 0 24 24"><path d="M9 3h6l1.5 3L20 21H4L7.5 6Z" fill="currentColor" fillOpacity=".25" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M12 6v15" stroke="currentColor" strokeWidth="1.3"/></symbol>
        <symbol id="it-potion" viewBox="0 0 24 24"><path d="M10 3h4M10.5 3v5.5L6 15a5.5 5.5 0 1 0 12 0l-4.5-6.5V3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M7 15.5h10a5 5 0 0 1-10 0Z" fill="#d8483a"/></symbol>
        <symbol id="it-greaves" viewBox="0 0 24 24"><path d="M8 2.5h6v11l6 4.5v3.5H6.5L8 13Z" fill="currentColor" fillOpacity=".25" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="M8 7h6M8 11h6" stroke="currentColor" strokeWidth="1.4"/></symbol>
        <symbol id="it-horn" viewBox="0 0 24 24"><path d="M3 5.5c4 0 6.5 2.5 8.5 6.5s4.5 7 9.5 7l-1-4c-3 0-4.5-2-6-5.5S10 3 3 2.5Z" fill="currentColor" fillOpacity=".3" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M7 3.5l-1 2.5M11 6l-1.5 2M14 10.5l-2 1" stroke="currentColor" strokeWidth="1.3"/><path d="M17 20.5l2.5-3" stroke="currentColor" strokeWidth="1.3" strokeDasharray="1.5 1.5"/></symbol>

        <symbol id="rune-a" viewBox="0 0 10 14"><path d="M5 1v12M5 4l3.5-3M5 8 1.5 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></symbol>
        <symbol id="rune-b" viewBox="0 0 10 14"><path d="M2 1v12M2 3l6 3.5L2 10M8 10v3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></symbol>
        <symbol id="rune-c" viewBox="0 0 10 14"><path d="M5 1 1 7l4 6 4-6ZM5 4v6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></symbol>
      </defs>
    </svg>
  );
});
