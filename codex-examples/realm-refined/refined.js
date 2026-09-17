(() => {
  'use strict';
  const screens = [
    ['hunt', 'Hunt', 'hunt-d-realm.html'],
    ['strategy', 'Strategy', 'realm-strategy.html'],
    ['bag', 'Bag & loot filter', 'realm-bag-lootfilter.html'],
    ['character', 'Character', 'realm-character.html'],
    ['away', 'Away report', 'realm-away-report.html']
  ];
  const current = document.body.dataset.screen;
  const nav = document.createElement('nav');
  nav.className = 'refined-nav';
  nav.setAttribute('aria-label', 'Realm screens');
  const brand = document.createElement('a');
  brand.className = 'refined-brand'; brand.href = 'index.html'; brand.textContent = 'REALM';
  nav.append(brand);
  for (const [id, label] of screens) {
    const link = document.createElement('a');
    link.href = `${id}.html`; link.textContent = label;
    if (id === current) link.setAttribute('aria-current', 'page');
    nav.append(link);
  }
  const original = screens.find(([id]) => id === current);
  if (original) {
    const link = document.createElement('a');
    link.href = `../../mockups/${original[2]}`;
    link.className = 'refined-original'; link.textContent = 'Compare original ↗';
    link.target = '_blank'; link.rel = 'noopener'; nav.append(link);
  }
  document.body.append(nav);
})();
