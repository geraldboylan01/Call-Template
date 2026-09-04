/**
 * WHAT THE SCREEN IS ALLOWED TO SEE.
 *
 * This turns the planner's own state into the compact card Type mode draws.
 * It decides nothing: which modules are relevant, which fields are open, the
 * question for each one and whether the plan is ready are all read straight
 * out of `MeetingBriefV3`. What is added is a label and a control kind, from
 * the display contract, because a JSON pointer cannot be rendered into English.
 *
 * IT IS DELIBERATELY POINTER-FREE ON THE WAY OUT.
 *
 * The card never receives a module id or a native input path, and it does not
 * need to: an answer leaves the browser as a SENTENCE composed from the labels
 * the client just read, travels the same route a typed message does, and the
 * planner reads it. Nothing has to be mapped back. That is what keeps the
 * public projection inside the tier rule -- `withheldOpportunities`, brief
 * signatures, plan nonces, snapshot revisions, module ids and pointers all stay
 * on the server -- and it is also why there is no second fact write path.
 *
 * A field the display contract does not know falls back to the planner's own
 * question in a plain text box. That is never wrong, only less good, and it
 * means a new module field can never leave a client stuck.
 */

import {
  collectionIndexForPointer,
  collectionPathForPointer,
  describeAssumption,
  describeModuleCollection,
  describeModuleField,
  isHiddenModulePath,
  moduleDisplayTitle
} from '../../../../js/planning/module_input_display.js';

/** Bounded so one runaway snapshot cannot produce an unusable wall of inputs. */
const MAX_FIELDS_PER_MODULE = 12;
const MAX_ROWS_PER_COLLECTION = 12;
const MAX_MODULES = 3;

function readPointer(target, pointer) {
  const tokens = String(pointer || '').split('/').slice(1)
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = target;
  for (const token of tokens) {
    if (node === null || typeof node !== 'object') return undefined;
    node = Array.isArray(node) ? node[Number(token)] : node[token];
  }
  return node;
}

/**
 * A value, rendered the way the client gave it.
 *
 * `rate` is the one that matters: the engines store a fraction and a client
 * says "six percent". Showing 0.06 back to someone who said 6% reads like a
 * mistake even when the maths is right.
 */
function renderValue(value, kind) {
  if (value === null || value === undefined || value === '') return '';
  if (kind === 'rate') {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return `${Number((number * 100).toFixed(2))}%`;
  }
  if (kind === 'money') {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return `€${number.toLocaleString('en-IE', { maximumFractionDigits: 0 })}`;
  }
  if (kind === 'boolean') return value === true ? 'Yes' : 'No';
  return String(value).slice(0, 120);
}

function fieldId(prefix, index) {
  return `${prefix}${index}`;
}

/**
 * One module's card.
 *
 * `known` is what the planner has evidence for, so a client sees their own
 * answers reflected rather than being asked again. `fields` is exactly what it
 * still needs -- never more, and never a field the module did not ask for.
 */
