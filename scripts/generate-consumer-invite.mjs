import { createHmac, randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'ci1';
const TOKEN_AUDIENCE = 'planeir-consumer';
const DEFAULT_PLAN_URL = 'https://planeir.ie/plan/';
const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 720;

function usage() {
  return `Usage: npm run generate:consumer-invite -- [options]

Options:
  --cohort <name>       Invite cohort claim (default: CONSUMER_COHORT or internal)
  --ttl-hours <hours>   Whole hours until expiry, 1-${MAX_TTL_HOURS} (default: ${DEFAULT_TTL_HOURS})
  --max-uses <count>    Maximum successful redemptions, 1-50 (default: 1)
  --plan-url <url>      Plan page used for the printed link (default: ${DEFAULT_PLAN_URL})
  --help                Show this help

Set CONSUMER_INVITE_SIGNING_KEY to the same 32-byte base64url HMAC key used by
the Worker. If it is absent, this command generates a new key and prints it once.`;
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^\d+$/.test(String(value || ''))) {
    throw new Error(`${label} must be a whole number between ${minimum} and ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function readOptions(argv) {
  const options = {
    cohort: String(process.env.CONSUMER_COHORT || 'internal').trim(),
    ttlHours: DEFAULT_TTL_HOURS,
    maxUses: 1,
    planUrl: String(process.env.CONSUMER_PLAN_BASE_URL || DEFAULT_PLAN_URL).trim()
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (!['--cohort', '--ttl-hours', '--max-uses', '--plan-url'].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    index += 1;
    if (argument === '--cohort') options.cohort = value.trim();
    if (argument === '--ttl-hours') options.ttlHours = parseInteger(value, 'TTL hours', 1, MAX_TTL_HOURS);
    if (argument === '--max-uses') options.maxUses = parseInteger(value, 'Maximum uses', 1, 50);
    if (argument === '--plan-url') options.planUrl = value.trim();
  }

  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(options.cohort)) {
    throw new Error('Cohort must contain 1-80 letters, numbers, dots, underscores, colons, or hyphens.');
  }
  const planUrl = new URL(options.planUrl);
  const localHttp = planUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(planUrl.hostname);
  if (planUrl.protocol !== 'https:' && !localHttp) {
    throw new Error('Plan URL must use HTTPS, except for localhost development.');
  }
  options.planUrl = planUrl.toString();
  return options;
}

function readSigningKey() {
  const configured = String(process.env.CONSUMER_INVITE_SIGNING_KEY || '').trim();
  if (!configured) {
    const bytes = randomBytes(32);
    return { bytes, encoded: bytes.toString('base64url'), generated: true };
  }
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(configured)) {
    throw new Error('CONSUMER_INVITE_SIGNING_KEY must be a base64url-encoded 32-byte key.');
  }
  const bytes = Buffer.from(configured, 'base64url');
  if (bytes.length !== 32) {
    throw new Error('CONSUMER_INVITE_SIGNING_KEY must decode to exactly 32 bytes.');
  }
  return { bytes, encoded: configured, generated: false };
}

function buildInvite(options, key) {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const payload = {
    v: 1,
    aud: TOKEN_AUDIENCE,
    jti: randomBytes(18).toString('base64url'),
    cohort: options.cohort,
    iat: issuedAt,
    exp: issuedAt + options.ttlHours * 60 * 60,
    maxUses: options.maxUses
  };
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signedValue = `${TOKEN_PREFIX}.${payloadPart}`;
  const signature = createHmac('sha256', key.bytes).update(signedValue, 'utf8').digest('base64url');
  return { token: `${signedValue}.${signature}`, payload };
}

try {
  const options = readOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  const key = readSigningKey();
  const invite = buildInvite(options, key);
  const link = new URL(options.planUrl);
  link.hash = new URLSearchParams({ invite: invite.token }).toString();

  console.log('Generated a signed Plan\u00e9ir consumer invite (ci1 / HMAC-SHA-256).');
  console.log(`Cohort: ${invite.payload.cohort}`);
  console.log(`Expires: ${new Date(invite.payload.exp * 1_000).toISOString()}`);
  console.log(`Maximum uses: ${invite.payload.maxUses}`);
  console.log('');
  if (key.generated) {
    console.log('A new signing key was generated because CONSUMER_INVITE_SIGNING_KEY was not set.');
    console.log('Store this key as a Worker secret and in the approved operator secret manager.');
    console.log('Do not use this new key if another invite signing key is already deployed.');
    console.log(`CONSUMER_INVITE_SIGNING_KEY="${key.encoded}"`);
    console.log('');
  } else {
    console.log('Used CONSUMER_INVITE_SIGNING_KEY from the current process; the key was not printed.');
    console.log('');
  }
  console.log(`Invite token: ${invite.token}`);
  console.log(`Private link: ${link.toString()}`);
  console.log('');
  console.log('Anyone with this unexpired link can redeem it up to the stated maximum. Share it privately.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('');
  console.error(usage());
  process.exitCode = 1;
}
