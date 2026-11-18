# UI/UX Redesign — Step 3 (Global Shell)

Scope for this session, per the master redesign brief and this phase's own
explicit instructions: Section 8 (Navigation) + the "global shell" part of
Step 3 — background, page structure, global spacing, and rolling Phase A's
(`CHANGELOG-redesign-step1-2.md`) documented tokens/control specs out to
the common/shared controls (buttons, inputs, checkboxes/toggles, the modal
shell, banners, the spinner) used app-wide — plus the three small,
low-risk flagged items Phase A deferred. **Content of Dashboard, Daily
Ledger, Fast Entry, Staff, Vehicles, Institutions, Reports, and every
Settings section was deliberately not redesigned** — that's Phase C/D/E,
per this phase's own scope boundary.

## Read first, before any code was touched

`CHANGELOG-redesign-step1-2.md` in full — the existing teal/brick/amber
semantic palette (confirmed intentional, not a gap), every token/control
spec Phase A added to `index.css`, the three flagged-but-not-fixed items,
and the `.gitignore` packaging fix.

## Environment limitation — read this before trusting any "verified" claim

**This session has no network access at all** (not even the narrower
`storage.googleapis.com` restriction earlier phases hit trying to reach
Firebase's emulator — no network reaches out from this sandbox). There is
no `node_modules` in the delivered ZIP and none could be installed.
Concretely, this means:

- `npm run build` (`tsc -b && vite build`) — **not run**. Could not be run.
- `npm run lint` (`oxlint`) — **not run**. Could not be run.
- Every `test:*` script — **not run**. Could not be run.
- No real or headless browser was reachable — same limitation every prior
  phase has already hit for actually rendering the app.

Everything marked "verified" below is verified the only way this session
could: reading the actual file contents, diffing this session's files
byte-for-byte against a fresh extraction of the delivered input ZIP, and
counting braces/parens as a crude structural sanity check. **None of that
substitutes for an actual `tsc -b`, `oxlint`, or `npm run test:all` run.**
Please run all of the above yourself — from a genuinely fresh
`npm install` — before treating this phase as shippable. If any of them
fail, the likely culprits are listed file-by-file below so a fix is fast.

## 1. Escape-to-close consolidation

### What Phase A actually flagged, vs. what a fresh count found

Phase A's changelog says "duplicated in at least 8 places" but its own
enumerated list (`App.tsx, DateNav.tsx, TransactionFormModal.tsx,
InstitutionsView.tsx ×2, VehiclesView.tsx, StaffView.tsx ×5`) sums to
**11**, not 8. A fresh `grep -rn "e.key === 'Escape'" src` this session
confirms 12 total matches: the 11 in that list, plus `FastEntryBar.tsx`'s
own two-tier Escape handler (dropdown-first, then a confirm-before-clear
flow) — which is explicitly a different, richer thing, not a copy of the
simple pattern, and `FastEntryBar.tsx` is out of scope for this phase
regardless. So: **11 sites consolidated**, matching Phase A's enumerated
list exactly (not the "8" in its prose header, which was simply wrong).

### The new shared hook

`src/hooks/useEscapeToClose.ts` (new file):

```ts
export function useEscapeToClose(onClose: () => void, enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, enabled]);
}
```

Same event, same key check, same attach/cleanup as every original
inline effect — this is a pure extraction, not a behavior change.

### The 9 identical "always-on" call sites — swapped for `useEscapeToClose(onClose)`

- `TransactionFormModal.tsx`
- `InstitutionsView.tsx` — `InstitutionFormModal`, `MovementModal`
- `VehiclesView.tsx` — `VehicleFormModal`
- `StaffView.tsx` — `StaffFormModal`, `PaySalaryModal`, `GiveAdvanceModal`,
  `PrintIdCard`, `PrintSummary`

`InstitutionsView.tsx` no longer uses `useEffect` anywhere else in the
file, so its `useEffect` import was removed; every other file above still
has unrelated `useEffect` calls, so their import was left as-is (checked
individually with `grep -c "useEffect("` before touching any import).

### The 2 sites with their own extra guard — adapted, not just swapped

- **`App.tsx`** (mobile nav drawer): was `if (!mobileNavOpen) return;` at
  the top of the effect. Now `useEscapeToClose(() => setMobileNavOpen(false), mobileNavOpen)`
  — the `enabled` parameter is exactly that guard, moved into the hook.
- **`DateNav.tsx`** (BS date picker popover): the original effect did two
  unrelated things in one `useEffect` — Escape-to-close *and* an
  outside-click (`mousedown`) listener — sharing one cleanup function.
  Splitting this was slightly more than a pure swap: Escape now goes
  through `useEscapeToClose(() => setPickerOpen(false), pickerOpen)`, and
  the outside-click listener stays in its own, now-smaller `useEffect`
  (still gated on `pickerOpen`, still on `window`, still `mousedown`,
  still cleaned up the same way — only the Escape half moved out).

### Verification (static, not run in a browser — see limitation note above)

- `grep -rn "e.key === 'Escape'" src` now returns exactly one match
  (`FastEntryBar.tsx`, untouched, out of scope).
- `grep -rln "useEscapeToClose" src` returns exactly the 7 files expected
  (the 6 component files above + `App.tsx`, `DateNav.tsx` — 7 distinct
  files for 11 call sites) plus the hook's own file.
- Brace/paren counts on all 8 touched `.tsx` files plus the new hook file
  are balanced (see table below) — a crude but real structural check.
- Each replaced call site was read back after editing to confirm the
  surrounding component still has the same props/behavior around it;
  no JSX structure outside each effect was touched.
- **Cannot verify**: this still doesn't confirm `tsc -b` accepts it, or
  that Escape actually closes each of the 11 dialogs when clicked/typed
  in a real browser. Please click through all 9 modals + the mobile
  drawer + the date picker popover and press Escape in each, once, before
  shipping.

## 2. Two stray `.orig` files deleted

`src/App.tsx.orig` and `src/components/SettingsView.tsx.orig` — confirmed
via `grep -rn "\.orig"` across `src`, every config file, and
`package.json` that nothing imports or references either file, then
deleted both. Diffing this session's tree against a fresh extraction of
the input ZIP confirms they're gone and nothing else in `src/` changed as
a side effect of removing them.

## 3. Settings-section order — fixed to match the merge notes' original intent

`MERGE-NOTES-app-lock-and-drive-backup.md` states the merge's intent
plainly: "the App Lock section from Phase 7 and the Google Drive Backup
section both render, **in that order**." The actual code had them
reversed (`GoogleDriveBackupSection` before `AppLockSection`). Swapped the
two `<GoogleDriveBackupSection />` / `<AppLockSection />` JSX lines in
`SettingsView.tsx` back to App Lock → Google Drive Backup, matching the
merge notes exactly. This is a pure reorder of two existing, unmodified
components — neither section's own internals were touched.

## 4. Global shell — control-spec rollout

Consistent with this phase's explicit boundary (shell/chrome only, not
screen content), the following were rolled out only where they're
genuinely shared/shell-level, not embedded in a specific screen's
content:

