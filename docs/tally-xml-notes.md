# Tally XML Gateway Notes

Field notes for integrating with TallyPrime's local HTTP/XML interface. Keep this
document updated as we test against more TallyPrime versions.

## Endpoint

- Default: `POST http://localhost:9000` (TallyPrime → F1 Help → Settings → connectivity).
- Content-Type: `text/xml;charset=utf-8`.
- If Tally serves an HTML login page instead of XML, the gateway is in secure mode:
  enable "Serve data over HTTP/XML" / configure gateway credentials. The connector maps
  this to `auth_error` with a hint.
- Connection refused usually means Tally isn't running or the port differs — the connector
  maps this to `upstream_unreachable` and includes the base URL.

## Request families

1. **Import Data** (writes): `<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>`
   with `REPORTNAME` = `Vouchers` (voucher create/delete) or `All Masters` (ledger create).
2. **Export Collection** (structured reads): `<TYPE>Collection</TYPE><ID>{name}</ID>` plus a
   TDL block declaring `<COLLECTION NAME="{id}" ISMODIFY="No"><TYPE>Ledger</TYPE>
   <FETCH>NAME,PARENT,...</FETCH></COLLECTION>`. Response repeats an element named after
   `{id}`; casing varies between versions, so matching is case-insensitive.
3. **Export Data** (report pages): `<TYPE>Data</TYPE><ID>Day Book</ID>` with
   `SVFROMDATE`/`SVTODATE`. Dates are compact `YYYYMMDD`.

## Vouchers

- Create: `<VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">`
  with `<ALLLEDGERENTRIES.LIST>` children. Debit = positive `AMOUNT`,
  `ISDEEMEDPOSITIVE=No`; credit = negative amount, `Yes`.
- Delete: prefer `REMOTEID`; falling back to number+type+date works but is version-sensitive.
- Import responses report `<CREATED>/<ALTERED>/<DELETED>/<VCHDEL>/<EXCEPTIONS>` and one or
  more `<LINEERROR>` elements on rejection. Treat any LINEERROR as failure.

## Version quirks

| Area | Notes |
| --- | --- |
| Collection response casing | Some versions echo the collection id uppercase; match case-insensitively. |
| Balance formats | May be `-11800.00`, `25,000.00 Dr`, or `25000 Cr`; parser handles all three. |
| Empty responses | Occur when security blocks a request; treated as `upstream_rejected`. |
| ODBC | Alternative read path (`Tally ODBC` 32-bit driver); not used — XML covers reads+writes uniformly. |

## Testing without Tally

All request builders are pure functions; unit tests assert exact XML against golden
fixtures under `test/fixtures/`. Integration tests spin a stub HTTP server; live tests run
with `TALLY_LIVE=1` against a real TallyPrime on localhost.
