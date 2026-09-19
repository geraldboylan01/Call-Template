import { getConsumerConfig } from '../config.js';
import { getLatestRealtimeMeetingBrief, listRecentRealtimeFinalTurns } from '../realtime_repository.js';
import { buildTypedCardIndex, buildTypedCardState } from './typed_projection.js';
import { sha256Base64Url, stableStringify } from '../crypto.js';
import { readJsonPointer } from '../../../../js/planning/utils.js';

// Draft identity follows the same structural field/entity. A Not sure action
// additionally belongs to the exact brief shown. Neither token reveals a
// module, pointer or revision, and both reproduce after coordinator eviction.
export async function projectTypedBrief({ sessionId, leaseId, brief }) {
  const card = buildTypedCardState(brief);
  const positions = buildTypedCardIndex(brief);
  const index = new Map();
  const scope = ['consumer/typed-card/v1', sessionId, leaseId];
  const briefHash = await sha256Base64Url(stableStringify(brief));
  for (const module of card.modules) for (const field of module.fields) {
    const entry = positions.get(field.id);
    if (!entry) continue;
    const input = brief.directModuleSnapshot.modules.find((item) => item.moduleId === entry.moduleId)?.input;
    const segments = entry.path.split('/');
    const owners = [];
    for (let i = 2; i < segments.length; i += 1) {
      const parent = readJsonPointer(input, segments.slice(0, i).join('/'));
      if (!Array.isArray(parent)) continue;
      const row = parent[Number(segments[i])];
      if (row && typeof row === 'object') {
        owners.push({ id: row.id, ownerId: row.ownerId, title: row.title, label: row.label });
      }
    }
    field.id = `f_${(await sha256Base64Url(stableStringify([...scope, entry, owners]))).slice(0, 32)}`;
    field.unknownFieldId = `u_${(await sha256Base64Url(stableStringify([...scope, briefHash, entry]))).slice(0, 32)}`;
    index.set(field.unknownFieldId, entry);
  }
  return { card, index };
}

/** Read-only recovery shared by the active coordinator and closed-session route.
 * The optional server callback restores bindings from the exact brief projected
 * publicly; native pointers, certificates and provider metadata never leave it.
 */
export async function loadStoredTypedState({ env, sessionId, leaseId, restoreCardIndex }) {
  const [stored, turns] = await Promise.all([
    getConsumerConfig(env).modulePlannerMode === 'apply'
      ? getLatestRealtimeMeetingBrief(env, sessionId, leaseId)
      : null,
    listRecentRealtimeFinalTurns(env, sessionId, leaseId, 200)
  ]);
  const brief = stored?.brief || null;
  const { card, index } = await projectTypedBrief({ sessionId, leaseId, brief });
  if (restoreCardIndex) restoreCardIndex(index);
  return {
    card,
    turns: turns.filter((turn) => ['user', 'assistant'].includes(turn.role))
      .map((turn) => ({ role: turn.role, text: turn.transcript }))
  };
}
