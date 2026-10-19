# Architecture

India Stack MCP is a monorepo of MCP servers for Indian enterprise systems: TallyPrime,
Zoho Books and GST.

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
   dry-run enforcement · idempotency · human approval · hash-chained audit log
        │
        ▼
Tally XML gateway client (HTTP POST localhost:9000)
   envelope builders · parsers · error taxonomy
```

## Design rules

1. **Writes default to dry-run.** Every write tool takes `dry_run` (default `true`)
   and returns the exact upstream request body for preview. Agents must opt in to commit.
2. **Idempotent writes.** A committed write with an `idempotency_key` is remembered (on disk,
   next to the audit log, for 7 days). Retrying with the same key returns the first result;
   reusing a key for different data is rejected. Writes without a key are never
   deduplicated, because two identical-looking entries (two ₹500 cash sales) can both be real.
3. **Human approval for destructive actions.** Destructive tools (voucher delete) ask the
   user through the MCP client's confirmation dialog (elicitation). Clients that cannot show
   one are refused unless `INDIA_STACK_DESTRUCTIVE=allow`; `deny` disables them entirely.
4. **Audit everything.** Each invocation appends one JSONL record with a SHA-256 chain
   (`prevHash → hash`). Tampering is detectable via `verify()`. Inputs are redacted
   (PAN/GSTIN/card/Aadhaar patterns, sensitive key names matched as whole words) before
   logging.
5. **Typed error taxonomy.** Upstream failures map to stable codes
   (`upstream_unreachable`, `upstream_rejected`, `auth_error`, ...) with actionable hints,
   so agents can self-correct instead of hallucinating.
6. **Client-side validation first.** Balance checks and schema validation run before any
   network call; upstream line-errors surface verbatim in `error.detail`. A write that times
   out is reported as "outcome unknown" so the agent checks before retrying.

## Sign conventions

Every tool uses positive = debit, negative = credit. Tally's XML uses the opposite sign
(debit = `ISDEEMEDPOSITIVE=Yes` with a negative `AMOUNT`); the Tally client converts at the
boundary. See `tally-xml-notes.md`. Vouchers must sum to zero and contain at least one debit
and one credit; the connector enforces this before sending anything to Tally.

## Adding a connector

1. Create `packages/connector-<name>` with `client/`, `tools/`, `server.ts`.
2. Implement a `<Name>Client` with pure request builders (testable offline).
3. Define tools with `defineTool` from core; scope reads vs writes.
4. Export a `create<Name>Server()` (wire `useElicitationApprover`) and a stdio `main()`.
5. Add protocol-level tests in `evals/test/mcp.test.ts` that call the tools through an MCP
   client, so argument parsing and naming are tested the way agents hit them.
