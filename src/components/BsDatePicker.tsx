import { adIsoToBS, bsToAdIso, daysInBsMonth, BS_MONTH_NAMES_NE, toNepaliDigits, todayBS } from '../lib/bsCalendar';
import { useLanguage } from '../lib/i18n';

interface Props {
  /** Internal ISO ('YYYY-MM-DD', Gregorian) date — same value shape every other date field in the app already uses. Empty string means "not set". */
  value: string;
  onChange: (iso: string) => void;
  /** BS year bounds for the year dropdown. Defaults to a sensible window around today's BS year. */
  minYear?: number;
  maxYear?: number;
  className?: string;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/**
 * §10: a proper BS year / BS month / BS day picker, replacing the native
 * `<input type="date">` (which is unavoidably Gregorian-first — there is
 * no browser-native BS calendar). Three plain `<select>` elements rather
 * than a full custom calendar-grid widget: simpler, fully keyboard/
 * screen-reader accessible for free (native `<select>` semantics), and
 * satisfies §10's literal requirement ("select BS year, BS month, BS
 * day") without the much larger surface area a custom popover calendar
 * would add. Changing the month or year clamps the day into the newly
 * selected month's real length (via bsCalendar's daysInBsMonth — never
 * assumed) rather than ever producing an invalid BS date.
 */
export function BsDatePicker({ value, onChange, minYear, maxYear, className }: Props) {
  const { t } = useLanguage();
  const today = todayBS();
  const bs = value ? adIsoToBS(value) : today;

  const yearFrom = minYear ?? today.year - 10;
  const yearTo = maxYear ?? today.year + 5;
  const years = range(yearFrom, yearTo);
  const daysCount = daysInBsMonth(bs.year, bs.month);
  const days = range(1, daysCount);

  function update(next: { year?: number; month?: number; day?: number }) {
    const year = next.year ?? bs.year;
    const month = next.month ?? bs.month;
    const maxDay = daysInBsMonth(year, month);
    const day = Math.min(next.day ?? bs.day, maxDay);
    onChange(bsToAdIso({ year, month, day }));
  }

  const selectClass =
    'field bs-date-select !py-1.5 !px-2 text-sm appearance-none cursor-pointer';

  return (
    <div className={`flex gap-1.5 ${className ?? ''}`}>
      <select
        value={bs.year}
        onChange={(e) => update({ year: Number(e.target.value) })}
        className={selectClass}
        aria-label={t('वर्ष', 'Year')}
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {toNepaliDigits(y)}
          </option>
        ))}
      </select>
      <select
        value={bs.month}
        onChange={(e) => update({ month: Number(e.target.value) })}
        className={selectClass}
        aria-label={t('महिना', 'Month')}
      >
        {BS_MONTH_NAMES_NE.map((name, idx) => (
          <option key={name} value={idx + 1}>
            {name}
          </option>
        ))}
      </select>
      <select
        value={bs.day}
        onChange={(e) => update({ day: Number(e.target.value) })}
        className={selectClass}
        aria-label={t('मिति', 'Day')}
      >
        {days.map((d) => (
          <option key={d} value={d}>
            {toNepaliDigits(d)}
          </option>
        ))}
      </select>
    </div>
  );
}
