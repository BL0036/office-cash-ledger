# UI/UX Redesign — Merged Step 4 + Step 5 (Core Workflow + Secondary Modules)

Scope: Dashboard, Daily Ledger, Fast Entry (visual only), Staff, Vehicles,
Institutions, Reports, Settings. Per this phase's own instructions, this
is a **token/spec rollout to existing screen content**, not a from-scratch
redesign — every color, radius, shadow, typography tier, checkbox,
toggle, and banner class used below was already defined in `index.css` by
Phase A; nothing new was added there, and `index.css` itself was not
touched this session (confirmed below).

## Read first

`CHANGELOG-redesign-step1-2.md` and `CHANGELOG-redesign-step3.md` in
full, plus this phase's own critical-risk sections on Fast Entry's
keyboard system and Staff's print mechanism, before touching either file.

## Environment limitation (same as Phase B — still true)

**No network access in this sandbox.** No `npm install`, `npm run
build`, `npm run lint`, or any `test:*` script could be run. Nothing
below claims otherwise. Verification this session is: reading the actual
diffs against the previously-delivered ZIP (shown below, not just
asserted), brace/paren balance checks on every touched file, and careful
manual tracing of the print-CSS and Fast-Entry-keyboard risk areas.
**Please run the real build/lint/test suite before shipping** — see
Phase B's changelog for the exact commands and expected counts.

## Screen-by-screen changes

### Dashboard (`DashboardView.tsx`)
- Page `<h1>` → `.text-page-title` (Phase A's own documented exact match
  for this file's prior ad hoc string — a like-for-like swap).
- The over-limit/missing-opening-balance/budget alert card → converted
  from an ad hoc `card card-pad` + inline `background` style to the
  shared `.banner banner-danger` component (Section 20's named rollout
  target). Same icon, same copy, same conditional logic — only the
  wrapping surface class changed.
- Hero closing-balance figure → `.text-value-primary` (Phase A's
  documented match for this exact figure) in place of the ad hoc
  `text-3xl font-bold ... tracking-tight` string; color/figures/margin
  utilities kept alongside it since the tier class itself doesn't set
  color (it sits on a dark gradient card).
- The three `StatGroupCard` values (Operating Expenses / Staff Payments /
  Savings-Deposits) → `.text-value-secondary` in place of the ad hoc
  `text-lg font-semibold` string.
- Loading state → `.spinner` + text, replacing bare "Loading…" text.
- **Not changed**: the hero card's gradient background (already
  documented by Phase A as this project's own deliberate "strongest
  value on the page" treatment, and Section 4 explicitly allows a
  restrained gradient — reworking it further would be a layout redesign
  beyond a token rollout), the `StatGroupCard`/`StatRow` component
  structure itself, and all business logic (`getDashboardData`, alert
  computation) — untouched.

### Daily Ledger (`App.tsx`'s `DailyLedgerScreen`, `TransactionList.tsx`, `BalanceSummary.tsx`, `DateNav.tsx`)
- `DailyLedgerScreen` itself: already well-structured from a prior
  (pre-redesign-project) pass — grouped Cash In/Cash Out sections with a
  colored dot + label + themed Add button, already satisfying Section
  12's "distinguish without relying only on color" requirement. **No
  changes made** — nothing ad hoc to roll a token onto.
- `BalanceSummary.tsx`: read in full. Already a deliberately-designed
  "Opening + Cash In − Cash Out = Closing" formula layout (documented as
  a prior "Phase 12d Part A" pass, predating this redesign project) that
  already gives Closing the largest/boldest treatment on the row —
  already satisfies Section 10's "balance visibility" ask. **Left
  unchanged** rather than force it into the newer token classes and risk
  a regression in a component that was already careful about its own
  responsive wrapping.
