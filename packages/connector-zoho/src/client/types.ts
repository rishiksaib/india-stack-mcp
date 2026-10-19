import type { CredentialVault } from "@india-stack/core";

export type ZohoDc = "in" | "com" | "eu" | "au" | "jp";

export interface ZohoCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  dc: ZohoDc;
}

export interface ZohoClientConfig {
  credentials?: ZohoCredentials;
  organizationId?: string;
  timeoutMs?: number;
  apiBaseOverride?: string;
  accountsBaseOverride?: string;
  vault?: CredentialVault;
  vaultRef?: string;
}

const DC_ENDPOINTS: Record<ZohoDc, { api: string; accounts: string }> = {
  in: { api: "https://www.zohoapis.in", accounts: "https://accounts.zoho.in" },
  com: { api: "https://www.zohoapis.com", accounts: "https://accounts.zoho.com" },
  eu: { api: "https://www.zohoapis.eu", accounts: "https://accounts.zoho.eu" },
  au: { api: "https://www.zohoapis.com.au", accounts: "https://accounts.zoho.com.au" },
  jp: { api: "https://www.zohoapis.jp", accounts: "https://accounts.zoho.jp" }
};

export function endpointsForDc(dc: ZohoDc): { api: string; accounts: string } {
  return DC_ENDPOINTS[dc] ?? DC_ENDPOINTS.com;
}

export interface ZohoOrganization {
  organizationId: string;
  name: string;
  currencyCode?: string;
  countryCode?: string;
  isActive?: boolean;
}

export type ContactType = "customer" | "vendor";

/** Zoho Books (India) GST treatment values. */
export type GstTreatment = "business_gst" | "business_none" | "overseas" | "consumer";
export const GST_TREATMENTS: GstTreatment[] = ["business_gst", "business_none", "overseas", "consumer"];

export interface ZohoContact {
  contactId?: string;
  contactName: string;
  contactType?: ContactType;
  email?: string;
  phone?: string;
  gstin?: string;
  gstTreatment?: GstTreatment;
  placeOfContact?: string;
  outstandingReceivableAmount?: number;
  outstandingPayableAmount?: number;
}

export interface CreateContactInput {
  name: string;
  type?: ContactType;
  email?: string;
  phone?: string;
  /** Sent to Zoho as gst_no. */
  gstin?: string;
  /** Defaults to business_gst when a GSTIN is given. */
  gstTreatment?: GstTreatment;
  /** 2-letter state code, e.g. "MH". */
  placeOfContact?: string;
}

export interface InvoiceLineInput {
  itemId?: string;
  name?: string;
  description?: string;
  rate: number;
  quantity: number;
  /** Zoho tax_id of the GST rate/group to apply (from the org's taxes). */
  taxId?: string;
  hsnOrSac?: string;
}

export interface CreateInvoiceInput {
  customerId: string;
  invoiceNumber?: string;
  referenceNumber?: string;
  date?: string;
  dueDate?: string;
  notes?: string;
  /** India: 2-letter state code of the place of supply (e.g. "MH", "TS"). */
  placeOfSupply?: string;
  gstTreatment?: GstTreatment;
  gstNo?: string;
  lineItems: InvoiceLineInput[];
}

export interface InvoiceLine {
  lineItemId?: string;
  itemId?: string;
  name?: string;
  description?: string;
  rate?: number;
  quantity?: number;
  itemTotal?: number;
  taxPercentage?: number;
  taxId?: string;
  taxName?: string;
  hsnOrSac?: string;
}

export interface ZohoInvoice {
  invoiceId?: string;
  invoiceNumber?: string;
  status?: string;
  date?: string;
  dueDate?: string;
  customerId?: string;
  customerName?: string;
  total?: number;
  balance?: number;
  referenceNumber?: string;
  placeOfSupply?: string;
  gstTreatment?: string;
  gstNo?: string;
  lineItems?: InvoiceLine[];
}

export interface ZohoItem {
  itemId?: string;
  name: string;
  rate?: number;
  sku?: string;
  description?: string;
  productType?: string;
}

export interface CreatePaymentInput {
  customerId: string;
  amount: number;
  date: string;
  paymentMode?: string;
  invoiceId?: string;
  referenceNumber?: string;
  description?: string;
}

export interface ZohoAccount {
  account_id?: string;
  accountId?: string;
  name?: string;
  accountName?: string;
  accountType?: string;
  balance?: number;
}
