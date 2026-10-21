# india-stack-mcp

MCP servers that let AI agents work with Indian accounting and tax systems: **TallyPrime**,
**Zoho Books** and **GST**. They work in Claude Desktop, Claude Code, Cursor, Codex or any
MCP client.

Frontier agents can reason about GST, but they cannot touch Tally: there is no modern API,
just a local XML gateway with its own conventions. This project is the connector layer:
typed tools, dry-run-first writes, idempotency, human approval for destructive actions, and a
tamper-evident audit trail.

## Status

| Connector | Scope | State |
| --- | --- | --- |
| `tally-mcp` | Companies, ledgers, vouchers (8 types), day book, trial balance, purchase register | **beta**: verified end to end on TallyPrime 7.2 (30/30 live checks: ledgers, payment, purchase, read-back, trial balance, purchase register, delete by Master ID) |
| `zoho-mcp` | Organizations, contacts, invoices (with GST fields), items, payments, chart of accounts | **beta** |
| `gst-mcp` | GSTIN validation, e-invoice JSON (schema v1.1), GSTR-2B reconciliation | **beta**; no IRP/GSP integration (see below) |

## Quick start

```bash
git clone https://github.com/rishiksaib/india-stack-mcp
cd india-stack-mcp
npm install
npm run build
```

