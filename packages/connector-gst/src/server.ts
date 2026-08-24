import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeToolContext, serveStdio, type ToolContext } from "@india-stack/core";
import { makeEinvoiceTools } from "./tools/einvoiceTools.js";
import { makeGstinTools } from "./tools/gstinTools.js";
import { makeReconTools } from "./tools/reconTools.js";

export const SERVER_NAME = "india-stack-gst";
export const SERVER_VERSION = "0.1.0";

export function createGstServer(context?: ToolContext): McpServer {
  const ctx = context ?? makeToolContext({ connector: "gst" });
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of [...makeGstinTools(), ...makeEinvoiceTools(), ...makeReconTools()]) {
    tool.attach(server, ctx);
  }
  return server;
}

export async function main(): Promise<void> {
  const server = createGstServer();
  await serveStdio(server);
}
