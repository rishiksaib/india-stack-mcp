#!/usr/bin/env node
// Live end-to-end test of the Tally MCP server against a real TallyPrime.
//
//   1. Open TallyPrime (Educational mode is fine) with "Client Server = Both" / port 9000,
//      and create an empty test company. Never run this against real books.
//   2. npm run build
//   3. TALLY_COMPANY="India Stack Test" LIVE_DATE=2026-04-02 node evals/live/tally-live.mjs
//
// LIVE_DATE must fall inside the company's books; Educational mode only accepts the 1st, 2nd
// and 31st of a month. Use a new date for each run. Creates six ledgers if missing, posts a
// Payment and a Purchase, deletes the Payment, and leaves the Purchase in place.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
import { rmSync, existsSync, readFileSync } from "node:fs";
const SDK = join(ROOT, "node_modules/@modelcontextprotocol/sdk/dist/esm");
const { Client } = await import(`file://${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`file://${SDK}/client/stdio.js`);
const { ElicitRequestSchema } = await import(`file://${SDK}/types.js`);

const AUDIT = join(ROOT, "evals/live/.live-audit.jsonl");
for (const f of [AUDIT, `${AUDIT}.idempotency.json`]) if (existsSync(f)) rmSync(f);

const transport = new StdioClientTransport({
  command: "node",
  args: [join(ROOT, "packages/connector-tally/bin/tally-mcp.js")],
  env: { PATH: process.env.PATH, TALLY_URL: process.env.TALLY_URL ?? "http://127.0.0.1:9000", TALLY_COMPANY: process.env.TALLY_COMPANY ?? "India Stack Test", TALLY_TIMEOUT_MS: "30000", INDIA_STACK_AUDIT_LOG: AUDIT, INDIA_STACK_QUIET: "1" },
  stderr: "pipe"
});
// A client that can show approval dialogs; it records each request and answers per `approveNext`.
let approveNext = true;
const dialogs = [];
const client = new Client({ name: "live-test", version: "1" }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  dialogs.push(req.params.message);
  return approveNext ? { action: "accept", content: { approve: true } } : { action: "decline" };
});
await client.connect(transport);

