// Phase 7: the lock screen. Rendered INSTEAD of the app (by AppLockGate)
// whenever a lock is configured and the session isn't unlocked - so while
// it's showing, none of the app's screens are mounted at all and nothing
// here reads or writes the ledger data. It only talks to lib/appLock.ts.

import { useState } from 'react';
import { Lock } from 'lucide-react';
import { useLanguage } from '../lib/i18n';
import { getRetryAfterMs, resetViaExternalVerification, resetViaRecoveryCode, verify, validateNewPin } from '../lib/appLock';
import { failureMessage } from '../lib/appLockMessages';
import { useRetryCountdown } from '../hooks/useRetryCountdown';
import { PinField, RecoveryCodePanel } from './AppLockParts';
import { isGoogleRecoveryLinked, verifyGoogleAccountForRecovery } from '../lib/googleAccountRecovery';

type Mode = 'pin' | 'recover' | 'google' | 'new-code';

export function LockScreen() {
  const { t, language, setLanguage } = useLanguage();
  const [mode, setMode] = useState<Mode>('pin');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { secondsLeft, start } = useRetryCountdown(getRetryAfterMs());

  // recovery-code flow
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [issuedCode, setIssuedCode] = useState<string | null>(null);

  // Google-account-linked recovery flow - a SEPARATE path from the
  // recovery code above, offered only when isGoogleRecoveryLinked() (set
  // once, in Settings, well before any lock-out - see
  // lib/googleAccountRecovery.ts's header comment for why this stays
  // fully independent of Google Drive Backup's own connection).
  const googleAvailable = isGoogleRecoveryLinked();
  const [googleVerified, setGoogleVerified] = useState(false);
  const [googlePin, setGooglePin] = useState('');
  const [googleConfirmPin, setGoogleConfirmPin] = useState('');
  const [googleError, setGoogleError] = useState<string | null>(null);

  const waiting = secondsLeft > 0;

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    if (busy || waiting || pin === '') return;
    setBusy(true);
    setError(null);
    const result = await verify(pin);
    if (result.ok) return; // the gate re-renders the app; this component unmounts
    setBusy(false);
    setPin('');
    if (result.retryAfterMs) start(result.retryAfterMs);
    setError(failureMessage(result, t));
  }

  async function handleRecover(e: React.FormEvent) {
    e.preventDefault();
    if (busy || waiting) return;
    setError(null);
    if (validateNewPin(newPin)) {
      setError(failureMessage({ ok: false, reason: 'invalid-new-pin' }, t));
      return;
    }
    if (newPin !== confirmPin) {
      setError(t('दुवै पिन / पासवर्ड मेल खाएनन्।', "The two entries don't match."));
      return;
    }
    setBusy(true);
    const result = await resetViaRecoveryCode(code, newPin);
    setBusy(false);
    if (!result.ok) {
      if (result.retryAfterMs) start(result.retryAfterMs);
      setError(failureMessage(result, t));
      return;
    }
    setCode('');
    setConfirmPin('');
    setIssuedCode(result.recoveryCode);
    setMode('new-code');
  }

  // After the owner confirms they've saved the NEW recovery code, sign in
  // with the new PIN (the only way to unlock is ever a successful verify()).
  async function handleNewCodeDone() {
    setBusy(true);
    const result = await verify(newPin);
    if (result.ok) return;
    setBusy(false);
    setIssuedCode(null);
    setMode('pin');
    setError(failureMessage(result, t));
  }

  async function handleGoogleSignIn() {
    if (busy) return;
    setGoogleError(null);
    setBusy(true);
    const result = await verifyGoogleAccountForRecovery();
    setBusy(false);
    if (!result.ok) {
      // Deliberately the same message whether sign-in failed outright or
      // succeeded with a non-matching account - see
      // verifyGoogleAccountForRecovery()'s own comment for why.
      setGoogleError(
        result.reason === 'unsupported'
          ? t('यो ब्राउजर वा ठेगानामा उपलब्ध छैन।', 'Not available in this browser or address.')
          : t(
              'साइन-इन गर्न सकिएन, वा यो लिङ्क गरिएको खाता होइन। रिकभरी कोड प्रयोग गर्नुहोस्, वा फेरि प्रयास गर्नुहोस्।',
              "Couldn't sign in, or this isn't the linked account. Use the recovery code instead, or try again.",
            ),
      );
      return;
    }
    setGoogleVerified(true);
  }

  async function handleGoogleReset(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setGoogleError(null);
    if (validateNewPin(googlePin)) {
      setGoogleError(failureMessage({ ok: false, reason: 'invalid-new-pin' }, t));
      return;
    }
    if (googlePin !== googleConfirmPin) {
      setGoogleError(t('दुवै पिन / पासवर्ड मेल खाएनन्।', "The two entries don't match."));
      return;
    }
    setBusy(true);
    const result = await resetViaExternalVerification(googlePin);
    setBusy(false);
    if (!result.ok) {
      setGoogleError(failureMessage(result, t));
      return;
    }
    setNewPin(googlePin);
    setGooglePin('');
    setGoogleConfirmPin('');
    setIssuedCode(result.recoveryCode);
    setMode('new-code');
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-600 text-white font-bold text-sm shrink-0">
              ₹
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink-900 leading-tight">{t('अफिस नगद खाता', 'Office Cash Ledger')}</p>
              <p className="text-[11px] text-ink-500 leading-tight">{t('दैनिक नगद खाता', 'Daily cashbook')}</p>
            </div>
          </div>
          <div className="inline-flex rounded-lg border border-line-300 overflow-hidden text-[11px] font-medium">
            <button
              type="button"
              onClick={() => setLanguage('ne')}
              className={`px-2.5 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 focus-visible:z-10 relative ${language === 'ne' ? 'bg-primary-600 text-white' : 'text-ink-500 hover:text-ink-900'}`}
              aria-pressed={language === 'ne'}
            >
              नेपाली
            </button>
            <button
              type="button"
              onClick={() => setLanguage('en')}
              className={`px-2.5 py-1.5 border-l border-line-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 focus-visible:z-10 relative ${language === 'en' ? 'bg-primary-600 text-white' : 'text-ink-500 hover:text-ink-900'}`}
              aria-pressed={language === 'en'}
            >
              EN
            </button>
          </div>
        </div>

        <section className="card card-pad space-y-4">
          {mode === 'pin' && (
            <form onSubmit={handleUnlock} className="space-y-4">
              <div className="flex items-center gap-2">
                <Lock size={16} className="text-ink-500" aria-hidden="true" />
                <h1 className="text-base font-semibold text-ink-900">{t('यो एप लक गरिएको छ', 'This app is locked')}</h1>
              </div>
              <PinField
                id="lock-pin"
                label={t('पिन / पासवर्ड', 'PIN / password')}
                value={pin}
                onChange={setPin}
                t={t}
                autoFocus
                disabled={busy}
              />
              {error && !waiting && <p className="text-sm text-brick-600" role="alert">{error}</p>}
              {waiting && (
                <p className="text-sm text-brick-600" role="alert">
                  {t(
                    `धेरै गलत प्रयास भए। ${secondsLeft} सेकेन्ड पछि फेरि प्रयास गर्नुहोस्।`,
                    `Too many wrong attempts. Try again in ${secondsLeft}s.`,
                  )}
                </p>
              )}
              <button type="submit" disabled={busy || waiting || pin === ''} className="btn btn-primary w-full">
                {busy ? t('जाँच हुँदैछ…', 'Checking…') : t('खोल्नुहोस्', 'Unlock')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('recover');
                  setError(null);
                }}
                className="link-teal"
              >
                {t('पिन बिर्सनुभयो?', 'Forgot your PIN?')}
              </button>
            </form>
          )}

          {mode === 'recover' && (
            <form onSubmit={handleRecover} className="space-y-3">
              <h1 className="text-base font-semibold text-ink-900">
                {t('रिकभरी कोडबाट पिन रिसेट गर्नुहोस्', 'Reset your PIN with the recovery code')}
              </h1>
              <div>
                <label htmlFor="lock-code" className="field-label">{t('रिकभरी कोड', 'Recovery code')}</label>
                <input
                  id="lock-code"
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="field uppercase tracking-wider figures"
                  placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>
              <PinField id="lock-new-pin" label={t('नयाँ पिन / पासवर्ड', 'New PIN / password')} value={newPin} onChange={setNewPin} t={t} disabled={busy} />
              <PinField id="lock-confirm-pin" label={t('नयाँ पिन / पासवर्ड फेरि लेख्नुहोस्', 'Confirm new PIN / password')} value={confirmPin} onChange={setConfirmPin} t={t} disabled={busy} />
              {error && !waiting && <p className="text-sm text-brick-600" role="alert">{error}</p>}
              {waiting && (
                <p className="text-sm text-brick-600" role="alert">
                  {t(
                    `धेरै गलत प्रयास भए। ${secondsLeft} सेकेन्ड पछि फेरि प्रयास गर्नुहोस्।`,
                    `Too many wrong attempts. Try again in ${secondsLeft}s.`,
                  )}
                </p>
              )}
              <button type="submit" disabled={busy || waiting || code.trim() === ''} className="btn btn-primary w-full">
                {busy ? t('जाँच हुँदैछ…', 'Checking…') : t('पिन रिसेट गर्नुहोस्', 'Reset PIN')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('pin');
                  setError(null);
                }}
                className="link-teal"
              >
                {t('← पछाडि', '← Back')}
              </button>
              {googleAvailable && (
                <button
                  type="button"
                  onClick={() => {
                    setMode('google');
                    setError(null);
                    setGoogleError(null);
                    setGoogleVerified(false);
                  }}
                  className="link-teal block"
                >
                  {t('कोड छैन? यसको सट्टा Google खाताबाट रिसेट गर्नुहोस्', "Don't have the code? Reset with Google sign-in instead")}
                </button>
              )}
              <div className="rounded-lg bg-surface-muted p-3 text-xs text-ink-500 space-y-1">
                <p className="font-medium text-ink-700">{t('रिकभरी कोड पनि छैन?', 'No recovery code either?')}</p>
                <p>
                  {t(
                    'लक रिसेट गर्ने अरू कुनै उपाय छैन — यो एपमा सर्भर वा इमेल छैन। अन्तिम उपायको रूपमा, ब्राउजरमा यस साइटको डाटा मेटाएर (वा नयाँ ब्राउजर प्रोफाइल प्रयोग गरेर) ब्याकअप फाइलबाट पुनःस्थापना गर्न सकिन्छ। पछिल्लो ब्याकअपपछि थपिएका (र क्लाउड सिंकमा नभएका) प्रविष्टिहरू गुम्नेछन्। गलत पिनले तपाईंको डाटा कहिल्यै मेट्दैन।',
                    "There is no other way to reset the lock — this app has no server and no email. As a last resort you can clear this site's data in the browser (or use a fresh browser profile) and restore from a backup file. Anything entered since your last backup (and not held by Cloud Sync) would be lost. A wrong PIN never deletes your data.",
                  )}
                </p>
              </div>
            </form>
          )}

          {mode === 'google' && (
            <div className="space-y-3">
              <h1 className="text-base font-semibold text-ink-900">
                {t('Google खाताबाट पिन रिसेट गर्नुहोस्', 'Reset your PIN with Google sign-in')}
              </h1>
              {!googleVerified ? (
                <>
                  <p className="text-sm text-ink-500">
                    {t(
                      'सेटअप गर्दा लिङ्क गरिएको सोही Google खातामा साइन-इन गर्नुहोस्।',
                      'Sign in with the same Google account that was linked during setup.',
                    )}
                  </p>
                  {googleError && <p className="text-sm text-brick-600" role="alert">{googleError}</p>}
                  <button type="button" onClick={handleGoogleSignIn} disabled={busy} className="btn btn-primary w-full">
                    {busy ? t('जाँच हुँदैछ…', 'Checking…') : t('Google बाट साइन-इन गर्नुहोस्', 'Sign in with Google')}
                  </button>
                </>
              ) : (
                <form onSubmit={handleGoogleReset} className="space-y-3">
                  <p className="text-sm text-teal-700">{t('पहिचान पुष्टि भयो। नयाँ पिन राख्नुहोस्।', 'Identity confirmed. Set a new PIN.')}</p>
                  <PinField id="lock-google-new-pin" label={t('नयाँ पिन / पासवर्ड', 'New PIN / password')} value={googlePin} onChange={setGooglePin} t={t} disabled={busy} autoFocus />
                  <PinField id="lock-google-confirm-pin" label={t('नयाँ पिन / पासवर्ड फेरि लेख्नुहोस्', 'Confirm new PIN / password')} value={googleConfirmPin} onChange={setGoogleConfirmPin} t={t} disabled={busy} />
                  {googleError && <p className="text-sm text-brick-600" role="alert">{googleError}</p>}
                  <button type="submit" disabled={busy || googlePin === ''} className="btn btn-primary w-full">
                    {busy ? t('सेभ हुँदैछ…', 'Saving…') : t('नयाँ पिन सेट गर्नुहोस्', 'Set new PIN')}
                  </button>
                </form>
              )}
              <button
                type="button"
                onClick={() => {
                  setMode('recover');
                  setGoogleError(null);
                  setGoogleVerified(false);
                }}
                className="link-teal"
              >
                {t('← रिकभरी कोड प्रयोग गर्नुहोस्', '← Use the recovery code instead')}
              </button>
            </div>
          )}

          {mode === 'new-code' && issuedCode && (
            <div className="space-y-3">
              <p className="text-sm text-teal-700 font-medium">
                {t('पिन रिसेट भयो। पुरानो रिकभरी कोड अब काम गर्दैन।', 'PIN reset. Your old recovery code no longer works.')}
              </p>
              <RecoveryCodePanel code={issuedCode} t={t} onDone={handleNewCodeDone} busy={busy} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
