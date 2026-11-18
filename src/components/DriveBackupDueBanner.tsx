import { useCallback, useEffect, useState } from 'react';
import { CloudUpload } from 'lucide-react';
import { useLanguage } from '../lib/i18n';
import { backupNow, getLastBackupStatus, isBackupDue } from '../lib/googleDriveBackup';

// Shown across the top of the app when Google Drive backup is connected but
// no backup has really uploaded for 24 hours. A browser cannot back up in the
// background while the app is closed, and Google's login for this app lasts
// about an hour, so the honest design is: try silently when the app opens
// (App.tsx does that), and if that could not happen, ask for ONE tap here.
// The tap is a real user gesture, so Google's sign-in window may open.
// Renders nothing when Drive backup is not connected or nothing is due.

const RECHECK_MS = 5 * 60 * 1000;

export function DriveBackupDueBanner() {
  const { t } = useLanguage();
  const [due, setDue] = useState(() => isBackupDue());
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recheck = useCallback(() => setDue(isBackupDue()), []);

  useEffect(() => {
    const timer = setInterval(recheck, RECHECK_MS);
    function onVisible() {
      if (document.visibilityState === 'visible') {
        // Give the silent auto-backup in App.tsx a moment to finish first.
        setTimeout(recheck, 4000);
      }
    }
    document.addEventListener('visibilitychange', onVisible);
    // Also re-check shortly after the app opens, for the same reason.
    const first = setTimeout(recheck, 4000);
    return () => {
      clearInterval(timer);
      clearTimeout(first);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [recheck]);

  if (!due || dismissed) return null;

  const last = getLastBackupStatus().lastSuccessAt;

  async function handleBackup() {
    setBusy(true);
    setError(null);
    try {
      const result = await backupNow();
      if (!result.ok) setError(result.reason);
    } finally {
      setBusy(false);
      recheck();
    }
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 bg-amber-50 border-b border-amber-100 text-sm text-ink-900"
    >
      <CloudUpload size={16} strokeWidth={2} className="shrink-0 text-amber-600" aria-hidden="true" />
      <span className="flex-1 min-w-[12rem]">
        {last
          ? t(
              `गुगल ड्राइभ ब्याकअप गर्ने बेला भयो (पछिल्लो सफल: ${new Date(last).toLocaleString()})।`,
              `Google Drive backup is due (last successful: ${new Date(last).toLocaleString()}).`,
            )
          : t('गुगल ड्राइभमा अहिलेसम्म कुनै सफल ब्याकअप भएको छैन।', 'No successful Google Drive backup yet.')}
        {error && <span className="text-brick-600"> — {error}</span>}
      </span>
      <button onClick={handleBackup} disabled={busy} className="btn btn-primary btn-sm">
        {busy ? t('ब्याकअप हुँदैछ…', 'Backing up…') : t('अहिले ब्याकअप गर्नुहोस्', 'Back up now')}
      </button>
      <button
        onClick={() => setDismissed(true)}
        disabled={busy}
        className="text-xs font-medium text-ink-500 hover:text-ink-900 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
      >
        {t('पछि', 'Later')}
      </button>
    </div>
  );
}
