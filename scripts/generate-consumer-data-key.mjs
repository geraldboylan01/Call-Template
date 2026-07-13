import { randomBytes } from 'node:crypto';

const key = randomBytes(32).toString('base64url');

console.log('Generated a 256-bit consumer data-encryption key.');
console.log('Keep this value secret. Do not commit it or paste it into client-side code.');
console.log('');
console.log(`CONSUMER_DATA_ENCRYPTION_KEY="${key}"`);
console.log('CONSUMER_DATA_ENCRYPTION_KEY_ID="consumer-v1"');
console.log('');
console.log('Local: add the line to worker/.dev.vars.');
console.log('Production: run `cd worker && wrangler secret put CONSUMER_DATA_ENCRYPTION_KEY`.');
