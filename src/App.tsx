import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  BookOpen,
  Search,
  NotebookText,
  Users,
  Truck,
  Landmark,
  BarChart3,
  Settings as SettingsIcon,
  Menu,
  X,
  Lock,
} from 'lucide-react';
import { seedReferenceData } from './db/schema';
import { getSyncConfig } from './lib/syncConfig';
import { ensureSignedIn } from './lib/firebaseClient';
import { autoBackupTick, MIN_AUTO_BACKUP_INTERVAL_MS } from './lib/googleDriveBackup';
import { todayISO, formatDateDisplay } from './lib/dates';
import { getOrCreateLedgerDay } from './lib/ledger';
import type { Direction, Transaction } from './types';
import { DateNav } from './components/DateNav';
import { BalanceSummary } from './components/BalanceSummary';
import { TransactionList } from './components/TransactionList';
import { TransactionFormModal } from './components/TransactionFormModal';
import { FastEntryBar } from './components/FastEntryBar';
import { SearchView } from './components/SearchView';
import { DiariesView } from './components/DiariesView';
import { SettingsView } from './components/SettingsView';
import { StaffView } from './components/StaffView';
import { VehiclesView } from './components/VehiclesView';
import { InstitutionsView } from './components/InstitutionsView';
import { ReportsView } from './components/ReportsView';
import { DashboardView } from './components/DashboardView';
import { useEscapeToClose } from './hooks/useEscapeToClose';
import { LanguageProvider, useLanguage } from './lib/i18n';
import { AppLockGate } from './components/AppLockGate';
import { DriveBackupDueBanner } from './components/DriveBackupDueBanner';
import { useAppLockState } from './hooks/useAppLock';
import { lockNow } from './lib/appLock';
import {
  useCashInTypeLookup,
  useCategoryLookup,
  useDayTransactions,
  useExpenseHeadLookup,
  useInstitutionLookup,
  useLedgerDay,
  useStaffLookup,
  useVehicleLookup,
} from './hooks/useLedger';

type Tab =
  | 'dashboard'
  | 'ledger'
  | 'diaries'
  | 'staff'
  | 'vehicles'
  | 'institutions'
  | 'reports'
  | 'search'
  | 'settings';

const NAV_GROUPS: { items: { tab: Tab; label: { ne: string; en: string }; icon: typeof LayoutDashboard }[] }[] = [
  { items: [{ tab: 'dashboard', label: { ne: 'ड्यासबोर्ड', en: 'Dashboard' }, icon: LayoutDashboard }] },
  {
    items: [
      { tab: 'ledger', label: { ne: 'दैनिक नगद खाता', en: 'Daily Ledger' }, icon: BookOpen },
      { tab: 'diaries', label: { ne: 'खर्च डायरी', en: 'Expense Diaries' }, icon: NotebookText },
      { tab: 'staff', label: { ne: 'कर्मचारी', en: 'Staff' }, icon: Users },
      { tab: 'vehicles', label: { ne: 'सवारी साधन', en: 'Vehicles' }, icon: Truck },
      { tab: 'institutions', label: { ne: 'बचत / वित्त', en: 'Savings / Finance' }, icon: Landmark },
    ],
  },
  {
    items: [
      { tab: 'search', label: { ne: 'खोजी', en: 'Search' }, icon: Search },
      { tab: 'reports', label: { ne: 'प्रतिवेदन', en: 'Reports' }, icon: BarChart3 },
    ],
  },
  { items: [{ tab: 'settings', label: { ne: 'सेटिङ', en: 'Settings' }, icon: SettingsIcon }] },
];

const TAB_LABELS: Record<Tab, { ne: string; en: string }> = {
  dashboard: { ne: 'ड्यासबोर्ड', en: 'Dashboard' },
  ledger: { ne: 'दैनिक नगद खाता', en: 'Daily Ledger' },
  diaries: { ne: 'खर्च डायरी', en: 'Expense Diaries' },
  staff: { ne: 'कर्मचारी', en: 'Staff' },
  vehicles: { ne: 'सवारी साधन', en: 'Vehicles' },
  institutions: { ne: 'बचत / वित्त', en: 'Savings / Finance' },
  reports: { ne: 'प्रतिवेदन', en: 'Reports' },
  search: { ne: 'खोजी', en: 'Search' },
  settings: { ne: 'सेटिङ', en: 'Settings' },
};

