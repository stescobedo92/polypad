import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import es from "./locales/es.json";

export const SUPPORTED_LOCALES = ["en", "es"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

const FALLBACK_LOCALE: Locale = "en";

export const resources = {
  en: { translation: en },
  es: { translation: es },
} as const;

/** Picks the first supported locale from the user's preference list (BCP 47 tags). */
export function detectLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0];
    const match = SUPPORTED_LOCALES.find((locale) => locale === base);
    if (match !== undefined) {
      return match;
    }
  }
  return FALLBACK_LOCALE;
}

/**
 * Initializes the shared i18next instance. Resources are bundled, so initialization is
 * synchronous and `t` is usable as soon as this returns.
 */
export function initI18n(locale: Locale): typeof i18next {
  void i18next.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: FALLBACK_LOCALE,
    initAsync: false,
    interpolation: { escapeValue: false }, // React already escapes rendered text
    returnNull: false,
  });
  return i18next;
}
