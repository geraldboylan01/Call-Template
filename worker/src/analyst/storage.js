import { encryptJson, decryptJson, sha256Base64Url } from '../consumer/crypto.js';

// Same key rotation and AES-GCM envelope as saved demo/session data. AAD
// binds every encrypted chunk to its request, run, checkpoint and position.
const keyEnv = env => ({ ...env,
  CONSUMER_DATA_ENCRYPTION_KEY: env.DEMO_DATA_ENCRYPTION_KEY,
  CONSUMER_DATA_ENCRYPTION_KEY_ID: env.DEMO_DATA_ENCRYPTION_KEY_ID || 'demo-v1',
  CONSUMER_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: env.DEMO_DATA_ENCRYPTION_PREVIOUS_KEYS_JSON });
const id = value => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error('Invalid analysis identifier.');
  return value;
};
export const runPrefix = (requestId, runId) => `analyst/${id(requestId)}/${id(runId)}`;

export function analystStorage(env) {
  const bucket = env.SESSIONS_BUCKET;
  async function putRaw(key, value) {
    const json = JSON.stringify(value), parts = [];
    // Four independent encrypted objects at a time, below Workers' six
    // simultaneous outgoing connections. Publish the manifest only at the end.
    for (let offset = 0; offset < json.length; offset += 4 * 64000) {
      const batch = [];
      for (let part = offset; part < Math.min(json.length, offset + 4 * 64000); part += 64000) {
        const chunkKey = `${key}/${crypto.randomUUID()}`; parts.push(chunkKey);
        batch.push((async () => {
          const encrypted = await encryptJson(keyEnv(env), json.slice(part, part + 64000), chunkKey);
          await bucket.put(chunkKey, encrypted);
        })());
      }
      await Promise.all(batch);
    }
    await bucket.put(key, await encryptJson(keyEnv(env), { parts }, key));
    return key;
  }
  async function getRaw(key) {
    const object = await bucket.get(key);
    if (!object) return null;
    const { parts } = await decryptJson(keyEnv(env), await object.text(), key);
    let json = '';
    for (let index = 0; index < parts.length; index += 4) {
      const strings = await Promise.all(parts.slice(index, index + 4).map(async part => {
        const chunk = await bucket.get(part);
        if (!chunk) throw new Error('Incomplete encrypted analysis checkpoint.');
        return decryptJson(keyEnv(env), await chunk.text(), part);
      }));
      json += strings.join('');
    }
    return JSON.parse(json);
  }
  return {
    async put(key, value) {
      if (!value.caseFile && !value.caseKey) return putRaw(key, value);
      const { caseFile, caseKey: previousCaseKey, caseSummary: previousSummary, ...state } = value;
      let caseKey = previousCaseKey, caseSummary = previousSummary;
      if (caseFile) {
        // Model turns and progress updates do not change the case. Keep one
        // immutable encrypted copy of each distinct case instead of copying
        // megabytes into every progress/model checkpoint.
        const prefix = key.split('/').slice(0, 3).join('/');
        caseKey = `${prefix}/cases/${await sha256Base64Url(JSON.stringify(caseFile))}`;
        if (!await bucket.head(caseKey)) await putRaw(caseKey, caseFile);
        caseSummary = { budget: caseFile.budget, versions: caseFile.pinned.versions, checkerReports: caseFile.checkerReports };
      }
      return putRaw(key, { analystSnapshotVersion: 2, caseKey, caseSummary, state });
    },
    async get(key, { includeCase = true } = {}) {
      const value = await getRaw(key);
      if (!value || value.analystSnapshotVersion !== 2) {
        // Read the first preview's complete snapshots as well.
        if (!includeCase && value?.caseFile) {
          value.caseSummary = { budget: value.caseFile.budget, versions: value.caseFile.pinned.versions, checkerReports: value.caseFile.checkerReports };
          // Legacy snapshots must retain their case until converted to v2.
        }
        return value;
      }
      const state = { ...value.state, caseKey: value.caseKey, caseSummary: value.caseSummary };
      if (includeCase) {
        state.caseFile = await getRaw(value.caseKey);
        if (!state.caseFile) throw new Error('Missing encrypted analysis case.');
      }
      return state;
    },
    async progress(runId, key, state) {
      await env.LEADS_DB.prepare('UPDATE analyst_runs SET snapshot_key=?,status=?,updated_at=? WHERE run_id=?')
        .bind(key, state.status, new Date().toISOString(), runId).run();
    },
    async recordEvent(requestId, runId, event, eventId = crypto.randomUUID()) {
      const key = `${runPrefix(requestId, runId)}/events/${encodeURIComponent(eventId)}`;
      const saved = { ...event, id: key };
      if (!await bucket.head(key)) await putRaw(key, saved);
      return saved;
    },
    async events(requestId, runId) {
      const values = []; let cursor;
      do {
        const page = await bucket.list({ prefix: `${runPrefix(requestId, runId)}/events/`, delimiter: '/', ...(cursor ? { cursor } : {}) });
        for (let index = 0; index < page.objects.length; index += 4) {
          values.push(...await Promise.all(page.objects.slice(index, index + 4).map(object => getRaw(object.key))));
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return values.filter(Boolean);
    }
  };
}
