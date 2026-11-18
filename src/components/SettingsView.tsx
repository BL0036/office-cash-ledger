import { useEffect, useState } from 'react';
import type { Budget, Category, ExpenseHead, CashInType } from '../types';
import {
  useAllBudgets,
  useAllCategories,
  useAllExpenseHeads,
  useAllCashInTypes,
} from '../hooks/useLedger';
import {
  addCategory,
  addExpenseHead,
  addCashInType,
  setCategoryActive,
  setExpenseHeadActive,
  setCashInTypeActive,
} from '../lib/referenceData';
import { clearBudget, getBudgetStatuses, setBudget, type BudgetStatus } from '../lib/budgets';
import { formatPaisaAsRupees, parseRupeeInputToPaisa } from '../lib/money';
import { db } from '../db/schema';
import {
  backupFileName,
  exportBackup,
  restoreFromBackup,
  serializeBackup,
  validateBackupPayload,
} from '../lib/backup';
import { buildTransactionExportRows, type ExportLookups } from '../lib/exportRows';
import { objectRowsToSheet, transactionRowsToSheet, workbookToBlob } from '../lib/excel';
import { downloadBlob, downloadTextFile } from '../lib/download';
import * as XLSX from 'xlsx';
import { clearSyncConfig, configureSyncCode, generateSyncCode, getSyncConfig } from '../lib/syncConfig';
import { syncNow, type SyncSummary } from '../lib/sync';
import type { SyncConfig } from '../types';
import { useLanguage } from '../lib/i18n';
import { getAiFallbackSettings, setAiFallbackSettings } from '../lib/aiSettingsStore';
import {
  backupNow as driveBackupNow,
  connect as driveConnect,
  disconnect as driveDisconnect,
  getLastBackupStatus as getDriveLastBackupStatus,
  isConnected as isDriveConnected,
  restoreFromDrive,
} from '../lib/googleDriveBackup';
import { getGoogleDriveBackupSettings } from '../lib/googleDriveSettingsStore';
import { Eye, EyeOff } from 'lucide-react';
import { useAppLockState } from '../hooks/useAppLock';
import {
  DEFAULT_IDLE_MINUTES,
  IDLE_MINUTES_OPTIONS,
  MIN_PIN_LENGTH,
  changePin,
  disableLock,
  getIdleMinutes,
  isAppLockSupported,
  lockNow,
  setIdleMinutes,
  setupLock,
  validateNewPin,
  type AppLockFailure,
} from '../lib/appLock';
import { failureMessage } from '../lib/appLockMessages';
import { PinField, RecoveryCodePanel } from './AppLockParts';
import {
  getGoogleRecoveryLinkedAt,
  isGoogleRecoveryLinked,
  linkGoogleAccount,
  unlinkGoogleAccount,
} from '../lib/googleAccountRecovery';

function ToggleRow({
  name,
  active,
  onToggle,
}: {
  name: string;
  active: boolean;
  onToggle: () => void;
}) {
  const { t: tr } = useLanguage();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className={`text-sm ${active ? 'text-ink-900' : 'text-ink-400 line-through'}`}>
        {name}
      </span>
      <button
        onClick={async () => {
          setBusy(true);
          try {
            await onToggle();
          } finally {
            setBusy(false);
          }
        }}
        disabled={busy}
        className={`text-xs font-medium rounded-full px-3 py-1.5 disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 ${
          active
            ? 'bg-line-100 text-ink-700 hover:bg-line-200'
            : 'bg-teal-50 text-teal-700 hover:bg-teal-100'
        }`}
      >
        {active ? tr('निष्क्रिय गर्नुहोस्', 'Deactivate') : tr('सक्रिय गर्नुहोस्', 'Activate')}
      </button>
    </div>
  );
}

function AddRow({
  placeholder,
  onAdd,
  before,
}: {
  placeholder: string;
  onAdd: (name: string) => Promise<unknown>;
  /** Optional control (e.g. a category picker) rendered before the input. */
  before?: React.ReactNode;
}) {
  const { t: tr } = useLanguage();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd(value.trim());
      setValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('थप्न सकिएन।', 'Could not add.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap gap-2 pt-2 items-center">
      {before}
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="flex-1 min-w-[8rem] rounded-lg border border-line-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
      />
      <button
        type="submit"
        disabled={saving || !value.trim()}
        className="btn btn-teal btn-sm"
      >
        {tr('थप्नुहोस्', 'Add')}
      </button>
      {error && <p className="text-xs text-brick-600 w-full">{error}</p>}
    </form>
  );
}

function CategoriesSection({ categories }: { categories: Category[] }) {
  const { t: tr } = useLanguage();
  return (
    <section className="card card-pad">
      <h2 className="panel-title mb-1">{tr('वर्गहरू', 'Categories')}</h2>
      <div className="divide-y divide-line-100">
        {categories.map((c) => (
          <ToggleRow
            key={c.id}
            name={c.name}
            active={c.active}
            onToggle={() => setCategoryActive(c.id, !c.active)}
          />
        ))}
      </div>
      <AddRow placeholder={tr('नयाँ वर्गको नाम', 'New category name')} onAdd={(name) => addCategory(name)} />
    </section>
  );
}

