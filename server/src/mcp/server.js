import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createTools } from './tools.js';

/**
 * An MCP server instance wired to one `api` function.
 *
 * A fresh instance per HTTP request: the Streamable HTTP transport runs
 * stateless here, so there is no session to keep and nothing to leak between
 * callers.
 */
export function buildMcpServer(api, { name = 'deploy', version = '1.0.0' } = {}) {
  const tools = createTools(api);
  const server = new Server({ name, version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: {
        readOnlyHint: Boolean(t.readOnly),
        // Nothing here deletes a project, a service or a domain: the
        // destructive parts of the panel are left to the web UI on purpose.
        destructiveHint: false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] };
    }
    try {
      const result = await tool.run(req.params.arguments || {});
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      // Reported as tool output rather than a protocol error, so the model
      // reads the reason and can act on it instead of seeing a bare failure.
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  });

  return { server, tools };
}

/** How many tools exist, for the UI — without standing up a server. */
export const toolCount = () => createTools(async () => ({})).length;
