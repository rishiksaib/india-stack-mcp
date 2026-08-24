import { ConnectorError, ErrorCode, type CredentialVault } from "@india-stack/core";
import { endpointsForDc, type ZohoClientConfig, type ZohoCredentials, type ZohoDc } from "./types.js";

export interface AccessToken {
  token: string;
  apiDomain: string;
  expiresAt: number;
}

export class TokenManager {
  private cached: AccessToken | null = null;
  private readonly vault?: CredentialVault;
  private readonly vaultRef: string;
  private credentials: ZohoCredentials | null = null;

  constructor(private readonly config: ZohoClientConfig = {}) {
    this.vault = config.vault;
    this.vaultRef = config.vaultRef ?? "zoho_books";
  }

  async getCredentials(): Promise<ZohoCredentials> {
    if (this.credentials) return this.credentials;
    if (this.config.credentials) {
      this.credentials = this.config.credentials;
      return this.config.credentials;
    }
    const envCreds = fromEnv();
    if (envCreds) {
      this.credentials = envCreds;
      return envCreds;
    }
    if (this.vault) {
      const stored = await this.vault.get(this.vaultRef);
      const parsed = parseStored(stored);
      if (parsed) {
        this.credentials = parsed;
        return parsed;
      }
    }
    throw new ConnectorError(
      ErrorCode.AuthError,
      "No Zoho Books credentials found. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN (and optional ZOHO_DC, ZOHO_ORGANIZATION_ID) or provision a credential in the vault.",
      { detail: { vaultRef: this.vaultRef } }
    );
  }

  async getToken(): Promise<AccessToken> {
    if (this.cached && Date.now() < this.cached.expiresAt - 60_000) return this.cached;
    const creds = await this.getCredentials();
    const endpoints = endpointsForDc(creds.dc);
    const accountsBase = this.config.accountsBaseOverride ?? endpoints.accounts;
    const body = new URLSearchParams({
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "refresh_token"
    });
    let response: Response;
    try {
      response = await fetch(`${accountsBase}/oauth/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15000)
      });
    } catch (err) {
      throw new ConnectorError(ErrorCode.UpstreamUnreachable, `Cannot reach Zoho accounts endpoint: ${(err as Error).message}`);
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || json.error || !json.access_token) {
      throw new ConnectorError(ErrorCode.AuthError, `Zoho OAuth refresh failed: ${String(json.error ?? response.status)}`, {
        detail: { hint: "Check client_id/client_secret/refresh_token and that the refresh token has Books scopes." }
      });
    }
    const token: AccessToken = {
      token: String(json.access_token),
      apiDomain: String(json.api_domain ?? this.config.apiBaseOverride ?? endpoints.api),
      expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000
    };
    this.cached = token;
    return token;
  }

  clear(): void {
    this.cached = null;
    this.credentials = null;
  }
}

function fromEnv(): ZohoCredentials | null {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const dcRaw = (process.env.ZOHO_DC ?? "in").toLowerCase() as ZohoDc;
  const dc: ZohoDc = dcRaw in endpointsForMap() ? dcRaw : "in";
  return { clientId, clientSecret, refreshToken, dc };
}

function endpointsForMap(): Record<string, unknown> {
  return { in: 1, com: 1, eu: 1, au: 1, jp: 1 };
}

function parseStored(stored: { kind?: string; fields?: Record<string, string> } | null): ZohoCredentials | null {
  if (!stored) return null;
  const f = stored.fields ?? {};
  const clientId = f.client_id;
  const clientSecret = f.client_secret;
  const refreshToken = f.refresh_token;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const dc = (f.dc as ZohoDc) ?? "in";
  return { clientId, clientSecret, refreshToken, dc };
}
