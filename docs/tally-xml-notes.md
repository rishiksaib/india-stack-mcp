# Tally XML Gateway Notes

Field notes for TallyPrime's local HTTP/XML interface, with the source for each rule.

**Verified live on TallyPrime 7.2** (Educational mode, 2026-10-21): every rule below was
exercised by `evals/live/tally-live.mjs`, and the captured responses are in
`packages/connector-tally/test/fixtures/live-tallyprime-7.2/`.
Sources: Tally developer reference, "Case Study I – XML Request and Response Formats",
"Case Study II – Creation and Alteration of Vouchers", and "Understanding Integration –
Transactions" (help.tallysolutions.com).

## Endpoint

- Default: `POST http://localhost:9000` (TallyPrime → F1 Help → Settings → Connectivity).
- Content-Type: `text/xml;charset=utf-8`.
- An HTML login page instead of XML means the gateway is in secure mode; the connector maps
  this to `auth_error` with a hint.
- Connection refused usually means Tally isn't running or the port differs
  (`upstream_unreachable`, with the base URL).

## Sign convention (the most important rule)

Tally writes **debits as negative amounts** and credits as positive, in vouchers and in
master balances:

| | `ISDEEMEDPOSITIVE` | `AMOUNT` |
| --- | --- | --- |
| Debit (e.g. Rent paid, customer in a sale) | `Yes` | negative, e.g. `-25000.00` |
| Credit (e.g. Bank in a payment, Sales) | `No` | positive, e.g. `25000.00` |

Tally's own samples: a Payment voucher with Conveyance `Yes / -12000.00` and the bank
`No / 12000.00`; a Sales voucher with the party `Yes / -215476.00` and Sales `No`; ledger
masters for a bank and a debtor created with negative opening balances.

**The connector's public contract is the accountant's convention: positive = debit,
negative = credit.** It converts at the XML boundary (`importData.ts` on the way in,
`parseBalance` on the way out), so every tool input and output uses positive = debit.

## Request families

1. **Import Data** (writes): `<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>`
   with `REPORTNAME` = `Vouchers` (voucher create/delete) or `All Masters` (ledger create).
2. **Export Collection** (structured reads): `<TYPE>Collection</TYPE><ID>{name}</ID>` plus a
   TDL block declaring the collection. The response nests objects as
   `ENVELOPE > BODY > DATA > COLLECTION > <LEDGER NAME="...">`: the name is an **attribute**
   and values are typed children (`<OPENINGBALANCE TYPE="Amount">`). The parser reads
   attributes and searches for the object tag at any depth.
3. **Vouchers** are read as a `Voucher` collection with `SVFROMDATE`/`SVTODATE` (compact
   `YYYYMMDD`), fetching `MASTERID`, `REFERENCE`, `PARTYLEDGERNAME` and the ledger-entry lists.
   On TallyPrime 7.2 the `Day Book` report export (`<TYPE>Data</TYPE><ID>Day Book</ID>`)
   returns an empty `<DATA>`, so it is not used. The connector also filters by date itself and
   drops deleted or cancelled vouchers.
4. **CMPINFO.** Every collection response starts with a `CMPINFO` block of object counts
   (`<VOUCHER>4</VOUCHER>`, `<LEDGER>17</LEDGER>`). The parser skips it; treating those as
   records produced empty vouchers.

## Import responses

- TallyPrime 7.2 returns a bare `RESPONSE` root for both masters and vouchers. The developer
  reference also shows `ENVELOPE > BODY > DATA > IMPORTRESULT`; both are handled. Counters: `CREATED`, `ALTERED`, `DELETED`,
  `LASTVCHID`, `LASTMID`, `COMBINED`, `IGNORED`, `ERRORS`, `CANCELLED`.
- **`ERRORS` is a count.** `<ERRORS>0</ERRORS>` is success. Failure = `ERRORS > 0`,
  `EXCEPTIONS > 0`, any `<LINEERROR>`, or nothing created/altered/deleted. A voucher naming a
  ledger that doesn't exist comes back with `ERRORS 0`, `EXCEPTIONS 1` and
  `<LINEERROR>Ledger 'X' does not exist!</LINEERROR>`, so `ERRORS` alone is not enough.
- `LASTVCHID` is the Master ID of the voucher just created; the connector returns it as
  `master_id`.

## Addressing an existing voucher

Tally's alteration sample addresses a voucher by Master ID:
`<VOUCHER DATE="07-Apr-2024" TAGNAME="MASTER ID" TAGVALUE="119" VCHTYPE="Payment" ACTION="Alter">`
(`DATE` attribute in `dd-Mon-yyyy`). Deletion uses the same addressing with
`ACTION="Delete"`. Verified live: the response reports `<DELETED>1</DELETED>` and the
voucher disappears from the Day Book. `REMOTEID` and `TAGNAME="Voucher Number"` are also
supported but were not exercised live.

## Version quirks

| Area | Notes |
| --- | --- |
| Element casing | Matching is case-insensitive. |
| Balance formats | `-11800.00` (Dr), `25,000.00 Dr`, `25000 Cr`; all map to positive = debit. |
| Empty responses | Security settings or an unloaded company; treated as `upstream_rejected`. |
| Profit & Loss A/c | Parent is `\u0004 Primary` (control character stripped). Its closing balance includes the current period's result, so the trial balance uses its opening balance, as Tally's own trial balance does. |
| Educational mode | Vouchers are accepted only on the 1st, 2nd and 31st of a month. |
| ODBC | Alternative read path (`Tally ODBC`); not used. XML covers reads and writes. |

## Testing without Tally

Request builders are pure functions with golden-XML tests. `test/fixtures/official-*.xml`
follow the documented response shapes above; the older flat fixtures are kept to make sure
both shapes parse. Live tests run with `TALLY_LIVE=1` against a real TallyPrime.
