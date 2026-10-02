/**
 * The laboratory's own strings, layered onto the client's `translation`
 * namespace (milestone B Task 9, ruling R166).
 *
 * Pause and Resume are laboratory playback controls: they freeze the lab's own
 * clock and settle nothing. The game client may never pause authoritative time
 * and offers no Resume (the owner's Stop decision), so those two strings left
 * `apps/client/src/locales/*` and live here, merged in deeply without
 * overwriting anything the client defines. Importing this module is what makes
 * them available, so every lab surface that renders them imports it.
 */
import i18n, { SUPPORTED_LANGUAGES } from '@narok/client/src/i18n';
import en from './locales/en.json';
import ptBR from './locales/pt-BR.json';

export const labResources = {
  en: { translation: en },
  'pt-BR': { translation: ptBR },
} as const;

for (const language of SUPPORTED_LANGUAGES) {
  i18n.addResourceBundle(language, 'translation', labResources[language].translation, true, false);
}

export default i18n;
