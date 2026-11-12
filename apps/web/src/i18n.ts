import en from "../../../content/i18n/en.json";
import es from "../../../content/i18n/es.json";

export type Locale = "en" | "es";
export type MessageKey = keyof typeof en;
export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const catalogs: Record<Locale, Record<string, string>> = { en, es };

export function detectLocale(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith("es") ? "es" : "en";
}

/** Replaces `{name}` placeholders; an unknown key renders as the key itself. */
export function createTranslator(locale: Locale): Translate {
  const catalog = catalogs[locale];
  return (key, params = {}) =>
    (catalog[key] ?? key).replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    );
}
