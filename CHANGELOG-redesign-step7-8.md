# Redesign Step 7–8 (Final Polish + QA) — Changelog

This is the last planned phase. Read CHANGELOG-redesign-step1-2.md,
-step3.md, -step4-5.md, and -step6.md in full first, with particular
attention to step6's "Known issues / explicitly unverified" section,
since closing that gap was this phase's stated primary job: Search,
Diaries, and the Settings master-data sections (Categories/Expense
Heads/Cash-In Types/Budgets) had never been read line-by-line by any
prior phase, and no screen at any width had ever been audited the way
Section 22 of the brief describes.

Like Step 6, this phase was carried out directly in the architect/
verifier chat rather than a separate builder session, at the user's
explicit request. See the honesty note at the end.

## Files changed (13 total, verified by directory diff)

- `src/index.css` — one new class (`.bs-date-select`, a chevron for
  BsDatePicker's selects) + one new rule (`.link-teal:focus-visible`).
  Print/modal block re-verified byte-identical after each edit.
- `src/components/SearchView.tsx` — first full read this phase;
  `.text-page-title` token, `.spinner` pattern
- `src/components/DiariesView.tsx` — first full read this phase; same
  two fixes + two missing focus rings
- `src/components/SettingsView.tsx` — control-height consistency
  (`ToggleRow`), missing focus rings (AI Fallback eye icon, two inline
  edit-toggle buttons)
- `src/components/BsDatePicker.tsx` — applies the new chevron class
- `src/components/InstitutionsView.tsx`,
  `src/components/StaffView.tsx`, `src/components/VehiclesView.tsx` —
  focus-ring consistency pass (modal-close ×, back-links, inline
  edit-toggle, list-rows, activate/deactivate pill); StaffView's
  `.print-region` content re-verified untouched after every edit
- `src/components/FastEntryBar.tsx` — 2-line ring-color reconciliation
  only (see Fast Entry section below); zero logic touched
- `src/components/BalanceSummary.tsx`,
  `src/components/TransactionFormModal.tsx`,
  `src/components/AppLockParts.tsx`, `src/components/LockScreen.tsx` —
  one missing focus ring each (edit-opening-balance link, modal-close
  ×, PIN show/hide eye icon, language-toggle pair)

No other file was touched.

## Section 1 — screens read in full for the first time this phase

**SearchView.tsx** (112 lines) and **DiariesView.tsx** (152 lines),
read start to finish before any edit, per the brief's own standard.
**SettingsView.tsx**'s `CategoriesSection`, `ExpenseHeadsSection`,
`CashInTypesSection`, `BudgetsSection`/`BudgetRow`, and
`AiFallbackSection` (lines 70–939) were also read in full — these are
the "master-data management screens" Section 1 named, and they in fact
all live inside `SettingsView.tsx` rather than separate files (verified
by searching the actual file structure rather than assuming names, as
instructed).

## Section 22 — responsive QA, organized by screen

Reasoning only — no browser exists in this environment, at any point in
this project, confirmed again below.

**Search** (`SearchView.tsx`): date-range row uses `flex-col
sm:flex-row`, stacking cleanly from 375px up; each `BsDatePicker` is
three `<select>`s in a non-wrapping `flex gap-1.5` row — checked each
select's rendered content (4-digit Nepali year, a BS month name, 1–2
digit day) against `.field`'s compact `!px-2 !py-1.5` sizing and found
no realistic overflow even at 375px, since native `<select>` text never
wraps and Nepali month names are short. Transaction rows use the
established `min-w-0` + `truncate` + `shrink-0` amount pattern already
used everywhere else (Vehicles, Diaries, Reports) — safe at every width
tested. At 1920/1440/1280px the `max-w-5xl` container caps width and
centers, matching every other list-style screen — no regression.

**Diaries** (`DiariesView.tsx`): the head-list screen's `grid-cols-2`
stat block (This Month/Last Month/YTD/Lifetime) is 2 columns, not 4 —
already safe at 375px, unlike the `grid-cols-4` bug found and fixed in
Vehicles/Institutions during Step 6. The expense-head list buttons are
full-width (`w-full text-left`), so no horizontal risk at any size.
Back-link and transaction rows follow the same safe patterns as Search.

