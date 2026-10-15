import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

export async function startPreviewServer(directory, { port = 0 } = {}) {
  const root = resolve(directory);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml' };
  const server = createServer(async (request, response) => {
    try {
      let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const file = resolve(root, `.${pathname}`);
      if (!file.startsWith(root + sep) || !mime[extname(file)]) { response.writeHead(404).end(); return; }
      const data = await readFile(file);
      const headers = { 'Content-Type': mime[extname(file)], 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      if (range) {
        const start = Number(range[1]), end = Math.min(Number(range[2] || data.length - 1), data.length - 1);
        if (start > end) { response.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end(); return; }
        response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 }).end(data.subarray(start, end + 1));
      } else response.writeHead(200, { ...headers, 'Content-Length': data.length }).end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done)) };
}
