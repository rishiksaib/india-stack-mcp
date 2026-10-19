import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createTallyServer } from "@india-stack/connector-tally";
import { createZohoServer } from "@india-stack/connector-zoho";
import { createGstServer } from "@india-stack/connector-gst";

// HTTP mode exposes write tools (Tally vouchers, Zoho invoices), so it is locked down by default:
//  - binds to 127.0.0.1 unless HOST is set;
//  - refuses to bind a non-loopback address without INDIA_STACK_HTTP_TOKEN;
//  - when a token is set, every /mcp request must send "Authorization: Bearer <token>";
//  - Host headers are checked (DNS-rebinding protection); extra names via INDIA_STACK_ALLOWED_HOSTS.

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const token = process.env.INDIA_STACK_HTTP_TOKEN ?? "";
const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";

if (!loopback && token.length < 16) {
  process.stderr.write(
    `Refusing to listen on ${host}: set INDIA_STACK_HTTP_TOKEN (16+ characters) to expose the connectors beyond this machine.\n`
  );
  process.exit(1);
}

const allowedHosts = [
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  `[::1]:${port}`,
  ...(loopback ? [] : [`${host}:${port}`]),
  ...(process.env.INDIA_STACK_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
];

function authorized(req: IncomingMessage): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  const presented = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function mcpHandler(create: () => McpServer) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts
    });
    try {
      await create().connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: "internal error", message: (err as Error).message });
    }
  };
}

const routes: Record<string, () => McpServer> = {
  "/mcp/tally": () => createTallyServer(),
  "/mcp/zoho": () => createZohoServer(),
  "/mcp/gst": () => createGstServer()
};

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    return json(res, 200, { ok: true, connectors: ["tally", "zoho", "gst"] });
  }
  const route = req.url ? routes[req.url] : undefined;
  if (req.method === "POST" && route) {
    if (!authorized(req)) return json(res, 401, { error: "unauthorized", hint: "Send Authorization: Bearer <INDIA_STACK_HTTP_TOKEN>" });
    return mcpHandler(route)(req, res);
  }
  json(res, 404, { error: "not found", hint: "POST /mcp/tally, /mcp/zoho, /mcp/gst or GET /healthz" });
}).listen(port, host, () => {
  process.stderr.write(`demo-host listening on http://${host}:${port} (POST /mcp/tally, /mcp/zoho, /mcp/gst)${token ? " with bearer auth" : ""}\n`);
});
