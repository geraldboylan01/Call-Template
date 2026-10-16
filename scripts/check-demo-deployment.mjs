// Public, read-only contract check. The API is deployed before the Pages UI.
const base = process.env.WORKER_BASE_URL || 'https://api.planeir.ie';
const attempts = Number(process.env.DEMO_DEPLOY_ATTEMPTS || 120);
let verified = false;
for (let attempt = 0; attempt < attempts; attempt += 1) {
  try {
    const response = await fetch(`${base}/api/demo/config`, { headers: { Origin: 'https://planeir.ie' }, cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (response.ok && data.contractVersion === 'demo-v1' && data.generationAvailable === false) {
      console.log(`Demo API contract verified; new requests ${data.enabled ? 'enabled' : 'paused'}.`);
      verified = true; break;
    }
  } catch { /* The Worker rollout can still be in progress. */ }
  if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 10000));
}
if (!verified) throw new Error('The demo API has not been deployed. Pages publication is stopped; deploy the Worker and demo storage key first.');
