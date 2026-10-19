import { ConnectorError, ErrorCode } from "@india-stack/core";
import { TokenManager } from "./auth.js";
import {
  type CreateContactInput,
  type CreateInvoiceInput,
  type CreatePaymentInput,
  type ZohoAccount,
  type ZohoClientConfig,
  type ZohoContact,
  type ZohoInvoice,
  type ZohoItem,
  type ZohoOrganization
} from "./types.js";

interface ListResult<T> {
  records: T[];
  hasMore: boolean;
  page: number;
}

export class ZohoClient {
  private readonly config: ZohoClientConfig;
  private readonly tokens: TokenManager;
  private readonly organizationId?: string;
  private readonly timeoutMs: number;

  constructor(config: ZohoClientConfig = {}) {
    this.config = config;
    this.tokens = new TokenManager(config);
    this.organizationId = config.organizationId ?? process.env.ZOHO_ORGANIZATION_ID;
    this.timeoutMs = config.timeoutMs ?? 20000;
  }

  resolveOrganizationId(organizationId?: string): string | undefined {
    return organizationId ?? this.organizationId;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    opts: { organizationId?: string; query?: Record<string, string | number | undefined>; body?: unknown }
  ): Promise<{ data: T; raw: Record<string, unknown> }> {
    try {
      return await this.requestOnce<T>(method, path, opts);
    } catch (err) {
      // An access token can expire or be revoked between our expiry check and the call.
      // requestOnce cleared the cached token, so one retry fetches a fresh one.
      if (err instanceof ConnectorError && err.code === ErrorCode.AuthError && err.detail?.status === 401) {
        return this.requestOnce<T>(method, path, opts);
      }
      throw err;
    }
  }

