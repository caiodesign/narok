/**
 * Localization for the laboratory (ruling R60).
 *
 * One `translation` namespace, EN and PT-BR loaded from committed JSON, EN as the
 * fallback. There is no HTTP backend and no language detector that phones home —
 * the client makes no network request at runtime (R51). The chosen language is
 * persisted under exactly one `localStorage` key and nothing else is stored.
 *
 * `t()` is the only source of user-visible text; components never hold an English
 * sentence. Numbers go through `formatNumber` and durations through
 * `formatDuration`, so a locale change re-renders both correctly.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { PublicActor } from '@narok/sim';
import en from './locales/en.json';
import ptBR from './locales/pt-BR.json';

export const SUPPORTED_LANGUAGES = ['en', 'pt-BR'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** The only key this client writes to `localStorage` (ruling R51). */
export const LANGUAGE_STORAGE_KEY = 'narok.language';

export const resources = {
  en: { translation: en },
  'pt-BR': { translation: ptBR },
} as const;

function isSupported(value: string | null): value is SupportedLanguage {
  return value !== null && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** Reads the stored language defensively: a blocked or absent store simply means EN. */
function storedLanguage(): SupportedLanguage {
  try {
    const stored = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY) ?? null;
    return isSupported(stored) ? stored : 'en';
  } catch {
    return 'en';
  }
}

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: storedLanguage(),
    fallbackLng: 'en',
    ns: ['translation'],
    defaultNS: 'translation',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    // React escapes already; double-escaping would corrupt names like "Guardião".
    interpolation: { escapeValue: false },
    // Resources are bundled, so nothing is ever loaded asynchronously.
    react: { useSuspense: false },
  });
}

/** Switches language and persists the choice. Storage failures never break the switch. */
export async function setLanguage(language: SupportedLanguage): Promise<void> {
  await i18n.changeLanguage(language);
  try {
    globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // A blocked store only costs the preference, never the language change.
  }
}

/** Locale-aware number formatting; `maximumFractionDigits` defaults to whole units. */
export function formatNumber(value: number, language: string, maximumFractionDigits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(language, { maximumFractionDigits }).format(value);
}

/** The narrow `t()` shape these helpers need; `useTranslation().t` satisfies it. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * The one duration helper (R60). `30000` renders as `30 s` in EN and its PT-BR
 * equivalent. It formats the value it is given, including a real, measured zero —
 * the live playback readout must read `0 s` before a run advances (ruling R81).
 * Use {@link formatMeasuredDuration} where a zero means "nothing was measured".
 */
export function formatDuration(ms: number, t: Translate, language: string): string {
  if (!Number.isFinite(ms) || ms < 0) return t('duration.none');
  if (ms < 60_000) {
    return t('duration.seconds', { value: formatNumber(ms / 1000, language, 1) });
  }
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms - minutes * 60_000) / 1000);
    return t('duration.minutesSeconds', {
      minutes: formatNumber(minutes, language),
      seconds: formatNumber(seconds, language),
    });
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms - hours * 3_600_000) / 60_000);
  return t('duration.hoursMinutes', {
    hours: formatNumber(hours, language),
    minutes: formatNumber(minutes, language),
  });
}

/**
 * A measurement window: an absent or zero-length one is reported as the em dash,
 * never as `0` and never as `NaN` (R60/R63, milestone spec §11).
 */
export function formatMeasuredDuration(ms: number | null | undefined, t: Translate, language: string): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return t('duration.none');
  return formatDuration(ms, t, language);
}

/**
 * A per-hour rate over the *actually simulated* elapsed duration (R63). A zero or
 * absent denominator has no rate at all, so it renders the em dash rather than a
 * fabricated figure; no NaN or Infinity can reach the DOM.
 */
export function formatPerHour(total: number, elapsedMs: number, t: Translate, language: string): string {
  if (!Number.isFinite(total) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return t('value.none');
  return formatNumber((total * 3_600_000) / elapsedMs, language, 1);
}

/**
 * Names an actor factually from the current projection: its translated class or
 * monster name plus its stable id, so three Mosslings stay distinguishable. An id
 * the projection no longer carries (an enemy from a finished encounter) falls back
 * to the raw id rather than inventing a name.
 */
export function actorLabel(
  t: Translate,
  id: string | null,
  actors: readonly PublicActor[],
): string {
  if (id === null || id === '') return '';
  const actor = actors.find((candidate) => candidate.id === id);
  if (actor === undefined) return t('actor.unknown', { id });
  const key = actor.side === 'party' ? `class.${actor.definitionId}` : `monster.${actor.definitionId}`;
  const name = t(key, { defaultValue: '' });
  return name === '' ? t('actor.unknown', { id }) : t('actor.label', { name, id });
}

export default i18n;