function DailyLedgerScreen() {
  const { t } = useLanguage();
  const [date, setDate] = useState(todayISO());
  const [formState, setFormState] = useState<
    { direction: Direction; editing: Transaction | null } | null
  >(null);

  // Ensure a LedgerDay row exists for whichever date is being viewed, so
  // opening/closing balances render immediately instead of staying blank
  // until the first transaction is added.
  useEffect(() => {
    getOrCreateLedgerDay(date).catch((err) => console.error('Failed to load ledger day', err));
  }, [date]);

  const day = useLedgerDay(date);
  const transactions = useDayTransactions(date);
  const categoryLookup = useCategoryLookup();
  const expenseHeadLookup = useExpenseHeadLookup();
  const cashInTypeLookup = useCashInTypeLookup();
  const staffLookup = useStaffLookup();
  const vehicleLookup = useVehicleLookup();
  const institutionLookup = useInstitutionLookup();

  const cashInEntries = (transactions ?? []).filter((t) => t.direction === 'cash_in');
  const cashOutEntries = (transactions ?? []).filter((t) => t.direction === 'cash_out');

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-5 space-y-4 pb-24">
      <DateNav date={date} onChange={setDate} />
      <BalanceSummary date={date} day={day} />

      <FastEntryBar
        date={date}
        onOpenDetailed={(direction) => setFormState({ direction, editing: null })}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="card overflow-hidden">
          <div className="flex items-center justify-between px-4 pt-4 pb-1">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-teal-600" aria-hidden="true" />
              <h2 className="panel-title">{t('नगद आम्दानी', 'Cash In')}</h2>
            </div>
            <button
              onClick={() => setFormState({ direction: 'cash_in', editing: null })}
              className="btn btn-teal btn-sm"
            >
              + {t('थप्नुहोस्', 'Add')}
            </button>
          </div>
          <div className="px-4 pb-1">
            <TransactionList
              transactions={cashInEntries}
              categoryLookup={categoryLookup}
              expenseHeadLookup={expenseHeadLookup}
              cashInTypeLookup={cashInTypeLookup}
              staffLookup={staffLookup}
              vehicleLookup={vehicleLookup}
              institutionLookup={institutionLookup}
              onEdit={(t) => setFormState({ direction: 'cash_in', editing: t })}
            />
          </div>
        </section>

        <section className="card overflow-hidden">
          <div className="flex items-center justify-between px-4 pt-4 pb-1">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-brick-600" aria-hidden="true" />
              <h2 className="panel-title">{t('नगद खर्च', 'Cash Out')}</h2>
            </div>
            <button
              onClick={() => setFormState({ direction: 'cash_out', editing: null })}
              className="btn btn-brick btn-sm"
            >
              + {t('थप्नुहोस्', 'Add')}
            </button>
          </div>
          <div className="px-4 pb-1">
            <TransactionList
              transactions={cashOutEntries}
              categoryLookup={categoryLookup}
              expenseHeadLookup={expenseHeadLookup}
              cashInTypeLookup={cashInTypeLookup}
              staffLookup={staffLookup}
              vehicleLookup={vehicleLookup}
              institutionLookup={institutionLookup}
              onEdit={(t) => setFormState({ direction: 'cash_out', editing: t })}
            />
          </div>
        </section>
      </div>

      {formState && (
        <TransactionFormModal
          date={date}
          direction={formState.direction}
          editing={formState.editing}
          onClose={() => setFormState(null)}
        />
      )}
    </div>
  );
}

