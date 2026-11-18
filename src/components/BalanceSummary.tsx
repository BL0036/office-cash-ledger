import { useState } from 'react';
import type { LedgerDay } from '../types';
import { formatPaisaAsRupees, parseRupeeInputToPaisa } from '../lib/money';
import { setManualOpeningBalance } from '../lib/ledger';
import { useLanguage } from '../lib/i18n';

interface Props {
  date: string;
  day: LedgerDay | undefined;
}

/** A quiet "+"/"−"/"=" glyph between two figures in the balance formula —
 * purely visual, so it's hidden from assistive tech (the figures' own
 * labels already carry the meaning). */
function OperatorGlyph({ symbol }: { symbol: string }) {
  return (
    <span
      aria-hidden="true"
      className="self-center text-lg sm:text-xl font-semibold text-ink-300 leading-none"
    >
      {symbol}
    </span>
  );
}

export function BalanceSummary({ date, day }: Props) {
  const { t } = useLanguage();
  const [editingOpening, setEditingOpening] = useState(false);
  const [openingInput, setOpeningInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const opening = day?.openingBalancePaisa ?? 0;
  const closing = day?.closingBalancePaisa ?? 0;
  const cashIn = day?.cashInPaisa ?? 0;
  const cashOut = day?.cashOutPaisa ?? 0;
  const canEditOpening = day?.isManualOpening ?? false;

  function startEdit() {
    setOpeningInput(String(opening / 100));
    setError(null);
    setEditingOpening(true);
  }

  async function saveOpening() {
    const paisa = parseRupeeInputToPaisa(openingInput);
    if (paisa == null || paisa < 0) {
      setError(t('मान्य रकम राख्नुहोस्।', 'Enter a valid amount.'));
      return;
    }
    setSaving(true);
    try {
      await setManualOpeningBalance(date, paisa);
      setEditingOpening(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('सुरक्षित गर्न सकिएन।', 'Could not save.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card p-3 sm:p-4">
      {/* Phase 12d Part A: the four figures laid out as the actual formula
          ("Opening + Cash In − Cash Out = Closing") rather than four
          unrelated boxes — each operator is grouped with the figure that
          follows it so the row never wraps mid-pair on a narrow screen. */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-3 sm:gap-x-4">
        <div className="min-w-[104px]">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-medium text-ink-500">{t('सुरुको नगद', 'Opening')}</p>
            {canEditOpening && !editingOpening && (
              <button
                onClick={startEdit}
                className="text-[11px] font-medium text-teal-700 hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
              >
                {t('सम्पादन', 'Edit')}
              </button>
            )}
          </div>

          {editingOpening ? (
            <div className="mt-1 space-y-1.5 w-36">
              <input
                type="text"
                inputMode="decimal"
                autoFocus
                value={openingInput}
                onChange={(e) => setOpeningInput(e.target.value)}
                className="field figures text-base font-semibold py-1.5"
              />
              {error && <p className="field-hint">{error}</p>}
              <div className="flex gap-1.5">
                <button
                  onClick={() => setEditingOpening(false)}
                  className="btn btn-secondary btn-sm flex-1"
                >
                  {t('रद्द गर्नुहोस्', 'Cancel')}
                </button>
                <button
                  onClick={saveOpening}
                  disabled={saving}
                  className="btn btn-teal btn-sm flex-1"
                >
                  {saving ? t('सुरक्षित हुँदैछ…', 'Saving…') : t('सुरक्षित गर्नुहोस्', 'Save')}
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-0.5 text-base sm:text-lg font-semibold text-ink-900 figures">
              {formatPaisaAsRupees(opening)}
            </p>
          )}
        </div>

        <div className="flex items-start gap-1.5 sm:gap-2">
          <OperatorGlyph symbol="+" />
          <div className="min-w-[92px]">
            <p className="text-[11px] font-medium text-teal-700">{t('नगद आम्दानी', 'Cash In')}</p>
            <p className="mt-0.5 text-base sm:text-lg font-semibold text-teal-700 figures">
              {formatPaisaAsRupees(cashIn)}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-1.5 sm:gap-2">
          <OperatorGlyph symbol="−" />
          <div className="min-w-[92px]">
            <p className="text-[11px] font-medium text-brick-700">{t('नगद खर्च', 'Cash Out')}</p>
            <p className="mt-0.5 text-base sm:text-lg font-semibold text-brick-700 figures">
              {formatPaisaAsRupees(cashOut)}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-1.5 sm:gap-2">
          <OperatorGlyph symbol="=" />
          <div className="min-w-[108px]">
            <p className="text-[11px] font-medium text-ink-500">{t('बाँकी नगद', 'Closing')}</p>
            <p className="mt-0.5 text-lg sm:text-xl font-bold text-ink-900 figures">
              {formatPaisaAsRupees(closing)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
