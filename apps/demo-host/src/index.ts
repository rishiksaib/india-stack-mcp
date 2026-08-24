import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createTallyServer } from "@india-stack/connector-tally";
import { createZohoServer } from "@india-stack/connector-zoho";
import { createGstServer } from "@india-stack/connector-gst";

const port = Number(process.env.PORT ?? 8787);

function mcpHandler(create: () => McpServer) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await create().connect(transport);
    void transport.handleRequest(req, res);
  };
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, connectors: ["tally", "zoho", "gst"] }));
    return;
  }
  if (req.method === "POST" && req.url === "/mcp/tally") {
    return mcpHandler(() => createTallyServer())(req, res);
  }
  if (req.method === "POST" && req.url === "/mcp/zoho") {
    return mcpHandler(() => createZohoServer())(req, res);
  }
  if (req.method === "POST" && req.url === "/mcp/gst") {
    return mcpHandler(() => createGstServer())(req, res);
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found", hint: "POST /mcp/tally, /mcp/zoho, /mcp/gst or GET /healthz" }));
}).listen(port, () => {
  process.stderr.write(`demo-host listening on http://localhost:${port} (POST /mcp/tally, /mcp/zoho, /mcp/gst)\n`);
});