function ExpenseHeadsSection({
  heads,
  categories,
}: {
  heads: ExpenseHead[];
  categories: Category[];
}) {
  const { t: tr } = useLanguage();
  const activeCategories = categories.filter((c) => c.active);
  const [newHeadCategoryId, setNewHeadCategoryId] = useState<string | null>(
    activeCategories[0]?.id ?? null,
  );
  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name ?? tr('अज्ञात', 'Unknown');

  return (
    <section className="card card-pad">
      <h2 className="panel-title mb-1">{tr('खर्च शीर्षकहरू', 'Expense Heads')}</h2>
      <div className="divide-y divide-line-100">
        {heads.map((h) => (
          <ToggleRow
            key={h.id}
            name={`${h.name} (${categoryName(h.categoryId)})`}
            active={h.active}
            onToggle={() => setExpenseHeadActive(h.id, !h.active)}
          />
        ))}
      </div>

      <AddRow
        placeholder={tr('नयाँ खर्च शीर्षकको नाम', 'New expense head name')}
        before={
          <select
            value={newHeadCategoryId ?? ''}
            onChange={(e) => setNewHeadCategoryId(e.target.value)}
            className="rounded-lg border border-line-300 px-2 py-1.5 text-sm"
          >
            {activeCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        }
        onAdd={(name) => {
          if (newHeadCategoryId == null) throw new Error(tr('पहिले वर्ग छान्नुहोस्।', 'Select a category first.'));
          return addExpenseHead(newHeadCategoryId, name);
        }}
      />
    </section>
  );
}

function CashInTypesSection({ types }: { types: CashInType[] }) {
  const { t: tr } = useLanguage();
  return (
    <section className="card card-pad">
      <h2 className="panel-title mb-1">{tr('नगद आम्दानी प्रकार', 'Cash-In Types')}</h2>
      <div className="divide-y divide-line-100">
        {types.map((t) => (
          <ToggleRow
            key={t.id}
            name={t.name}
            active={t.active}
            onToggle={() => setCashInTypeActive(t.id, !t.active)}
          />
        ))}
      </div>
      <AddRow placeholder={tr('नयाँ नगद आम्दानी प्रकारको नाम', 'New cash-in type name')} onAdd={(name) => addCashInType(name)} />
    </section>
  );
}

const TIER_LABELS: Record<BudgetStatus['tier'], { ne: string; en: string }> = {
  under: { ne: 'ठीक ठाक', en: 'On track' },
  informational: { ne: 'सीमा नजिकै', en: 'Approaching limit' },
  reached: { ne: 'बजेट पुग्यो', en: 'Budget reached' },
  over: { ne: 'बजेट नाघ्यो', en: 'Over budget' },
};

const TIER_CLASSES: Record<BudgetStatus['tier'], string> = {
  under: 'bg-teal-50 text-teal-700',
  informational: 'bg-amber-50 text-amber-700',
  reached: 'bg-amber-100 text-amber-700',
  over: 'bg-brick-50 text-brick-700',
};

function BudgetRow({
  head,
  budget,
  status,
  onSaved,
}: {
  head: ExpenseHead;
  budget: Budget | undefined;
  status: BudgetStatus | undefined;
  onSaved: () => void;
}) {
  const { t: tr, language } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [amountInput, setAmountInput] = useState(
    budget ? String(budget.monthlyLimitPaisa / 100) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSave() {
    setError(null);
    const paisa = parseRupeeInputToPaisa(amountInput);
    if (paisa == null || paisa <= 0) {
      setError(tr('शून्यभन्दा बढी मान्य रकम राख्नुहोस्।', 'Enter a valid amount greater than zero.'));
      return;
    }
    setBusy(true);
    try {
      await setBudget(head.id!, paisa);
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('सुरक्षित गर्न सकिएन।', 'Could not save.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    setBusy(true);
    try {
      await clearBudget(head.id!);
      setAmountInput('');
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-ink-900">{head.name}</span>
        {!editing && (
          <div className="flex items-center gap-2">
            {status && (
              <span
                className={`text-xs font-medium rounded-full px-2 py-0.5 ${TIER_CLASSES[status.tier]}`}
              >
                {TIER_LABELS[status.tier][language]}
              </span>
            )}
            <button
              onClick={() => setEditing(true)}
              className="text-xs font-medium text-ink-500 hover:text-ink-900 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            >
              {budget ? tr('सम्पादन', 'Edit') : tr('बजेट राख्नुहोस्', 'Set Budget')}
            </button>
          </div>
        )}
      </div>

      {status && budget && !editing && (
        <p className="text-xs text-ink-400 mt-0.5">
          {tr(
            `यो महिना ${formatPaisaAsRupees(budget.monthlyLimitPaisa)} मध्ये ${formatPaisaAsRupees(status.spentPaisa)} खर्च भयो (${status.percentage.toFixed(0)}%)`,
            `${formatPaisaAsRupees(status.spentPaisa)} of ${formatPaisaAsRupees(budget.monthlyLimitPaisa)} this month (${status.percentage.toFixed(0)}%)`,
          )}
        </p>
      )}

      {editing && (
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <input
            type="text"
            inputMode="decimal"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder={tr('मासिक सीमा (रु)', 'Monthly limit (Rs.)')}
            className="flex-1 min-w-[8rem] rounded-lg border border-line-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
          <button
            onClick={handleSave}
            disabled={busy}
            className="btn btn-teal btn-sm"
          >
            {tr('सुरक्षित गर्नुहोस्', 'Save')}
          </button>
          {budget && (
            <button
              onClick={handleClear}
              disabled={busy}
              className="text-sm font-medium text-brick-600 hover:text-brick-700 disabled:opacity-60"
            >
              {tr('बजेट हटाउनुहोस्', 'Clear Budget')}
            </button>
          )}
          <button
            onClick={() => {
              setEditing(false);
              setError(null);
              setAmountInput(budget ? String(budget.monthlyLimitPaisa / 100) : '');
            }}
            className="text-sm font-medium text-ink-500 hover:text-ink-700"
          >
            {tr('रद्द गर्नुहोस्', 'Cancel')}
          </button>
          {error && <p className="text-xs text-brick-600 w-full">{error}</p>}
        </div>
      )}
    </div>
  );
}

function BudgetsSection({ heads, budgets }: { heads: ExpenseHead[]; budgets: Budget[] }) {
  const { t: tr } = useLanguage();
  const [statuses, setStatuses] = useState<BudgetStatus[]>([]);
  const activeHeads = heads.filter((h) => h.active);
  const budgetByHead = new Map(budgets.map((b) => [b.expenseHeadId, b]));

  async function refreshStatuses() {
    setStatuses(await getBudgetStatuses());
  }

  useEffect(() => {
    refreshStatuses();
  }, [budgets]);

  const statusByHead = new Map(statuses.map((s) => [s.expenseHeadId, s]));

  return (
    <section className="card card-pad">
      <h2 className="panel-title mb-1">{tr('बजेट', 'Budgets')}</h2>
      <p className="text-xs text-ink-400 mb-2">
        {tr(
          'प्रत्येक खर्च शीर्षकको लागि वैकल्पिक मासिक खर्च सीमा। सुझावमात्र हो — बजेटले कारोबार सुरक्षित हुनबाट कहिल्यै रोक्दैन।',
          'Optional monthly spending limits per expense head. Advisory only — a budget never blocks a transaction from being saved.',
        )}
      </p>
      <div className="divide-y divide-line-100">
        {activeHeads.length === 0 ? (
          <p className="text-sm text-ink-400 py-2">{tr('अहिलेसम्म कुनै सक्रिय खर्च शीर्षक छैन।', 'No active expense heads yet.')}</p>
        ) : (
          activeHeads.map((h) => (
            <BudgetRow
              key={h.id}
              head={h}
              budget={budgetByHead.get(h.id)}
              status={statusByHead.get(h.id)}
              onSaved={refreshStatuses}
            />
          ))
        )}
      </div>
    </section>
  );
}

function BackupExportSection() {
  const { t: tr } = useLanguage();
  const [exporting, setExporting] = useState(false);
  const [exportingWorkbook, setExportingWorkbook] = useState(false);
  const [restoreStep, setRestoreStep] = useState<'idle' | 'confirming' | 'restoring' | 'done'>('idle');
  const [pendingFileContents, setPendingFileContents] = useState<string | null>(null);
  const [pendingFileName, setPendingFileName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  async function handleExportBackup() {
    setExporting(true);
    setError(null);
    try {
      const payload = await exportBackup();
      downloadTextFile(serializeBackup(payload), backupFileName(payload), 'application/json');
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('निर्यात असफल भयो।', 'Export failed.'));
    } finally {
      setExporting(false);
    }
  }

  async function handleExportWorkbook() {
    setExportingWorkbook(true);
    setError(null);
    try {
      const [transactions, staff, vehicles, institutions, categories, expenseHeads, cashInTypes] =
        await Promise.all([
          db.transactions.toArray(),
          db.staff.toArray(),
          db.vehicles.toArray(),
          db.financialInstitutions.toArray(),
          db.categories.toArray(),
          db.expenseHeads.toArray(),
          db.cashInTypes.toArray(),
        ]);
      const lookups: ExportLookups = {
        categories: new Map(categories.map((c) => [c.id, c])),
        expenseHeads: new Map(expenseHeads.map((h) => [h.id, h])),
        cashInTypes: new Map(cashInTypes.map((t) => [t.id, t])),
        staff: new Map(staff.map((s) => [s.id, s])),
        vehicles: new Map(vehicles.map((v) => [v.id, v])),
        institutions: new Map(institutions.map((i) => [i.id, i])),
      };
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        workbook,
        transactionRowsToSheet(buildTransactionExportRows(transactions, lookups)),
        'Transactions',
      );
      XLSX.utils.book_append_sheet(workbook, objectRowsToSheet(staff), 'Staff');
      XLSX.utils.book_append_sheet(workbook, objectRowsToSheet(vehicles), 'Vehicles');
      XLSX.utils.book_append_sheet(workbook, objectRowsToSheet(institutions), 'Financial Institutions');
      downloadBlob(workbookToBlob(workbook), `cash-ledger-workbook-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('कार्यपुस्तिका निर्यात असफल भयो।', 'Workbook export failed.'));
    } finally {
      setExportingWorkbook(false);
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;

    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError(tr('यो फाइल मान्य JSON होइन।', 'This file is not valid JSON.'));
      return;
    }
    const validation = validateBackupPayload(parsed);
    if (!validation.valid) {
      setError(validation.error);
      return;
    }

    setPendingFileContents(text);
    setPendingFileName(file.name);
    setRestoreStep('confirming');
  }

  async function handleConfirmRestore() {
    if (!pendingFileContents) return;
    setRestoreStep('restoring');
    setError(null);
    try {
      const result = await restoreFromBackup(pendingFileContents);
      // Automatic pre-restore safety snapshot download (Part B) — always
      // happens on a successful restore, not something the owner has to
      // remember to ask for.
      downloadTextFile(
        serializeBackup(result.preRestoreSnapshot),
        `pre-restore-safety-${backupFileName(result.preRestoreSnapshot)}`,
        'application/json',
      );
      setRestoreStep('done');
      setPendingFileContents(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('पुनर्स्थापना असफल भयो।', 'Restore failed.'));
      setRestoreStep('idle');
      setPendingFileContents(null);
    }
  }

  function handleCancelRestore() {
    setRestoreStep('idle');
    setPendingFileContents(null);
    setPendingFileName('');
  }

  return (
    <section className="card card-pad space-y-4">
      <div>
        <h2 className="panel-title mb-1">{tr('ब्याकअप र निर्यात', 'Backup & Export')}</h2>
        <p className="text-xs text-ink-400">
          {tr(
            'पूर्ण JSON ब्याकअप मात्र पुनर्स्थापना गर्न सकिने ढाँचा हो। CSV/Excel निर्यात (खोजी, डायरी, सवारी साधन र संस्था स्क्रिनमा) स्प्रेडसिटमा पढ्नको लागि मात्र हो।',
            'A full JSON backup is the only format that can be restored. CSV/Excel exports (on Search, Diaries, Vehicle and Institution screens) are for reading in a spreadsheet only.',
          )}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleExportBackup}
          disabled={exporting}
          className="btn btn-teal btn-sm"
        >
          {exporting ? tr('निर्यात हुँदैछ…', 'Exporting…') : tr('ब्याकअप निर्यात (JSON)', 'Export Backup (JSON)')}
        </button>
        <button
          onClick={handleExportWorkbook}
          disabled={exportingWorkbook}
          className="btn btn-primary btn-sm"
        >
          {exportingWorkbook ? tr('निर्यात हुँदैछ…', 'Exporting…') : tr('पूर्ण कार्यपुस्तिका निर्यात (.xlsx)', 'Export Full Workbook (.xlsx)')}
        </button>
        <label className="text-sm font-medium text-brick-700 border border-brick-100 hover:bg-brick-50 rounded-lg px-3 py-1.5 cursor-pointer">
          {tr('ब्याकअपबाट पुनर्स्थापना गर्नुहोस्…', 'Restore from Backup…')}
          <input type="file" accept="application/json" className="hidden" onChange={handleFileSelected} />
        </label>
      </div>

      {error && <p className="text-sm text-brick-600">{error}</p>}

      {restoreStep === 'confirming' && (
        <div className="rounded-lg border border-brick-100 bg-brick-50 p-3 space-y-2">
          <p className="text-sm font-semibold text-brick-700">
            {tr(`"${pendingFileName}" ले हालको सबै डाटा बदल्ने हो?`, `Replace ALL current data with "${pendingFileName}"?`)}
          </p>
          <p className="text-xs text-brick-700">
            {tr(
              'यसले हरेक कारोबार, कर्मचारी, सवारी साधन, संस्था, वर्ग, र बजेटलाई यस फाइलमा भएको डाटाले स्थायी रूपमा बदल्नेछ। केही गल्ती भएमा, केही परिवर्तन हुनुअघि तपाईंको हालको डाटाको सुरक्षा ब्याकअप स्वतः डाउनलोड हुनेछ।',
              "This will permanently replace every transaction, staff member, vehicle, institution, category, and budget with what's in this file. A safety backup of your current data will download automatically before anything is changed, in case this restore was a mistake.",
            )}
          </p>
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleCancelRestore}
              className="text-sm font-medium text-ink-700 border border-line-300 hover:bg-line-100 rounded-lg px-3 py-1.5"
            >
              {tr('रद्द गर्नुहोस्', 'Cancel')}
            </button>
            <button
              onClick={handleConfirmRestore}
              className="btn btn-brick btn-sm"
            >
              {tr('हो, सबै डाटा बदल्नुहोस्', 'Yes, Replace All Data')}
            </button>
          </div>
        </div>
      )}

      {restoreStep === 'restoring' && (
        <p className="text-sm text-ink-500">{tr('पुनर्स्थापना हुँदैछ… कृपया यो ट्याब बन्द नगर्नुहोस्।', "Restoring… please don't close this tab.")}</p>
      )}

      {restoreStep === 'done' && (
        <div className="rounded-lg border border-teal-100 bg-teal-50 p-3 space-y-2">
          <p className="text-sm font-medium text-teal-700">
            {tr(
              'पुनर्स्थापना पूरा भयो। तपाईंको अघिल्लो डाटाको सुरक्षा ब्याकअप स्वतः डाउनलोड भयो।',
              'Restore complete. A safety backup of your previous data was downloaded automatically.',
            )}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="btn btn-teal btn-sm"
          >
            {tr('एप पुनः लोड गर्नुहोस्', 'Reload App')}
          </button>
        </div>
      )}
    </section>
  );
}

function CloudSyncSection() {
  const { t: tr } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<SyncSummary | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  async function refresh() {
    const c = await getSyncConfig();
    setConfig(c);
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    try {
      await configureSyncCode(generateSyncCode());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('क्लाउड सिंक सेटअप गर्न सकिएन।', 'Could not set up Cloud Sync.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin() {
    setBusy(true);
    setError(null);
    try {
      await configureSyncCode(joinCodeInput);
      setJoinCodeInput('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('त्यो सिंक कोडसँग जोड्न सकिएन।', 'Could not join with that sync code.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleSyncNow() {
    setBusy(true);
    setError(null);
    setLastSummary(null);
    try {
      const summary = await syncNow();
      setLastSummary(summary);
      await refresh();
    } catch (err) {
      // Part D: a failed sync leaves local data and lastSyncedAt exactly
      // as before — this error is the only thing that changed.
      setError(err instanceof Error ? err.message : tr('सिंक असफल भयो। केही परिवर्तन भएन।', 'Sync failed. Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setBusy(true);
    setError(null);
    try {
      await clearSyncConfig();
      setLastSummary(null);
      setConfirmingRemove(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('क्लाउड सिंक हटाउन सकिएन।', 'Could not remove Cloud Sync.'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="card card-pad">
        <p className="flex items-center gap-2 text-sm text-ink-400">
          <span className="spinner" aria-hidden="true" />
          {tr('क्लाउड सिंक लोड हुँदैछ…', 'Loading Cloud Sync…')}
        </p>
      </section>
    );
  }

  return (
    <section className="card card-pad space-y-4">
      <div>
        <h2 className="panel-title mb-1">{tr('क्लाउड सिंक', 'Cloud Sync')}</h2>
        <p className="text-xs text-ink-400">
          {tr(
            'एउटै सिंक कोड साझा गर्ने उपकरणहरू बीच म्यानुअल, दुई-तर्फी सिंक। यो साझा गोप्य कुरा हो, निजी लगइन होइन — कोड र एप भएको जो कोहीले पनि यो समूहको डाटा पढ्न र लेख्न सक्छ। एप बिना सेटअप पूर्ण रूपमा अफलाइन काम गर्छ; सिंक पूर्णतया वैकल्पिक हो।',
            'Manual, two-way sync between devices that share the same sync code. This is a shared secret, not a private login — anyone with the code and the app can read and write this group\'s data. The app works fully offline with zero setup; sync is entirely optional.',
          )}
        </p>
      </div>

      {error && <p className="text-sm text-brick-600">{error}</p>}

      {!config && (
        <div className="space-y-3">
          <button
            onClick={handleGenerate}
            disabled={busy}
            className="btn btn-teal btn-sm"
          >
            {busy ? tr('सेटअप हुँदैछ…', 'Setting up…') : tr('नयाँ सिंक कोड बनाउनुहोस्', 'Generate New Sync Code')}
          </button>
          <div className="flex items-center gap-2">
            <input
              value={joinCodeInput}
              onChange={(e) => setJoinCodeInput(e.target.value)}
              placeholder={tr('भइरहेको सिंक कोड राख्नुहोस्', 'Enter an existing sync code')}
              className="field flex-1"
            />
            <button
              onClick={handleJoin}
              disabled={busy || !joinCodeInput.trim()}
              className="btn btn-primary btn-sm"
            >
              {tr('जोड्नुहोस्', 'Join')}
            </button>
          </div>
        </div>
      )}

      {config && (
        <div className="space-y-3">
          <div className="rounded-lg border border-line-200 bg-line-100 p-3">
            <p className="text-xs text-ink-500">{tr('यो उपकरणको सिंक कोड', 'Sync code for this device')}</p>
            <p className="text-lg font-mono font-semibold tracking-widest text-ink-900">
              {config.syncCode}
            </p>
            <p className="text-xs text-ink-400 mt-1">
              {config.lastSyncedAt
                ? tr(
                    `पछिल्लो सिंक ${new Date(config.lastSyncedAt).toLocaleString()}`,
                    `Last synced ${new Date(config.lastSyncedAt).toLocaleString()}`,
                  )
                : tr('अहिलेसम्म सिंक भएको छैन', 'Never synced yet')}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSyncNow}
              disabled={busy}
              className="btn btn-teal btn-sm"
            >
              {busy ? tr('सिंक हुँदैछ…', 'Syncing…') : tr('अहिले सिंक गर्नुहोस्', 'Sync Now')}
            </button>
            {!confirmingRemove ? (
              <button
                onClick={() => setConfirmingRemove(true)}
                disabled={busy}
                className="text-sm font-medium text-brick-700 border border-brick-100 hover:bg-brick-50 rounded-lg px-3 py-1.5 disabled:opacity-60"
              >
                {tr('क्लाउड सिंक हटाउनुहोस्…', 'Remove Cloud Sync…')}
              </button>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-brick-700 w-full sm:w-auto">{tr('यो उपकरणमा सिंक रोक्ने हो?', 'Stop syncing on this device?')}</span>
                <button
                  onClick={handleRemove}
                  disabled={busy}
                  className="btn btn-brick btn-sm"
                >
                  {tr('हो, हटाउनुहोस्', 'Yes, Remove')}
                </button>
                <button
                  onClick={() => setConfirmingRemove(false)}
                  disabled={busy}
                  className="text-sm font-medium text-ink-700 border border-line-300 hover:bg-line-100 rounded-lg px-3 py-1.5"
                >
                  {tr('रद्द गर्नुहोस्', 'Cancel')}
                </button>
              </div>
            )}
          </div>

          {lastSummary && (
            <div className="rounded-lg border border-teal-100 bg-teal-50 p-3">
              <p className="text-sm font-medium text-teal-700">{tr('सिंक पूरा भयो।', 'Sync complete.')}</p>
              <p className="text-xs text-teal-700 mt-1">
                {tr(
                  `${Object.values(lastSummary.pushedCounts).reduce((a, b) => a + b, 0)} पठाइयो र ${Object.values(lastSummary.pulledCounts).reduce((a, b) => a + b, 0)} ल्याइयो।`,
                  `Pushed ${Object.values(lastSummary.pushedCounts).reduce((a, b) => a + b, 0)} and pulled ${Object.values(lastSummary.pulledCounts).reduce((a, b) => a + b, 0)} changed row(s).`,
                )}
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// Phase 6: OPTIONAL Gemini API fallback for Fast Entry's Smart Entry.
// Off by default; the key never leaves this device (see
// lib/aiSettingsStore.ts's own doc comment for exactly why it's
// structurally impossible for it to reach a backup file or Firestore -
// it's plain localStorage, a storage mechanism lib/backup.ts and
// lib/sync.ts don't import or know exists).
function AiFallbackSection() {
  const { t: tr } = useLanguage();
  const [settings, setSettings] = useState(() => getAiFallbackSettings());
  const [keyInput, setKeyInput] = useState(settings.apiKey ?? '');
  const [showKey, setShowKey] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  function persist(next: typeof settings) {
    const ok = setAiFallbackSettings(next);
    setSettings(next);
    setSaveNote(
      ok
        ? null
        : tr(
            'सेभ गर्न सकिएन — यो ब्राउजरमा लोकल स्टोरेज उपलब्ध नहुन सक्छ।',
            'Could not save — local storage may be unavailable in this browser.',
          ),
    );
  }

  function handleToggle() {
    persist({ ...settings, enabled: !settings.enabled });
  }

  function handleSaveKey() {
    persist({ ...settings, apiKey: keyInput.trim() || null });
  }

  return (
    <section className="card card-pad space-y-4">
      <div>
        <h2 className="panel-title mb-1">{tr('AI फलब्याक (वैकल्पिक)', 'AI Fallback (optional)')}</h2>
        <p className="text-xs text-ink-400">
          {tr(
            'यो पूर्णतया वैकल्पिक हो र पूर्वनिर्धारित रूपमा बन्द छ। यसले Fast Entry को भरपर्दो, अफलाइन Smart Entry इन्जिनलाई प्रतिस्थापन गर्दैन — त्यो इन्जिनले केही फेला नपारेको वा दुई/बढी उम्मेद्वार भएको बेला मात्र, र तपाईंले स्पष्ट रूपमा "Ask AI" थिच्नुभएको बेला मात्र, यसले एकपटक Google लाई सोध्छ। यसले तपाईंको टाइप गरेको विवरण अनि तपाईंको आफ्नै श्रेणी/कर्मचारी/सवारी साधन/संस्थाका नामहरू (कहिल्यै तपाईंको वास्तविक कारोबार रकम वा इतिहास होइन) Google लाई पठाउँछ। जवाफ सधैं एउटा छनौट गर्न सकिने सुझावको रूपमा मात्र देखिन्छ — यो कहिल्यै आफै लागू वा सेभ हुँदैन। यो API कुञ्जी यही उपकरणमा मात्र बस्छ — यो न Cloud Sync मार्फत पठाइन्छ, न ब्याकअप फाइलमा समावेश हुन्छ।',
            'This is entirely optional and off by default. It does not replace Fast Entry\'s reliable, offline Smart Entry engine — that engine still runs first for every entry, exactly as before. This only ever asks Google once, and only when that engine already found nothing or a genuine ambiguity for what you typed, and only when you explicitly click "Ask AI". It sends the description you typed plus your own category/staff/vehicle/institution names (never your actual amounts or transaction history) to Google. The reply always shows up as a selectable suggestion, never auto-applied or auto-saved. The API key stays on this device only — it is never sent through Cloud Sync and never included in a backup file.',
          )}
        </p>
      </div>

      {saveNote && <p className="text-sm text-brick-600">{saveNote}</p>}

      <label className="toggle flex items-center gap-2.5 text-sm font-medium text-ink-900 cursor-pointer">
        <input type="checkbox" className="sr-only" checked={settings.enabled} onChange={handleToggle} />
        <span className="toggle-track">
          <span className="toggle-thumb" />
        </span>
        {tr('AI फलब्याक सक्षम गर्नुहोस्', 'Enable AI Fallback')}
      </label>

      {settings.enabled && (
        <div className="space-y-2">
          <label className="field-label">{tr('Gemini API कुञ्जी', 'Gemini API key')}</label>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                type={showKey ? 'text' : 'password'}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={tr('आफ्नो Gemini API कुञ्जी टाँस्नुहोस्', 'Paste your Gemini API key')}
                className="field pr-9"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
                aria-label={showKey ? tr('लुकाउनुहोस्', 'Hide') : tr('देखाउनुहोस्', 'Show')}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <button onClick={handleSaveKey} className="btn btn-primary btn-sm">
              {tr('सेभ गर्नुहोस्', 'Save')}
            </button>
          </div>
          <p className="text-xs text-ink-400">
            {settings.apiKey
              ? tr('यस उपकरणमा एउटा कुञ्जी सेभ गरिएको छ।', 'A key is saved on this device.')
              : tr('अहिलेसम्म कुनै कुञ्जी सेभ गरिएको छैन — माथि टाँस्नुहोस्।', 'No key saved yet — paste one above.')}
          </p>
          <p className="text-xs text-ink-400">
            {tr('निःशुल्क Gemini API कुञ्जी यहाँबाट लिन सकिन्छ: ', 'Get a free Gemini API key at: ')}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer"
              className="text-primary-700 underline"
            >
              aistudio.google.com/apikey
            </a>
          </p>
        </div>
      )}
    </section>
  );
}

// Phase 7: OPTIONAL App Lock (PIN/password). Off by default. Everything it
// stores lives in this browser's localStorage only (lib/appLock.ts explains
// why that makes it structurally impossible for it to reach a backup file
// or Cloud Sync) - the same isolation pattern the AI Fallback key uses.
function AppLockSection() {
  const { t: tr } = useLanguage();
  const lockState = useAppLockState();
  const configured = lockState !== 'unconfigured';
  const supported = isAppLockSupported();

  const [mode, setMode] = useState<'idle' | 'change' | 'disable'>('idle');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [idleSel, setIdleSel] = useState<number>(() => getIdleMinutes());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set only right after setup: shown ONCE, then discarded from memory.
  const [issuedCode, setIssuedCode] = useState<string | null>(null);

  // Google-account-linked recovery: a SEPARATE, independent connection
  // from Google Drive Backup below - own Client ID input, own storage,
  // own OAuth scope (identity only). See lib/googleAccountRecovery.ts's
  // header comment. Reused here only in the sense that the owner may
  // choose to paste the SAME Client ID string they used for Drive Backup
  // if they want - the app itself never reads or shares that value.
  const [googleLinked, setGoogleLinked] = useState(() => isGoogleRecoveryLinked());
  const [googleLinkedAt, setGoogleLinkedAt] = useState(() => getGoogleRecoveryLinkedAt());
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [googleNotice, setGoogleNotice] = useState<string | null>(null);

  function refreshGoogleLinkState() {
    setGoogleLinked(isGoogleRecoveryLinked());
    setGoogleLinkedAt(getGoogleRecoveryLinkedAt());
  }

  async function handleLinkGoogle(e: React.FormEvent) {
    e.preventDefault();
    if (googleBusy || googleClientId.trim() === '') return;
    setGoogleError(null);
    setGoogleNotice(null);
    setGoogleBusy(true);
    const result = await linkGoogleAccount(googleClientId.trim());
    setGoogleBusy(false);
    if (!result.ok) {
      setGoogleError(
        result.reason === 'unsupported'
          ? tr('यो ब्राउजर वा ठेगानामा उपलब्ध छैन (सुरक्षित सन्दर्भ चाहिन्छ)।', 'Not available in this browser or address (needs a secure context).')
          : result.reason === 'sign-in-failed'
            ? tr('Google साइन-इन असफल भयो वा रद्द गरियो। फेरि प्रयास गर्नुहोस्।', 'Google sign-in failed or was cancelled. Try again.')
            : tr('सेभ गर्न सकिएन।', 'Could not save.'),
      );
      return;
    }
    refreshGoogleLinkState();
    setGoogleClientId('');
    setGoogleNotice(tr('Google खाता लिङ्क गरियो।', 'Google account linked.'));
  }

  function handleUnlinkGoogle() {
    setGoogleError(null);
    setGoogleNotice(null);
    if (!unlinkGoogleAccount()) {
      setGoogleError(tr('हटाउन सकिएन।', 'Could not remove.'));
      return;
    }
    refreshGoogleLinkState();
    setGoogleNotice(tr('Google लिङ्क हटाइयो।', 'Google link removed.'));
  }

  function resetForm() {
    setPin('');
    setConfirmPin('');
    setCurrentPin('');
    setError(null);
  }

  function fail(f: AppLockFailure) {
    setError(failureMessage(f, tr));
  }

  function checkNewPin(): boolean {
    if (validateNewPin(pin)) {
      fail({ ok: false, reason: 'invalid-new-pin' });
      return false;
    }
    if (pin !== confirmPin) {
      setError(tr('दुवै पिन / पासवर्ड मेल खाएनन्।', "The two entries don't match."));
      return false;
    }
    return true;
  }

  async function handleSetup(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    if (!checkNewPin()) return;
    setBusy(true);
    const result = await setupLock(pin, { idleMinutes: idleSel });
    setBusy(false);
    if (!result.ok) {
      fail(result);
      return;
    }
    resetForm();
    setIssuedCode(result.recoveryCode);
  }

  async function handleChange(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!checkNewPin()) return;
    setBusy(true);
    const result = await changePin(currentPin, pin);
    setBusy(false);
    if (!result.ok) {
      fail(result);
      setCurrentPin('');
      return;
    }
    resetForm();
    setMode('idle');
    setNotice(tr('पिन / पासवर्ड परिवर्तन भयो।', 'PIN / password changed.'));
  }

  async function handleDisable(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    const result = await disableLock(currentPin);
    setBusy(false);
    if (!result.ok) {
      fail(result);
      setCurrentPin('');
      return;
    }
    resetForm();
    setMode('idle');
    setNotice(tr('App Lock बन्द गरियो।', 'App Lock turned off.'));
  }

  function handleIdleChange(minutes: number) {
    setIdleSel(minutes);
    if (configured && !setIdleMinutes(minutes)) {
      setError(tr('सेभ गर्न सकिएन।', 'Could not save.'));
    }
  }

  const idleSelect = (
    <div>
      <label htmlFor="applock-idle" className="field-label">
        {tr('निष्क्रिय भएपछि स्वतः लक', 'Auto-lock after inactivity')}
      </label>
      <select
        id="applock-idle"
        value={idleSel}
        onChange={(e) => handleIdleChange(Number(e.target.value))}
        className="field"
      >
        {IDLE_MINUTES_OPTIONS.map((m) => (
          <option key={m} value={m}>
            {m === DEFAULT_IDLE_MINUTES
              ? tr(`${m} मिनेट (पूर्वनिर्धारित)`, `${m} minutes (default)`)
              : tr(`${m} मिनेट`, `${m} ${m === 1 ? 'minute' : 'minutes'}`)}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <section className="card card-pad space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <h2 className="panel-title">{tr('App Lock (वैकल्पिक)', 'App Lock (optional)')}</h2>
          {configured && <span className="pill pill-teal">{tr('सक्रिय', 'On')}</span>}
        </div>
        <p className="text-xs text-ink-400">
          {tr(
            'यो वैकल्पिक हो र पूर्वनिर्धारित रूपमा बन्द छ। सक्रिय गरेपछि, एप खोल्दा हरेक पटक — र केही समय निष्क्रिय रहेपछि फेरि — पिन वा पासवर्ड सोधिन्छ। यसको उद्देश्य यो उपकरण हातमा लिने साधारण व्यक्तिलाई तपाईंको खाता खोल्नबाट रोक्नु हो। यसले तपाईंको डाटा इन्क्रिप्ट गर्दैन: ब्राउजरको डेभलपर टुल्स खोल्न जान्ने व्यक्तिले भण्डारण गरिएको खाता डाटा सिधै पढ्न सक्छ। पिन यही उपकरणमा मात्र, नुन (salt) सहितको ह्यासको रूपमा बस्छ (पिन आफैं कहिल्यै होइन) — यो न क्लाउड सिंक मार्फत पठाइन्छ, न ब्याकअप फाइलमा समावेश हुन्छ। पिन बिर्सनुभयो भने सेटअपमा देखाइएको रिकभरी कोड नै एकमात्र उपाय हो — इमेल रिसेट छैन। गलत वा बिर्सिएको पिनले तपाईंको डाटा कहिल्यै मेट्दैन वा बदल्दैन।',
            "Optional and off by default. When on, the app asks for a PIN or password every time it opens, and again after a period of inactivity. It is meant to keep casual visitors out of your books - for example someone who picks up this device. It does NOT encrypt your data: anyone technical enough to open the browser's developer tools can still read the stored ledger data directly. The PIN is kept on this device only, as a salted hash (never the PIN itself) - it is never sent through Cloud Sync and never included in a backup file. If you forget your PIN, the recovery code shown at setup is the only way back in - there is no email reset. A wrong or forgotten PIN never deletes or changes your data.",
          )}
        </p>
      </div>

      {notice && <p className="text-sm text-teal-700">{notice}</p>}

      {issuedCode ? (
        <RecoveryCodePanel code={issuedCode} t={tr} onDone={() => setIssuedCode(null)} />
      ) : !configured ? (
        !supported ? (
          <p className="text-sm text-amber-700">
            {tr(
              'यो ब्राउजर वा ठेगानामा App Lock उपलब्ध छैन — यसलाई सुरक्षित सन्दर्भ (https:// वा localhost) चाहिन्छ।',
              'App Lock is not available in this browser or address - it needs a secure context (https:// or localhost).',
            )}
          </p>
        ) : (
          <form onSubmit={handleSetup} className="space-y-3">
            <PinField
              id="applock-new-pin"
              label={tr('पिन / पासवर्ड छान्नुहोस्', 'Choose a PIN / password')}
              value={pin}
              onChange={setPin}
              t={tr}
              disabled={busy}
            />
            <PinField
              id="applock-confirm-pin"
              label={tr('फेरि लेख्नुहोस्', 'Confirm PIN / password')}
              value={confirmPin}
              onChange={setConfirmPin}
              t={tr}
              disabled={busy}
            />
            <p className="text-xs text-ink-400">
              {tr(
                `कम्तिमा ${MIN_PIN_LENGTH} अक्षर/अङ्क। सक्रिय गरेपछि एउटा रिकभरी कोड एकपटक मात्र देखाइनेछ — त्यसलाई कागजमा लेख्न तयार रहनुहोस्।`,
                `At least ${MIN_PIN_LENGTH} characters. After you turn this on, a recovery code is shown once - have paper ready to write it down.`,
              )}
            </p>
            {idleSelect}
            {error && <p className="text-sm text-brick-600" role="alert">{error}</p>}
            <button type="submit" disabled={busy || pin === ''} className="btn btn-primary">
              {busy ? tr('सक्रिय गर्दै…', 'Turning on…') : tr('App Lock सक्रिय गर्नुहोस्', 'Turn on App Lock')}
            </button>
          </form>
        )
      ) : (
        <div className="space-y-3">
          {idleSelect}
          {mode === 'idle' && (
            <>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setNotice(null);
                    lockNow();
                  }}
                  className="btn btn-secondary btn-sm"
                >
                  {tr('अहिले लक गर्नुहोस्', 'Lock now')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    resetForm();
                    setNotice(null);
                    setMode('change');
                  }}
                  className="btn btn-secondary btn-sm"
                >
                  {tr('पिन परिवर्तन गर्नुहोस्', 'Change PIN')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    resetForm();
                    setNotice(null);
                    setMode('disable');
                  }}
                  className="btn btn-secondary btn-sm"
                >
                  {tr('App Lock बन्द गर्नुहोस्…', 'Turn off App Lock…')}
                </button>
              </div>
              <p className="text-xs text-ink-400">
                {tr(
                  'रिकभरी कोड हरायो तर पिन याद छ? App Lock बन्द गरेर फेरि सक्रिय गर्नुहोस् — नयाँ कोड पाइनेछ।',
                  'Lost your recovery code but still know your PIN? Turn App Lock off and on again to get a new code.',
                )}
              </p>

              <div className="rounded-lg border border-ink-100 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">
                    {tr('रिकभरीको लागि Google खाता (वैकल्पिक)', 'Google account for recovery (optional)')}
                  </p>
                  {googleLinked && <span className="pill pill-teal">{tr('लिङ्क गरिएको', 'Linked')}</span>}
                </div>
                <p className="text-xs text-ink-400">
                  {tr(
                    'लिङ्क गरेपछि, पिन बिर्सिएमा रिकभरी कोडको सट्टा (वा साथसाथै) सोही Google खातामा साइन-इन गरेर पिन रिसेट गर्न सकिन्छ — कुनै कोड लेखेर राख्नु पर्दैन। यसले खाताको इमेल/नाम कतै भण्डारण गर्दैन — केवल खाताको पहिचान (hash) मात्र, यो उपकरणमै। यो Google Drive Backup भन्दा बिल्कुल छुट्टै जडान हो।',
                    'Once linked, a forgotten PIN can be reset by signing into that same Google account, instead of (or alongside) the recovery code - no code to write down. Nothing about the account (email/name) is stored, only a hash of its identity, on this device only. This is a completely separate connection from Google Drive Backup below.',
                  )}
                </p>
                {googleNotice && <p className="text-sm text-teal-700">{googleNotice}</p>}
                {googleError && <p className="text-sm text-brick-600" role="alert">{googleError}</p>}
                {googleLinked ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-xs text-ink-400">
                      {googleLinkedAt
                        ? tr(`लिङ्क गरिएको: ${new Date(googleLinkedAt).toLocaleDateString()}`, `Linked: ${new Date(googleLinkedAt).toLocaleDateString()}`)
                        : null}
                    </p>
                    <button type="button" onClick={handleUnlinkGoogle} className="btn btn-secondary btn-sm">
                      {tr('लिङ्क हटाउनुहोस्', 'Unlink')}
                    </button>
                  </div>
                ) : (
                  <form onSubmit={handleLinkGoogle} className="space-y-2">
                    <input
                      type="text"
                      value={googleClientId}
                      onChange={(e) => setGoogleClientId(e.target.value)}
                      placeholder={tr('Google OAuth Client ID टाँस्नुहोस्', 'Paste Google OAuth Client ID')}
                      className="field text-sm"
                      disabled={googleBusy}
                    />
                    <button type="submit" disabled={googleBusy || googleClientId.trim() === ''} className="btn btn-secondary btn-sm">
                      {googleBusy ? tr('जडान हुँदै…', 'Connecting…') : tr('Google खाता लिङ्क गर्नुहोस्', 'Link Google account')}
                    </button>
                  </form>
                )}
              </div>
            </>
          )}

          {mode === 'change' && (
            <form onSubmit={handleChange} className="space-y-3">
              <PinField id="applock-cur-pin" label={tr('हालको पिन / पासवर्ड', 'Current PIN / password')} value={currentPin} onChange={setCurrentPin} t={tr} disabled={busy} />
              <PinField id="applock-chg-pin" label={tr('नयाँ पिन / पासवर्ड', 'New PIN / password')} value={pin} onChange={setPin} t={tr} disabled={busy} />
              <PinField id="applock-chg-confirm" label={tr('नयाँ फेरि लेख्नुहोस्', 'Confirm new PIN / password')} value={confirmPin} onChange={setConfirmPin} t={tr} disabled={busy} />
              {error && <p className="text-sm text-brick-600" role="alert">{error}</p>}
              <div className="flex gap-2">
                <button type="submit" disabled={busy || currentPin === '' || pin === ''} className="btn btn-primary btn-sm">
                  {busy ? tr('सेभ गर्दै…', 'Saving…') : tr('सेभ गर्नुहोस्', 'Save')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    resetForm();
                    setMode('idle');
                  }}
                  disabled={busy}
                  className="btn btn-ghost btn-sm"
                >
                  {tr('रद्द गर्नुहोस्', 'Cancel')}
                </button>
              </div>
            </form>
          )}

          {mode === 'disable' && (
            <form onSubmit={handleDisable} className="space-y-3">
              <p className="text-xs text-ink-400">
                {tr(
                  'यसले यो उपकरणबाट पिन र रिकभरी कोड हटाउँछ। तपाईंको खाता डाटामा कुनै असर पर्दैन। जारी राख्न हालको पिन लेख्नुहोस्।',
                  'This removes the PIN and recovery code from this device. Your ledger data is not affected. Enter your current PIN to continue.',
                )}
              </p>
              <PinField id="applock-dis-pin" label={tr('हालको पिन / पासवर्ड', 'Current PIN / password')} value={currentPin} onChange={setCurrentPin} t={tr} disabled={busy} />
              {error && <p className="text-sm text-brick-600" role="alert">{error}</p>}
              <div className="flex gap-2">
                <button type="submit" disabled={busy || currentPin === ''} className="btn btn-brick btn-sm">
                  {busy ? tr('बन्द गर्दै…', 'Turning off…') : tr('App Lock बन्द गर्नुहोस्', 'Turn off App Lock')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    resetForm();
                    setMode('idle');
                  }}
                  disabled={busy}
                  className="btn btn-ghost btn-sm"
                >
                  {tr('रद्द गर्नुहोस्', 'Cancel')}
                </button>
              </div>
            </form>
          )}
          {mode === 'idle' && error && <p className="text-sm text-brick-600" role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}

// Google Drive backup: a SEPARATE, independent, opt-in backup
// destination from Firebase Cloud Sync above — see
// lib/googleDriveBackup.ts's own header comment for the full research
// and design this is based on. Off by default; the OAuth Client ID and
// access token never leave this device the same way the Gemini key
// doesn't (lib/googleDriveSettingsStore.ts, a sibling to
// lib/aiSettingsStore.ts).
function GoogleDriveBackupSection() {
  const { t: tr } = useLanguage();
  const [clientIdInput, setClientIdInput] = useState(() => getGoogleDriveBackupSettings().clientId ?? '');
  const [connected, setConnected] = useState(() => isDriveConnected());
  const [status, setStatus] = useState(() => getDriveLastBackupStatus());
  const [busy, setBusy] = useState<'connecting' | 'backing-up' | 'restoring' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoreConfirming, setRestoreConfirming] = useState(false);
  const [restoreDone, setRestoreDone] = useState(false);

  function refreshStatus() {
    setConnected(isDriveConnected());
    setStatus(getDriveLastBackupStatus());
  }

  async function handleConnect() {
    setBusy('connecting');
    setError(null);
    try {
      const result = await driveConnect(clientIdInput);
      if (!result.ok) setError(result.reason);
      refreshStatus();
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect() {
    setBusy('connecting');
    try {
      await driveDisconnect();
      refreshStatus();
    } finally {
      setBusy(null);
    }
  }

  async function handleBackupNow() {
    setBusy('backing-up');
    setError(null);
    try {
      const result = await driveBackupNow();
      if (!result.ok) setError(result.reason);
      refreshStatus();
    } finally {
      setBusy(null);
    }
  }

  async function handleConfirmRestore() {
    setRestoreConfirming(false);
    setBusy('restoring');
    setError(null);
    try {
      const result = await restoreFromDrive();
      if (!result.ok) {
        setError(result.reason);
      } else {
        // Same automatic pre-restore safety snapshot the local restore
        // flow already downloads (BackupExportSection above) — restore
        // is destructive/replacing regardless of where the file came
        // from, so it gets the exact same safety net.
        downloadTextFile(
          serializeBackup(result.result.preRestoreSnapshot),
          `pre-restore-safety-${backupFileName(result.result.preRestoreSnapshot)}`,
          'application/json',
        );
        setRestoreDone(true);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card card-pad space-y-4">
      <div>
        <h2 className="panel-title mb-1">{tr('गुगल ड्राइभ ब्याकअप (वैकल्पिक)', 'Google Drive Backup (optional)')}</h2>
        <p className="text-xs text-ink-400">
          {tr(
            'यो पूर्णतया वैकल्पिक हो र पूर्वनिर्धारित रूपमा बन्द छ, र माथिको Cloud Sync भन्दा पूर्णतया छुट्टै सुविधा हो। जोडिएपछि, यसले तपाईंको उही JSON ब्याकअपलाई ("ब्याकअप र निर्यात" ले बनाउने उस्तै) तपाईंको आफ्नै गुगल ड्राइभमा भएको "Office Cash Ledger Backups" नामक फोल्डरको एउटै फाइलमा बेला-बेलामा (लगभग घण्टौं-घण्टामा, यो ट्याब खुला हुँदा) र म्यानुअल रूपमा "Backup Now" थिचेर अपलोड गर्छ — हरेक पटक नयाँ फाइल होइन, उही फाइल अपडेट हुन्छ। तपाईंको आफ्नै गुगल क्लाउड प्रोजेक्टको OAuth Client ID चाहिन्छ। Client ID गोप्य होइन (यो सार्वजनिक क्लाइन्टहरूको लागि बनिएको हो), तर पहुँच टोकन यही उपकरणमा मात्र बस्छ — न Cloud Sync मार्फत, न ब्याकअप फाइलमा।',
            'This is entirely optional, off by default, and a completely separate feature from Cloud Sync above. Once connected, it uploads the same JSON backup "Backup & Export" already produces, opportunistically (roughly hourly while this tab is open) and via a manual "Backup Now" click, into one continuously-updated file in a folder named "Office Cash Ledger Backups" in your own Google Drive — never a new file each time, the same file updated in place. It needs your own Google Cloud project\'s OAuth Client ID. The Client ID isn\'t secret (it\'s designed to be public), but the resulting access token stays on this device only — never through Cloud Sync, never in a backup file.',
          )}
        </p>
      </div>

      {error && <p className="text-sm text-brick-600">{error}</p>}

      {!connected ? (
        <div className="space-y-2">
          <label className="field-label">{tr('गुगल क्लाउड OAuth Client ID', 'Google Cloud OAuth Client ID')}</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={clientIdInput}
              onChange={(e) => setClientIdInput(e.target.value)}
              placeholder={tr('जस्तै: 123456-abc.apps.googleusercontent.com', 'e.g. 123456-abc.apps.googleusercontent.com')}
              className="field flex-1"
              autoComplete="off"
            />
            <button onClick={handleConnect} disabled={busy === 'connecting' || !clientIdInput.trim()} className="btn btn-primary btn-sm">
              {busy === 'connecting' ? tr('जडान हुँदैछ…', 'Connecting…') : tr('जडान गर्नुहोस्', 'Connect')}
            </button>
          </div>
          <p className="text-xs text-ink-400">
            {tr(
              'आफ्नो Google Cloud Console मा एउटा OAuth Client ID (Web application, "public/SPA client") बनाउनुहोस्, Drive API सक्षम गर्नुहोस्, र त्यो Client ID माथि टाँस्नुहोस्।',
              'Create an OAuth Client ID (Web application, a "public/SPA client") in your own Google Cloud Console, enable the Drive API, and paste that Client ID above.',
            )}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={handleBackupNow} disabled={busy != null} className="btn btn-teal btn-sm">
              {busy === 'backing-up' ? tr('ब्याकअप हुँदैछ…', 'Backing up…') : tr('अहिले ड्राइभमा ब्याकअप गर्नुहोस्', 'Backup to Drive Now')}
            </button>
            <button
              onClick={() => setRestoreConfirming(true)}
              disabled={busy != null}
              className="text-sm font-medium text-brick-700 border border-brick-100 hover:bg-brick-50 rounded-lg px-3 py-1.5"
            >
              {tr('ड्राइभबाट पुनर्स्थापना गर्नुहोस्…', 'Restore from Drive…')}
            </button>
            <button onClick={handleDisconnect} disabled={busy != null} className="text-xs font-medium text-ink-500 hover:text-ink-900 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300">
              {tr('जडान हटाउनुहोस्', 'Disconnect')}
            </button>
          </div>
          <p className="text-xs text-ink-400">
            {status.lastBackupAt
              ? tr(
                  `पछिल्लो ब्याकअप: ${new Date(status.lastBackupAt).toLocaleString()}`,
                  `Last backup: ${new Date(status.lastBackupAt).toLocaleString()}`,
                )
              : tr('अहिलेसम्म कुनै ब्याकअप भएको छैन।', 'No backup yet.')}
            {status.lastError && (
              <span className="text-brick-600"> — {status.lastError}</span>
            )}
          </p>
        </div>
      )}

      {restoreConfirming && (
        <div className="rounded-lg border border-brick-100 bg-brick-50 p-3 space-y-2">
          <p className="text-sm font-semibold text-brick-700">
            {tr('ड्राइभको फाइलले हालको सबै डाटा बदल्ने हो?', 'Replace ALL current data with the file on Drive?')}
          </p>
          <p className="text-xs text-brick-700">
            {tr(
              'यसले हरेक कारोबार, कर्मचारी, सवारी साधन, संस्था, वर्ग, र बजेटलाई ड्राइभको फाइलमा भएको डाटाले स्थायी रूपमा बदल्नेछ। केही गल्ती भएमा, केही परिवर्तन हुनुअघि तपाईंको हालको डाटाको सुरक्षा ब्याकअप स्वतः डाउनलोड हुनेछ।',
              "This will permanently replace every transaction, staff member, vehicle, institution, category, and budget with what's in the file on Drive. A safety backup of your current data will download automatically before anything is changed, in case this restore was a mistake.",
            )}
          </p>
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => setRestoreConfirming(false)}
              className="text-sm font-medium text-ink-700 border border-line-300 hover:bg-line-100 rounded-lg px-3 py-1.5"
            >
              {tr('रद्द गर्नुहोस्', 'Cancel')}
            </button>
            <button onClick={handleConfirmRestore} className="btn btn-brick btn-sm">
              {tr('हो, सबै डाटा बदल्नुहोस्', 'Yes, Replace All Data')}
            </button>
          </div>
        </div>
      )}

      {busy === 'restoring' && (
        <p className="text-sm text-ink-500">{tr('पुनर्स्थापना हुँदैछ… कृपया यो ट्याब बन्द नगर्नुहोस्।', "Restoring… please don't close this tab.")}</p>
      )}

      {restoreDone && (
        <div className="rounded-lg border border-teal-100 bg-teal-50 p-3 space-y-2">
          <p className="text-sm font-medium text-teal-700">
            {tr(
              'पुनर्स्थापना पूरा भयो। तपाईंको अघिल्लो डाटाको सुरक्षा ब्याकअप स्वतः डाउनलोड भयो।',
              'Restore complete. A safety backup of your previous data was downloaded automatically.',
            )}
          </p>
          <button onClick={() => window.location.reload()} className="btn btn-teal btn-sm">
            {tr('एप पुनः लोड गर्नुहोस्', 'Reload App')}
          </button>
        </div>
      )}
    </section>
  );
}

export function SettingsView() {
  const { t: tr } = useLanguage();
  const categories = useAllCategories();
  const heads = useAllExpenseHeads();
  const cashInTypes = useAllCashInTypes();
  const budgets = useAllBudgets();

  if (!categories || !heads || !cashInTypes || !budgets) {
    return (
      <div className="empty-state flex items-center justify-center gap-2">
        <span className="spinner" aria-hidden="true" />
        {tr('लोड हुँदैछ…', 'Loading…')}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-5 space-y-4 pb-24">
      <h1 className="text-page-title">{tr('सेटिङ', 'Settings')}</h1>
      <CategoriesSection categories={categories} />
      <ExpenseHeadsSection heads={heads} categories={categories} />
      <CashInTypesSection types={cashInTypes} />
      <BudgetsSection heads={heads} budgets={budgets} />
      <CloudSyncSection />
      <AiFallbackSection />
      <AppLockSection />
      <GoogleDriveBackupSection />
      <BackupExportSection />
    </div>
  );
}
