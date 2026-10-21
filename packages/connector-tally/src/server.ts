import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeToolContext, serveStdio, useElicitationApprover, type ToolContext } from "@india-stack/core";
import { TallyClient } from "./client/tallyClient.js";
import type { TallyClientConfig } from "./client/types.js";
import { makeCompanyTools } from "./tools/companies.js";
import { makeLedgerTools } from "./tools/ledgers.js";
import { makeReportTools } from "./tools/reports.js";
import { makeVoucherTools } from "./tools/vouchers.js";

export const SERVER_NAME = "india-stack-tally";
export const SERVER_VERSION = "0.2.1";

export function createTallyServer(config: TallyClientConfig = {}, context?: ToolContext): McpServer {
  const client = new TallyClient(config);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const ctx = context ?? useElicitationApprover(server, makeToolContext({ connector: "tally" }));

  for (const tool of [
    ...makeCompanyTools(client),
    ...makeLedgerTools(client),
    ...makeVoucherTools(client),
    ...makeReportTools(client)
  ]) {
    tool.attach(server, ctx);
  }
  return server;
}

export async function main(): Promise<void> {
  const server = createTallyServer();
  await serveStdio(server);
}
