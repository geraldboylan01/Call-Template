import { pbkdf2Sync, randomBytes } from 'node:crypto';

const PBKDF2_ITERATIONS = 310_000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const SESSION_SECRET_LENGTH = 32;

function toBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function getPasswordFromArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const entry = String(argv[index] || '');
    if (entry === '--password' && argv[index + 1]) {
      return String(argv[index + 1]);
    }
    if (entry.startsWith('--password=')) {
      return entry.slice('--password='.length);
    }
  }

  return process.env.ADVISOR_PASSWORD || '';
}

function printUsage() {
  console.error('Usage: node ./scripts/generate-advisor-auth.mjs --password "your advisor password"');
  console.error('You can also provide ADVISOR_PASSWORD in the environment.');
}

const password = getPasswordFromArgs(process.argv.slice(2));
if (!password) {
  printUsage();
  process.exit(1);
}

const salt = randomBytes(SALT_LENGTH);
const hash = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
const sessionSecret = randomBytes(SESSION_SECRET_LENGTH);

console.log('# Worker secrets / vars');
console.log(`ADVISOR_SESSION_SECRET=${toBase64Url(sessionSecret)}`);
console.log(`ADVISOR_PASSWORD_HASH_B64U=${toBase64Url(hash)}`);
console.log(`ADVISOR_PASSWORD_SALT_B64U=${toBase64Url(salt)}`);
console.log('');
console.log('# Optional CI secret for live smoke login when auth is enabled');
console.log('ADVISOR_SMOKE_PASSWORD=<same plaintext password>');
