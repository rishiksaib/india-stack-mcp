import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectorError, ErrorCode } from "@india-stack/core";
import { TallyClient } from "../src/client/tallyClient.js";

let server: Server;
let baseUrl = "";
let lastBody = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      lastBody = data;
      if (data.includes("IndiaStackCompanies")) {
        res.setHeader("Content-Type", "text/xml");
        res.end(`<ENVELOPE><INDIASTACKCOMPANIES><NAME>Acme Traders</NAME></INDIASTACKCOMPANIES></ENVELOPE>`);
      } else if (data.includes("<LINEERROR")) {
        res.end("");
      } else if (data.includes('LEDGER NAME="Sunrise Stores"')) {
        res.end(
          `<ENVELOPE><IMPORTDATA><CREATED>0</CREATED><EXCEPTIONS>1</EXCEPTIONS><LINEERROR>Ledger "Sunrise Stores" does not exist.</LINEERROR></IMPORTDATA></ENVELOPE>`
        );
      } else if (data.includes('NAME="HTMLTEST"')) {
        res.end("<html><body>Tally login</body></html>");
      } else if (data.includes('VCHTYPE="Sales"')) {
        res.end(`<ENVELOPE><IMPORTDATA><CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><VCHDEL>0</VCHDEL><EXCEPTIONS>0</EXCEPTIONS></IMPORTDATA></ENVELOPE>`);
      } else {
        res.end(`<ENVELOPE><IMPORTDATA><CREATED>0</CREATED><EXCEPTIONS>0</EXCEPTIONS></IMPORTDATA></ENVELOPE>`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("TallyClient against a stub gateway", () => {
  it("lists companies", async () => {
    const client = new TallyClient({ baseUrl });
    const companies = await client.listCompanies();
    expect(companies).toEqual([{ name: "Acme Traders", guid: undefined, startingFrom: undefined }]);
  });

  it("dry-run returns the exact request without POSTing a write", async () => {
    const client = new TallyClient({ baseUrl });
    const result = await client.createVoucher(
      {
        kind: "Sales",
        date: "2024-04-05",
        partyLedger: "Sunrise Stores",
        lines: [
          { ledgerName: "Sunrise Stores", amount: -11800 },
          { ledgerName: "Sales Account", amount: 11800 }
        ]
      },
      { dryRun: true }
    );
    expect(result).toHaveProperty("preview");
    expect(lastBody).not.toContain("VCHTYPE");
  });

  it("rejects unbalanced vouchers before any network call", async () => {
    const client = new TallyClient({ baseUrl });
    await expect(
      client.createVoucher(
        {
          kind: "Journal",
          date: "2024-04-05",
          lines: [
            { ledgerName: "A", amount: -100 },
            { ledgerName: "B", amount: 90 }
          ]
        },
        { dryRun: false }
      )
    ).rejects.toMatchObject({ code: ErrorCode.ValidationError });
  });

  it("surfaces line errors as UpstreamRejected with detail", async () => {
    const client = new TallyClient({ baseUrl });
    const err = await client
      .createLedger({ name: "Sunrise Stores", parent: "Sundry Debtors" }, { dryRun: false })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe(ErrorCode.UpstreamRejected);
    expect(JSON.stringify((err as ConnectorError).detail)).toContain("does not exist");
  });

  it("maps HTML responses to AuthError with an actionable hint", async () => {
    const client = new TallyClient({ baseUrl });
    const err = await client.createLedger({ name: "HTMLTEST", parent: "G" }, { dryRun: false }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe(ErrorCode.AuthError);
  });

  it("posts company-scoped voucher XML on execute", async () => {
    const client = new TallyClient({ baseUrl });
    const result = await client.createVoucher(
      {
        kind: "Sales",
        date: "2024-04-05",
        lines: [
          { ledgerName: "Party", amount: -100 },
          { ledgerName: "Sales", amount: 100 }
        ]
      },
      { dryRun: false, company: "Acme Traders" }
    );
    expect(result).toMatchObject({ created: 1, exceptions: 0 });
    expect(lastBody).toContain('<VOUCHER VCHTYPE="Sales" ACTION="Create"');
    expect(lastBody).toContain("<SVCURRENTCOMPANY>Acme Traders</SVCURRENTCOMPANY>");
  });
});

const LIVE = Boolean(process.env.TALLY_LIVE);
describe.skipIf(!LIVE)("live TallyPrime (set TALLY_LIVE=1)", () => {
  it("reaches the local gateway and lists companies", async () => {
    const client = new TallyClient({});
    const companies = await client.listCompanies();
    console.log("companies:", companies.map((c) => c.name));
    expect(Array.isArray(companies)).toBe(true);
  });
});