function NavList({ tab, onSelect }: { tab: Tab; onSelect: (t: Tab) => void }) {
  const { language } = useLanguage();
  return (
    <nav className="flex-1 overflow-y-auto thin-scroll px-3 py-4 space-y-4">
      {NAV_GROUPS.map((group, gi) => (
        <div key={gi} className="space-y-0.5">
          {group.items.map(({ tab: itemTab, label, icon: Icon }) => {
            const active = tab === itemTab;
            return (
              <button
                key={itemTab}
                onClick={() => onSelect(itemTab)}
                className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-3 lg:py-2 text-sm font-medium transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/70 ${
                  active
                    ? 'bg-white/10 text-white'
                    : 'text-primary-200 hover:bg-white/5 hover:text-white'
                }`}
              >
                <Icon
                  size={17}
                  strokeWidth={2}
                  className={`transition-transform duration-150 group-hover:translate-x-0.5 ${
                    active ? 'text-teal-400' : 'text-primary-300'
                  }`}
                />
                <span className="truncate">{label[language]}</span>
              </button>
            );
          })}
          {gi < NAV_GROUPS.length - 1 && (
            <div className="!mt-3 mx-3 border-t border-white/10" />
          )}
        </div>
      ))}
    </nav>
  );
}

function SidebarBrand() {
  const { t } = useLanguage();
  return (
    <div className="flex items-center gap-2.5 px-4 py-5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600 text-white font-bold text-sm shrink-0">
        ₹
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-white leading-tight truncate">{t('अफिस नगद खाता', 'Office Cash Ledger')}</p>
        <p className="text-[11px] text-primary-300 leading-tight">{t('दैनिक नगद खाता', 'Daily cashbook')}</p>
      </div>
    </div>
  );
}

function LanguageToggle({ className }: { className?: string }) {
  const { language, setLanguage } = useLanguage();
  return (
    <div className={`inline-flex rounded-lg border border-white/15 overflow-hidden text-[11px] font-medium ${className ?? ''}`}>
      <button
        onClick={() => setLanguage('ne')}
        className={`px-2.5 py-2 lg:py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/70 focus-visible:z-10 relative ${language === 'ne' ? 'bg-white/15 text-white' : 'text-primary-300 hover:text-white'}`}
        aria-pressed={language === 'ne'}
      >
        नेपाली
      </button>
      <button
        onClick={() => setLanguage('en')}
        className={`px-2.5 py-2 lg:py-1 border-l border-white/15 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/70 focus-visible:z-10 relative ${language === 'en' ? 'bg-white/15 text-white' : 'text-primary-300 hover:text-white'}`}
        aria-pressed={language === 'en'}
      >
        EN
      </button>
    </div>
  );
}

// Phase 7: "Lock now". Renders ONLY when an App Lock is configured, so with
// no lock set (the default) the sidebar is exactly what it was before.
function LockNowButton() {
  const { t } = useLanguage();
  const lockState = useAppLockState();
  if (lockState === 'unconfigured') return null;
  return (
    <button
      onClick={lockNow}
      className="w-full flex items-center gap-2 rounded-lg px-2 py-2.5 lg:px-1 lg:py-1 text-xs font-medium text-primary-200 hover:text-white hover:bg-white/5 lg:hover:bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/70"
    >
      <Lock size={14} strokeWidth={2} />
      {t('अहिले लक गर्नुहोस्', 'Lock now')}
    </button>
  );
}

function AppShell() {
  const { t, language } = useLanguage();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [ready, setReady] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Set when the Staff screen's "Assigned Vehicle" link is clicked, so the
  // Vehicles screen knows which profile to open once it mounts (Phase 5
  // Part B). Cleared by VehiclesView as soon as it's consumed.
  const [vehicleToOpen, setVehicleToOpen] = useState<string | null>(null);

  useEffect(() => {
    seedReferenceData()
      .then(() => setReady(true))
      .catch((err) => {
        console.error('Failed to seed reference data', err);
        setReady(true);
      });

    // Phase 10b Part A: if a sync code is configured, silently sign in
    // with Firebase Anonymous Auth on app start (no UI, no prompt) so the
    // device is already authenticated by the time Sync Now is pressed.
    // If NO sync code is configured, getSyncConfig() resolves null and
    // ensureSignedIn() is never called — zero Firebase SDK calls, zero
    // network activity, exactly Phase 10a's behavior. Best-effort and
    // non-blocking: a failure here (e.g. offline) never blocks the app —
    // syncNow() will simply retry the sign-in itself when Sync Now is
    // actually pressed.
    getSyncConfig()
      .then((config) => {
        if (config) return ensureSignedIn();
      })
      .catch((err) => {
        console.error('Cloud Sync: silent sign-in failed (will retry on next Sync Now)', err);
      });
  }, []);

  // Optional Google Drive backup: opportunistic, rate-limited auto-backup
  // (see lib/googleDriveBackup.ts's own header comment for the full
  // design). Deliberately a SEPARATE effect from Cloud Sync's own
  // sign-in above — this feature is independent of Cloud Sync and must
  // never be conflated with it (its own non-negotiable constraint #4).
  // autoBackupTick() itself checks isConnected() first and returns
  // immediately if Drive backup was never set up, so with it
  // unconfigured this effect creates a harmless, no-op interval timer
  // and two no-op event listeners — zero network calls, exactly
  // constraint #1's "not connected = zero new network calls" for the
  // ongoing/background path (the same guarantee already holds
  // separately for the Settings UI itself, which renders nothing extra
  // either until Drive backup is enabled).
  useEffect(() => {
    const interval = setInterval(() => {
      void autoBackupTick();
    }, MIN_AUTO_BACKUP_INTERVAL_MS);

    // Best-effort on page hide/unload, whichever comes first (constraint
    // #5) - 'visibilitychange' fires reliably on mobile backgrounding and
    // tab switches; 'pagehide' covers actual navigation/close. Both are
    // fire-and-forget: a page that's genuinely closing may not let this
    // finish, which is an accepted, documented limitation (see
    // CHANGELOG) rather than something worth blocking unload for.
    function onVisibilityOrHide() {
      // Hidden: best-effort backup on the way out. Visible: when the app is
      // opened again, try a silent backup at once (it only goes ahead while
      // Google's short-lived login is still valid; otherwise the "backup is
      // due" banner asks for one tap after 24 hours).
      void autoBackupTick();
    }
    void autoBackupTick(); // also once when the app first opens
    function onPageHide() {
      void autoBackupTick();
    }
    document.addEventListener('visibilitychange', onVisibilityOrHide);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityOrHide);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  // Close the mobile nav drawer whenever the active tab changes.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [tab]);

  // v1.0 §19: Escape closes the mobile drawer.
  useEscapeToClose(() => setMobileNavOpen(false), mobileNavOpen);

  function navigateToVehicle(vehicleId: string) {
    setVehicleToOpen(vehicleId);
    setTab('vehicles');
  }

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside
        className="hidden lg:flex lg:flex-col lg:w-60 lg:shrink-0 lg:sticky lg:top-0 lg:h-screen"
        style={{ background: 'linear-gradient(180deg,var(--color-primary-900),var(--color-primary-800))' }}
      >
        <SidebarBrand />
        <NavList tab={tab} onSelect={setTab} />
        <div className="px-4 py-4 border-t border-white/10 space-y-2">
          <LockNowButton />
          <LanguageToggle />
          <p className="text-[11px] text-primary-300 figures">{formatDateDisplay(todayISO())}</p>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="lg:hidden sticky top-0 z-30 bg-primary-900 text-white">
        <div className="flex items-center justify-between px-4 py-3">
          <button
            onClick={() => setMobileNavOpen(true)}
            className="flex h-11 w-11 -ml-2.5 items-center justify-center rounded-lg hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/70"
            aria-label={t('नेभिगेसन खोल्नुहोस्', 'Open navigation')}
          >
            <Menu size={20} />
          </button>
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-teal-600 text-white font-bold text-xs">
              ₹
            </div>
            <p className="text-sm font-semibold">{TAB_LABELS[tab][language]}</p>
          </div>
          <LanguageToggle />
        </div>
      </header>

      {/* Mobile nav drawer */}
      {mobileNavOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
          <div
            className="relative w-64 max-w-[80vw] flex flex-col h-full"
            style={{
              background: 'linear-gradient(180deg,var(--color-primary-900),var(--color-primary-800))',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            <div className="flex items-center justify-between pr-2">
              <SidebarBrand />
              <button
                onClick={() => setMobileNavOpen(false)}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-primary-200 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/70"
                aria-label={t('नेभिगेसन बन्द गर्नुहोस्', 'Close navigation')}
              >
                <X size={18} />
              </button>
            </div>
            <NavList tab={tab} onSelect={setTab} />
            <div className="px-4 py-3 border-t border-white/10 space-y-2">
              <LockNowButton />
              <LanguageToggle />
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 min-w-0">
        <DriveBackupDueBanner />
        {!ready ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-ink-400">
            <span className="spinner" aria-hidden="true" />
            {t('लोड हुँदैछ…', 'Loading…')}
          </div>
        ) : tab === 'dashboard' ? (
          <DashboardView />
        ) : tab === 'ledger' ? (
          <DailyLedgerScreen />
        ) : tab === 'search' ? (
          <SearchView />
        ) : tab === 'diaries' ? (
          <DiariesView />
        ) : tab === 'staff' ? (
          <StaffView onNavigateToVehicle={navigateToVehicle} />
        ) : tab === 'vehicles' ? (
          <VehiclesView
            openVehicleId={vehicleToOpen}
            onOpenedVehicle={() => setVehicleToOpen(null)}
          />
        ) : tab === 'institutions' ? (
          <InstitutionsView />
        ) : tab === 'reports' ? (
          <ReportsView />
        ) : (
          <SettingsView />
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AppLockGate>
        <AppShell />
      </AppLockGate>
    </LanguageProvider>
  );
}
