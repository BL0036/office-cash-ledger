import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { addDaysISO, formatDateDisplay, todayISO } from '../lib/dates';
import { BsDatePicker } from './BsDatePicker';
import { useLanguage } from '../lib/i18n';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

interface Props {
  date: string;
  onChange: (date: string) => void;
}

/**
 * v1.0 Nepali BS Edition (§9): BS-first date navigation. Previous/Next
 * still move by exactly one internal ISO day — addDaysISO is completely
 * unchanged — which is what makes month/year BS boundaries "just work"
 * here (बैशाख ३१ -> जेठ १, चैत's last day -> next year's बैशाख १):
 * every calendar day has exactly one BS date, so incrementing the
 * underlying ISO day and re-displaying it in BS is already correct,
 * without this component needing any BS-specific day-rollover logic of
 * its own. formatDateDisplay (lib/dates.ts) is what actually renders the
 * BS label. The BS year/month/day picker (§10) replaces the native
 * Gregorian date input that used to sit here.
 */
export function DateNav({ date, onChange }: Props) {
  const { t } = useLanguage();
  const [pickerOpen, setPickerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEscapeToClose(() => setPickerOpen(false), pickerOpen);

  useEffect(() => {
    if (!pickerOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPickerOpen(false);
    }
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [pickerOpen]);

  return (
    <div ref={rootRef} className="relative flex items-center gap-2">
      <button
        onClick={() => onChange(addDaysISO(date, -1))}
        className="w-9 h-9 shrink-0 rounded-lg border border-line-300 bg-surface text-ink-500 hover:bg-surface-muted hover:text-ink-900 flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
        aria-label={t('अघिल्लो दिन', 'Previous day')}
      >
        <ChevronLeft size={16} />
      </button>

      <button
        onClick={() => setPickerOpen((v) => !v)}
        className="flex-1 min-w-0 flex items-center justify-between gap-2 rounded-lg border border-line-300 bg-surface px-3 py-2 hover:bg-surface-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
        aria-expanded={pickerOpen}
      >
        <span className="text-bs-date text-sm font-semibold text-ink-900 truncate">{formatDateDisplay(date)}</span>
        <CalendarDays size={15} className="text-ink-400 shrink-0" />
      </button>

      <button
        onClick={() => onChange(addDaysISO(date, 1))}
        className="w-9 h-9 shrink-0 rounded-lg border border-line-300 bg-surface text-ink-500 hover:bg-surface-muted hover:text-ink-900 flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
        aria-label={t('अर्को दिन', 'Next day')}
      >
        <ChevronRight size={16} />
      </button>

      {date !== todayISO() && (
        <button
          onClick={() => onChange(todayISO())}
          className="text-xs font-medium text-teal-700 px-2.5 py-2 rounded-lg hover:bg-teal-50 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
        >
          {t('आज', 'Today')}
        </button>
      )}

      {pickerOpen && (
        <div className="dropdown-pop absolute z-10 top-full left-9 right-9 mt-1.5 card card-pad">
          <BsDatePicker
            value={date}
            onChange={(iso) => {
              onChange(iso);
              setPickerOpen(false);
            }}
            className="w-full [&>select]:flex-1"
          />
        </div>
      )}
    </div>
  );
}
