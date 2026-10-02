/**
 * Route-scoped stylesheets for the three town screens.
 *
 * Ruling R181: `bag.css`, `character.css` and `away.css` are imported by their
 * own screen module as raw text (`?raw`) and mounted as one `<style>` element
 * only while that screen is mounted, never by `main.tsx` — because the three
 * sheets share selectors with `styles.css:1-754` and some of those bodies
 * differ, `:root` (Character, Away) and `.realm` (Character) among them
 * (`docs/realm-town-port.md`), so a sheet loaded globally, or left loaded
 * after its screen closed, would restyle Hunt. A plain CSS import cannot be
 * unloaded once Vite has injected it; a mounted `<style>` can.
 */
import { useLayoutEffect } from 'react';

export type RouteSheet = 'bag' | 'character' | 'away';

/** Mounts `css` as `<style data-route-sheet={name}>` for as long as the calling component is mounted. */
export function useRouteSheet(name: RouteSheet, css: string): void {
  useLayoutEffect(() => {
    const style = document.createElement('style');
    style.dataset.routeSheet = name;
    style.textContent = css;
    document.head.append(style);
    return () => {
      style.remove();
    };
  }, [name, css]);
}
