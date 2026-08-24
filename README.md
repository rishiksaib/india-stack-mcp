# india-stack-mcp

Production-grade MCP servers for Indian enterprise systems. Agents that can do books and
file taxes in India — starting with **TallyPrime**, the accounting system behind millions
of Indian SMEs.

## Why

Frontier agents can reason about GST, but they cannot touch Tally. There is no modern API,
no OAuth, no SDK — just a local XML gateway that punishes the unprepared. This project is
the missing connector layer: typed tools, dry-run-first writes, idempotency, human approval
hooks, and a tamper-evident audit trail, packaged as standard MCP servers that work in
Claude Desktop, Claude Code, Cursor, Codex, or any MCP client.

## Status

| Connector | Scope | State |
| --- | --- | --- |
| `tally-mcp` | Companies, ledgers, vouchers (7 types), day book, trial balance | **alpha** |
| `zoho-mcp` | Organizations, contacts, invoices, items, payments, chart of accounts | **alpha** |
| `gst-mcp` | GSTIN validation, e-invoice (IRN) payloads + NIC-style encryption, GSTR-2B reconciliation | **alpha** |

## Quick start

```bash
npm install
npm run build
```

Point Claude Desktop / Cursor at the built server (see
`examples/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tally": {
      "command": "node",
      "args": ["<abs-path>/packages/connector-tally/bin/tally-mcp.js"],
      "env": {
        "TALLY_URL": "http://localhost:9000",
        "TALLY_COMPANY": "Your Company Pvt Ltd"
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
        "ZOHO_ORGANIZATION_ID": "..."
      }
    }
  }
}
```

Requirements on the Tally side: TallyPrime running locally with XML serving enabled on
port 9000 (F1 → Settings → Connectivity). See `docs/tally-xml-notes.md`.

Zoho Books needs a self-client OAuth refresh token with Books scopes
(`ZohoBooks.fullaccess.all` or narrower), created at the Zoho API Console. Credentials can
also live in a file-based vault instead of env vars (`CredentialVault` in core).

## Tools (27)

**Tally (12)** — Reads: `tally_list_companies`, `tally_get_company`, `tally_search_ledgers`,
`tally_get_ledger`, `tally_day_book`, `tally_trial_balance`, `tally_ledger_balances`,
`tally_list_voucher_types`, `tally_find_vouchers`. Writes: `tally_create_ledger`,
`tally_create_voucher` (7 voucher types), `tally_delete_voucher`.

**Zoho Books (11)** — Reads: `zoho_list_organizations`, `zoho_list_contacts`,
`zoho_get_contact`, `zoho_list_invoices`, `zoho_get_invoice`, `zoho_list_items`,
`zoho_chart_of_accounts`. Writes (dry-run by default): `zoho_create_contact`,
`zoho_create_invoice`, `zoho_create_item`, `zoho_create_customer_payment`.

**GST ops (4)** — `gst_validate_gstin` (mod-36 checksum, state, PAN/entity type),
`gst_einvoice_build` (canonical v1.01 payload with tax splits + round-off),
`gst_einvoice_generate` (IRN via pluggable IRP client; NIC-style encrypted envelopes:
RSA-wrapped SEK + AES-256-CBC + HMAC-SHA256), `gst_reconcile_2b`
(matched/mismatch/missing classification across your purchase register vs GSTR-2B,
with ITC-at-risk quantification).

Every write returns the exact upstream request body as a preview until you pass
`dry_run: false`. Retries with the same `idempotency_key` never double-post.

## Safety model

- Writes default to preview; committing requires explicit opt-in.
- Vouchers are balance-checked client-side before any network call.
- Every invocation appends a redacted, hash-chained audit record (`INDIA_STACK_AUDIT_LOG`).
- Destructive tools can require human approval via a pluggable `Approver`.

See `docs/architecture.md` for the full design.

## HTTP mode

```bash
npm run start -w @india-stack/demo-host   # POST http://localhost:8787/mcp/tally
```

## Development

```bash
npm run test        # unit + golden-file tests (no Tally needed)
TALLY_LIVE=1 npm run test:live   # hits a real local TallyPrime
npm run lint && npm run typecheck && npm test
```

## License

Apache-2.0
