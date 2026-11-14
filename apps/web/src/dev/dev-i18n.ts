import devEn from "../../../../content/i18n/dev.en.json";
import devEs from "../../../../content/i18n/dev.es.json";
import { createTranslator, type Locale, type Translate } from "../i18n.js";

/** The translator of the developer pages: the app catalog plus the dev.* messages. Dev entry points only. */
export function createDevTranslator(locale: Locale): Translate {
  return createTranslator(locale, locale === "es" ? devEs : devEn);
}
