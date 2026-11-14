import en from "../../../content/i18n/en.json";
import es from "../../../content/i18n/es.json";
// Types only: the developer catalog is never part of the production bundle (see dev-i18n.ts).
import type devEn from "../../../content/i18n/dev.en.json";

export type Locale = "en" | "es";
export type MessageKey = keyof typeof en | keyof typeof devEn;
export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const catalogs: Record<Locale, Record<string, string>> = { en, es };

export function detectLocale(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith("es") ? "es" : "en";
}

/**
 * Replaces `{name}` placeholders; an unknown key renders as the key itself. `extra` adds messages
 * to the app catalog (the developer pages pass theirs, see dev-i18n.ts).
 */
export function createTranslator(locale: Locale, extra: Record<string, string> = {}): Translate {
  const catalog = { ...catalogs[locale], ...extra };
  return (key, params = {}) =>
    (catalog[key] ?? key).replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    );
}
