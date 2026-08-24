export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function compactDate(isoDate: string): string {
  const digits = isoDate.replaceAll("-", "").replaceAll("/", "");
  if (!/^\d{8}$/.test(digits)) {
    throw new Error(`date must be YYYY-MM-DD or YYYYMMDD, got "${isoDate}"`);
  }
  return digits;
}

export function importEnvelope(reportName: string, requestDataXml: string, company?: string): string {
  const staticVars = company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : "";
  return [
    "<ENVELOPE>",
    "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>",
    "<BODY><IMPORTDATA>",
    `<REQUESTDESC><REPORTNAME>${xmlEscape(reportName)}</REPORTNAME>${staticVars}</REQUESTDESC>`,
    `<REQUESTDATA>${requestDataXml}</REQUESTDATA>`,
    "</IMPORTDATA></BODY>",
    "</ENVELOPE>"
  ].join("");
}

export interface CollectionSpec {
  id: string;
  type: string;
  fetchFields: string[];
  company?: string;
}

export function collectionEnvelope(spec: CollectionSpec): string {
  const staticVars = [
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
    spec.company ? `<SVCURRENTCOMPANY>${xmlEscape(spec.company)}</SVCURRENTCOMPANY>` : ""
  ].join("");
  return [
    "<ENVELOPE>",
    "<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>",
    `<ID>${xmlEscape(spec.id)}</ID></HEADER>`,
    "<BODY><DESC>",
    `<STATICVARIABLES>${staticVars}</STATICVARIABLES>`,
    "<TDL><TDLMESSAGE>",
    `<COLLECTION NAME="${xmlEscape(spec.id)}" ISMODIFY="No">`,
    `<TYPE>${xmlEscape(spec.type)}</TYPE>`,
    `<FETCH>${spec.fetchFields.map(xmlEscape).join(",")}</FETCH>`,
    "</COLLECTION>",
    "</TDLMESSAGE></TDL>",
    "</DESC></BODY>",
    "</ENVELOPE>"
  ].join("");
}

export interface ReportSpec {
  reportName: string;
  fromDate?: string;
  toDate?: string;
  company?: string;
}

export function reportEnvelope(spec: ReportSpec): string {
  const vars = [
    spec.fromDate ? `<SVFROMDATE>${compactDate(spec.fromDate)}</SVFROMDATE>` : "",
    spec.toDate ? `<SVTODATE>${compactDate(spec.toDate)}</SVTODATE>` : "",
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
    spec.company ? `<SVCURRENTCOMPANY>${xmlEscape(spec.company)}</SVCURRENTCOMPANY>` : ""
  ].join("");
  return [
    "<ENVELOPE>",
    "<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>",
    `<ID>${xmlEscape(spec.reportName)}</ID></HEADER>`,
    "<BODY><DESC>",
    `<STATICVARIABLES>${vars}</STATICVARIABLES>`,
    "</DESC></BODY>",
    "</ENVELOPE>"
  ].join("");
}