  private async requestOnce<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    opts: { organizationId?: string; query?: Record<string, string | number | undefined>; body?: unknown }
  ): Promise<{ data: T; raw: Record<string, unknown> }> {
    const token = await this.tokens.getToken();
    const org = this.resolveOrganizationId(opts.organizationId);
    if (!org) {
      throw new ConnectorError(ErrorCode.ValidationError, "organization_id is required (pass it or set ZOHO_ORGANIZATION_ID). Run zoho_list_organizations first.");
    }
    const base = this.config.apiBaseOverride ?? token.apiDomain;
    const url = new URL(`${base}/books/v3${path}`);
    url.searchParams.set("organization_id", org);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Zoho-oauthtoken ${token.token}`,
          "Content-Type": "application/json"
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      throw new ConnectorError(ErrorCode.UpstreamUnreachable, `Cannot reach Zoho Books API: ${(err as Error).message}`, { detail: { path } });
    }

    if (response.status === 401) {
      this.tokens.clear();
      throw new ConnectorError(ErrorCode.AuthError, "Zoho rejected the access token even after a refresh. Check that the refresh token is still valid and has Books scopes.", { detail: { status: 401 } });
    }
    if (response.status === 429) {
      throw new ConnectorError(ErrorCode.RateLimited, "Zoho Books rate limit exceeded (100 req/min/org)", { retryable: true });
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = json.code !== undefined ? Number(json.code) : response.status;
      const message = String(json.message ?? `HTTP ${response.status}`);
      if (response.status === 404 || code === 1048 || code === 15) {
        throw new ConnectorError(ErrorCode.NotFound, message, { detail: { path, zohoCode: code } });
      }
      throw new ConnectorError(ErrorCode.UpstreamRejected, message, { detail: { path, zohoCode: code, status: response.status } });
    }
    return { data: json as T, raw: json };
  }

  async listOrganizations(): Promise<ZohoOrganization[]> {
    try {
      return await this.listOrganizationsOnce();
    } catch (err) {
      if (err instanceof ConnectorError && err.code === ErrorCode.AuthError && err.detail?.status === 401) return this.listOrganizationsOnce();
      throw err;
    }
  }

  private async listOrganizationsOnce(): Promise<ZohoOrganization[]> {
    const token = await this.tokens.getToken();
    const base = this.config.apiBaseOverride ?? token.apiDomain;
    let response: Response;
    try {
      response = await fetch(`${base}/books/v3/organizations`, {
        headers: { Authorization: `Zoho-oauthtoken ${token.token}` },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (err) {
      throw new ConnectorError(ErrorCode.UpstreamUnreachable, `Cannot reach Zoho Books API: ${(err as Error).message}`);
    }
    const json = (await response.json().catch(() => ({}))) as { organizations?: Array<Record<string, unknown>> };
    if (response.status === 401) {
      this.tokens.clear();
      throw new ConnectorError(ErrorCode.AuthError, "Zoho rejected the access token even after a refresh.", { detail: { status: 401 } });
    }
    if (!response.ok) {
      throw new ConnectorError(ErrorCode.UpstreamRejected, `organizations listing failed: HTTP ${response.status} ${String((json as Record<string, unknown>).message ?? "")}`.trim(), { detail: { status: response.status } });
    }
    return (json.organizations ?? []).map(mapOrganization);
  }

  async listContacts(opts: { type?: "customer" | "vendor"; query?: string; page?: number; organizationId?: string }): Promise<ListResult<ZohoContact>> {
    const { data } = await this.request<Record<string, unknown>>("GET", "/contacts", {
      organizationId: opts.organizationId,
      query: {
        contact_type: opts.type,
        search_text: opts.query,
        page: opts.page ?? 1,
        per_page: 100
      }
    });
    const contacts = Array.isArray(data.contacts) ? data.contacts : [];
    return { records: contacts.map(mapContact), hasMore: hasMorePage(data), page: pageNum(data) };
  }

  async getContact(contactId: string, organizationId?: string): Promise<ZohoContact> {
    const { data } = await this.request<Record<string, unknown>>("GET", `/contacts/${encodeURIComponent(contactId)}`, { organizationId });
    return mapContact((data.contact ?? {}) as Record<string, unknown>);
  }

  buildCreateContactBody(input: CreateContactInput): Record<string, unknown> {
    const body: Record<string, unknown> = { contact_name: input.name };
    if (input.type) body.contact_type = input.type;
    if (input.email) body.email = input.email;
    if (input.phone) body.phone = input.phone;
    // Zoho Books (India) calls the GSTIN "gst_no".
    if (input.gstin) body.gst_no = input.gstin.trim().toUpperCase();
    const treatment = input.gstTreatment ?? (input.gstin ? "business_gst" : undefined);
    if (treatment) body.gst_treatment = treatment;
    if (treatment === "business_gst" && !input.gstin) {
      throw new ConnectorError(ErrorCode.ValidationError, "gst_treatment business_gst needs the contact's GSTIN");
    }
    if (input.placeOfContact) body.place_of_contact = input.placeOfContact.trim().toUpperCase();
    return body;
  }

  async createContact(
    input: CreateContactInput,
    opts: { dryRun: boolean; organizationId?: string }
  ): Promise<{ preview: Record<string, unknown> } | ZohoContact> {
    const body = this.buildCreateContactBody(input);
    if (opts.dryRun) return { preview: body };
    const { data } = await this.request<Record<string, unknown>>("POST", "/contacts", { body, organizationId: opts.organizationId });
    return mapContact((data.contact ?? {}) as Record<string, unknown>);
  }

  async listInvoices(opts: { status?: string; customerId?: string; page?: number; organizationId?: string }): Promise<ListResult<ZohoInvoice>> {
    const { data } = await this.request<Record<string, unknown>>("GET", "/invoices", {
      organizationId: opts.organizationId,
      query: { status: opts.status, customer_id: opts.customerId, page: opts.page ?? 1, per_page: 100 }
    });
    const invoices = Array.isArray(data.invoices) ? data.invoices : [];
    return { records: invoices.map(mapInvoiceSummary), hasMore: hasMorePage(data), page: pageNum(data) };
  }

  async getInvoice(invoiceId: string, organizationId?: string): Promise<ZohoInvoice> {
    const { data } = await this.request<Record<string, unknown>>("GET", `/invoices/${encodeURIComponent(invoiceId)}`, { organizationId });
    return mapInvoiceDetail((data.invoice ?? {}) as Record<string, unknown>);
  }

  buildCreateInvoiceBody(input: CreateInvoiceInput): Record<string, unknown> {
    if (!input.lineItems.length) throw new ConnectorError(ErrorCode.ValidationError, "invoice needs at least one line item");
    for (const li of input.lineItems) {
      if (!li.itemId && !li.name) throw new ConnectorError(ErrorCode.ValidationError, "each line item needs item_id or name");
      if (!(li.quantity > 0)) throw new ConnectorError(ErrorCode.ValidationError, "line item quantity must be > 0");
      if (li.rate === undefined || Number.isNaN(li.rate)) throw new ConnectorError(ErrorCode.ValidationError, "line item rate is required");
    }
    const body: Record<string, unknown> = {
      customer_id: input.customerId,
      line_items: input.lineItems.map((li) => ({
        ...(li.itemId ? { item_id: li.itemId } : {}),
        ...(li.name ? { name: li.name } : {}),
        ...(li.description ? { description: li.description } : {}),
        rate: li.rate,
        quantity: li.quantity,
        ...(li.taxId ? { tax_id: li.taxId } : {}),
        ...(li.hsnOrSac ? { hsn_or_sac: li.hsnOrSac } : {})
      }))
    };
    if (input.placeOfSupply) body.place_of_supply = input.placeOfSupply.trim().toUpperCase();
    if (input.gstTreatment) body.gst_treatment = input.gstTreatment;
    if (input.gstNo) body.gst_no = input.gstNo.trim().toUpperCase();
    if (input.invoiceNumber) body.invoice_number = input.invoiceNumber;
    if (input.referenceNumber) body.reference_number = input.referenceNumber;
    if (input.date) body.date = input.date;
    if (input.dueDate) body.due_date = input.dueDate;
    if (input.notes) body.notes = input.notes;
    return body;
  }

  async createInvoice(input: CreateInvoiceInput, opts: { dryRun: boolean; organizationId?: string }): Promise<{ preview: Record<string, unknown> } | ZohoInvoice> {
    const body = this.buildCreateInvoiceBody(input);
    if (opts.dryRun) return { preview: body };
    const { data } = await this.request<Record<string, unknown>>("POST", "/invoices", { body, organizationId: opts.organizationId });
    return mapInvoiceDetail((data.invoice ?? {}) as Record<string, unknown>);
  }

  async listItems(opts: { query?: string; page?: number; organizationId?: string }): Promise<ListResult<ZohoItem>> {
    const { data } = await this.request<Record<string, unknown>>("GET", "/items", {
      organizationId: opts.organizationId,
      query: { search_text: opts.query, page: opts.page ?? 1, per_page: 100 }
    });
    const items = Array.isArray(data.items) ? data.items : [];
    return {
      records: items.map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          itemId: optStr(r.item_id),
          name: str(r.name),
          rate: num(r.rate),
          sku: optStr(r.sku),
          description: optStr(r.description),
          productType: optStr(r.product_type)
        };
      }),
      hasMore: hasMorePage(data),
      page: pageNum(data)
    };
  }

  buildCreateItemBody(input: { name: string; rate: number; description?: string; sku?: string }): Record<string, unknown> {
    if (!(input.rate >= 0) || Number.isNaN(input.rate)) throw new ConnectorError(ErrorCode.ValidationError, "item rate must be a number >= 0");
    const body: Record<string, unknown> = { name: input.name, rate: input.rate };
    if (input.description) body.description = input.description;
    if (input.sku) body.sku = input.sku;
    return body;
  }

  async createItem(
    input: { name: string; rate: number; description?: string; sku?: string },
    opts: { dryRun: boolean; organizationId?: string }
  ): Promise<{ preview: Record<string, unknown> } | ZohoItem> {
    const body = this.buildCreateItemBody(input);
    if (opts.dryRun) return { preview: body };
    const { data } = await this.request<Record<string, unknown>>("POST", "/items", { body, organizationId: opts.organizationId });
    const item = (data.item ?? {}) as Record<string, unknown>;
    return { itemId: optStr(item.item_id), name: str(item.name), rate: num(item.rate), sku: optStr(item.sku), description: optStr(item.description) };
  }

  async chartOfAccounts(opts: { page?: number; organizationId?: string }): Promise<ListResult<ZohoAccount>> {
    const { data } = await this.request<Record<string, unknown>>("GET", "/chartofaccounts", {
      organizationId: opts.organizationId,
      query: { page: opts.page ?? 1, per_page: 100 }
    });
    const accounts = Array.isArray(data.chartofaccounts) ? data.chartofaccounts : [];
    return {
      records: accounts.map((raw) => {
        const r = raw as Record<string, unknown>;
        return { accountId: optStr(r.account_id), accountName: str(r.account_name), accountType: optStr(r.account_type), balance: num(r.balance) };
      }),
      hasMore: hasMorePage(data),
      page: pageNum(data)
    };
  }

  buildCustomerPaymentBody(input: CreatePaymentInput): Record<string, unknown> {
    if (!(input.amount > 0)) throw new ConnectorError(ErrorCode.ValidationError, "payment amount must be > 0");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new ConnectorError(ErrorCode.ValidationError, "date must be YYYY-MM-DD");
    const body: Record<string, unknown> = {
      customer_id: input.customerId,
      amount: input.amount,
      date: input.date,
      payment_mode: input.paymentMode ?? "banktransfer"
    };
    if (input.invoiceId) body.invoices = [{ invoice_id: input.invoiceId, amount_applied: input.amount }];
    if (input.referenceNumber) body.reference_number = input.referenceNumber;
    if (input.description) body.description = input.description;
    return body;
  }

  async createCustomerPayment(
    input: CreatePaymentInput,
    opts: { dryRun: boolean; organizationId?: string }
  ): Promise<{ preview: Record<string, unknown> } | Record<string, unknown>> {
    const body = this.buildCustomerPaymentBody(input);
    if (opts.dryRun) return { preview: body };
    const { data } = await this.request<Record<string, unknown>>("POST", "/customerpayments", { body, organizationId: opts.organizationId });
    const payment = (data.payment ?? {}) as Record<string, unknown>;
    return { paymentId: optStr(payment.payment_id), amount: num(payment.amount), date: optStr(payment.date), invoicePayments: payment.invoices ?? [] };
  }
}

function mapOrganization(raw: Record<string, unknown>): ZohoOrganization {
  return {
    organizationId: str(raw.organization_id),
    name: str(raw.name),
    currencyCode: optStr(raw.currency_code),
    countryCode: optStr(raw.country_code),
    isActive: Boolean(raw.is_active)
  };
}

function mapContact(raw: Record<string, unknown>): ZohoContact {
  return {
    contactId: optStr(raw.contact_id),
    contactName: str(raw.contact_name),
    contactType: (optStr(raw.contact_type) as ZohoContact["contactType"]) || undefined,
    email: optStr(raw.email),
    phone: optStr(raw.phone),
    gstin: optStr(raw.gst_no) ?? optStr(raw.gstin),
    gstTreatment: (optStr(raw.gst_treatment) as ZohoContact["gstTreatment"]) || undefined,
    placeOfContact: optStr(raw.place_of_contact),
    outstandingReceivableAmount: num(raw.outstanding_receivable_amount),
    outstandingPayableAmount: num(raw.outstanding_payable_amount)
  };
}

function mapInvoiceSummary(raw: Record<string, unknown>): ZohoInvoice {
  return {
    invoiceId: optStr(raw.invoice_id),
    invoiceNumber: optStr(raw.invoice_number),
    status: optStr(raw.status),
    date: optStr(raw.date),
    dueDate: optStr(raw.due_date),
    customerId: optStr(raw.customer_id),
    customerName: optStr(raw.customer_name),
    total: num(raw.total),
    balance: num(raw.balance)
  };
}

function mapInvoiceDetail(raw: Record<string, unknown>): ZohoInvoice {
  const lines = Array.isArray(raw.line_items)
    ? (raw.line_items as Array<Record<string, unknown>>).map((l) => ({
        lineItemId: optStr(l.line_item_id),
        itemId: optStr(l.item_id),
        name: optStr(l.name),
        description: optStr(l.description),
        rate: num(l.rate),
        quantity: num(l.quantity),
        itemTotal: num(l.item_total),
        taxPercentage: num(l.tax_percentage),
        taxId: optStr(l.tax_id),
        taxName: optStr(l.tax_name),
        hsnOrSac: optStr(l.hsn_or_sac)
      }))
    : undefined;
  return {
    ...mapInvoiceSummary(raw),
    referenceNumber: optStr(raw.reference_number),
    placeOfSupply: optStr(raw.place_of_supply),
    gstTreatment: optStr(raw.gst_treatment),
    gstNo: optStr(raw.gst_no),
    lineItems: lines
  };
}

function hasMorePage(data: Record<string, unknown>): boolean {
  const ctx = data.page_context as Record<string, unknown> | undefined;
  return Boolean(ctx?.has_more_page);
}

function pageNum(data: Record<string, unknown>): number {
  const ctx = data.page_context as Record<string, unknown> | undefined;
  return typeof ctx?.page === "number" ? ctx.page : 1;
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

function optStr(v: unknown): string | undefined {
  return v === undefined || v === null || v === "" ? undefined : String(v);
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isNaN(n) ? undefined : n;
}