function describeModule(item, index) {
  const moduleId = String(item?.moduleId || '');
  const title = moduleDisplayTitle(moduleId);
  if (!title) return null;
  const input = item?.input && typeof item.input === 'object' ? item.input : {};
  const missing = Array.isArray(item?.missing) ? item.missing : [];
  const missingPaths = new Set(missing.map((need) => String(need?.path || '')));

  // KNOWN VALUES COME FROM THE PLANNER'S OWN EVIDENCE, not from whatever
  // happens to be present in the input. A value the planner could not support
  // is not something to show back as established.
  const evidencePaths = [...new Set((Array.isArray(item?.evidence) ? item.evidence : [])
    .map((entry) => String(entry?.path || ''))
    .filter(Boolean))];

  const known = [];
  for (const path of evidencePaths) {
    if (missingPaths.has(path) || isHiddenModulePath(path)) continue;
    const descriptor = describeModuleField(moduleId, path);
    if (!descriptor) continue;
    const display = renderValue(readPointer(input, path), descriptor.kind);
    if (!display) continue;
    const collectionPath = collectionPathForPointer(path);
    known.push({
      id: fieldId(`k${index}_`, known.length),
      label: descriptor.label,
      value: display,
      ...(collectionPath ? {
        group: describeModuleCollection(moduleId, collectionPath)?.path
          ? collectionPath.replace('/', '')
          : '',
        row: collectionIndexForPointer(path)
      } : {})
    });
    if (known.length >= MAX_FIELDS_PER_MODULE * 2) break;
  }

  const fields = [];
  for (const need of missing.slice(0, MAX_FIELDS_PER_MODULE)) {
    const path = String(need?.path || '');
    if (!path || isHiddenModulePath(path)) continue;
    const descriptor = describeModuleField(moduleId, path);
    const collectionPath = collectionPathForPointer(path);
    const collectionSpec = collectionPath ? describeModuleCollection(moduleId, collectionPath) : null;
    fields.push({
      id: fieldId(`f${index}_`, fields.length),
      // The planner's own client-safe question is the label of record when the
      // display contract has nothing to say about this path.
      label: descriptor?.label || '',
      kind: descriptor?.kind || 'text',
      ...(descriptor?.options ? { options: descriptor.options.map((option) => ({ ...option })) } : {}),
      question: String(need?.question || '').slice(0, 500),
      why: String(need?.reason || '').slice(0, 500),
      ...(collectionSpec ? {
        group: collectionPath.replace('/', ''),
        row: Math.min(collectionIndexForPointer(path), MAX_ROWS_PER_COLLECTION)
      } : {})
    });
  }

  const collections = Object.values(
    Object.fromEntries(
      [...new Set([...fields, ...known].map((entry) => entry.group).filter(Boolean))]
        .map((group) => {
          const spec = describeModuleCollection(moduleId, `/${group}`);
          return [group, spec ? { group, addLabel: spec.addLabel, noneLabel: spec.noneLabel } : null];
        })
        .filter(([, value]) => value)
    )
  );

  const assumptions = [...new Set((Array.isArray(item?.assumptions) ? item.assumptions : [])
    .map((entry) => describeAssumption(entry?.path))
    .filter(Boolean))];

  return {
    id: `m${index}`,
    title,
    status: ['collecting', 'needs_clarification', 'ready'].includes(item?.status) ? item.status : 'collecting',
    // WHOSE IDEA THIS WAS. Telling someone they asked for an analysis they
    // never mentioned is a small lie about their own conversation.
    origin: item?.selection?.origin === 'client_requested' ? 'client_requested' : 'planeir_suggested',
    reason: String(item?.selection?.reason || '').slice(0, 400),
    known,
    fields,
    collections,
    assumptions,
    ambiguities: (Array.isArray(item?.ambiguities) ? item.ambiguities : [])
      .slice(0, 4)
      .map((entry, position) => ({
        id: fieldId(`a${index}_`, position),
        question: String(entry?.question || '').slice(0, 500)
      }))
      .filter((entry) => entry.question)
  };
}

/**
 * The whole card state for one typed turn.
 *
 * Returns `{ modules: [] }` whenever there is nothing useful to draw, which is
 * the common case early in a conversation and is exactly right: the screen
 * stays a conversation until the planner has something worth showing.
 */
export function buildTypedCardState(brief) {
  if (!brief || brief.schemaVersion !== 'MeetingBriefV3') return { modules: [] };
  const snapshot = brief.directModuleSnapshot;
  const modules = (Array.isArray(snapshot?.modules) ? snapshot.modules : [])
    .filter((item) => item?.status !== 'not_relevant')
    .slice(0, MAX_MODULES)
    .map(describeModule)
    .filter(Boolean)
    // A ready module with nothing outstanding is a line, not a card. Only the
    // module actually being collected for needs to be expanded.
    .map((module, index) => ({ ...module, expanded: index === 0 && module.fields.length > 0 }));

  return {
    modules,
    // The certified prompt is delivered as an assistant turn by the Durable
    // Object, never from here. This flag only tells the screen to present the
    // review calmly; it carries no authority and no token.
    readyToConfirm: brief.readyToConfirm === true
  };
}

/**
 * The server's private key to the card it just drew: field id -> what it means.
 *
 * This is the other half of keeping the screen pointer-free. The client sends
 * back an opaque id it was given; only the side that built the card can say
 * which module and which native path that id stood for, and it can only ever
 * resolve an id it actually issued.
 */
export function buildTypedCardIndex(brief) {
  const index = new Map();
  if (!brief || brief.schemaVersion !== 'MeetingBriefV3') return index;
  const modules = (Array.isArray(brief.directModuleSnapshot?.modules) ? brief.directModuleSnapshot.modules : [])
    .filter((item) => item?.status !== 'not_relevant')
    .slice(0, MAX_MODULES);
  modules.forEach((item, moduleIndex) => {
    const moduleId = String(item?.moduleId || '');
    if (!moduleDisplayTitle(moduleId)) return;
    let position = 0;
    for (const need of (Array.isArray(item?.missing) ? item.missing : []).slice(0, MAX_FIELDS_PER_MODULE)) {
      const path = String(need?.path || '');
      if (!path || isHiddenModulePath(path)) continue;
      index.set(fieldId(`f${moduleIndex}_`, position), { moduleId, path });
      position += 1;
    }
  });
  return index;
}
