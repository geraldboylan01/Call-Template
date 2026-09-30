import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PACKABLE_CONSUMER_SETTINGS } from '../worker/src/consumer/packed_settings.js';

export function compactConsumerSettings(source) {
  const allowed = new Set(PACKABLE_CONSUMER_SETTINGS);
  const values = {};
  const stripped = source.replace(/^(CONSUMER_[A-Z0-9_]+)\s*=\s*("[^"\n]*")\s*$/gm, (line, name, raw) => {
    if (!allowed.has(name)) return line;
    if (Object.hasOwn(values, name)) throw new Error(`Duplicate configuration: ${name}`);
    values[name] = JSON.parse(raw);
    return '';
  });
  const groups = [{}];
  for (const [name, value] of Object.entries(values)) {
    let group = groups.at(-1);
    if (Buffer.byteLength(JSON.stringify({ ...group, [name]: value })) > 4096) {
      groups.push(group = {});
    }
    group[name] = value;
    if (Buffer.byteLength(JSON.stringify(group)) > 4096) throw new Error(`Configuration value is too large: ${name}`);
  }
  if (groups.length > 4) throw new Error('Packed consumer settings exceed the supported capacity.');
  if (!/^\[vars\]$/m.test(stripped) || /^CONSUMER_SETTINGS_JSON_\d\s*=/m.test(source)) throw new Error('Expected an unpacked Worker configuration.');
  const packed = groups.map((group, index) => `CONSUMER_SETTINGS_JSON_${index + 1} = ${JSON.stringify(JSON.stringify(group))}`).join('\n');
  return stripped.replace(/^\[vars\]$/m, `[vars]\n${packed}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length < 3) throw new Error('Provide the generated Worker configuration paths.');
  for (const path of process.argv.slice(2)) {
    const compact = compactConsumerSettings(readFileSync(path, 'utf8'));
    writeFileSync(path, compact, { mode: 0o600 });
    console.log(`Compacted non-secret consumer settings in ${path}.`);
  }
}
