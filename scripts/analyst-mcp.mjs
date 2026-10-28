import { parseArgs } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callLocalTool } from './analyst-local-store.mjs';
import { TOOL_CATALOGUE, ANALYST_VERSION, refused } from '../js/planning/analyst/contracts.js';

console.info = console.warn = console.log = (...args) => console.error(...args);
const { values } = parseArgs({ options: { case: { type: 'string' } } });
if (!values.case) throw new Error('Use npm run analyst:mcp -- --case private/analyses/<requestId>/<runId>');
const server = new Server({ name: 'planeir-local-analyst', version: ANALYST_VERSION }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_CATALOGUE.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  let result;
  try { result = await callLocalTool(values.case, request.params.name, request.params.arguments ?? {}); }
  catch (error) { result = refused(error.code ?? 'invalid_case', error.path ?? '/case', error.message); }
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
});
await server.connect(new StdioServerTransport());