- **Checkbox** (`.checkbox`, Phase A's spec) — applied to the 3 bare
  `<input type="checkbox">` elements found anywhere in the app (confirmed
  exhaustive via `grep -rn 'type="checkbox"' src`): `StaffView.tsx`'s
  vehicle-assignment checkbox list, `AppLockParts.tsx`'s recovery-code
  confirmation checkbox, and `SettingsView.tsx`'s AI Fallback enable
  checkbox. Each edit is a one-line `className` addition — sizing +
  `accent-color` only, no surrounding JSX/layout touched. This is a
  narrow interpretation of "checkboxes/toggles" rollout, deliberately
  stopping short of the `.toggle` track+thumb spec (see "Not done" below).
- **Spinner** (`.spinner`, genuinely new this session — Phase A noted
  nothing like it existed anywhere before) — applied to `App.tsx`'s own
  pre-`ready` loading state (shown before any screen mounts, while the DB
  is seeding). This is the app shell's own loading state, not any
  screen's — the per-screen "लोड हुँदैछ…" text scattered across
  `SearchView.tsx`, `InstitutionsView.tsx`, `ReportsView.tsx`, etc. was
  deliberately left alone (that's screen-content work, Phase C/D/E).
- **Navigation** (Section 8) — the existing sidebar/drawer (`NavList`,
  `SidebarBrand`, both shared between desktop sidebar and mobile drawer,
  confirmed in `App.tsx`) already does most of what Section 8 asks:
  active-tab highlighting, grouped items, a working mobile drawer. Two
  real gaps found and fixed, both chrome-only:
  - **Elevation**: the mobile drawer panel had no shadow at all despite
    floating over the backdrop/content — added `boxShadow:
    'var(--shadow-lg)'` (Phase A's own elevation token) alongside its
    existing gradient background.
  - **Focus visibility** (Section 21): none of the sidebar/drawer's
    interactive elements — nav item buttons, the mobile hamburger and
    drawer-close buttons, the language toggle, "Lock now" — had any
    `:focus-visible` styling. Added a consistent
    `focus-visible:ring-2 focus-visible:ring-teal-300/70` treatment to
    all of them (teal reads clearly against the sidebar's dark primary
    gradient, and reuses an existing semantic color rather than
    introducing a new one).

### Deliberately NOT done this phase, and why

- **`.toggle` track+thumb markup** — Phase A's spec expects extra
  decorative `<span>` elements wrapping each checkbox
  (`<label class="toggle"><input .../><span class="toggle-track">...`).
  Adding that to the 3 checkbox sites above means restructuring JSX
  inside `SettingsView.tsx` and `StaffView.tsx` beyond a one-line
  className swap — closer to content/layout work than shell chrome, so
  left for whichever phase actually redesigns those sections' content.
- **Banners** (`.banner`/`.banner-*`) — grepped for every ad hoc
  `style={{ background: 'var(--color-*-50)' }}` banner in the app; found
  exactly 3, and all 3 live inside screens explicitly out of scope this
  phase: `DashboardView.tsx`'s over-limit alert, `FastEntryBar.tsx`'s
  advance-limit warning, and `StaffView.tsx`'s `GiveAdvanceModal` advance-
  limit warning (the same one Phase A's own changelog named as the reason
  `.banner` exists). There is no shell-level banner call site anywhere in
  the app to roll this out to — all three are screen content. Left
  exactly as Phase A found them.
- **Modal shell** (`.modal-overlay`/`.modal-panel`/`.modal-header`/
  `.modal-body`) — read in full, understood, **not modified**, for the
  same reason Phase A gave: `.modal-panel` already has its own working
  values (not yet using the new radius/shadow tokens), and touching it —
  even to swap in a token with an identical value — is exactly the file
  the print-CSS mechanism depends on. See the dedicated verification
  section below for why this was left completely alone rather than
  "touched but explained."
- **Select/textarea/search/date-control** — Phase A's own audit already
  found these adequately specified (`.field` reuse); nothing to roll out.
- **Page-level container spacing/typography** — each screen defines its
  own `mx-auto max-w-5xl px-4 ... py-5` wrapper inside its own content;
  there's no single shared "page frame" component in `App.tsx` to touch
  without editing screen content directly, so this was left alone.

## 5. Print-CSS / modal-shell verification (this phase's explicit, named acceptance criterion)

**`src/index.css` was not edited at all this session** — confirmed with
`diff -q` against a fresh extraction of the input ZIP: byte-for-byte
identical, not just the modal/print sections. Since the whole file is
untouched, the modal shell and print mechanism are untouched by
construction, but here are the exact line ranges anyway, so this isn't
"asserted, not shown":

- `.modal-overlay` / `.modal-panel` / `.modal-header` / `.modal-body`:
  lines 581–611 of `src/index.css`, before and after — identical (the
  file itself is identical).
- `@media print { ... }` block: lines 685–702 — identical.

No before/after diff of these ranges is meaningful to show since there is
no "after" — the file has zero changes. The only files touched this
session are listed in the file-change table below, and `src/index.css`
is not among them.

## Files changed this session

| File | What changed |
|---|---|
| `src/hooks/useEscapeToClose.ts` | **New.** Shared Escape-to-close hook. |
| `src/App.tsx` | Escape hook adopted (mobile drawer); spinner on shell's pre-ready loading state; shadow-lg on mobile drawer; focus-visible rings on nav/hamburger/close/language-toggle/lock-now. |
| `src/components/DateNav.tsx` | Escape hook adopted (date picker popover); outside-click listener split into its own effect. |
| `src/components/TransactionFormModal.tsx` | Escape hook adopted. |
| `src/components/InstitutionsView.tsx` | Escape hook adopted (×2); unused `useEffect` import removed. |
| `src/components/VehiclesView.tsx` | Escape hook adopted. |
| `src/components/StaffView.tsx` | Escape hook adopted (×5); `.checkbox` class on vehicle-assignment checkboxes; `App.tsx.orig`'s sibling `.orig` file deleted (see below — not this file, but same commit). |
| `src/components/SettingsView.tsx` | `.checkbox` class on AI Fallback checkbox; App Lock / Google Drive Backup section order swapped. |
| `src/components/AppLockParts.tsx` | `.checkbox` class on recovery-code confirmation checkbox. |
| `src/App.tsx.orig` | **Deleted.** Unused merge leftover. |
| `src/components/SettingsView.tsx.orig` | **Deleted.** Unused merge leftover. |

`src/index.css` and every other file in the project: **unchanged**,
confirmed by full recursive diff against a fresh extraction of the input
ZIP (only the 8 files above plus the new hook file and the 2 deletions
show up in that diff).

## Business logic preserved

No calculation, ledger, sync, backup, or BS-calendar file was touched —
confirmed both by the file list above (none of `lib/*.ts`, `db/schema.ts`
were edited) and by the full recursive diff against the input ZIP.

## Tests

**Not run — see the "Environment limitation" section at the top.** The
exact commands to run, unchanged from Phase A: `npm run build`, `npm run
lint` (no path argument — the `.gitignore` Phase A added is still present
in this ZIP, confirmed via `ls -la`, so lint should still scope correctly
to `0 errors, 20 warnings`), and each `test:*` script. None of this
session's changes touch any file a `test:*` script exercises (all of them
test `lib/*.ts`/`db/schema.ts` logic), so there's no code-level reason to
expect a regression — but that's a prediction, not a verification, and
this phase cannot tell you it actually still holds.

## Known issues / honest status for the next phase

1. **No build/lint/test/browser verification was possible in this
   session's environment** — this is the single most important caveat in
   this whole document. Please run all of it before shipping.
2. Phase A's Section 5/6/19 concern (the master brief's literal text
   possibly saying something different from the existing semantic
   palette) still applies here too — this phase made no color changes,
   so it's not a new risk, but it's not resolved either.
3. `.toggle` and `.banner` specs remain unused by any component, same as
   Phase A left them — now explicitly re-flagged with the specific reason
   (content/layout risk) rather than left implicit.
4. Visual quality is **UNVERIFIED** — same as every prior phase, for the
   same reason (no reachable browser). Please look at the app yourself,
   especially the mobile drawer's new shadow and the sidebar/drawer focus
   rings, before Phase C proceeds.
