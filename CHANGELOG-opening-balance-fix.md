# Fix: opening balance "Save" did not stick

## The problem
The ledger has ONE hand-set opening balance (the starting cash of the whole ledger).
Every later day's opening is simply the previous day's closing.

The app marks the first day ever opened as "Day 1" (editable). But just opening an
EARLIER date (for example pressing "Previous day") creates an earlier day. From then
on the old "Day 1" was no longer the first day, yet it still showed an Edit button.
Typing an amount and pressing Save was accepted, then silently overwritten with the
previous day's closing - so it looked like Save did nothing - while the real first day
had no Edit button at all.

## The fix
- The Edit button now appears only on the FIRST day of the ledger (the earliest date).
- Editing it saves, and the amount flows into every later day.
- If the earliest day was not the anchor yet, the anchor moves there. The old anchor's
  own amount was already being ignored, so no effective balance changes.
- Trying to set an opening on a later day now gives a clear message instead of
  silently doing nothing (this can only happen through code, not the screen).
- Later days show a small note: "from previous day's closing".

## Not changed
Ledger calculations, entries, reports, backup/restore format and Cloud Sync are untouched.
Changed files: `src/lib/ledger.ts`, `src/components/BalanceSummary.tsx`.

## Verified
- New `npm run test:opening-anchor`: 22 checks (normal case, the bug scenario, a second
  earlier day, refusal on later days, backup -> restore). All suites pass with unchanged
  counts (ledger 327, integration 35, app-lock 215, drive-backup 56, backup-due 19, ...).
- Real browser (Chromium) walk-through of the exact flow: open app -> Previous day -> Edit
  -> 50,000 -> Save -> opening shows 50,000 -> Next day shows 50,000, not editable.
- Not verified: your own saved data (cannot be seen from here), real phones.
