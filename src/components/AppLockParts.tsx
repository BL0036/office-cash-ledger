// Phase 7: small pieces shared by the lock screen (LockScreen.tsx) and the
// Settings -> App Lock section (SettingsView.tsx). Components only: the
// countdown hook lives in hooks/useRetryCountdown.ts and the message helper
// in lib/appLockMessages.ts (keeps this file Fast-Refresh-friendly).

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

type Translate = (ne: string, en: string) => string;

/** A password-style PIN/password input with the same show/hide eye toggle the AI-key field uses. */
export function PinField({
  label,
  value,
  onChange,
  t,
  autoFocus,
  disabled,
  id,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  t: Translate;
  autoFocus?: boolean;
  disabled?: boolean;
  id: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="field pr-9"
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={disabled}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
          aria-label={show ? t('लुकाउनुहोस्', 'Hide') : t('देखाउनुहोस्', 'Show')}
          tabIndex={-1}
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}

/**
 * Shows a freshly generated recovery code EXACTLY ONCE, with the "cannot
 * see it again" warning, and won't let the owner continue until they
 * confirm they've written it down. Used after setup and after a
 * recovery-code reset (the code is single-use).
 */
export function RecoveryCodePanel({
  code,
  t,
  onDone,
  busy,
}: {
  code: string;
  t: Translate;
  onDone: () => void;
  busy?: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (permissions / insecure context); writing it down is the real instruction.
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-ink-900">
        {t('आफ्नो रिकभरी कोड लेखेर राख्नुहोस्', 'Write down your recovery code')}
      </h3>
      <div className="rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-700 space-y-1.5">
        <p className="font-semibold">
          {t('यो कोड फेरि कहिल्यै देखाइने छैन।', 'This code will NOT be shown again.')}
        </p>
        <p>
          {t(
            'यसलाई कागजमा लेखेर सुरक्षित ठाउँमा राख्नुहोस् (यही उपकरणमा होइन)। पिन बिर्सनुभयो भने नयाँ पिन राख्ने एकमात्र उपाय यही कोड हो — इमेल रिसेट वा अरू कुनै रिकभरी छैन। यो कोड पनि गुमे, अन्तिम उपाय भनेको ब्राउजरमा यस साइटको डाटा मेटाएर ब्याकअप फाइलबाट पुनःस्थापना गर्नु हो — पछिल्लो ब्याकअपपछि थपिएका प्रविष्टिहरू गुम्न सक्छन्।',
            'Write it on paper and keep it somewhere safe (not on this device). If you forget your PIN, this code is the ONLY way to set a new one — there is no email reset and no other recovery. If you lose the code too, the last resort is clearing this site\'s data in the browser and restoring from a backup file, and anything entered since your last backup could be lost.',
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <code
          className="flex-1 rounded-lg border border-line-300 bg-surface-muted px-3 py-2.5 text-center text-base font-semibold tracking-wider text-ink-900 select-all figures"
          data-testid="recovery-code"
        >
          {code}
        </code>
        <button type="button" onClick={handleCopy} className="btn btn-secondary btn-sm">
          {copied ? t('कपी भयो', 'Copied') : t('कपी', 'Copy')}
        </button>
      </div>
      <label className="flex items-start gap-2 text-sm text-ink-900">
        <input
          type="checkbox"
          className="checkbox mt-0.5"
          data-testid="recovery-confirm"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        {t('मैले रिकभरी कोड लेखेर राखेको छु', "I've written down my recovery code")}
      </label>
      <button type="button" onClick={onDone} disabled={!confirmed || busy} className="btn btn-primary">
        {t('सकियो', 'Done')}
      </button>
    </div>
  );
}
