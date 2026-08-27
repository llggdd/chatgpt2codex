import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../types.js";
import { ensureDeviceIdentity, mcpServerName } from "../identity/device.js";
import { registerTools } from "./tools.js";

/**
 * Construct and configure the MCP server (stdio transport) with all tools
 * registered against ctx. Returns the server instance ready to `connect()`.
 */
export async function createServer(ctx: ToolContext): Promise<McpServer> {
  // Most production callers already build the context through cli.ts, but
  // keeping this fallback makes direct embedders and diagnostics safe too.
  const identity =
    ctx.identity ??
    (await ensureDeviceIdentity(ctx.stateDir, {
      instanceId: process.env.CHATGPT2CODEX_INSTANCE_ID,
      displayName: process.env.CHATGPT2CODEX_DISPLAY_NAME,
    }));
  const serverContext = ctx.identity ? ctx : { ...ctx, identity };
  const server = new McpServer(
    {
      name: mcpServerName(identity),
      version: "0.1.1",
    },
    {
      // Keep the protocol-level instruction free of user-supplied display
      // names; the human label remains available as structured data through
      // device_identity and tool-call proofs.
      instructions: `Connected ChatGPT To Codex instance ${mcpServerName(identity)}. Call device_identity before selecting a project when multiple installations are connected.`,
    },
  );

  registerTools(server, serverContext);

  return server;
}
