// One-time provisioning. Secrets travel through stdin only and never appear in
// arguments, files or output. Existing encryption keys must never be replaced.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const config = 'worker/wrangler.toml';
function command(executable, args, input) {
  const result = spawnSync(executable, args, { encoding: 'utf8', input, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${executable} ${args.slice(0, 2).join(' ')} failed (${result.status ?? 'unavailable'}). No secret values were printed.`);
  return result.stdout;
}
const inventory = JSON.parse(command('wrangler', ['secret', 'list', '--config', config, '--format', 'json']));
if (inventory.some(item => item.name === 'DEMO_DATA_ENCRYPTION_KEY')) {
  console.log('The demo encryption key already exists. It was not changed.');
} else {
  const value = randomBytes(32).toString('base64url');
  // Back up in the protected GitHub environment before installing it in the Worker.
  command('gh', ['secret', 'set', 'DEMO_DATA_ENCRYPTION_KEY', '--env', 'production', '--repo', 'geraldboylan01/Call-Template'], value);
  command('wrangler', ['secret', 'put', 'DEMO_DATA_ENCRYPTION_KEY', '--config', config], value);
  console.log('A new demo encryption key was stored in the protected production environment and Worker. No key was printed or written locally.');
}
