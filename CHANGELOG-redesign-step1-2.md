# UI/UX Redesign — Step 1 (Audit) + Step 2 (Design System)

Scope for this session, per the master redesign brief: audit the existing
app and establish a centralized design system (tokens + documented
control specs). Dashboard, Daily Ledger, Fast Entry, Staff, Vehicles,
Institutions, Reports, and every Settings section's actual rendered
content/layout were **not** touched — that rollout is Steps 3–5, on top
of what this session establishes. No business logic, calculation, ledger
cascade, BS calendar implementation, sync, or backup code was touched.

## Important note on the brief itself

The prompt for this session referenced a "MASTER UI/UX REDESIGN &
PREMIUM PRODUCT POLISH" document, Sections 1–34, to be pasted in full —
in particular Section 5 (colors) and Section 6 (typography). That
document's actual text was **not** present in what this session
received; the placeholder for it was never filled in. Two things in the
existing code suggest at least fragments of that same master brief have
already been applied in an earlier, undocumented session: a code comment
reading `v1.0 §19: Escape closes the mobile drawer.` in `App.tsx`, and
one reading `v1.0 release polish: ...` in `index.css` (the subtle
background wash). Neither is documented in any `CHANGELOG-*.md`/
`MERGE-NOTES-*.md` file in the project.

Without Section 5/6's actual text, Step 2 below was built the way the
brief's own fallback allows ("your call based on what you find in
Step 1") — from what Step 1's audit found already working, rather than
guessing at unseen spec language. If the real Section 5/6 text turns out
to prescribe something different from what's below (e.g. a literal
"cool-blue/neutral" palette rather than the existing teal/brick/amber
semantic one), please share it — everything below is additive and
reversible, not a destructive rewrite.

## Step 1 — Audit

### What was read before any code was touched
Every `CHANGELOG-*.md` and `MERGE-NOTES-*.md` file in the project root
(13 phase changelogs plus the App Lock/Drive Backup merge notes), in
order, to establish the authoritative current state: 14 `test:*` npm
scripts with their exact current pass counts, the current Settings
section list, and the print-CSS mechanism's own history (Phase 4).
`READ-ME-FIRST.txt` and `README.md` were also read for the non-technical
owner-facing picture.

### Component architecture — what's reusable, what's duplicated
- **Reusable and consistent**: every modal in the app (`TransactionFormModal`,
  both `InstitutionsView` modals, five `StaffView` modals including the
  two print views, both `VehiclesView` modals) uses the exact same
  `.modal-overlay`/`.modal-panel`/`.modal-header`/`.modal-body` shell —
  no divergent modal implementation anywhere. Every `<select>` and
  `<textarea>` in the app already reuses the single `.field` class
  rather than a separate control style per screen.
- **Duplicated**: the "Escape key closes this modal" `useEffect` is
  copied verbatim in at least 8 places (`App.tsx`, `DateNav.tsx`,
  `TransactionFormModal.tsx`, `InstitutionsView.tsx` ×2,
  `VehiclesView.tsx`, `StaffView.tsx` ×5) instead of one shared
  `useEscapeToClose(onClose)` hook. Flagged, not touched — extracting it
  means editing every one of those component files, out of scope for
  Steps 1–2.
- **Stray files**: `src/App.tsx.orig` and
  `src/components/SettingsView.tsx.orig` are pre-merge backups left over
  from the App Lock/Google Drive Backup hand-merge
  (`MERGE-NOTES-app-lock-and-drive-backup.md`) — dead weight in the
  repo, not imported or built by anything. Left in place; deleting stray
  files felt like more than a "specs only" Step 1–2 change should decide
  unilaterally, but worth a deliberate cleanup pass.

### Existing design tokens (in `index.css`, Tailwind v4 CSS-first `@theme`)
Already substantial and centralized before this session — colors (`canvas`/
`surface`/`surface-muted`/`surface-sunken`, `line-100/200/300`,
`ink-300…900`, a full `primary-50…900` ramp, and `teal`/`brick`/`amber`
ramps each tied to a specific meaning: teal = cash-in/positive, brick =
cash-out/danger, amber = warning/budget), one radius token
(`--radius-card`), and a component layer (`.card`, `.btn*`, `.field*`,
`.pill*`, the modal shell, `.dropdown-pop`, `.table-*`, `.thin-scroll`,
`.empty-state`). This is **not** a generic "cool-blue/neutral" system —
it's a deliberate, semantically-meaningful palette, already reused
consistently everywhere (confirmed by grep: no screen defines its own
one-off color). Per the brief's own instruction ("preserve existing
semantic meaning... don't change what they mean without a reason tied to
an actual audit finding"), Step 2 below extends this system rather than
replacing it.

