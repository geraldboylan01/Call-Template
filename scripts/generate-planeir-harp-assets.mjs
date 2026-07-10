import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  HARP_FRAME_PATH,
  HARP_STRING_STROKE_WIDTH,
  HARP_STRINGS,
  HARP_VIEW_BOX,
  PLANEIR_WORDMARK_LETTER_PATH,
  getHarpStringPath
} from '../js/planeir_harp_artwork.js';

const BRAND_DIR = new URL('../assets/brand/', import.meta.url);
const LIGHT = '#F3F8FF';
const DARK = '#07101D';

function createHarpGeometry(color, indent = '  ') {
  const strings = HARP_STRINGS.map((definition) => `${indent}<path data-planeir-harp-string="${definition.id}" data-harp-string="${definition.id}" d="${getHarpStringPath(definition)}" fill="none" stroke="${color}" stroke-width="${HARP_STRING_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />`).join('\n');

  return `${indent}<path data-planeir-harp-frame="" data-harp-frame="" d="${HARP_FRAME_PATH}" fill="${color}" />\n${strings}`;
}

function createStandaloneSvg(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${HARP_VIEW_BOX}" width="140" height="136" role="img" aria-label="Planeir harp" shape-rendering="geometricPrecision">
  <g data-planeir-harp="">
${createHarpGeometry(color, '    ')}
  </g>
</svg>
`;
}

function createWordmarkSvg(letterPath, color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1330 384" width="1330" height="384" role="img" aria-label="Planeir logo" shape-rendering="geometricPrecision">
  <g fill="${color}" fill-rule="evenodd">
    <path d="${letterPath}" />
  </g>
  <g data-planeir-harp="">
${createHarpGeometry(color, '    ')}
  </g>
</svg>
`;
}

function createWordmarkLettersSvg(letterPath, color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1330 384" width="1330" height="384" role="img" aria-label="Planeir logo" shape-rendering="geometricPrecision">
  <path data-planeir-wordmark-letters="" d="${letterPath}" fill="${color}" fill-rule="evenodd" />
</svg>
`;
}

async function writeAsset(name, source) {
  await writeFile(new URL(name, BRAND_DIR), source, 'utf8');
  console.log(`Wrote assets/brand/${name}`);
}

function exportPng(svgName, pngName) {
  const svgPath = fileURLToPath(new URL(svgName, BRAND_DIR));
  const pngPath = fileURLToPath(new URL(pngName, BRAND_DIR));
  const result = spawnSync('sips', ['-s', 'format', 'png', svgPath, '--out', pngPath], {
    encoding: 'utf8'
  });

  if (result.error?.code === 'ENOENT') {
    console.warn(`Skipped ${pngName}: macOS sips is not available.`);
    return;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `sips failed while writing ${pngName}.`);
  }
  console.log(`Wrote assets/brand/${pngName}`);
}

await writeAsset('planeir-harp-light.svg', createStandaloneSvg(LIGHT));
await writeAsset('planeir-wordmark-no-harp-light.svg', createWordmarkLettersSvg(PLANEIR_WORDMARK_LETTER_PATH, LIGHT));
await writeAsset('planeir-wordmark-light.svg', createWordmarkSvg(PLANEIR_WORDMARK_LETTER_PATH, LIGHT));
await writeAsset('planeir-wordmark-dark.svg', createWordmarkSvg(PLANEIR_WORDMARK_LETTER_PATH, DARK));

if (process.argv.includes('--png')) {
  exportPng('planeir-wordmark-light.svg', 'planeir-wordmark-light.png');
  exportPng('planeir-wordmark-dark.svg', 'planeir-wordmark-dark.png');
}