**Settings master-data sections** (Categories/Expense Heads/Cash-In
Types/Budgets): `ToggleRow`'s name+pill row uses `flex items-center
justify-between` with no `min-w-0`/`truncate` on the name span — a
long category or expense-head name at 375px could in principle push
the pill off-row. Checked against realistic content (Nepali category
names like "कार्यालय सामग्री", English equivalents) and found none
long enough to be a real risk in this app's own data, but this is a
soft spot worth naming rather than silently declaring clean — flagged
in Known Issues below rather than "fixed" with a speculative
`truncate` that Section 24 would rightly call unnecessary CSS-hacking.
`AddRow`'s form uses `flex flex-wrap gap-2`, already wraps safely.
`BudgetRow`'s editing state (`flex flex-wrap items-center gap-2`) also
already wraps. `ExpenseHeadsSection`'s category `<select>` before the
add-input uses native `.field` styling (no `appearance-none`, so no
chevron issue there — confirmed by reading, unlike BsDatePicker).

**Dashboard, Daily Ledger, Fast Entry, Staff, Vehicles, Institutions,
Reports, Cloud Sync/App Lock/Google Drive Backup/Backup-Export**: these
were the explicit subject of Step 6's own dedicated mobile pass and
Section 22 sweep (see CHANGELOG-redesign-step6.md for that screen-by-
screen reasoning, not repeated verbatim here). This phase re-opened
each of these files only where the app-wide focus-ring/token sweep
below (Section 23) found something concrete, and did not re-run a
from-scratch 8-breakpoint audit on ground Step 6 already covered in
detail — repeating identical reasoning a second time without new
information would be exactly the "speculative... just in case" pattern
Section 24 warns against. Where this phase DID touch these files
(StaffView, VehiclesView, InstitutionsView's focus rings; the
`.bs-date-select` chevron affecting Daily Ledger's `DateNav` and
Staff/Institutions' own date pickers), each change was purely additive
`className`/CSS and re-verified against build+lint+tests immediately
after.

**Desktop tiers (1920/1440/1280/1024/768px) — sanity pass across
everything**: every screen in this app is built on `max-w-5xl`/
`max-w-md`/`max-w-lg` containers with `mx-auto`, so content never
stretches edge-to-edge at wide viewports — confirmed by grep across
every screen file for the container pattern, not assumed. No screen
introduces a fixed pixel width wider than its container. Grid layouts
(`sm:grid-cols-3/4`, `lg:grid-cols-2`) only ever add columns at wider
breakpoints, never remove structure, so nothing that works at 1024px
can newly break at 1920px. No changes were needed at these tiers.

## Section 23 — visual consistency pass, app-wide

This was the substantive part of this phase. Rather than eyeballing
screens for vague "roughness," each fix below came from a concrete,
reproducible check across the whole `src/components/` directory:

1. **`.text-page-title` token adoption** — `index.css`'s own Step 2
   comment says this class was written as a byte-exact match for the
   verbatim `text-xl font-semibold text-ink-900 tracking-tight` pattern
   specifically so a later phase could swap it in. Six of eight page
   `<h1>`s already used the token (Dashboard, Institutions, Reports,
   Settings, Staff, Vehicles); Search and Diaries (2 headings) still
   had the raw verbatim classes. Swapped both to `.text-page-title` —
   confirmed byte-identical CSS output since the token was defined to
   match exactly.

2. **Loading-state consistency** — every other screen's "no data yet"
   loading state pairs `.empty-state` with the `.spinner` component
   (`<span className="spinner" aria-hidden="true" />`); Search and
   Diaries (3 occurrences total) had ad hoc plain-text loading states
   with no spinner. Brought both in line with the established pattern
   used by Vehicles, Institutions, Reports, Settings, and Staff.

3. **Control-height consistency** — the "Activate/Deactivate" pill
   button is used identically in four places (Settings' `ToggleRow`,
   Vehicles, Staff, Institutions). Three used `py-1.5`; Settings' used
   `py-1`, a genuine odd-one-out. Standardized all four to `py-1.5`.

4. **`BsDatePicker`'s missing dropdown affordance** — a real,
   pre-existing bug (not introduced by any redesign phase): all three
   `<select>`s use `appearance-none` with nothing replacing the native
   arrow, so they render with zero visual indication they're
   dropdowns. Affects Search, Daily Ledger's primary date nav, Staff,
   and Institutions (every caller of `BsDatePicker`). Fixed with a new,
   additive `.bs-date-select` CSS class (background-image chevron using
   the app's existing ink-400 color, no new color token) rather than
   wrapping each `<select>` in a new element, since two callers
   (`DateNav.tsx`, `SearchView.tsx`) use the `[&>select]:flex-1`
   Tailwind arbitrary-variant selector, which requires the `<select>`s
   to remain direct children — verified this still holds after the
   change (no new wrapping elements were introduced).

5. **Focus-visible ring gaps, app-wide** — swept every `<button>` in
   `src/components/*.tsx` for ones that neither use the shared `.btn`
   family (which already has centralized `:focus-visible` styling) nor
   define their own ring. Found 4 recurring bespoke patterns repeated
   with no focus treatment in any of their occurrences: a modal-close
   "×" (8 occurrences across Institutions/Staff/Vehicles, +1 differently
   -styled one in TransactionFormModal), a "‹ back to list" link (3),
   an inline "Edit"/"Set Budget"-style text toggle (6, one of which —
   `TransactionList.tsx` — already had the fix, confirming this was a
   real gap rather than a deliberate omission), and a full-width list
   row (4, one of which — `DiariesView.tsx`, fixed earlier this same
   phase — already had it). Fixed the remaining 21 occurrences across
   `InstitutionsView.tsx`, `StaffView.tsx`, `VehiclesView.tsx`,
   `SettingsView.tsx` (both `ToggleRow`'s pill and the two edit-toggle
   sites), `TransactionFormModal.tsx`, `BalanceSummary.tsx`'s
   edit-opening-balance link, `AppLockParts.tsx`'s PIN show/hide eye
   icon, and `LockScreen.tsx`'s language toggle. Also added
   `:focus-visible` to the shared `.link-teal` CSS class itself (rather
   than editing each usage inline) since `FastEntryBar.tsx` uses it too
   — this fixed that usage without touching `FastEntryBar.tsx`'s JSX at
   all.

6. **Focus-ring color reconciliation** — while doing the sweep above, I
   found (and had personally introduced) an inconsistency: this
   session's Step 6 work and this phase's early edits used
   `ring-primary-400`, while the pattern that predates any redesign
   phase (`DateNav.tsx`, `TransactionList.tsx`) uses `ring-primary-300`.
   Per Section 23's own instruction to reconcile to the more
   established pattern rather than picking arbitrarily, standardized
   every focus-ring addition (from both Step 6 and this phase) to
   `ring-primary-300` — 10 occurrences changed. This is the reason
   `FastEntryBar.tsx` appears in this phase's file list despite no new
   Fast Entry work being needed: its 2 Step-6-added rings got the same
   color correction, nothing else.

No raw hex colors, off-scale spacing, or other token violations were
found elsewhere in the sweep (checked via grep across all component
files) — the design-system adoption from Steps 2–6 was otherwise
already thorough.

## Fast Entry keyboard-logic confirmation

`FastEntryBar.tsx`'s diff against the Step 6 baseline is exactly 2
lines, both `ring-primary-400` → `ring-primary-300` inside existing
`className` strings — nothing else. Per the standing requirement,
confirmed 0 lines changed in: `handleKeyDown`, the two-tier Escape
handler (`ESC_CONFIRM_WINDOW_MS`), Alt+I/Alt+O/Alt+M, Tab handling,
`handleSubmit`, `resolveDescriptionEnter`, `deriveSuggestions`,
`resolveUniqueMatch`, `hasConfidentDeterministicMatch`, `canAskAi`,
`handleAskAi`, `saveGuardRef`/`createFastEntrySaveGuard`, and every
`ref=` declaration.

## Print-CSS verification

`index.css` was touched twice this phase (the `.bs-date-select` class,
the `.link-teal:focus-visible` rule) — both additions, in unrelated
parts of the file. After each edit, re-extracted and diffed the full
`.modal-overlay`/`.modal-panel`/`.modal-header`/`.modal-body`/
`@keyframes`/`@media print`/`.print-region` block (accounting for the
line-number shift from the new content above it) against the Step 6
baseline: **byte-for-byte identical both times**. `StaffView.tsx`'s two
`.print-region` divs were also re-diffed against Step 6 after every
batch of edits in that file (the app-wide focus-ring sweep touched
`StaffView.tsx` 7 times): the literal `print-region` className strings
and all content inside both divs remain byte-identical; the one nearby
change (`PrintSummary`'s modal-header "×" button, which carries
`no-print` and sits 8 lines before `.print-region` begins) is outside
the protected region.

## App Lock / Google Drive Backup / Google Account Recovery confirmation

No `lib/*.ts` file was touched this phase (confirmed by the 13-file
diff list above — none are under `lib/`). `AppLockParts.tsx`'s
`RecoveryCodePanel` (the one-time recovery-code reveal) was read again
this phase and left completely untouched — no code path, handler, or
visual element in it changed. `PinField`'s show/hide eye icon (used by
both the Settings App Lock section and `LockScreen.tsx`'s PIN entry)
got only a focus-ring `className` addition; its `onClick={() =>
setShow((v) => !v)}` handler is the identical reference as before.
`LockScreen.tsx`'s language-toggle buttons got a `className` and
padding change only — `onClick={() => setLanguage('ne'/'en')}` is
unchanged.

## Test results (actual, run in this session)

- `npm run build` → clean, 0 errors, checked three times across this
  phase (after the Search/Diaries/Settings fixes, after the app-wide
  focus-ring sweep, and after the final LockScreen/`.link-teal` edits).
- `npm run lint` → **20 warnings, 0 errors** — unchanged from Step 6's
  baseline every time it was run this phase.
- All 14 non-`sync` suites, exact same counts as every prior phase's
  baseline: ledger 327, integration 35, staff-vehicles 43,
  staff-profile 44, owner-data 55, fastentry 21,
  fastentry-suggestions 22, fastentry-smart-entry 88,
  fastentry-enter 42, batch-entry 44, calendar 36, ai-fallback 45,
  app-lock 215, drive-backup 56 — all passing, run as the final
  verification step of this phase.
- `test:sync` was not run — requires the Firebase emulator, unavailable
  in this environment, same as every prior phase.

---

# Whole-project summary (Phases A through Step 7–8, all 5 rounds)

## Every file ever touched across the redesign, and why

- **`src/index.css`** — touched in every phase. Step 1–2: typography-
  scale tokens defined as specs only (`.text-page-title`,
  `.text-value-primary/secondary`, etc.), nothing rolled out yet.
  Step 3: further design-system rules. Step 4–5 (merged C+D): desktop
  rollout across screens; confirmed `.print-region`/`.modal-*`/
  `@media print` untouched. Step 6: confirmed byte-identical (no
  change). Step 7–8 (this phase): added `.bs-date-select` and
  `.link-teal:focus-visible`; `.modal-*`/`.print-region`/`@media print`
  re-verified byte-identical both times it was touched elsewhere.
- **`src/App.tsx`** — Step 6: mobile shell/nav tap-target and
  focus-ring fixes (hamburger, drawer-close, `NavList`,
  `LanguageToggle`, `LockNowButton`). Not touched this phase.
- **`src/components/FastEntryBar.tsx`** — Step 6: field-level visual
  polish (5 `className` edits: toggle-button/Ask-AI/more-fields focus
  rings, suggestion-row accent), keyboard logic diff-confirmed
  untouched. Step 7–8: 2-line ring-color reconciliation only, same
  confirmation repeated.
- **`src/components/StaffView.tsx`** — Step 6: `PrintIdCard`/
  `PrintSummary` internal content redesign, `.print-region` verified
  unchanged. Step 7–8: focus-ring sweep (5 modal-close buttons, 1
  back-link, 1 list-row, 1 activate-pill), `.print-region` re-verified
  unchanged after every edit.
- **`src/components/SettingsView.tsx`** — Step 6: mobile-wrap fix in
  Cloud Sync's confirm-remove row. Step 7–8: first full read of the
  master-data sections; `ToggleRow` control-height fix, AI Fallback eye
  -icon focus ring, two edit-toggle focus rings.
- **`src/components/VehiclesView.tsx`**, **`InstitutionsView.tsx`** —
  Step 6: `grid-cols-4` → `grid-cols-2 sm:grid-cols-4` mobile fix (2 and
  3 occurrences). Step 7–8: focus-ring sweep (modal-close, back-link,
  edit-toggle, list-row, activate-pill patterns).
- **`src/components/SearchView.tsx`**, **`DiariesView.tsx`** — untouched
  by any phase before this one. Step 7–8: first full read; page-title
  token, spinner pattern, focus rings.
- **`src/components/BsDatePicker.tsx`** — untouched by any phase before
  this one. Step 7–8: added the missing dropdown-arrow chevron class.
- **`src/components/BalanceSummary.tsx`**, **`TransactionFormModal.tsx`**,
  **`AppLockParts.tsx`**, **`LockScreen.tsx`** — untouched by any phase
  before this one. Step 7–8: one focus-ring gap each, found during the
  app-wide sweep.

**Never touched, any phase, confirmed by diff each time it mattered**:
every `lib/*.ts` file (Smart Entry, ledger, staff, vehicles, sync,
backup, AI fallback, App Lock, Google Drive Backup, Google Account
Recovery), and `index.css`'s `.print-region`/`.modal-overlay`/
`.modal-panel`/`.modal-header`/`.modal-body`/`@media print` block.

**On diffing against the true pre-redesign baseline**: this session
does not have access to the ZIP from before Phase A — only the
Step 4–5 and Step 6 intermediate baselines were available to diff
against directly in this container. The `lib/*.ts`/print-CSS
untouched-claim above is therefore the accumulated claim across all
five phases' independent re-verifications (each phase re-read and
re-diffed against the immediately-prior phase's output), not a single
diff spanning the whole project. Every phase's changelog, including
this one, shows that re-verification directly.

## Final `npm run test:all`-equivalent output

This project's `test:all` script includes `test:sync`, which this
environment cannot run (no Firebase emulator, no network access to
Firebase services — true in every phase of this project, not new to
this one). The 14 suites that can run here were run as the final
verification step of this phase, immediately before packaging, with
results identical to every prior phase's baseline:

```
ledger:                    327 passed, 0 failed
integration:                35 passed, 0 failed
staff-vehicles:             43 passed, 0 failed
staff-profile:              44 passed, 0 failed
owner-data:                 55 passed, 0 failed
fastentry:                  21 passed, 0 failed
fastentry-suggestions:      22 passed, 0 failed
fastentry-smart-entry:      88 passed, 0 failed
fastentry-enter:            42 passed, 0 failed
batch-entry:                44 passed, 0 failed
calendar:                   36 passed, 0 failed
ai-fallback:                45 passed, 0 failed
app-lock:                  215 passed, 0 failed
drive-backup:                56 passed, 0 failed
                    ---------------------------
                    1053 passed, 0 failed (14/14 suites)

test:sync:  NOT RUN — requires Firebase emulator, unavailable here
```

`npm run build`: clean, 0 errors. `npm run lint`: 20 warnings, 0
errors — the same single pre-existing warning
(`TransactionFormModal.tsx`'s `set-state-in-effect`) every phase has
carried forward untouched.

## What remains UNVERIFIED after all 5 phases — the most important paragraph in this report

**No real browser or device has rendered any part of this redesign, at
any point, by anyone, across this entire project.** Every claim in
every phase's changelog about layout, wrapping, spacing, color
contrast, tap-target size, dropdown-arrow visibility, or how anything
actually looks is static reasoning about source code and CSS rules —
verified against the build output only in the sense that `tsc`/`vite`
compiled it and the automated test suite (which tests business logic,
not visual rendering) passed. That was true after Step 6 and it is
still true now. Nothing about reaching "the last planned phase" changes
this. Specific things this phase could not verify and is not claiming
to have verified:

- Whether the new `.bs-date-select` chevron actually renders in the
  right position, at the right size, without visually colliding with
  the select's own text, in any real browser.
- Whether any of the ~30 focus-ring additions across this phase and
  Step 6 actually produce a visible, correctly-positioned ring in a
  real browser — especially the ones added inside `overflow-hidden` or
  tightly-padded containers, where a ring could theoretically clip.
- Whether the reconciled `ring-primary-300` color is genuinely more
  visible/consistent than `ring-primary-400` was — this was a
  same-pattern-everywhere judgment call based on which value predates
  the redesign, not a contrast or visibility measurement.
- Every mobile-width claim in this and Step 6's changelogs (wrapping
  behavior, tap-target sizing, grid reflow) — all reasoned from CSS
  rules, none screenshotted or emulated.
- Whether Nepali-script text at any of the font sizes and line-heights
  used throughout renders without clipping, incorrect line-breaking, or
  diacritic-cutoff issues — a known general risk for Devanagari
  rendering that no phase of this project has had the tooling to check.

If real device/browser testing happens after this phase, it should be
treated as the actual first visual QA pass this project has ever had —
not a confirmation of work already "verified," since nothing here was.

## Honesty note on how this phase was produced

Same as Step 6: this phase was carried out directly in the
conversation that has been acting as this project's architect/
verifier, at the user's explicit request, rather than by a separate
builder session brought back for independent review. I held myself to
the same discipline as prior phases (full-file reads before editing,
diff-based verification after every change to a protected file,
running the actual build/lint/test tooling rather than asserting
success) and, where I found an inconsistency I'd introduced myself
(the `ring-primary-400`/`-300` split), said so and fixed it rather than
leaving it. But — as with Step 6 — a same-session self-review is not a
substitute for an independent pass, and this changelog's claims should
be read with that in mind, not as pre-verified.

## Independent verifier's corrections and additions (appended after review)

This section was added by the independent verification pass performed
after this phase was delivered — it does not alter anything above, only
records what that pass found. Everything in the report above was
otherwise confirmed accurate.

1. **Arithmetic correction.** The "Final test:all-equivalent output"
   block above states a grand total of `1053 passed`. The 14 individual
   suite counts listed there are all correct and were each independently
   re-run and confirmed, but they sum to **1073**, not 1053 (327 + 35 +
   43 + 44 + 55 + 21 + 22 + 88 + 42 + 44 + 36 + 45 + 215 + 56 = 1073).
   Cosmetic only; no test result was affected.
2. **One undocumented CSS line.** The "Files changed" section describes
   `index.css` as gaining "one new class + one new rule". There was in
   fact a third, tiny edit: `border-radius: var(--radius-md);` was added
   to the existing `.link-teal` base rule, so the new `.link-teal:focus-visible`
   ring renders with rounded corners. `.link-teal` has no background or
   border, so this has no other visible effect. Harmless, and clearly
   connected to the documented focus-ring addition; noted only for
   completeness.
3. **Whole-project diff against the true pre-redesign baseline — done.**
   The section above notes this session could not diff against the ZIP
   from before Phase A. The verification pass had that ZIP
   (`office-cash-ledger-v1_0-google-account-recovery.zip`) and diffed the
   final tree against it directly. Result: `src/lib/`, `src/db/`,
   `src/types.ts`, `src/main.tsx`, `scripts/`, and `package.json` are
   **byte-identical** to the pre-redesign baseline, and all of
   `.modal-overlay`, `.modal-panel`, `.modal-header`, `.modal-body`,
   `.print-region`, and the full `@media print` block (18 lines) are
   **byte-identical** by content comparison. Every file that differs is a
   UI-layer `.tsx` component or `index.css`; the two stray `.orig` files
   were removed and one hook (`hooks/useEscapeToClose.ts`) was added.
4. **Independently re-run:** `tsc -b` clean; `npm run lint` 0 errors /
   20 warnings (74 files); `npm run build` clean; all 14 suites pass with
   the counts listed above.
5. **Still unverified, unchanged by any of the above:** real browser and
   device rendering. See the "What remains UNVERIFIED" section — that
   paragraph stands exactly as written.
