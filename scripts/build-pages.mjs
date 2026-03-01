import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSET_EXTENSIONS = new Set([
  '.css',
  '.js',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.ico'
]);

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const HTML_FILES = ['index.html', 'session.html'];
const COPY_ENTRIES = ['styles', 'js', 'favicon.png', 'Planeir_logo_transparent.png'];
const VERSION = (process.env.ASSET_VERSION || Date.now().toString()).slice(0, 16);

const ASSET_TAG_PATTERN = /((?:href|src)=["'])(?!https?:\/\/|\/\/|data:|mailto:|#)([^"'?#]+)(["'])/gi;

function shouldVersionUrl(url) {
  if (!url.startsWith('./') && !url.startsWith('../')) {
    return false;
  }

  const extension = path.extname(url).toLowerCase();
  return ASSET_EXTENSIONS.has(extension);
}

function addVersionToAssetUrls(html) {
  return html.replace(ASSET_TAG_PATTERN, (fullMatch, prefix, rawUrl, suffix) => {
    if (!shouldVersionUrl(rawUrl)) {
      return fullMatch;
    }
    return `${prefix}${rawUrl}?v=${VERSION}${suffix}`;
  });
}

async function build() {
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  for (const entry of COPY_ENTRIES) {
    await cp(path.join(ROOT_DIR, entry), path.join(DIST_DIR, entry), { recursive: true });
  }

  for (const htmlFile of HTML_FILES) {
    const inputPath = path.join(ROOT_DIR, htmlFile);
    const outputPath = path.join(DIST_DIR, htmlFile);
    const html = await readFile(inputPath, 'utf8');
    await writeFile(outputPath, addVersionToAssetUrls(html), 'utf8');
  }

  await writeFile(path.join(DIST_DIR, '.nojekyll'), '', 'utf8');
  console.log(`Built GitHub Pages artifact in ${DIST_DIR} (asset version: ${VERSION})`);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
