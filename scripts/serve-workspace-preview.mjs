import { resolve } from 'node:path';
import { startPreviewServer } from './lib/preview-server.mjs';
const port = Number(process.env.PREVIEW_PORT || 8790);
const server = await startPreviewServer(resolve(process.argv[2] || 'dist'), { port });
console.log(`Planéir local preview: ${server.origin}`);
process.on('SIGINT', async () => { await server.close(); process.exit(); });
process.on('SIGTERM', async () => { await server.close(); process.exit(); });
