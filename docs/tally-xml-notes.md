# Tally XML Gateway Notes

Field notes for TallyPrime's local HTTP/XML interface, with the source for each rule.
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
3. **Export Data** (report pages): `<TYPE>Data</TYPE><ID>Day Book</ID>` with
   `SVFROMDATE`/`SVTODATE` (compact `YYYYMMDD`). The parser collects `VOUCHER` elements at any
   depth and reads both `ALLLEDGERENTRIES.LIST` and `LEDGERENTRIES.LIST` (invoice mode).
   The exact Day Book export envelope is not documented; verify on a live install.

## Import responses

- Counters appear under a `RESPONSE` root (masters) or under
  `ENVELOPE > BODY > DATA > IMPORTRESULT` (vouchers): `CREATED`, `ALTERED`, `DELETED`,
  `LASTVCHID`, `LASTMID`, `COMBINED`, `IGNORED`, `ERRORS`, `CANCELLED`.
- **`ERRORS` is a count.** `<ERRORS>0</ERRORS>` is success. Failure = `ERRORS > 0`,
  `EXCEPTIONS > 0`, any `<LINEERROR>`, or nothing created/altered/deleted.
- `LASTVCHID` is the Master ID of the voucher just created; the connector returns it as
  `master_id`.

## Addressing an existing voucher

Tally's alteration sample addresses a voucher by Master ID:
`<VOUCHER DATE="07-Apr-2024" TAGNAME="MASTER ID" TAGVALUE="119" VCHTYPE="Payment" ACTION="Alter">`
(`DATE` attribute in `dd-Mon-yyyy`). Deletion uses the same addressing with
`ACTION="Delete"`; `REMOTEID` and `TAGNAME="Voucher Number"` are also supported. The delete
form itself is not in Tally's published samples: run it once against a test company first.

## Version quirks

| Area | Notes |
| --- | --- |
| Element casing | Matching is case-insensitive. |
| Balance formats | `-11800.00` (Dr), `25,000.00 Dr`, `25000 Cr`; all map to positive = debit. |
| Empty responses | Security settings or an unloaded company; treated as `upstream_rejected`. |
| ODBC | Alternative read path (`Tally ODBC`); not used. XML covers reads and writes. |

## Testing without Tally

Request builders are pure functions with golden-XML tests. `test/fixtures/official-*.xml`
follow the documented response shapes above; the older flat fixtures are kept to make sure
both shapes parse. Live tests run with `TALLY_LIVE=1` against a real TallyPrime.
