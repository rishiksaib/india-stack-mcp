import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeToolContext, serveStdio, useElicitationApprover, type ToolContext } from "@india-stack/core";
import { ZohoClient } from "./client/zohoClient.js";
import type { ZohoClientConfig } from "./client/types.js";
import { makeContactTools } from "./tools/contacts.js";
import { makeFinanceTools } from "./tools/finance.js";
import { makeInvoiceTools } from "./tools/invoices.js";
import { makeItemTools } from "./tools/items.js";
import { makeOrganizationTools } from "./tools/organizations.js";

export const SERVER_NAME = "india-stack-zoho";
export const SERVER_VERSION = "0.2.1";

export function createZohoServer(config: ZohoClientConfig = {}, context?: ToolContext): McpServer {
  const client = new ZohoClient(config);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const ctx = context ?? useElicitationApprover(server, makeToolContext({ connector: "zoho" }));

  for (const tool of [
    ...makeOrganizationTools(client),
    ...makeContactTools(client),
    ...makeInvoiceTools(client),
    ...makeItemTools(client),
    ...makeFinanceTools(client)
  ]) {
    tool.attach(server, ctx);
  }
  return server;
}

export async function main(): Promise<void> {
  const server = createZohoServer();
  await serveStdio(server);
}