- `TransactionList.tsx`: already well-structured (documented "Phase 12d
  Part B" field-priority design). One real, in-scope gap fixed: the
  plain-text Edit/Delete/Cancel buttons had no `:focus-visible` styling
  at all (Section 21). Added a consistent focus ring to all three —
  no layout, copy, or delete/edit logic touched.
- `DateNav.tsx`: visual-only pass, no date logic touched (confirmed by
  diff below — only className additions). Added `:focus-visible` rings
  to all four buttons (prev/next/date-toggle/today) and applied Phase
  A's `.text-bs-date` line-height class to the BS date label (documented
  by Phase A as needed for Devanagari conjuncts, never applied until
  now). `addDaysISO`, `todayISO`, the picker open/close state, and the
  outside-click/Escape effects are byte-for-byte unchanged.

### Fast Entry (`FastEntryBar.tsx`) — visual only, by design
Read the entire file (996 lines) including every "Phase 3/6/12b/12c/12f"
comment describing its keyboard system, suggestion ranking, AI-fallback
gating, and advance-limit gating, per this phase's explicit critical
warning. **Exactly one line changed**, confirmed by diff against the
Step 3 ZIP:

```diff
- <div className="flex items-start gap-1.5 rounded-md border border-amber-100 px-2 py-1.5" style={{ background: 'var(--color-amber-50)' }}>
+ <div className="banner banner-warning items-start py-1.5 px-2">
```

This converts the advance-limit warning to the shared `.banner
banner-warning` class Section 20 explicitly names as one of the 3
target call sites. Everything else in this file — every `useState`,
every `useEffect`, `handleKeyDown`, `handleSubmit`,
`resolveDescriptionEnter`, `deriveSuggestions`, `resolveUniqueMatch`,
`hasConfidentDeterministicMatch`, `canAskAi`, `handleAskAi`, the
Cash In/Out toggle buttons, the description/amount/category fields, the
"+ more fields" section, `saveGuardRef`, and the `ESC_CONFIRM_WINDOW_MS`
two-tier Escape handling — is untouched. I deliberately did not attempt
further visual polish here (spacing, focus-ring styling on the many
interlinked fields/refs) because I could not verify in a real browser
that a spacing change wouldn't shift where a ref-focused element lands
mid-keystroke, and the brief is explicit that an uncertain change here
should be flagged rather than made. **Flagging it now**: this file's
input/select/button visual polish (beyond the one banner) is unclaimed
work for whoever can actually test the keyboard flow in a browser.

