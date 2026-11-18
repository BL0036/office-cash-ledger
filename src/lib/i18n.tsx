// Bilingual UI support — a lightweight language toggle, not a full i18n
// framework. `t(ne, en)` is called inline at each piece of UI text with
// both language variants literally in place, rather than routing through
// a separate keyed dictionary file — far fewer moving parts for an app
// this size, and it keeps each string's two variants next to each other
// in the code instead of in two files that can drift apart.
//
// Date/calendar formatting (lib/bsCalendar.ts, lib/dates.ts) is
// deliberately NOT wired to this toggle — dates always display in BS
// (Bikram Sambat) with Nepali digits and month names, in both languages.
// Only surrounding UI text (labels, buttons, headers) switches.
//
// DashboardView.tsx is a deliberate exception: it does not call
// useLanguage()'s t() at all and is permanently English text (dates
// still BS, via the same date-formatting functions everyone else uses)
// — a specific choice, not an oversight, so don't "fix" it to use t().

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Language = 'ne' | 'en';

const STORAGE_KEY = 'officeCashLedgerLanguage';

interface LanguageContextValue {
  language: Language;
  setLanguage: (lang: Language) => void;
  /** Returns `ne` or `en` depending on the current language. Call inline: `{t('नगद आम्दानी', 'Cash In')}`. */
  t: (ne: string, en: string) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

function readStoredLanguage(): Language {
  if (typeof window === 'undefined') return 'ne';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'en' ? 'en' : 'ne';
  } catch {
    return 'ne';
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readStoredLanguage);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // best-effort only — a private/incognito window with storage
      // disabled just means the choice won't persist across reloads.
    }
  }, [language]);

  function setLanguage(lang: Language) {
    setLanguageState(lang);
  }

  function t(ne: string, en: string): string {
    return language === 'ne' ? ne : en;
  }

  return <LanguageContext.Provider value={{ language, setLanguage, t }}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage() must be used within a LanguageProvider.');
  return ctx;
}
