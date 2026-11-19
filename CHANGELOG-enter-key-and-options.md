# Enter key in the Cash In / Cash Out popup, new built-in options, add categories in Expense Diaries

## 1. Enter works like Tab in the Cash In / Cash Out popup
- Enter moves to the next field; on the LAST field (Notes) Enter saves.
  Cash Out: Description -> Amount -> Category -> Expense Head (if the category has any)
  -> Staff -> Vehicle -> Reference Number -> Notes -> save.
  Cash In: Description -> Amount -> Source -> Notes -> save.
- Before: Enter inside Description or Amount tried to save the half-filled form at once.
- Shift+Enter still starts a new line inside Notes. Buttons keep their normal Enter behaviour.
- If Amount or Description is missing when saving, the cursor jumps to that field.
- The form can no longer save the same entry twice if Enter (or Add) is hit several times quickly.
- Only `src/components/TransactionFormModal.tsx` changed. Fast Entry is untouched.

## 2. New built-in options (also added to apps that are already installed)
- Cash In source: **Goods Sold**
- Cash Out categories: **Goods Purchase** and **Transport Fare / Gadi Bhada**
- Both Cash Out categories count under "Operating Expenses" in totals and reports
  (the same bucket as Food, Office, Travel & Fuel ...).
- They are added once, never duplicated (even if you already typed a same-name one in
  Settings, in any capitalisation), and never switched back on if you switch them off.
  They have fixed ids so two devices using Cloud Sync do not each add a copy.

## 3. Expense Diaries: add your own categories and heads right on the page
- "Add a new category" box at the top; "Add head" box inside every category.
  Type a name and press Enter or the button. Same-name duplicates are refused with a message.
- Every active category is now listed, including ones with no heads yet (before, a category
  without heads did not show on this page at all).
- Settings still has the same add / switch-off controls.

## Tests
- Existing suites unchanged: ledger 327, integration 35, staff-vehicles 43, staff-profile 44,
  fastentry 21, fastentry-suggestions 22, fastentry-smart-entry 88, fastentry-enter 42,
  batch-entry 44, calendar 36, ai-fallback 45, app-lock 215, drive-backup 56, backup-due 19,
  opening-anchor 22.
- owner-data: two count checks updated on purpose (categories 8 -> 10, cash-in types 6 -> 7),
  plus a new check that the original 8 categories are all still there. 56 pass.
- New `npm run test:goods-transport`: 13 checks.
- Real-browser run (Chromium): Enter walks every field in order, saves on the last one, hammering
  Enter 8 times saved exactly once, missing amount keeps the popup open and focuses Amount,
  Shift+Enter makes a new line, the three options are in the lists, categories and heads added
  in Expense Diaries appear and the new category shows up in the Cash Out list.
- Not verified: real phones (on-screen keyboards use their own "Next/Go" key), your saved data.
