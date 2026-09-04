import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const MODULE_EXTENSIONS = new Set([
  '.js',
  '.mjs'
]);
const TEXT_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.css'
]);

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const HTML_FILES = [
  'index.html',
  'session.html',
  'app/index.html',
  'app/session.html',
  'app/clients.html',
  'app/analytics.html',
  'app/modules.html',
  'app/access.html',
  'app/leads.html',
  'app/video.html',
  'plan/index.html',
  'plan/privacy.html'
];
const COPY_ENTRIES = [
  'styles',
  'js',
  'assets',
  'favicon.png',
  'favicon.svg',
  'favicon-32.png',
  'favicon.ico',
  'apple-touch-icon.png',
  'Planeir_logo_transparent.png',
  'CNAME',
  'robots.txt',
  'sitemap.xml'
];
const VERSION = (process.env.ASSET_VERSION || Date.now().toString()).slice(0, 16);

const HTML_ASSET_TAG_PATTERN = /((?:href|src)=["'])(?!https?:\/\/|\/\/|data:|mailto:|#)([^"']+)(["'])/gi;
const JS_FROM_PATTERN = /(\bfrom\s*)(['"])([^'"]+)\2/g;
const JS_SIDE_EFFECT_IMPORT_PATTERN = /((?:^|[\n\r;])\s*import\s+)(['"])([^'"]+)\2/g;
const JS_DYNAMIC_IMPORT_PATTERN = /(\bimport\s*\(\s*)(['"])([^'"]+)\2(\s*\))/g;
const CSS_URL_PATTERN = /(\burl\(\s*['"]?)([^)'"]+)(['"]?\s*\))/gi;

function splitUrlParts(url) {
  const [withoutHash, hash = ''] = String(url).split('#', 2);
  const [pathname, query = ''] = withoutHash.split('?', 2);
  return {
    pathname,
    query,
    hash
  };
}

function hasVersionQuery(url) {
  const { query } = splitUrlParts(url);
  if (!query) {
    return false;
  }

  const params = new URLSearchParams(query);
  return params.has('v');
}

function appendVersion(url) {
  if (hasVersionQuery(url)) {
    return url;
  }

  const { pathname, query, hash } = splitUrlParts(url);
  const params = new URLSearchParams(query);
  params.set('v', VERSION);
  const queryString = params.toString();
  return `${pathname}${queryString ? `?${queryString}` : ''}${hash ? `#${hash}` : ''}`;
}

function shouldVersionUrl(url, allowedExtensions = ASSET_EXTENSIONS) {
  if (!url.startsWith('./') && !url.startsWith('../')) {
    return false;
  }

  if (hasVersionQuery(url)) {
    return false;
  }

  const { pathname } = splitUrlParts(url);
  const extension = path.extname(pathname).toLowerCase();
  return allowedExtensions.has(extension);
}

function addVersionToAssetUrls(html) {
  return html.replace(HTML_ASSET_TAG_PATTERN, (fullMatch, prefix, rawUrl, suffix) => {
    if (!shouldVersionUrl(rawUrl)) {
      return fullMatch;
    }
    return `${prefix}${appendVersion(rawUrl)}${suffix}`;
  });
}

function removeLocalConsumerApiOrigins(html) {
  return html
    .replaceAll(' http://127.0.0.1:8787', '')
    .replaceAll(' http://localhost:8787', '');
}

function addVersionToJsModuleSpecifiers(source) {
  let updated = source.replace(JS_FROM_PATTERN, (fullMatch, prefix, quote, rawUrl) => {
    if (!shouldVersionUrl(rawUrl, MODULE_EXTENSIONS)) {
      return fullMatch;
    }

    return `${prefix}${quote}${appendVersion(rawUrl)}${quote}`;
  });

  updated = updated.replace(JS_SIDE_EFFECT_IMPORT_PATTERN, (fullMatch, prefix, quote, rawUrl) => {
    if (!shouldVersionUrl(rawUrl, MODULE_EXTENSIONS)) {
      return fullMatch;
    }

    return `${prefix}${quote}${appendVersion(rawUrl)}${quote}`;
  });

  updated = updated.replace(JS_DYNAMIC_IMPORT_PATTERN, (fullMatch, prefix, quote, rawUrl, suffix) => {
    if (!shouldVersionUrl(rawUrl, MODULE_EXTENSIONS)) {
      return fullMatch;
    }

    return `${prefix}${quote}${appendVersion(rawUrl)}${quote}${suffix}`;
  });

  return updated;
}

function addVersionToCssAssetUrls(source) {
  return source.replace(CSS_URL_PATTERN, (fullMatch, prefix, rawUrl, suffix) => {
    if (!shouldVersionUrl(rawUrl)) {
      return fullMatch;
    }

    return `${prefix}${appendVersion(rawUrl)}${suffix}`;
  });
}

function rewriteTextAssetReferences(source, extension) {
  switch (extension) {
    case '.html':
      return removeLocalConsumerApiOrigins(addVersionToAssetUrls(source));
    case '.js':
      return addVersionToJsModuleSpecifiers(source);
    case '.css':
      return addVersionToCssAssetUrls(source);
    default:
      return source;
  }
}

async function listFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(entryPath);
    }

    return entry.isFile() ? [entryPath] : [];
  }));

  return files.flat();
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
    await mkdir(path.dirname(outputPath), { recursive: true });
    await cp(inputPath, outputPath);
  }

  const distFiles = await listFiles(DIST_DIR);
  for (const filePath of distFiles) {
    const extension = path.extname(filePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) {
      continue;
    }

    const source = await readFile(filePath, 'utf8');
    const rewritten = rewriteTextAssetReferences(source, extension);
    if (rewritten !== source) {
      await writeFile(filePath, rewritten, 'utf8');
    }
  }

  await writeFile(path.join(DIST_DIR, '.nojekyll'), '', 'utf8');
  console.log(`Built GitHub Pages artifact in ${DIST_DIR} (asset version: ${VERSION})`);
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
