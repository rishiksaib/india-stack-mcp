# Live TallyPrime 7.2 responses

Captured on 2026-10-21 from TallyPrime 7.2 (Educational mode) with XML server on port 9000,
company "India Stack Test", while the connector created ledgers, posted a Payment, a
Purchase and a Journal, read them back and deleted them by Master ID.

| File | Request |
| --- | --- |
| `companies.xml` | Collection of `Company` |
| `ledgers.xml` | Collection of `Ledger` (NAME, PARENT, OPENINGBALANCE, CLOSINGBALANCE, ...) |
| `vouchers.xml` | Collection of `Voucher`, 1 Apr to 31 May 2026 |
| `voucher-types.xml` | Collection of `VoucherType` |
| `import-voucher-created.xml` | Import of a Journal voucher (success) |
| `import-voucher-lineerror.xml` | Import of a voucher using a ledger that does not exist |
| `import-voucher-deleted.xml` | Delete by `TAGNAME="MASTER ID"` |
| `import-ledger-created.xml` | Import of a ledger master |

Notes from the live run:

- The `Day Book` report export (`<TYPE>Data</TYPE><ID>Day Book</ID>`) returned an empty
  `<DATA>`; a `Voucher` collection returns the vouchers.
- Every collection response starts with a `CMPINFO` block of object counts
  (`<VOUCHER>4</VOUCHER>`, `<LEDGER>17</LEDGER>`); these are not records.
- A rejected import reports `ERRORS 0` but `EXCEPTIONS 1` plus `LINEERROR`.
- `Profit & Loss A/c`'s parent is `\u0004 Primary`, and its closing balance includes the
  current period's result.
- Educational mode accepts vouchers dated only on the 1st, 2nd and 31st of a month.
