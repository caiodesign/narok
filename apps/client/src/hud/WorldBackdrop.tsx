import { memo } from 'react';

/**
 * The painted environment behind the HUD.
 *
 * A verbatim port of the approved reference's `.world` scenery layer
 * (`codex-examples/realm-refined/hunt.html:823-998`) — the same gradients,
 * patterns, filters, skyline, ledges, scaffold, slag pools, ember cracks,
 * boulder and shard scatter, rising sparks, drifting fog, film grain and
 * vignette, as one inert, presentational SVG.
 *
 * It carries no data and reads no state: it is scenery, marked `aria-hidden`
 * so the board's own text summary stays the single accessible description of
 * what is happening. Every animation here is decorative and is stopped dead by
 * the `prefers-reduced-motion` rule in `styles.css`; nothing that moves carries
 * information.
 *
 * All assets are inline path data. No image request, no font request, no
 * network of any kind.
 */
/**
 * Memoised: it takes no props and its markup is a constant, but it sits in the
 * `.realm` tree, which re-renders on every published frame.
 */
export const WorldBackdrop = memo(function WorldBackdrop(): React.JSX.Element {
  return (
    <svg className="world" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="w-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0a0a0d"/>
          <stop offset=".28" stopColor="#1a1411"/>
          <stop offset="1" stopColor="#110c0a"/>
        </linearGradient>
        <linearGradient id="w-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2d2119"/>
          <stop offset=".5" stopColor="#271c15"/>
          <stop offset="1" stopColor="#1a130f"/>
        </linearGradient>
        <linearGradient id="w-ledge" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3d2e23"/>
          <stop offset="1" stopColor="#2c2019"/>
        </linearGradient>
        <radialGradient id="w-slag" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#fff0b0"/>
          <stop offset=".25" stopColor="#ffb54a"/>
          <stop offset=".6" stopColor="#e5561a"/>
          <stop offset=".9" stopColor="#6e1d06"/>
          <stop offset="1" stopColor="#2a0e05"/>
        </radialGradient>
        <radialGradient id="w-glow" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#ff7a2a" stopOpacity=".55"/>
          <stop offset=".5" stopColor="#ff5a1a" stopOpacity=".16"/>
          <stop offset="1" stopColor="#ff5a1a" stopOpacity="0"/>
        </radialGradient>
        <radialGradient id="w-cool" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#6d8fb0" stopOpacity=".16"/>
          <stop offset="1" stopColor="#6d8fb0" stopOpacity="0"/>
        </radialGradient>
        <radialGradient id="w-vignette" cx=".5" cy=".5" r=".72">
          <stop offset=".45" stopColor="#000" stopOpacity="0"/>
          <stop offset="1" stopColor="#000" stopOpacity=".82"/>
        </radialGradient>
        <radialGradient id="w-fog" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#c8b6a6" stopOpacity=".11"/>
          <stop offset="1" stopColor="#c8b6a6" stopOpacity="0"/>
        </radialGradient>
        <pattern id="w-iso" width="124" height="62" patternUnits="userSpaceOnUse">
          <path d="M0 31 62 0l62 31-62 31Z" fill="none" stroke="#f3c79a" strokeOpacity=".045" strokeWidth="1"/>
        </pattern>
        <pattern id="w-strata" width="240" height="26" patternUnits="userSpaceOnUse">
          <path d="M0 20c40-4 80 3 120-1s80-5 120 1" fill="none" stroke="#3a2a20" strokeOpacity=".7" strokeWidth="1.2"/>
        </pattern>
        <filter id="w-bloom" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3.5" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="w-soft"><feGaussianBlur stdDeviation="18"/></filter>
        <filter id="w-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="7"/>
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .55 0"/>
        </filter>
        <g id="boulder">
          <path d="M-20 2-11-15 5-20 21-8 17 7-2 12Z" fill="#3b2c22"/>
          <path d="M-20 2-2 12 17 7 21-8 5-1-11-3Z" fill="#1f1611"/>
          <path d="M-11-15 5-20 21-8 5-1Z" fill="#4d3a2c"/>
        </g>
        <g id="shard">
          <path d="M-6 4 0-14 7 3 1 7Z" fill="#2a1f18"/>
          <path d="M0-14 7 3 1 7Z" fill="#3f2f24"/>
        </g>
      </defs>

      <rect width="1440" height="900" fill="url(#w-sky)"/>

      <path d="M0 0H1440V232L1392 212 1330 248 1262 220 1190 262 1128 236 1050 272 984 246 910 282 830 254 766 280 694 250 626 282 548 248 478 272 410 236 338 262 268 226 190 254 118 218 48 244 0 226Z" fill="#120d0b"/>
      <path d="M0 0H1440V232L1392 212 1330 248 1262 220 1190 262 1128 236 1050 272 984 246 910 282 830 254 766 280 694 250 626 282 548 248 478 272 410 236 338 262 268 226 190 254 118 218 48 244 0 226Z" fill="url(#w-strata)" opacity=".8"/>
      <path d="M140 70 260 130 420 60 560 120 700 50 880 130 1010 70 1180 140 1300 80 1440 130" fill="none" stroke="#231914" strokeWidth="3"/>
      <path d="M0 150 180 190 330 140 520 200 700 150 900 210 1080 160 1260 210 1440 170" fill="none" stroke="#2a1e17" strokeWidth="2"/>
      <g className="crack crack-b" filter="url(#w-bloom)">
        <path d="M612 36l14 22-8 20 16 26-6 24 12 30" fill="none" stroke="#ff7a2a" strokeWidth="1.8" strokeLinecap="round"/>
        <path d="M1098 90l-10 24 12 16-6 30 10 20" fill="none" stroke="#ff8f3a" strokeWidth="1.5" strokeLinecap="round"/>
      </g>
      <ellipse cx="260" cy="90" rx="300" ry="140" fill="url(#w-cool)"/>

      <rect x="0" y="228" width="1440" height="672" fill="url(#w-floor)"/>
      <rect x="0" y="228" width="1440" height="672" fill="url(#w-iso)"/>

      <path d="M0 258H292L520 372 172 546 0 460Z" fill="url(#w-ledge)"/>
      <path d="M0 258H292L520 372 172 546 0 460Z" fill="url(#w-iso)"/>
      <path d="M520 372 172 546V598L520 424Z" fill="#3b2419"/>
      <path d="M172 546 0 460V512L172 598Z" fill="#150f0c"/>
      <path d="M520 372 172 546" stroke="#6b4c35" strokeWidth="1.5"/>
      <path d="M520 424 172 598V606L520 432Z" fill="#000" opacity=".35"/>

      <path d="M1440 262H1148L934 369 1252 528 1440 434Z" fill="url(#w-ledge)"/>
      <path d="M1440 262H1148L934 369 1252 528 1440 434Z" fill="url(#w-iso)"/>
      <path d="M934 369 1252 528V580L934 421Z" fill="#171009"/>
      <path d="M1252 528 1440 434V486L1252 580Z" fill="#40271b"/>
      <path d="M1252 528 1440 434" stroke="#6b4c35" strokeWidth="1.5"/>

      <g stroke="#5a4636" strokeWidth="2.2">
        <path d="M1440 310 1192 434M1440 330 1212 444" />
      </g>
      <g stroke="#3a2b20" strokeWidth="3">
        <path d="M1420 314l10 16M1380 334l10 16M1340 354l10 16M1300 374l10 16M1260 394l10 16M1220 414l10 16"/>
      </g>
      <g transform="translate(1175 432)">
        <path d="M-26 4 0-9 30 6 4 19Z" fill="#4a3526"/>
        <path d="M-26 4 4 19V33L-26 18Z" fill="#23180f"/>
        <path d="M4 19 30 6V20L4 33Z" fill="#35251a"/>
        <path d="M-20 3 0-6 22 5 4 14Z" fill="#6a3a1c"/>
        <circle cx="-4" cy="4" r="4" fill="#ff9a45" filter="url(#w-bloom)" className="crack"/>
      </g>

      <path d="M880 900 1214 733 1440 846V900Z" fill="#0d0908"/>
      <path d="M880 900 1214 733V780L974 900Z" fill="#2e1d14"/>
      <path d="M1214 733 1440 846V890L1214 780Z" fill="#1d130d"/>
      <path d="M880 900 1214 733 1440 846" fill="none" stroke="#7a5236" strokeWidth="1.5"/>
      <ellipse cx="1210" cy="850" rx="230" ry="90" fill="url(#w-glow)" className="slag-glow"/>
      <ellipse cx="1200" cy="860" rx="150" ry="52" fill="url(#w-slag)"/>
      <ellipse cx="1180" cy="852" rx="60" ry="14" fill="#fff3c4" opacity=".35"/>

      <ellipse cx="300" cy="400" rx="130" ry="70" fill="url(#w-glow)" className="slag-glow"/>
      <ellipse cx="300" cy="402" rx="62" ry="26" fill="url(#w-slag)"/>
      <path d="M238 402c20-18 104-18 124 0" fill="none" stroke="#1a0f0a" strokeWidth="3"/>

      <ellipse cx="720" cy="520" rx="520" ry="260" fill="url(#w-glow)" opacity=".35"/>

      <g className="crack" filter="url(#w-bloom)" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M90 690l42-10 26 18 46-6 20 22 54-4 18 20" stroke="#ff7a2a" strokeWidth="2"/>
        <path d="M204 702l10 26 -14 22" stroke="#ff9a45" strokeWidth="1.4"/>
        <path d="M1120 610l-36 16-10 26-48 10-22 30" stroke="#ff7a2a" strokeWidth="2"/>
        <path d="M660 760l28 14 40-6 26 24 44 2" stroke="#ff8c3a" strokeWidth="1.8"/>
        <path d="M560 262l30 12 12 24 40 6" stroke="#ff8a3a" strokeWidth="1.6"/>
      </g>
      <g className="crack crack-b" filter="url(#w-bloom)" fill="none" strokeLinecap="round">
        <path d="M362 470l22 18 38 2 14 26" stroke="#ff7a2a" strokeWidth="1.6"/>
        <path d="M1000 420l24 20 -6 30 30 16" stroke="#ff9a45" strokeWidth="1.6"/>
        <path d="M40 330l40 16 30-6 26 20" stroke="#ff7a2a" strokeWidth="1.5"/>
      </g>

      <use href="#boulder" transform="translate(120 330) scale(1.6)"/>
      <use href="#boulder" transform="translate(178 352) scale(.9)"/>
      <use href="#boulder" transform="translate(430 330) scale(1.1)"/>
      <use href="#shard" transform="translate(452 350) scale(1.4)"/>
      <use href="#boulder" transform="translate(1300 330) scale(1.4)"/>
      <use href="#shard" transform="translate(1256 348) scale(1.6)"/>
      <use href="#boulder" transform="translate(1030 330) scale(.8)"/>
      <use href="#boulder" transform="translate(330 610) scale(1.2)"/>
      <use href="#shard" transform="translate(360 626) scale(1.2)"/>
      <use href="#boulder" transform="translate(1100 680) scale(1.5)"/>
      <use href="#shard" transform="translate(1060 700) scale(1.3)"/>
      <use href="#boulder" transform="translate(560 800) scale(1.3)"/>
      <use href="#boulder" transform="translate(860 700) scale(.9)"/>
      <use href="#shard" transform="translate(820 250) scale(1.5)"/>
      <use href="#boulder" transform="translate(640 250) scale(1.2)"/>

      <g fill="#ffb65a">
        <circle className="spark" cx="300" cy="400" r="1.6" style={{ animationDelay: '-1s' }}/>
        <circle className="spark" cx="330" cy="396" r="1.2" style={{ animationDelay: '-4s' }}/>
        <circle className="spark" cx="270" cy="404" r="1.4" style={{ animationDelay: '-2.6s' }}/>
        <circle className="spark" cx="1180" cy="850" r="2" style={{ animationDelay: '-.5s' }}/>
        <circle className="spark" cx="1230" cy="846" r="1.5" style={{ animationDelay: '-3.2s' }}/>
        <circle className="spark" cx="1150" cy="858" r="1.4" style={{ animationDelay: '-5.4s' }}/>
        <circle className="spark" cx="1260" cy="862" r="1.8" style={{ animationDelay: '-2s' }}/>
        <circle className="spark" cx="210" cy="720" r="1.3" style={{ animationDelay: '-6s' }}/>
        <circle className="spark" cx="1050" cy="660" r="1.3" style={{ animationDelay: '-1.8s' }}/>
        <circle className="spark" cx="720" cy="780" r="1.2" style={{ animationDelay: '-4.6s' }}/>
      </g>

      <g className="fog">
        <ellipse cx="420" cy="620" rx="520" ry="110" fill="url(#w-fog)"/>
        <ellipse cx="1100" cy="300" rx="480" ry="90" fill="url(#w-fog)"/>
      </g>
      <g className="fog fog-b">
        <ellipse cx="820" cy="840" rx="620" ry="120" fill="url(#w-fog)"/>
        <ellipse cx="200" cy="250" rx="400" ry="80" fill="url(#w-fog)"/>
      </g>

      <rect width="1440" height="900" filter="url(#w-grain)" opacity=".16"/>
      <rect width="1440" height="900" fill="url(#w-vignette)"/>
    </svg>
  );
});