Point your MCP client at the built servers (see `examples/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tally": {
      "command": "node",
      "args": ["<abs-path>/packages/connector-tally/bin/tally-mcp.js"],
      "env": {
        "TALLY_URL": "http://localhost:9000",
        "TALLY_COMPANY": "Your Company Pvt Ltd",
        "INDIA_STACK_AUDIT_LOG": "<abs-path>/audit/tally-audit.jsonl"
      }
    },
    "zoho": {
      "command": "node",
      "args": ["<abs-path>/packages/connector-zoho/bin/zoho-mcp.js"],
      "env": {
        "ZOHO_CLIENT_ID": "...",
        "ZOHO_CLIENT_SECRET": "...",
        "ZOHO_REFRESH_TOKEN": "...",
        "ZOHO_DC": "in",
        "ZOHO_ORGANIZATION_ID": "...",
        "INDIA_STACK_AUDIT_LOG": "<abs-path>/audit/zoho-audit.jsonl"
      }
    },
    "gst": {
      "command": "node",
      "args": ["<abs-path>/packages/connector-gst/bin/gst-mcp.js"]
    }
  }
}
```

**Tally:** TallyPrime running on the same machine with XML serving enabled on port 9000
(F1 → Settings → Connectivity). See `docs/tally-xml-notes.md`.

**Zoho Books:** a self-client OAuth refresh token with Books scopes
(`ZohoBooks.fullaccess.all` or narrower) from the Zoho API Console. Use `ZOHO_DC=in` for
India accounts.

## Conventions every tool follows

- **Amounts: positive = debit, negative = credit.** Rent paid from the bank is
  `Rent +25000, HDFC Bank -25000`. The Tally client converts to Tally's own XML signs.
- **Writes preview first.** Every write returns the exact upstream request (and, for Tally
  vouchers, a debit/credit summary) until you pass `dry_run: false`.
- **Retries are safe with a key.** Pass an `idempotency_key` on committed writes; a retry
  with the same key returns the first result instead of posting again, even after a restart.
  Writes without a key are never merged, so two genuine identical entries both post.
- **Destructive actions need a human.** Deleting a voucher opens a confirmation dialog in
  the MCP client. If the client can't show one, the call is refused unless
  `INDIA_STACK_DESTRUCTIVE=allow` is set.

## Tools (28)

**Tally (13)**. Reads: `tally_list_companies`, `tally_get_company`, `tally_search_ledgers`,
`tally_get_ledger`, `tally_ledger_balances`, `tally_trial_balance` (with debit/credit
totals and difference), `tally_day_book`, `tally_find_vouchers` (with `master_id`),
`tally_list_voucher_types`, `tally_purchase_register` (supplier GSTIN, bill number, taxable
value and tax split, ready for `gst_reconcile_2b`). Writes: `tally_create_ledger`,
`tally_create_voucher` (Sales, Purchase, Payment, Receipt, Journal, Contra, Credit Note,
Debit Note; returns `master_id`), `tally_delete_voucher` (approval required).

**Zoho Books (11)**. Reads: `zoho_list_organizations`, `zoho_list_contacts`,
`zoho_get_contact`, `zoho_list_invoices`, `zoho_get_invoice`, `zoho_list_items`,
`zoho_chart_of_accounts`. Writes (dry-run by default): `zoho_create_contact` (GSTIN as
`gst_no`, `gst_treatment`, state), `zoho_create_invoice` (`place_of_supply`, per-line
`tax_id` and `hsn_or_sac`), `zoho_create_item`, `zoho_create_customer_payment`.

**GST (4)**. `gst_validate_gstin` (mod-36 checksum, state, PAN, holder type);
`gst_einvoice_build` (schema v1.1 JSON: `IsServc`, place of supply, IGST vs CGST+SGST by
place of supply, SEZ/export with and without payment, rates including 40%, optional rupee
round-off); `gst_einvoice_generate` (dry-run only unless an IRP integration exists; it never
returns a fake IRN); `gst_reconcile_2b` (exact and fuzzy matching, value/tax mismatches,
missing either side, credit notes, cess, and ITC that 2B marks as not available).

There is no licensed IRP/GSP client in this package. Build the JSON with
`gst_einvoice_build` and upload it through the e-invoice portal or your GSP.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `TALLY_URL`, `TALLY_COMPANY`, `TALLY_TIMEOUT_MS` | Tally gateway, default company, timeout (ms) |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_DC`, `ZOHO_ORGANIZATION_ID` | Zoho Books credentials and defaults |
| `INDIA_STACK_AUDIT_LOG` | Path of the hash-chained audit log (recommended) |
| `INDIA_STACK_IDEMPOTENCY_FILE` | Where idempotency keys are kept; defaults to `<audit log>.idempotency.json` |
| `INDIA_STACK_DESTRUCTIVE` | `ask` (default: confirmation dialog), `allow`, or `deny` |
| `INDIA_STACK_ACTOR` | Name recorded in the audit log |
| `INDIA_STACK_IRP` | `mock` enables a test IRP that returns `MOCK-` IRNs (never use on real invoices) |

## Safety model

- Writes default to preview; committing requires `dry_run: false`.
- Vouchers are balance-checked client-side before any network call.
- Tally import responses are checked properly: `ERRORS` count, `LINEERROR`, and that
  something was actually created, altered or deleted.
- Every call appends a redacted, hash-chained audit record. Secrets, PAN, GSTIN, card and
  Aadhaar numbers are masked; company names and record IDs are kept.
- A write that times out is reported as "outcome unknown" so the agent checks before
  retrying.

See `docs/architecture.md` for the design.

## HTTP mode

```bash
npm run start -w @india-stack/demo-host   # POST http://127.0.0.1:8787/mcp/tally
```

Binds to `127.0.0.1` by default and checks the `Host` header. To expose it beyond this
machine set `HOST` and `INDIA_STACK_HTTP_TOKEN` (16+ characters); every request then needs
`Authorization: Bearer <token>`. Add extra host names with `INDIA_STACK_ALLOWED_HOSTS`.

## Development

```bash
npm run test        # unit, recorded TallyPrime 7.2 responses, and MCP protocol-level tests
TALLY_COMPANY="Test Co" LIVE_DATE=2026-04-02 node evals/live/tally-live.mjs   # end-to-end on a real TallyPrime (use an empty test company)
npm run lint && npm run typecheck && npm test
```

## License

Apache-2.0
