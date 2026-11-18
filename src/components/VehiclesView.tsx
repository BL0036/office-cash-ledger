import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Vehicle } from '../types';
import { formatDateDisplay } from '../lib/dates';
import { formatPaisaAsRupees } from '../lib/money';
import { getCurrentMonthPetrolByVehicle, getVehicleTotals } from '../lib/aggregation';
import { addVehicle, editVehicle, getPetrolExpenseHead, setVehicleActive } from '../lib/vehicles';
import {
  useActiveVehicles,
  useAllVehicles,
  useCashInTypeLookup,
  useCategoryLookup,
  useExpenseHeadLookup,
  useInstitutionLookup,
  useStaffForVehicle,
  useStaffLookup,
  useVehicleTransactions,
} from '../hooks/useLedger';
import { ExportButtons } from './ExportButtons';
import type { ExportLookups } from '../lib/exportRows';
import { useLanguage } from '../lib/i18n';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

// Vehicles are never deleted — only deactivated — same rule as every other
// master-data entity in this app.

// --- Add / edit vehicle form ---

interface VehicleFormProps {
  editing?: Vehicle | null;
  onClose: () => void;
}

function VehicleFormModal({ editing, onClose }: VehicleFormProps) {
  const { t: tr } = useLanguage();
  useEscapeToClose(onClose);
  const [name, setName] = useState(editing?.name ?? '');
  const [vehicleType, setVehicleType] = useState(editing?.vehicleType ?? '');
  const [registrationNumber, setRegistrationNumber] = useState(editing?.registrationNumber ?? '');
  const [aliasesInput, setAliasesInput] = useState((editing?.aliases ?? []).join(', '));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError(tr('नाम आवश्यक छ।', 'Name is required.'));
      return;
    }
    if (!vehicleType.trim()) {
      setError(tr('सवारी साधनको प्रकार आवश्यक छ।', 'Vehicle type is required.'));
      return;
    }
    const aliases = aliasesInput.split(',').map((a) => a.trim()).filter(Boolean);

    setSaving(true);
    try {
      if (editing) {
        await editVehicle(editing.id!, {
          name: name.trim(),
          vehicleType: vehicleType.trim(),
          registrationNumber: registrationNumber.trim() || null,
          aliases,
        });
      } else {
        await addVehicle({
          name: name.trim(),
          vehicleType: vehicleType.trim(),
          registrationNumber: registrationNumber.trim() || null,
          aliases,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('केही गडबड भयो।', 'Something went wrong.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-panel">
        <div className="modal-header">
          <h2 className="text-base font-semibold text-ink-900">
            {editing ? tr('सवारी साधन सम्पादन', 'Edit Vehicle') : tr('सवारी साधन थप्नुहोस्', 'Add Vehicle')}
          </h2>
          <button
            onClick={onClose}
            className="text-ink-400 hover:text-ink-700 text-xl leading-none px-2 rounded-md hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
            aria-label={tr('बन्द गर्नुहोस्', 'Close')}
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="field-label">{tr('नाम', 'Name')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="field"
              placeholder={tr('जस्तै: 220 Pulsar', 'e.g. 220 Pulsar')}
              autoFocus
            />
          </div>

          <div>
            <label className="field-label">{tr('सवारी साधनको प्रकार', 'Vehicle Type')}</label>
            <input
              type="text"
              value={vehicleType}
              onChange={(e) => setVehicleType(e.target.value)}
              className="field"
              placeholder={tr('जस्तै: मोटरसाइकल, भ्यान, कार', 'e.g. Motorbike, Van, Car')}
            />
          </div>

          <div>
            <label className="field-label">
              {tr('दर्ता नम्बर', 'Registration Number')} <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
            </label>
            <input
              type="text"
              value={registrationNumber}
              onChange={(e) => setRegistrationNumber(e.target.value)}
              className="field"
            />
          </div>

          <div>
            <label className="field-label">
              {tr('उपनाम / अन्य हिज्जे (अल्पविरामले छुट्याइएको)', 'Aliases / other spellings (comma-separated)')}{' '}
              <span className="text-ink-400 font-normal">({tr('वैकल्पिक', 'optional')})</span>
            </label>
            <input
              type="text"
              value={aliasesInput}
              onChange={(e) => setAliasesInput(e.target.value)}
              className="field"
              placeholder={tr('जस्तै: Pulsar, बाइक', 'e.g. Pulsar, Bike')}
            />
          </div>

          {error && <p className="text-sm text-brick-600">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary flex-1"
            >
              {tr('रद्द गर्नुहोस्', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="btn btn-teal flex-1"
            >
              {saving ? tr('सुरक्षित हुँदैछ…', 'Saving…') : editing ? tr('परिवर्तन सुरक्षित गर्नुहोस्', 'Save Changes') : tr('थप्नुहोस्', 'Add')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Vehicle profile ---

function VehicleProfile({ vehicle, onBack }: { vehicle: Vehicle; onBack: () => void }) {
  const { t: tr } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [petrolHeadId, setPetrolHeadId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getPetrolExpenseHead().then((head) => {
      if (!cancelled) setPetrolHeadId(head?.id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const transactions = useVehicleTransactions(vehicle.id!);
  const categoryLookup = useCategoryLookup();
  const expenseHeadLookup = useExpenseHeadLookup();
  const cashInTypeLookup = useCashInTypeLookup();
  const staffLookup = useStaffLookup();
  const institutionLookup = useInstitutionLookup();
  // Phase 2: staff members currently assigned to this vehicle, via the
  // StaffVehicle join table (see lib/staffVehicles.ts).
  const assignedStaff = useStaffForVehicle(vehicle.id!);
  const totals = useLiveQuery(
    () => getVehicleTotals(vehicle.id!, petrolHeadId),
    [vehicle.id, petrolHeadId],
  );

  const exportLookups: ExportLookups = {
    categories: categoryLookup,
    expenseHeads: expenseHeadLookup,
    cashInTypes: cashInTypeLookup,
    staff: staffLookup,
    vehicles: new Map([[vehicle.id!, vehicle]]),
    institutions: institutionLookup,
  };

  async function toggleActive() {
    setBusy(true);
    try {
      await setVehicleActive(vehicle.id!, !vehicle.active);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-5 space-y-4 pb-24">
      <button
        onClick={onBack}
        className="text-sm font-medium text-teal-700 hover:underline flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
      >
        &#8249; {tr('सबै सवारी साधन', 'All Vehicles')}
      </button>

      <div className="card card-pad space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className={`text-lg font-bold ${vehicle.active ? 'text-ink-900' : 'text-ink-400'}`}>
              {vehicle.name}
              {!vehicle.active && (
                <span className="ml-2 text-xs font-medium text-ink-400">({tr('निष्क्रिय', 'inactive')})</span>
              )}
            </h2>
            <p className="text-sm text-ink-500 mt-0.5">{vehicle.vehicleType}</p>
            {vehicle.registrationNumber && (
              <p className="text-sm text-ink-500">{tr('दर्ता', 'Reg')}: {vehicle.registrationNumber}</p>
            )}
            {(assignedStaff ?? []).length > 0 && (
              <p className="text-sm text-ink-500">
                {tr('तोकिएका कर्मचारी', 'Assigned Staff')}:{' '}
                {(assignedStaff ?? []).map((s) => s.name).join(', ')}
              </p>
            )}
          </div>
          <button
            onClick={() => setEditing(true)}
            className="text-xs font-medium text-ink-500 hover:text-ink-900 shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
          >
            {tr('सम्पादन', 'Edit')}
          </button>
        </div>

        <div className="flex gap-2 pt-1">
          <button
            onClick={toggleActive}
            disabled={busy}
            className={`text-xs font-medium rounded-full px-3 py-1.5 disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 ${
              vehicle.active
                ? 'bg-line-100 text-ink-700 hover:bg-line-200'
                : 'bg-teal-50 text-teal-700 hover:bg-teal-100'
            }`}
          >
            {vehicle.active ? tr('निष्क्रिय गर्नुहोस्', 'Deactivate') : tr('सक्रिय गर्नुहोस्', 'Activate')}
          </button>
        </div>
      </div>

      <div className="card card-pad">
        <p className="panel-label mb-2">
          {tr('समग्र (सबै खर्च शीर्षक)', 'Overall (all expense heads)')}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 gap-y-3">
          <div>
            <p className="text-xs text-ink-400">{tr('यो महिना', 'This Month')}</p>
            <p className="text-sm font-semibold text-ink-900">
              {formatPaisaAsRupees(totals?.overall.currentMonthPaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('गत महिना', 'Last Month')}</p>
            <p className="text-sm font-semibold text-ink-900">
              {formatPaisaAsRupees(totals?.overall.previousMonthPaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('चालु वर्षसम्म', 'YTD')}</p>
            <p className="text-sm font-semibold text-ink-900">
              {formatPaisaAsRupees(totals?.overall.yearToDatePaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('जम्मा', 'Lifetime')}</p>
            <p className="text-sm font-semibold text-ink-900">
              {formatPaisaAsRupees(totals?.overall.lifetimePaisa ?? 0)}
            </p>
          </div>
        </div>
      </div>

      <div className="card card-pad">
        <p className="panel-label mb-2">
          {tr('पेट्रोल मात्र', 'Petrol only')}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 gap-y-3">
          <div>
            <p className="text-xs text-ink-400">{tr('यो महिना', 'This Month')}</p>
            <p className="text-sm font-semibold text-amber-700">
              {formatPaisaAsRupees(totals?.petrol.currentMonthPaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('गत महिना', 'Last Month')}</p>
            <p className="text-sm font-semibold text-amber-700">
              {formatPaisaAsRupees(totals?.petrol.previousMonthPaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('चालु वर्षसम्म', 'YTD')}</p>
            <p className="text-sm font-semibold text-amber-700">
              {formatPaisaAsRupees(totals?.petrol.yearToDatePaisa ?? 0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-400">{tr('जम्मा', 'Lifetime')}</p>
            <p className="text-sm font-semibold text-amber-700">
              {formatPaisaAsRupees(totals?.petrol.lifetimePaisa ?? 0)}
            </p>
          </div>
        </div>
      </div>

      {transactions && transactions.length > 0 && (
        <ExportButtons
          transactions={transactions}
          lookups={exportLookups}
          filenamePrefix={`vehicle-${vehicle.name.toLowerCase().replace(/\s+/g, '-')}`}
        />
      )}

      <div className="card divide-y divide-line-100">
        {!transactions ? (
          <div className="empty-state flex items-center justify-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {tr('लोड हुँदैछ…', 'Loading…')}
          </div>
        ) : transactions.length === 0 ? (
          <p className="empty-state">{tr('अहिलेसम्म कुनै कारोबार छैन।', 'No transactions yet.')}</p>
        ) : (
          transactions.map((t) => {
            const subtitle = [
              t.categoryId != null ? categoryLookup.get(t.categoryId)?.name : null,
              t.expenseHeadId != null ? expenseHeadLookup.get(t.expenseHeadId)?.name : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <div key={t.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-900 truncate">{t.description}</p>
                  <p className="text-xs text-ink-500 truncate">
                    {formatDateDisplay(t.date)}
                    {subtitle ? ` · ${subtitle}` : ''}
                  </p>
                </div>
                <span className="text-sm font-semibold text-brick-700 shrink-0">
                  − {formatPaisaAsRupees(t.amountPaisa)}
                </span>
              </div>
            );
          })
        )}
      </div>

      {editing && <VehicleFormModal editing={vehicle} onClose={() => setEditing(false)} />}
    </div>
  );
}

// --- Monthly Petrol comparison (Part E) ---

function PetrolComparisonTable() {
  const { t: tr } = useLanguage();
  const activeVehicles = useActiveVehicles();
  const [petrolHeadId, setPetrolHeadId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getPetrolExpenseHead().then((head) => {
      if (!cancelled) setPetrolHeadId(head?.id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const vehicleIds = (activeVehicles ?? []).map((v) => v.id!);
  const vehicleIdsKey = vehicleIds.join(',');
  const comparison = useLiveQuery(
    () => getCurrentMonthPetrolByVehicle(petrolHeadId, vehicleIds),
    [petrolHeadId, vehicleIdsKey],
  );

  if (!activeVehicles || activeVehicles.length === 0) return null;

  return (
    <div className="card card-pad">
      <p className="text-sm font-semibold text-ink-700 mb-2">{tr('पेट्रोल — यो महिना', 'Petrol — This Month')}</p>
      <div className="divide-y divide-line-100">
        {activeVehicles.map((v) => (
          <div key={v.id} className="py-2 flex items-center justify-between gap-3">
            <span className="text-sm text-ink-900">{v.name}</span>
            <span className="text-sm font-semibold text-amber-700">
              {formatPaisaAsRupees(comparison?.get(v.id!) ?? 0)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Vehicles list ---

export function VehiclesView({
  openVehicleId,
  onOpenedVehicle,
}: {
  openVehicleId?: string | null;
  onOpenedVehicle?: () => void;
}) {
  const { t: tr } = useLanguage();
  const vehicles = useAllVehicles();
  const [selected, setSelected] = useState<Vehicle | null>(null);
  const [adding, setAdding] = useState(false);

  // Open a vehicle's profile when navigated here from the Staff screen
  // ("Assigned Vehicle" link) — Part B.
  useEffect(() => {
    if (openVehicleId != null && vehicles) {
      const match = vehicles.find((v) => v.id === openVehicleId);
      if (match) {
        setSelected(match);
        onOpenedVehicle?.();
      }
    }
  }, [openVehicleId, vehicles, onOpenedVehicle]);

  // Keep the selected vehicle row in sync with live query updates instead
  // of a stale snapshot — same reasoning as StaffView.
  const liveSelected = selected
    ? (vehicles ?? []).find((v) => v.id === selected.id) ?? selected
    : null;

  if (liveSelected) {
    return <VehicleProfile vehicle={liveSelected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-5 space-y-4 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-page-title">{tr('सवारी साधन', 'Vehicles')}</h1>
        <button
          onClick={() => setAdding(true)}
          className="btn btn-teal btn-sm"
        >
          + {tr('सवारी साधन थप्नुहोस्', 'Add Vehicle')}
        </button>
      </div>

      <div className="card divide-y divide-line-100">
        {!vehicles ? (
          <div className="empty-state flex items-center justify-center gap-2">
            <span className="spinner" aria-hidden="true" />
            {tr('लोड हुँदैछ…', 'Loading…')}
          </div>
        ) : vehicles.length === 0 ? (
          <p className="empty-state">{tr('अहिलेसम्म कुनै सवारी साधन छैन।', 'No vehicles yet.')}</p>
        ) : (
          vehicles.map((v) => (
            <button
              key={v.id}
              onClick={() => setSelected(v)}
              className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-surface-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-300"
            >
              <span className={`text-sm ${v.active ? 'text-ink-900' : 'text-ink-400 line-through'}`}>
                {v.name}
              </span>
              <span className="text-xs text-ink-400">{v.vehicleType}</span>
            </button>
          ))
        )}
      </div>

      <PetrolComparisonTable />

      {adding && <VehicleFormModal onClose={() => setAdding(false)} />}
    </div>
  );
}
