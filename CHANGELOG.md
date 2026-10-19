# Changelog

## 0.2.0 (2026-10-19)

A correctness release. Several 0.1.0 behaviours could post wrong or duplicate entries;
upgrade before using any write tool.

### Fixed: data correctness

- **Tally debit/credit signs were reversed.** Vouchers were written with debits as positive
  `AMOUNT`/`ISDEEMEDPOSITIVE=No`; Tally's convention is the opposite, so entries posted with
  sides swapped. Tool input stays positive = debit; the client now converts to Tally's
  signs. Balances read back (ledgers, trial balance, day book) are converted the same way,
  and `tally_create_ledger` takes a numeric opening balance with positive = debit.
- **Successful Tally writes were reported as failures.** `<ERRORS>0</ERRORS>` was read as
  error text, so a created voucher returned an error and a retry posted it again. Import
  results are now read from `RESPONSE` or `ENVELOPE/BODY/DATA/IMPORTRESULT` with `ERRORS` as
  a count, and the new voucher's Master ID is returned as `master_id`.
- **Different writes were silently dropped as duplicates.** The automatic idempotency key
  ignored nested fields, so any two vouchers with the same type, date and narration
  collided. Deduplication now happens only with an explicit `idempotency_key`; keys are
  fingerprinted on the full arguments, reuse for different data is rejected, and keys
  persist on disk.
- **Tally reads returned nothing on real responses.** Collection exports nest objects under
  `ENVELOPE/BODY/DATA/COLLECTION` with the name as an attribute; the parser now handles
  attributes and any nesting depth (companies, ledgers, voucher types, day book).
- **`gst_einvoice_build` / `gst_einvoice_generate` failed on every MCP call.** Tool
  arguments (snake_case) are now mapped to the library's fields.
- **`gst_einvoice_generate` returned synthetic `MOCK-` IRNs as `generated: true`.** Live
  generation is now refused unless a real IRP integration exists (`INDIA_STACK_IRP=mock`
  only for tests).

### Fixed: compliance

- E-invoice JSON follows schema v1.1: `Version "1.1"`, `TaxSch`, `RegRev`, mandatory
  `IsServc` per item, buyer `Pos`, `Pin` (was `Pincode`), `Em` (was `Emal`); supply types
  `B2B, SEZWP, SEZWOP, EXPWP, EXPWOP, DEXP`; IGST vs CGST+SGST decided by place of supply;
  exports to `URP` buyers; zero tax for supplies without payment; state code checked
  against each GSTIN; 40% rate accepted; optional rupee round-off.
- Zoho Books: GSTIN is sent and read as `gst_no` (it was silently dropped); contacts take
  `gst_treatment`; invoices take `place_of_supply`, `gst_treatment`, `gst_no` and per-line
  `tax_id` / `hsn_or_sac`; `zoho_get_invoice` returns each line's `tax_id`.
- GSTR-2B reconciliation flags matched invoices whose ITC is not available, accepts credit
  notes (negative values) and cess, and never fuzzy-matches a note to an invoice.

### Security

- Destructive actions (voucher delete) need human approval through the client's
  confirmation dialog; `INDIA_STACK_DESTRUCTIVE=allow|deny` overrides.
- Audit redaction matches sensitive key names as whole words (company names were being
  redacted as "pan"); card numbers (Luhn) and Aadhaar (Verhoeff) are masked, record IDs kept.
- HTTP mode binds to 127.0.0.1, requires a bearer token to bind elsewhere, and enables
  DNS-rebinding protection.
- Dependencies updated: `npm audit` reports 0 vulnerabilities (MCP SDK 1.32,
  fast-xml-parser 5).

### Added

- `tally_purchase_register`: purchase register (supplier GSTIN, bill number, taxable value,
  IGST/CGST/SGST/cess) shaped for `gst_reconcile_2b`.
- `Contra` voucher type; `master_id` on create and in day-book results; delete by Master ID.
- Trial balance totals and difference.
- Zoho requests retry once after refreshing an expired access token.
- Protocol-level test suite (`evals/test/mcp.test.ts`) and fixtures in Tally's documented
  response shapes.

### Changed

- Packages are 0.2.0 with pinned `@india-stack/*` dependencies and public publish config.
- Server card corrected (license Apache-2.0, repository URL, version, description).
