import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { formatDateDisplay } from '../lib/dates';
import { formatPaisaAsRupees } from '../lib/money';
import { getDashboardData, type DashboardData } from '../lib/reports';

type Tone = 'brick' | 'teal' | 'neutral';

function toneClass(tone: Tone) {
  if (tone === 'teal') return 'text-teal-700';
  if (tone === 'brick') return 'text-brick-700';
  return 'text-ink-900';
}

function StatRow({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-line-100 last:border-0">
      <p className="text-[13px] text-ink-500">{label}</p>
      <p className={`text-sm font-semibold figures ${toneClass(tone)}`}>{value}</p>
    </div>
  );
}

function StatGroupCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="card card-pad">
      <p className="panel-label mb-1">{title}</p>
      <div>{children}</div>
      {footer}
    </div>
  );
}

export function DashboardView() {
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDashboardData().then((result) => {
      if (!cancelled) setData(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-sm text-ink-400">
        <span className="spinner" aria-hidden="true" />
        Loading…
      </div>
    );
  }

  const { today, thisMonth, topExpenseHeads, alerts } = data;
  const hasAlerts =
    alerts.negativeCashDays.length > 0 || alerts.missingOpeningBalance || alerts.budgetAlerts.length > 0;

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 space-y-5 pb-24">
      <div>
        <p className="panel-label">{formatDateDisplay(today.date)}</p>
        <h1 className="text-page-title mt-0.5">Dashboard</h1>
      </div>

      {hasAlerts && (
        <div className="banner banner-danger items-start">
          <AlertTriangle size={18} className="text-brick-600 shrink-0 mt-0.5" />
          <div className="space-y-2 min-w-0">
            <p className="text-sm font-semibold text-brick-700">Needs attention</p>
            {alerts.missingOpeningBalance && (
              <p className="text-[13px] text-brick-700">
                No opening balance set yet — record your first transaction or set Day 1's opening
                balance to get started.
              </p>
            )}
            {alerts.negativeCashDays.length > 0 && (
              <div className="text-[13px] text-brick-700">
                <p className="font-medium">
                  {alerts.negativeCashDays.length} day(s) with negative closing cash:
                </p>
                <ul className="mt-1 space-y-0.5">
                  {alerts.negativeCashDays.slice(0, 5).map((d) => (
                    <li key={d.date} className="figures">
                      {formatDateDisplay(d.date)} — {formatPaisaAsRupees(d.closingBalancePaisa)}
                    </li>
                  ))}
                  {alerts.negativeCashDays.length > 5 && (
                    <li className="text-brick-500">…and {alerts.negativeCashDays.length - 5} more</li>
                  )}
                </ul>
              </div>
            )}
            {alerts.budgetAlerts.length > 0 && (
              <div className="text-[13px] text-brick-700">
                <p className="font-medium">Budget alerts:</p>
                <ul className="mt-1 space-y-0.5">
                  {alerts.budgetAlerts.map((b) => (
                    <li key={b.expenseHeadId}>
                      {b.name} — {b.percentage.toFixed(0)}%{' '}
                      {b.tier === 'over' ? '(over budget)' : b.tier === 'reached' ? '(budget reached)' : '(approaching limit)'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Today's closing balance is the strongest visual value on the
          page — the number an owner most wants at a glance. */}
      <div className="card card-pad" style={{ background: 'linear-gradient(135deg,var(--color-primary-900),var(--color-primary-700))' }}>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-medium text-primary-200">Today's closing cash</p>
            <p className="text-value-primary text-white figures mt-1">
              {formatPaisaAsRupees(today.closingCashPaisa)}
            </p>
            {!today.hasLedgerDay && (
              <p className="text-xs text-primary-300 mt-1">No activity recorded for today yet.</p>
            )}
          </div>
          <div className="flex gap-5">
            <div>
              <p className="text-[11px] font-medium text-primary-200">Opening</p>
              <p className="text-sm font-semibold text-white figures mt-0.5">
                {formatPaisaAsRupees(today.openingCashPaisa)}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-teal-300">Cash In</p>
              <p className="text-sm font-semibold text-teal-300 figures mt-0.5">
                {formatPaisaAsRupees(today.cashInPaisa)}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatGroupCard title="Operating Expenses">
          <p className="text-value-secondary text-brick-700 figures">
            {formatPaisaAsRupees(today.operatingExpensesPaisa)}
          </p>
          <p className="text-[11px] text-ink-400 mt-0.5">Today</p>
        </StatGroupCard>
        <StatGroupCard title="Staff Payments">
          <p className="text-value-secondary text-brick-700 figures">
            {formatPaisaAsRupees(today.staffPaymentsPaisa)}
          </p>
          <p className="text-[11px] text-ink-400 mt-0.5">Today</p>
        </StatGroupCard>
        <StatGroupCard title="Savings / Deposits">
          <p className="text-value-secondary text-brick-700 figures">
            {formatPaisaAsRupees(today.savingsDepositsPaisa)}
          </p>
          <p className="text-[11px] text-ink-400 mt-0.5">Today</p>
        </StatGroupCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card card-pad">
          <p className="panel-title mb-1">This Month</p>
          <StatRow label="Cash In" value={formatPaisaAsRupees(thisMonth.totalCashInPaisa)} tone="teal" />
          <StatRow label="Cash Out" value={formatPaisaAsRupees(thisMonth.totalCashOutPaisa)} tone="brick" />
          <StatRow
            label="Closing Cash"
            value={thisMonth.closingCashPaisa != null ? formatPaisaAsRupees(thisMonth.closingCashPaisa) : '—'}
          />
          <StatRow
            label="Operating Expenses"
            value={formatPaisaAsRupees(thisMonth.totalOperatingExpensesPaisa)}
            tone="brick"
          />
          <StatRow
            label="Staff Payments"
            value={formatPaisaAsRupees(thisMonth.totalStaffPaymentsPaisa)}
            tone="brick"
          />
          <StatRow
            label="Savings / Deposits"
            value={formatPaisaAsRupees(thisMonth.totalSavingsDepositsPaisa)}
            tone="brick"
          />
          <div className="pt-2 mt-1 border-t border-line-200">
            <StatRow
              label="Outstanding Staff Advances (active staff)"
              value={formatPaisaAsRupees(thisMonth.outstandingStaffAdvancesPaisa)}
              tone="brick"
            />
          </div>
        </div>

        <div className="card card-pad">
          <p className="panel-title mb-1">Top Expense Heads — This Month</p>
          {topExpenseHeads.length === 0 ? (
            <p className="empty-state">No expenses recorded this month yet.</p>
          ) : (
            <div>
              {topExpenseHeads.map((h) => (
                <StatRow key={h.expenseHeadId} label={h.name} value={formatPaisaAsRupees(h.totalPaisa)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