**Gaps found** (see Step 2 for what fills each):
- No named radius scale beyond `--radius-card` — `.btn`/`.field` (0.5rem),
  `.btn-sm` (0.4rem), and `.pill` (999px) were bare literals.
- No named elevation/shadow scale — `.card`, `.card-hover:hover`, and each
  solid button's `:hover` state each had their own bare `box-shadow`
  literal.
- No typography scale beyond `.panel-title`/`.panel-label` — page-level
  headings (`DashboardView.tsx`, `ReportsView.tsx`, `DiariesView.tsx`)
  all repeat the identical `text-xl font-semibold text-ink-900
  tracking-tight` utility string rather than a shared class; the big
  balance figure and its two smaller companions in `DashboardView.tsx`
  do the same with `text-3xl font-bold ... figures tracking-tight` /
  `text-lg font-semibold ... figures`.
- No documented control specs for: checkbox (every Settings toggle today
  is a bare unstyled `<input type="checkbox">`), toggle/switch, tab,
  dropdown/autocomplete menu chrome (`.dropdown-pop` only defines the
  pop-in animation, not the menu surface itself), or a loading spinner
  (none exists anywhere in the app today — confirmed by grep).
- No shared feedback-banner component — `DashboardView.tsx`'s over-limit
  alert and the Part 3 advance-limit warnings
  (`FastEntryBar.tsx`/`StaffView.tsx`'s `GiveAdvanceModal`) each hand-roll
  their own banner via an inline `style={{ background: 'var(--color-
  *-50)' }}` plus ad hoc border-color utilities, rather than one shared
  class.

### Modal/dialog system
Confirmed: one shell (`.modal-overlay`/`.modal-panel`), used identically
everywhere, mobile-first (bottom sheet under 640px, centered dialog
above), with `Escape`-to-close on every instance. Nothing here was
touched.

### Form/input components
`.field` (shared by text input, `<select>`, `<textarea>`), `.field-label`,
`.field-hint` (error text), `.field-error` (border state). Consistently
applied everywhere a form field appears. Not touched.

### Table/list components
Two patterns coexist by design, not by accident: `TransactionList.tsx`
renders a card-style list (each transaction its own row-like block with
inline actions), while `ReportsView.tsx` and parts of `StaffView.tsx` use
the actual `.table-head-cell`/`.table-cell` classes for genuinely tabular
data (reports, salary/advance history). Appropriate split; not touched.

### Mobile navigation pattern
A fixed desktop sidebar (`≥1024px`) and a slide-in drawer + backdrop
below that, both sharing the same `NavList`/`SidebarBrand` components (no
duplicated nav markup) — confirmed in `App.tsx`. `Escape` closes the
drawer. Not touched.

### Keyboard shortcut implementation
Two layers: the generic "Escape closes this modal/drawer" pattern noted
above (duplicated 8×, not consolidated this phase), and Fast Entry's own,
much richer, self-contained keyboard system in `FastEntryBar.tsx`
(`ArrowUp`/`ArrowDown` to move through suggestions, `Enter` to save/pick,
`Escape` to dismiss the dropdown, `Alt+I`/`Alt+O`/`Alt+M` quick-focus
shortcuts, `Tab` handling) — explicitly out of scope to touch (Fast Entry
is one of the excluded screens), and not touched.

### All 6 Settings sections — current visual patterns
There are actually **nine** section components in `SettingsView.tsx`
(`CategoriesSection`, `ExpenseHeadsSection`, `CashInTypesSection`,
`BudgetsSection`, `CloudSyncSection`, `AiFallbackSection`,
`GoogleDriveBackupSection`, `AppLockSection`, `BackupExportSection`), not
six — the brief's own count likely meant the four "optional feature"
sections (Cloud Sync, AI Fallback, App Lock, Google Drive Backup) plus
Backup/Export, on top of the four original reference-data sections. Every
optional section shares one visual pattern: `<section class="card
card-pad space-y-4">` → `<h2 class="panel-title">` heading → a `text-xs
text-ink-400` explanation paragraph → the actual controls. Confirmed
consistent across all four.

**One discrepancy worth flagging**: the actual render order in the code
(`SettingsView.tsx`'s final JSX) is Cloud Sync → AI Fallback → **Google
Drive Backup → App Lock** → Backup/Export. `MERGE-NOTES-app-lock-and-
drive-backup.md` describes the merge producing "the App Lock section...
and the Google Drive Backup section both render, **in that order**" —
i.e., App Lock before Drive Backup, the reverse of what's actually in the
file today. Something reordered these two sections after that merge, in
a change no changelog documents. Not touched this phase (reordering two
existing sections is a Steps 3–5 concern, not a Step 2 token/spec one) —
flagged for whoever does that pass.

### The print CSS mechanism (read, understood, **not touched**)
Read in full in `index.css`'s `@media print` block and cross-checked
against `.modal-overlay`'s `position: fixed; inset: 0` (the containing
block `.print-region`'s own `position: absolute` needs) and its two call
sites in `StaffView.tsx` (`PrintIdCard`/`PrintSummary`, both Phase 4).
Confirmed understanding: `visibility: hidden` on `body *`, then
`visibility: visible` reapplied only to `.print-region` and descendants,
then `.print-region` pulled out of flow with `position: absolute; top:
0; left: 0; width: 100%` so it isn't left occupying its hidden siblings'
space. This still has never been rendered in a real browser by anyone on
this project (every session, including Phase 4's and Phase 5's own,
hit the same network restriction trying to install a headless browser) —
still trusted on code-level reasoning only. **Confirmed byte-for-byte
identical, before and after this session's changes**, by diffing against
a fresh extraction of the delivered ZIP:
- `.modal-overlay` / `.modal-panel` / `.modal-header` / `.modal-body`
  block: unchanged.
- The entire `@media print { ... }` block: unchanged.

## Step 2 — Design System

Everything below lives in `src/index.css` (the pre-existing centralized
location — no new tokens file, since one wasn't needed: this codebase
was already disciplined about not scattering tokens across component
files, and a second file would itself be a small scattering). Nothing
here is wired into any screen yet, per the brief's own "specs only,
not full rollout" instruction for this phase.

### Colors
**Not changed.** Per the audit finding above (an existing, deliberate,
semantically-meaningful palette, already used consistently everywhere),
and the brief's own instruction to preserve existing semantic meaning
absent an audit finding that says otherwise — no audit finding here
argued for replacing it. If Section 5 of the actual master brief turns
out to specify something genuinely different, that's a deliberate,
separate decision for the owner, not something to guess at from a
missing document.

### Radius scale (new, value-preserving)
```
--radius-card: 0.875rem;   /* unchanged, unrenamed */
--radius-sm:   0.4rem;     /* was a bare literal on .btn-sm */
--radius-md:   0.5rem;     /* was a bare literal on .btn, .field */
--radius-pill: 999px;      /* was a bare literal on .pill, the scrollbar thumb */
```
Applied to the exact rules that already used each literal value — zero
visual change, confirmed by diff and by an identical CSS bundle size
delta consisting only of the new rules (see Verification).

### Elevation (shadow) scale (new, mostly value-preserving)
```
--shadow-xs: 0 1px 2px rgba(15, 30, 51, 0.04);   /* was .card's own literal */
--shadow-sm: 0 1px 3px rgba(15, 30, 51, 0.06);   /* new step, not yet applied */
--shadow-md: 0 4px 14px rgba(15, 30, 51, 0.08);  /* was .card-hover:hover's own literal */
--shadow-lg: 0 12px 32px rgba(15, 30, 51, 0.14); /* new step, not yet applied */
```
Deliberately neutral (ink-based), **not** applied to the three solid
buttons' own tinted `:hover` shadows (`.btn-primary`/`.btn-teal`/
`.btn-brick` each glow their own brand color on hover, a real,
intentional detail — collapsing them into one neutral token would be a
visual change, not a refactor, so they're left exactly as-is). Also
deliberately **not** applied to `.modal-panel`'s own shadow, to keep the
"nothing touched in the modal shell" guarantee simple and absolute
rather than "touched but explained."

### Typography scale
Four tiers already existed under other names and are **unchanged, not
renamed**: section title → `.panel-title`, metadata → `.panel-label`,
label → `.field-label`, helper/error → `.field-hint`. Four new classes
fill the remaining tiers, three of them matching an exact, already-
repeated ad hoc Tailwind pattern found in the audit (so adopting them
later is a like-for-like swap): `.text-page-title`, `.text-value-primary`,
`.text-value-secondary`, plus two new conservative in-between steps
(`.text-card-title`, `.text-body`, `.text-secondary`) with no exact prior
match, for a later phase's own judgement call. A `.text-bs-date` modifier
(`line-height: 1.5`) is included specifically for Devanagari BS-date
text, which needs more vertical headroom than Latin text at the same
size — `DateNav.tsx` currently renders BS dates at plain `text-sm` with
no explicit line-height; this is available for whichever future phase
applies it there.

### Standardized control specs (documented, not yet applied anywhere)
- **Button, input**: already fully specified (`.btn*`, `.field*`) —
  nothing added.
- **Select, textarea, search, date control**: audited and found already
  adequately specified (select/textarea reuse `.field` as-is; search
  reuses `.field` plus the new `.dropdown-menu` below for results; the
  bespoke BS calendar UI in `BsDatePicker.tsx`/`DateNav.tsx` works today
  and redesigning it is a Steps 3–5 decision, not a Step 2 one) — nothing
  new added for these.
- **Checkbox**: `.checkbox` (sized, `accent-color` tied to
  `--color-primary-600` instead of generic OS-blue).
- **Toggle**: `.toggle`/`.toggle-track`/`.toggle-thumb` — a track+thumb
  spec for later replacing the bare `<input type="checkbox">` every
  Settings on/off control uses today, keeping the real checkbox as the
  accessible control underneath.
- **Tab**: `.tab`/`.tab-active` — generalizes `NavList`'s own
  active/inactive treatment for a light-surface context.
- **Badge**: documented as the existing `.pill`/`.pill-*` — not a new or
  renamed class.
- **Dropdown**: `.dropdown-menu`/`.dropdown-menu-item` — the menu-surface
  chrome `.dropdown-pop` (animation-only) was missing, for pairing with
  FastEntryBar's suggestion list later without touching it now.

### Feedback-state specs
- **Loading**: `.spinner` — genuinely new; no loading indicator of any
  kind existed anywhere in the app before this.
- **Success/warning/danger/info**: `.banner`/`.banner-success`/
  `.banner-warning`/`.banner-danger`/`.banner-info` — one shared shape,
  reusing the exact teal/amber/brick tokens the existing ad hoc inline-
  styled banners already reach for, plus a new info variant on the
  primary token.
- **Empty/disabled/hover/focus/active**: already fully specified
  (`.empty-state`, `.btn:disabled`, `:hover`/`:focus-visible`/`:active`
  states throughout) — nothing added.
- **Error**: already fully specified (`.field-error`, `.pill-brick`) —
  nothing added.

## A packaging bug found and fixed (tooling, not a screen/logic change)

Running the documented `npm run build`/`npm run lint`/`npm run test:*`
acceptance criteria from a genuinely fresh extraction of the delivered
ZIP surfaced one real, reproducible bug, unrelated to any phase's
product code: **the ZIP ships with no `.gitignore`**. `package.json`'s
`"lint": "oxlint"` script has no path argument, and with no `.gitignore`
to fall back on, oxlint scans the entire project directory including
`node_modules` and `dist` — **65,536 warnings and 182 errors** on a fresh
`npm install`, instead of the documented `0 errors, 20 warnings`.
Scoping the same command to `oxlint src scripts` reproduces the
documented count exactly, confirming this is a discovery/config problem,
not a real code regression.

Added a standard `.gitignore` (`node_modules/`, `dist/`, `.env`, editor/
OS files, Firebase debug logs) at the project root. This alone restores
`npm run lint` (run exactly as documented, no path argument) to `0
errors, 20 warnings` from a completely fresh extraction — verified
directly, see below. This is the only non-CSS file this session added or
changed.

(This also explains, retroactively, the "briefly went to 24,641 files /
54,925 warnings" incident `CHANGELOG-google-account-recovery.md` reported
and attributed to a local `cp -r dir/*` glob dropping dotfiles — the
same failure mode. It isn't only a copy-glob problem; the ZIP itself
has never included a `.gitignore` in any phase so far, and would produce
the same failure for the owner too the first time they ran `npm run
lint` from these exact delivered files rather than an existing git
checkout.)

## Verification performed

- `npm run build` (`tsc -b && vite build`) — clean, no type errors, from
  a fresh `npm install` + extraction of the final ZIP. JS bundle
  unchanged (`1,399.58 kB`, identical to before this session — confirms
  zero `.ts`/`.tsx` files were touched). CSS bundle grew from `34.60 kB`
  to `37.59 kB` gzip (`7.59 kB` → `8.09 kB`), entirely accounted for by
  the new, additive CSS rules above.
- `npm run lint` (`oxlint`, run exactly as documented, no path argument)
  — **0 errors, 20 warnings**, from a genuinely fresh extraction — see
  the packaging-bug section above for why this required adding
  `.gitignore` to actually reproduce.
- Every one of the 14 `test:*` suites, rerun individually from the same
  fresh extraction, all matching `CHANGELOG-google-account-recovery.md`'s
  own counts exactly: ledger 327, integration 35, staff-vehicles 43,
  staff-profile 44, owner-data 55, fastentry 21, fastentry-suggestions
  22, fastentry-smart-entry 88, fastentry-enter 42, batch-entry 44,
  calendar 36, ai-fallback 45, app-lock 215, drive-backup 56 (see below).
- **`test:drive-backup` flaked twice more in this session** (54/56, then
  54/56 again, then 56/56 three times in a row) before settling —
  slightly more often than `MERGE-NOTES-app-lock-and-drive-backup.md`'s
  own "fails once immediately post-install, never again" description,
  but the same class of issue: a pre-existing timing flake in that
  suite's own mocking, unrelated to anything CSS-only work in this
  session could touch. Re-running it until it passes 56/56 (as this
  session did) is the same guidance that changelog already gives.
- `npm run test:sync` — **still not run**, same network-egress
  restriction (`storage.googleapis.com` not in this sandbox's allowlist)
  every phase before this one has hit. Nothing in this session touches
  `lib/sync.ts` or anything sync-related, so this should be an unaffected
  pass — please run it yourself before shipping, as every prior phase
  has also asked.
- **Print-CSS / modal-shell check** (this phase's own explicit
  acceptance criterion): confirmed by diffing this session's `index.css`
  against a fresh extraction of the original ZIP — `.modal-overlay`,
  `.modal-panel` (including its `position: fixed`), `.modal-header`,
  `.modal-body`, and the entire `@media print { ... }` block are
  byte-for-byte identical, before and after. A full recursive diff of
  the whole project confirms only two files changed or were added this
  session: `src/index.css` and the new `.gitignore` — nothing else.
- Visual quality itself is **UNVERIFIED** — no browser is reachable in
  this environment (same restriction every phase has hit trying to
  reach a headless-browser download host). Everything above is
  code-level/diff-level verification, not rendered-output verification.
  Please look at the app yourself before the next phase proceeds, per
  this phase's own instruction.

## Known limitations, for whoever picks this up next

1. **The master brief's actual Section 5/6/19 text was never provided**
   to this session — see the note at the top of this file. Steps 3–5
   should get that text before rolling these tokens out screen-by-screen,
   in case it specifies something the audit-driven approach here
   couldn't have known about.
2. The Settings-section reordering discrepancy (Drive Backup now renders
   before App Lock, the opposite of what the merge notes describe) is
   flagged but not fixed — fixing it means editing `SettingsView.tsx`,
   out of this phase's scope.
3. The duplicated Escape-key-closes-modal `useEffect` (8 call sites) is
   flagged but not consolidated into a shared hook, for the same reason.
4. `App.tsx.orig` and `SettingsView.tsx.orig` (merge-leftover files) are
   still in the repo, unused by the build — flagged, not deleted.
5. Every new CSS class in this changelog is unused by any component as
   of this commit. That's intentional (Step 2 is specs, not rollout) but
   worth stating plainly so nobody mistakes "class exists in `index.css`"
   for "screen X now uses it."
6. `test:drive-backup`'s occasional first-run flake (see Verification)
   is pre-existing and not something this or any prior phase has
   actually fixed — only worked around by re-running.
