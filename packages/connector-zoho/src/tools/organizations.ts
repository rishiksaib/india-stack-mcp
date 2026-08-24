import { defineTool, type RegisteredTool } from "@india-stack/core";
import type { ZohoClient } from "../client/zohoClient.js";

export function makeOrganizationTools(client: ZohoClient): RegisteredTool[] {
  const listOrganizations = defineTool({
    name: "zoho_list_organizations",
    description: "List all Zoho Books organizations accessible to the connected account, with their organization_id.",
    scope: "read",
    inputSchema: {},
    handler: async () => {
      const organizations = await client.listOrganizations();
      return {
        data: { count: organizations.length, organizations },
        meta: { hint: "Use organization_id in other zoho_* tools or set ZOHO_ORGANIZATION_ID." }
      };
    }
  });

  return [listOrganizations];
}
