import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectorError, ErrorCode } from "@india-stack/core";
import { TokenManager } from "../src/client/auth.js";

let accountsServer: Server;
let apiServer: Server;
let accountsUrl = "";
let apiUrl = "";

beforeAll(async () => {
  accountsServer = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const params = new URLSearchParams(data);
      if (params.get("refresh_token") === "good") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ access_token: "at_123", expires_in: 3600, api_domain: apiUrl }));
      } else {
        res.end(JSON.stringify({ error: "invalid_code" }));
      }
    });
  });
  apiServer = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ code: 0, message: "ok" }));
  });
  await new Promise<void>((r) => accountsServer.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => apiServer.listen(0, "127.0.0.1", r));
  accountsUrl = `http://127.0.0.1:${(accountsServer.address() as { port: number }).port}`;
  apiUrl = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => accountsServer.close(() => r()));
  await new Promise<void>((r) => apiServer.close(() => r()));
});

describe("TokenManager", () => {
  it("refreshes tokens and reports the api domain", async () => {
    const tm = new TokenManager({
      credentials: { clientId: "cid", clientSecret: "sec", refreshToken: "good", dc: "in" },
      accountsBaseOverride: accountsUrl,
      apiBaseOverride: apiUrl
    });
    const token = await tm.getToken();
    expect(token.token).toBe("at_123");
    expect(token.apiDomain).toBe(apiUrl);
    expect(token.expiresAt).toBeGreaterThan(Date.now());
  });

  it("caches until near expiry", async () => {
    const tm = new TokenManager({
      credentials: { clientId: "cid", clientSecret: "sec", refreshToken: "good", dc: "in" },
      accountsBaseOverride: accountsUrl,
      apiBaseOverride: apiUrl
    });
    const first = await tm.getToken();
    const second = await tm.getToken();
    expect(second.token).toBe(first.token);
  });

  it("maps OAuth errors to AuthError with a hint", async () => {
    const tm = new TokenManager({
      credentials: { clientId: "cid", clientSecret: "sec", refreshToken: "bad", dc: "in" },
      accountsBaseOverride: accountsUrl,
      apiBaseOverride: apiUrl
    });
    const err = await tm.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe(ErrorCode.AuthError);
  });

  it("throws AuthError when no credentials exist anywhere", async () => {
    delete process.env.ZOHO_CLIENT_ID;
    delete process.env.ZOHO_CLIENT_SECRET;
    delete process.env.ZOHO_REFRESH_TOKEN;
    const tm = new TokenManager({});
    const err = await tm.getCredentials().catch((e) => e);
    expect((err as ConnectorError).code).toBe(ErrorCode.AuthError);
  });
});
