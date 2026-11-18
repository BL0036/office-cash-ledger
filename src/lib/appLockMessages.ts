// Phase 7: bilingual, human-readable messages for failed App Lock operations.

import { MIN_PIN_LENGTH, type AppLockFailure } from './appLock';

export type Translate = (ne: string, en: string) => string;

/** Human-readable, bilingual message for a failed lock operation. */
export function failureMessage(f: AppLockFailure, t: Translate): string {
  if (f.retryAfterMs) {
    const s = Math.ceil(f.retryAfterMs / 1000);
    return t(
      `धेरै गलत प्रयास भए। ${s} सेकेन्ड पछि फेरि प्रयास गर्नुहोस्।`,
      `Too many wrong attempts. Try again in ${s}s.`,
    );
  }
  switch (f.reason) {
    case 'wrong-pin': {
      const base = t('गलत पिन / पासवर्ड।', 'Incorrect PIN / password.');
      if (f.attemptsBeforeDelay !== undefined && f.attemptsBeforeDelay <= 2) {
        return `${base} ${t(
          `छोटो प्रतीक्षा सुरु हुनुअघि ${f.attemptsBeforeDelay} पटक प्रयास बाँकी।`,
          `${f.attemptsBeforeDelay} more ${f.attemptsBeforeDelay === 1 ? 'try' : 'tries'} before a short wait.`,
        )}`;
      }
      return base;
    }
    case 'wrong-recovery-code':
      return t('रिकभरी कोड मिलेन।', "That recovery code doesn't match.");
    case 'rate-limited':
      return t('धेरै गलत प्रयास भए।', 'Too many wrong attempts.');
    case 'invalid-new-pin':
      return t(
        `नयाँ पिन / पासवर्ड कम्तिमा ${MIN_PIN_LENGTH} अक्षर/अङ्कको हुनुपर्छ।`,
        `The new PIN / password must be at least ${MIN_PIN_LENGTH} characters.`,
      );
    case 'unsupported':
      return t(
        'यो ब्राउजर वा ठेगानामा App Lock उपलब्ध छैन (https:// वा localhost चाहिन्छ)।',
        'App Lock is not available in this browser or address (it needs https:// or localhost).',
      );
    case 'storage-unavailable':
      return t(
        'सेभ गर्न सकिएन — यो ब्राउजरमा लोकल स्टोरेज उपलब्ध नहुन सक्छ। कुनै लक सक्रिय गरिएको छैन।',
        'Could not save — local storage may be unavailable in this browser. No lock was turned on.',
      );
    case 'already-configured':
      return t('App Lock पहिले नै सक्रिय छ।', 'App Lock is already on.');
    case 'not-configured':
      return t('App Lock सक्रिय छैन।', 'App Lock is not on.');
    default:
      return t('केही गडबड भयो। फेरि प्रयास गर्नुहोस्।', 'Something went wrong. Please try again.');
  }
}
