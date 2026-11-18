# APP_VERSION metadata fix

`src/lib/backup.ts`'s locally-duplicated `APP_VERSION` constant was
updated from `'0.0.0'` to `'1.0.0'` to match `package.json`'s current
`"version"` field, with a one-line comment added directly above it
noting there's no automated link between the two and that whoever bumps
`package.json`'s version next needs to update this constant too. Nothing
else was touched: `package.json`'s version, `schemaVersion`/`db.verno`
(still 14) in `db/schema.ts`, and every other part of the app are
unchanged. A search of the rest of `src/` found no other hardcoded
version string and no About/version-display screen, so there was nothing
else to report. Verified directly: a freshly exported backup's
`appVersion` field now reads `"1.0.0"` while its `schemaVersion` field is
still `14`, unaffected; `npm run build` is clean with no type errors; and
every existing `test:*` script passes with its exact prior count
(test:ledger 327, test:integration 35, test:staff-vehicles 43,
test:staff-profile 44, test:owner-data 55, test:fastentry 21,
test:fastentry-suggestions 22, test:fastentry-smart-entry 88,
test:fastentry-enter 42, test:batch-entry 44, test:calendar 36,
test:ai-fallback 45) — all reconfirmed from a fresh `npm install` +
extraction of the final ZIP, not just the working copy.
