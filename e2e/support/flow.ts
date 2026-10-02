/**
 * Shared steps of the milestone B end-to-end specs (`hunt.spec.ts`,
 * `town.spec.ts`): locale strings read from the committed files at run time,
 * and the onboarding ruling R197 describes. Not a spec; it registers no test.
 */
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { databaseUrl, provisionPresets } from './server.mjs';

type Strings = Record<string, Record<string, unknown>>;

function read(path: string): Strings {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Strings;
}

export const LOCALES = {
  en: read('../../apps/client/src/locales/en.json'),
  'pt-BR': read('../../apps/client/src/locales/pt-BR.json'),
} as const;
/** The laboratory's own run controls, which must never reach the client (R166). */
export const LAB = [read('../../apps/lab/src/locales/en.json'), read('../../apps/lab/src/locales/pt-BR.json')];

export type Language = keyof typeof LOCALES;

export function s(strings: Strings, path: string): string {
  let node: unknown = strings;
  for (const key of path.split('.')) node = (node as Record<string, unknown>)[key];
  if (typeof node !== 'string') throw new Error(`missing locale string ${path}`);
  return node;
}

export const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parses `formatDuration`'s output (`12 s`, `1 min 5 s`, `2 h 3 min`) back to seconds. */
export function seconds(text: string): number {
  // `2.8 s` in EN, `2,8 s` in PT-BR; values here stay under a thousand, so no grouping separator.
  const num = (match: RegExpExecArray | null) => (match === null ? 0 : Number(match[1].replace(',', '.')));
  return num(/([\d.,]+)\s*h\b/.exec(text)) * 3600 + num(/([\d.,]+)\s*min\b/.exec(text)) * 60 + num(/([\d.,]+)\s*s\b/.exec(text));
}

export const ORIGIN = 'http://127.0.0.1:4173';
const PASSWORD = 'correct horse battery staple';

/**
 * Registers, signs in and creates a three-member party through the real routes,
 * then seeds the presets (R197). Returns the account email.
 */
export async function onboard(page: Page, tag: string): Promise<string> {
  const id = crypto.randomUUID().slice(0, 8);
  const email = `${tag}-${id}@example.com`;
  // Each onboarding is charged to its own source address (TEST-NET-2), as
  // distinct players behind the production proxy would be: the credential
  // limiter keys on the first `X-Forwarded-For` entry (`plugins/rate-limit.ts`),
  // and a whole suite from one loopback address would otherwise spend one
  // window of 10 attempts. The limiter itself is exercised by `auth.test.ts`.
  const source = `198.51.100.${1 + Math.floor(Math.random() * 254)}`;
  const post = (url: string, data: unknown, key?: string) =>
    page.request.post(url, {
      data,
      headers: { origin: ORIGIN, 'x-forwarded-for': source, ...(key === undefined ? {} : { 'idempotency-key': key }) },
    });

  const registered = await post('/api/auth/register', { email, password: PASSWORD });
  expect(registered.status()).toBe(200);
  let version = ((await registered.json()) as { stateVersion: number }).stateVersion;
  expect((await post('/api/auth/login', { email, password: PASSWORD })).status()).toBe(204);

  // Long PT-BR-length names on purpose: they must not hide a control (part 4 §5).
  const party: [string, string][] = [['guardian', `Guardiã${id.slice(0, 4)}`], ['cleric', `Clérigo${id.slice(0, 4)}`], ['ranger', `Patrulha${id.slice(0, 4)}`]];
  for (const [slot, [classId, name]] of party.entries()) {
    const created = await post('/api/characters', { slot, name, classId, expectedStateVersion: version }, crypto.randomUUID());
    expect(created.status(), await created.text()).toBe(200);
    version = ((await created.json()) as { stateVersion: number }).stateVersion;
  }
  provisionPresets(databaseUrl('narok_e2e'), [email]);
  return email;
}

/** Sets the language before the bundle boots, through the one key the client stores. */
export async function useLanguage(page: Page, language: Language): Promise<void> {
  await page.addInitScript((value) => window.localStorage.setItem('narok.language', value), language);
}