### Staff (`StaffView.tsx`) — print-CSS critical section, read in full below
- Page `<h1>` → `.text-page-title` (same exact-match pattern as the
  other 4 screens' headers, see next section).
- Loading state (staff list, salary-payments list) → `.spinner` + text,
  replacing bare "Loading…" text — 2 call sites.
- `GiveAdvanceModal`'s advance-limit warning → converted to `.banner
  banner-warning`, the exact call site Section 20 names alongside Fast
  Entry's. Same icon, same copy, same `warning` state.
- **Print-CSS / modal-shell verification (Section 13's named critical risk)**:
  Read `.print-region`'s CSS in `index.css` (lines 672–702) and both
  `PrintIdCard` (uses it at line 778) and `PrintSummary` (line 875) in
  full before making any change in this file. **`.print-region`,
  `.modal-overlay`, `.modal-panel`, `.modal-header`, `.modal-body`, and
  the entire `@media print` block in `index.css` were not touched —
  index.css has zero changes this session** (confirmed: `diff -q` against
  both the original input ZIP and the Step 3 output ZIP shows it
  byte-for-byte identical in both comparisons). Line ranges, unchanged:
  `.modal-overlay`/`.modal-panel`/`.modal-header`/`.modal-body` at
  581–611, `@media print` at 685–702 (same ranges Phase B already
  reported — nothing shifted since nothing was inserted above them).
  Within `StaffView.tsx` itself, a full diff against the Step 3 ZIP
  confirms the only 4 changes are: the h1 swap, 2 spinner swaps, and the
  banner swap — nothing within 50 lines of either `print-region` div
  (778, 875) or any `modal-overlay`/`modal-panel` line (186, 470, 656,
  760, 859) was touched. I deliberately did **not** attempt the visual
  content redesign of `PrintIdCard`/`PrintSummary` the brief says is
  welcome (their internal spacing/typography/card layout) — with no way
  to render either the on-screen or the `@media print` result in a
  browser, and this mechanism explicitly flagged as never having been
  visually verified by anyone on this project, I judged the safer choice
  to leave their internals exactly as delivered rather than guess at a
  layout change I cannot check. Flagging this as unclaimed work for a
  session with real browser/print-preview access.
- **Not changed**: `PayrollSalaryModal`, `PrintIdCard`, `PrintSummary`
  content/layout, staff CRUD logic, advance/salary calculation logic —
  all untouched.

### Vehicles (`VehiclesView.tsx`)
- Page `<h1>` → `.text-page-title`.
- Loading state → `.spinner` + text (1 call site).
- **Not changed**: card/list layout, vehicle-expense aggregation logic,
  petrol/servicing/other-expense presentation structure. This screen's
  existing compact list layout already reads reasonably clearly; a
  deeper structural pass (e.g. reworking how petrol vs. servicing totals
  are grouped) would be layout work beyond a token rollout and I didn't
  want to restructure something I can't visually check without a
  browser.

### Institutions / Savings (`InstitutionsView.tsx`)
- Page `<h1>` → `.text-page-title`.
- Loading state → `.spinner` + text (2 call sites: institutions list,
  transaction history list).
- **Not changed**: institution CRUD, deposit/withdrawal transaction
  history layout, same reasoning as Vehicles above.

### Reports (`ReportsView.tsx`)
- Page `<h1>` → `.text-page-title`.
- Loading state → `.spinner` + text (5 call sites — this screen has
  several independently-loading report sections, each got its own
  spinner rather than one shared one, matching how they already fail/
  load independently).
- **Not changed**: report table structure, filters, BS month-boundary
  logic (`lib/bsCalendar.ts` untouched, confirmed — this file doesn't
  import it directly for calculation, only for display formatting which
  wasn't touched either).

### Settings (`SettingsView.tsx`) — all sections reviewed, most left alone
- Page `<h1>` → `.text-page-title`.
- Loading states → `.spinner` + text (2 call sites: the whole-screen
  guard and Cloud Sync's own section-level loading state).
- **AI Fallback's "Enable AI Fallback" switch → Phase A's `.toggle`
  track+thumb spec**, its first real use anywhere in the app (Section 20
  names this as the intended first rollout target). The real, keyboard-
  and-screen-reader-accessible `<input type="checkbox">` is now visually
  hidden (`sr-only`, not removed or replaced) with the decorative
  track/thumb spans as its siblings, exactly matching Phase A's
  documented markup shape. `checked={settings.enabled}` and
  `onChange={handleToggle}` — the actual AI Fallback enable/disable
  logic — are the same props on the same input element, untouched.
- **Not changed**: Cloud Sync, App Lock (incl. its Google-recovery
  sub-section), Google Drive Backup, and Backup/Export sections' internal
  layout — Phase B already fixed these sections' *order*; their own
  internal content/layout is technically this phase's named scope
  (Section 31's list), but each is a substantial, security-sensitive
  flow (recovery codes, backup file handling, sync state) and I judged
  that restyling their internals without any way to click through the
  actual flows in a browser was too risky for this pass, especially
  since Section 24/28 both warn against speculative rework. Flagging all
  four as unclaimed work for whoever can test them interactively. None
  of their own business logic (`lib/appLock.ts`, `lib/googleDriveBackup.ts`,
  `lib/syncConfig.ts`, `lib/aiFallback.ts`) was touched either way.

## Files changed this session

Confirmed by `diff -rq` against the previously-delivered Step 3 ZIP —
exactly these 9 files differ, nothing else:

| File | What changed |
|---|---|
| `src/components/DashboardView.tsx` | `.text-page-title`, `.banner banner-danger`, `.text-value-primary`, `.text-value-secondary` ×3, `.spinner`. |
| `src/components/TransactionList.tsx` | Focus-visible rings on Edit/Delete/Cancel. |
| `src/components/DateNav.tsx` | Focus-visible rings ×4, `.text-bs-date`. |
| `src/components/FastEntryBar.tsx` | One line: advance-limit warning → `.banner banner-warning`. |
| `src/components/StaffView.tsx` | `.text-page-title`, `.spinner` ×2, `.banner banner-warning` (GiveAdvanceModal). |
| `src/components/VehiclesView.tsx` | `.text-page-title`, `.spinner`. |
| `src/components/InstitutionsView.tsx` | `.text-page-title`, `.spinner` ×2. |
| `src/components/ReportsView.tsx` | `.text-page-title`, `.spinner` ×5. |
| `src/components/SettingsView.tsx` | `.text-page-title`, `.spinner` ×2, `.toggle` rollout (AI Fallback switch). |

`src/index.css`: **unchanged** — confirmed byte-for-byte identical to
both the original input ZIP and the Step 3 output ZIP. `App.tsx`
(outside `DailyLedgerScreen`, already covered by Phase B), every
`lib/*.ts`, `db/schema.ts`, and every hook: **unchanged**.

## Business logic preserved

Confirmed by the diffs above: no calculation, ledger, staff/vehicle/
institution CRUD, sync, backup, AI-fallback, App-Lock, or BS-calendar
file was touched. Every className-only or wrapper-only change was
verified against the Step 3 baseline to confirm nothing beyond markup/
class strings moved.

## Tests

**Not run — no network access in this session, same as Phase B.**
Commands to run yourself, unchanged from Phase B/Step 3's list:
`npm run build`, `npm run lint` (still expecting 0 errors / 20 warnings
per Phase B's baseline — this session added no new dependencies or
lint-relevant patterns beyond what oxlint already saw), and every
`test:*` script. None of this session's files are exercised by any
`test:*` suite (they all test `lib/*.ts`/`db/schema.ts`), so there's no
code-level reason to expect a regression in the 14 suites' counts — but
again, that's a prediction, not a verification.

## Fast Entry keyboard-logic confirmation (explicitly requested)

Verified by full-file read + line-level diff against the Step 3 ZIP:
- Event handlers (`onKeyDown` on description/amount, the two-tier Escape
  handler, Alt+I/Alt+O/Alt+M shortcuts, Tab handling): **0 lines changed**.
- Suggestion resolution/ranking (`deriveSuggestions`, `resolveUniqueMatch`,
  `hasConfidentDeterministicMatch`, `deterministicSuggestions`): **0 lines
  changed**.
- AI-fallback gating (`canAskAi`, `handleAskAi`, `isAiFallbackConfigured`):
  **0 lines changed**.
- Advance-limit gating (`checkAdvanceLimit`, `advanceLimitWarning` state
  and its "not reset by resetForm()" behavior): **0 lines changed** — only
  its *rendering wrapper* (the one banner-class diff above) changed, not
  the state itself.
- Double-submit guard (`saveGuardRef`, `createFastEntrySaveGuard`):
  **0 lines changed**.

## Known issues / honest status for whoever picks this up next

1. **No build/lint/test/browser verification was possible** — the single
   most important caveat, repeated from Phase B because it's still true.
2. **Deliberately unclaimed, flagged work** (listed above, not silently
   skipped): Fast Entry's field-level visual polish beyond the one
   banner; `PrintIdCard`/`PrintSummary`'s internal visual redesign;
   Settings' Cloud Sync/App Lock/Google Drive Backup/Backup-Export
   sections' internal layout. All four involve either untestable
   keyboard timing or untestable print/security flows, and I chose not
   to guess.
3. Visual quality is **UNVERIFIED** — same as every prior phase. This
   phase touched more files than Phase B did; please look at all 8
   screens yourself, especially the new `.toggle` switch and the 3
   converted banners, before treating this as done.
4. Vehicles/Institutions/Reports' own content layout got token rollout
   (headers, spinners) but not a deeper structural redesign pass — they
   were already reasonably organized and I prioritized the riskier,
   more consequential Dashboard/Ledger/Fast-Entry/Staff work first, per
   this phase's own stated priority order, and ran out of safe, verifiable
   ground to cover beyond that within one session.