const results = [];
async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  return { isError: Boolean(res.isError), ...body };
}
function check(id, desc, pass, evidence) {
  results.push({ id, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${desc}${evidence !== undefined ? `\n        ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}` : ""}`);
}
const D = process.env.LIVE_DATE ?? "2026-04-02"; // Educational mode allows dates 1, 2 and 31 of a month

// 1. Reads on a fresh company
let r = await call("tally_list_companies", {});
check("L01", "list companies", r.data?.companies?.some((c) => c.name === (process.env.TALLY_COMPANY ?? "India Stack Test")), r.data?.companies);
r = await call("tally_list_voucher_types", {});
check("L02", "list voucher types (Payment, Purchase, Contra present)", ["Payment", "Purchase", "Contra", "Journal"].every((t) => r.data?.voucherTypes?.includes(t)), `${r.data?.count} types`);
r = await call("tally_search_ledgers", {});
check("L03", "default ledgers readable (Cash, Profit & Loss A/c)", ["Cash", "Profit & Loss A/c"].every((n) => r.data?.ledgers?.some((l) => l.name === n)), r.data?.ledgers?.map((l) => `${l.name} [${l.parent}]`));

// 2. Ledger creation: preview, then commit
const ledgers = [
  { name: "Rent", parent: "Indirect Expenses", opening_balance: 0 },
  { name: "HDFC Bank", parent: "Bank Accounts", opening_balance: 100000 },
  { name: "Owner Capital", parent: "Capital Account", opening_balance: -100000 },
  { name: "Global Suppliers", parent: "Sundry Creditors", opening_balance: 0 },
  { name: "Purchase Account", parent: "Purchase Accounts", opening_balance: 0 },
  { name: "Input IGST", parent: "Duties & Taxes", opening_balance: 0 }
];
r = await call("tally_create_ledger", ledgers[1]);
check("L04", "ledger create previews by default", r.data?.previewed === true && /<OPENINGBALANCE>-100000\.00<\/OPENINGBALANCE>/.test(r.data?.request), r.data?.request?.match(/<OPENINGBALANCE>[^<]*/)?.[0]);
for (const l of ledgers) {
  const exists = await call("tally_get_ledger", { name: l.name });
  if (!exists.isError) { check(`L05.${l.name}`, `ledger ${l.name} already exists from an earlier run`, exists.data?.parent === l.parent, exists.data); continue; }
  r = await call("tally_create_ledger", { ...l, dry_run: false });
  check(`L05.${l.name}`, `create ledger ${l.name} under ${l.parent}`, !r.isError && r.data?.created === true, r.isError ? r.error : r.data);
}
r = await call("tally_get_ledger", { name: "HDFC Bank" });
check("L06", "bank opening balance reads back as +100000 (debit)", r.data?.openingBalance === 100000 && r.data?.parent === "Bank Accounts", r.data);
r = await call("tally_get_ledger", { name: "Owner Capital" });
check("L07", "capital opening balance reads back as -100000 (credit)", r.data?.openingBalance === -100000, r.data);

// 3. Payment voucher: preview, commit, retry with the same key
const pay = { voucher_type: "Payment", date: D, narration: "Rent for April (india-stack live test)", lines: [{ ledger_name: "Rent", amount: 25000 }, { ledger_name: "HDFC Bank", amount: -25000 }] };
r = await call("tally_create_voucher", pay);
check("L08", "voucher preview shows Rent on the debit side", r.data?.summary?.debit?.[0]?.ledger === "Rent" && r.data?.summary?.credit?.[0]?.ledger === "HDFC Bank", r.data?.summary);
r = await call("tally_create_voucher", { ...pay, dry_run: false, idempotency_key: "live-rent-apr" });
const masterId = r.data?.master_id;
check("L09", "payment voucher posts and returns a master_id", !r.isError && r.data?.posted === true && Boolean(masterId), r.isError ? r.error : r.data);
r = await call("tally_create_voucher", { ...pay, dry_run: false, idempotency_key: "live-rent-apr" });
check("L10", "retry with the same idempotency_key does not post again", r.meta?.duplicate === true, r.meta);

// 4. Read it back
r = await call("tally_find_vouchers", { from_date: D, to_date: D, voucher_type: "Payment" });
const v = r.data?.vouchers?.[0];
check("L11", "find_vouchers returns exactly one payment", r.data?.count === 1, `count=${r.data?.count}`);
check("L12", "read-back lines: Rent +25000 (Dr), HDFC Bank -25000 (Cr)", v?.lines?.find((l) => l.ledgerName === "Rent")?.amount === 25000 && v?.lines?.find((l) => l.ledgerName === "HDFC Bank")?.amount === -25000, v?.lines);
check("L13", "read-back master_id matches the one create returned", v?.masterId === masterId, { created: masterId, read: v?.masterId, remoteId: v?.remoteId });
r = await call("tally_get_ledger", { name: "Rent" });
check("L14", "Rent closing balance is +25000 (debit)", r.data?.closingBalance === 25000, r.data);
r = await call("tally_get_ledger", { name: "HDFC Bank" });
check("L15", "HDFC Bank closing balance is +75000 (debit)", r.data?.closingBalance === 75000, r.data);
r = await call("tally_trial_balance", {});
check("L16", "trial balance difference is 0", r.data?.totals?.difference === 0, r.data?.totals);

// 5. Purchase with supplier bill number -> purchase register
const pur = { voucher_type: "Purchase", date: D, party_ledger: "Global Suppliers", reference: "GS/2026/114", narration: "live test purchase",
  lines: [{ ledger_name: "Purchase Account", amount: 10000 }, { ledger_name: "Input IGST", amount: 1800 }, { ledger_name: "Global Suppliers", amount: -11800 }] };
r = await call("tally_create_voucher", { ...pur, dry_run: false, idempotency_key: "live-purchase-1" });
check("L17", "purchase voucher with party and reference posts", !r.isError && r.data?.posted === true, r.isError ? r.error : r.data);
r = await call("tally_purchase_register", { from_date: D, to_date: D });
const row = r.data?.purchases?.[0];
check("L18", "purchase register: bill no, taxable 10000, IGST 1800", row?.invoice_number === "GS/2026/114" && row?.taxable_value === 10000 && row?.igst === 1800, row ?? r.error);

// 6. Delete: declined, then approved
approveNext = false;
r = await call("tally_delete_voucher", { master_id: masterId, voucher_type: "Payment", date: D, dry_run: false });
check("L19", "delete stops when the user declines the dialog", r.isError && r.error?.code === "approval_required" && dialogs.length === 1, r.error);
approveNext = true;
r = await call("tally_delete_voucher", { master_id: masterId, voucher_type: "Payment", date: D, dry_run: false });
check("L20", "delete by master_id succeeds after approval", !r.isError && r.data?.deleted === true, r.isError ? r.error : r.data);
r = await call("tally_find_vouchers", { from_date: D, to_date: D, voucher_type: "Payment" });
check("L21", "the payment is gone from the day book", r.data?.count === 0, `count=${r.data?.count}`);
r = await call("tally_get_ledger", { name: "HDFC Bank" });
check("L22", "HDFC Bank balance is back to +100000", r.data?.closingBalance === 100000, r.data);
r = await call("tally_find_vouchers", { from_date: D, to_date: D, voucher_type: "Purchase" });
check("L23", "the purchase voucher is untouched", r.data?.count === 1, `count=${r.data?.count}`);

// 7. Errors from real Tally
r = await call("tally_create_voucher", { voucher_type: "Journal", date: D, dry_run: false, lines: [{ ledger_name: "No Such Ledger", amount: 1 }, { ledger_name: "Rent", amount: -1 }] });
check("L24", "unknown ledger -> upstream_rejected with Tally's own message", r.isError && r.error?.code === "upstream_rejected", r.error);
const audit = readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
check("L25", "audit log has one record per call and keeps the company name", audit.length >= 25 && !audit.some((a) => a.input?.company === "[redacted]"), `${audit.length} records`);

await client.close();
const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} live checks passed`);
process.exit(failed === 0 ? 0 : 1);
