# Architecture

India Stack MCP is a monorepo of production-grade MCP servers for Indian enterprise
systems. Milestone 1 ships the TallyPrime connector; Zoho Books and GST follow.

## Layers

```
MCP client (Claude, Cursor, agent)
        │  stdio or streamable-HTTP
        ▼
connector server (packages/connector-tally)
   intent-shaped tools: tally_create_voucher, tally_trial_balance, ...
        │
        ▼
@india-stack/core (defineTool wrapper)
   dry-run enforcement · idempotency · approval hooks · hash-chained audit log
        │
        ▼
Tally XML gateway client (HTTP POST localhost:9000)
   envelope builders · parsers · error taxonomy
```

## Design rules

1. **Writes default to dry-run.** Every write tool takes `dry_run` (default `true`)
   and returns the exact upstream request body for preview. Agents must opt in to commit.
2. **Idempotent writes.** Committed writes are keyed (explicit `idempotency_key` or a
   SHA of tool+args); retries return the cached outcome instead of double-posting.
3. **Audit everything.** Each invocation appends one JSONL record with a SHA-256 chain
   (`prevHash → hash`). Tampering is detectable via `verify()`. Inputs are redacted
   (PAN/GSTIN/card patterns, sensitive keys) before logging.
4. **Typed error taxonomy.** Upstream failures map to stable codes
   (`upstream_unreachable`, `upstream_rejected`, `auth_error`, ...) with actionable hints,
   so agents can self-correct instead of hallucinating.
5. **Client-side validation first.** Balance checks and schema validation run before any
   network call; upstream line-errors surface verbatim in `error.detail`.

## Sign conventions

Every amount the tools accept or return uses the accounting convention: positive = debit,
negative = credit. Tally's XML uses the reverse — a debit line is `ISDEEMEDPOSITIVE=Yes`
with a negative `AMOUNT`, a credit line `ISDEEMEDPOSITIVE=No` with a positive one — so
the client negates amounts when writing XML and when reading bare numbers back
(`parseBalance`; "Dr"/"Cr" text is already unambiguous). Vouchers must sum to zero; the connector enforces this before
sending anything to Tally.

## Adding a connector

1. Create `packages/connector-<name>` with `client/`, `tools/`, `server.ts`.
2. Implement a `<Name>Client` with pure request builders (testable offline).
3. Define tools with `defineTool` from core; scope reads vs writes.
4. Export a `create<Name>Server()` and a stdio `main()`.
