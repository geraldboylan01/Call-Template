import { getVideoModuleKind, resolveModuleForVideo } from './video_scene.js';

export const CODEX_VIDEO_BRIEF_VERSION = 1;

const FORBIDDEN_KEY_PATTERN = /(?:^|[_-])(email|phone|token|password|pin|secret|capability|recovery|r2(?:[_-]?key)?|auth(?:[_-]?hash)?|asset[_-]?id|client[_-]?link|advisor[_-]?link|zoom(?:[_-]?(?:join|meeting|password|url))?|schedule[_-]?(?:response|invite|token))(?:$|[_-])/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SENSITIVE_LABELLED_VALUE_PATTERN = /\b(?:password|token|pin|secret|capability(?:\s+key)?|recovery(?:\s+payload)?|r2\s*key|auth(?:entication)?\s*hash)\b\s*[:=]\s*[^\s<]+/gi;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asTrimmedText(value, fallback = '') {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text || fallback;
}

function redactSensitiveText(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return value
    .replace(EMAIL_PATTERN, '[redacted email]')
    .replace(SENSITIVE_LABELLED_VALUE_PATTERN, '[redacted operational value]')
    .replace(URL_PATTERN, (url) => (
      /zoom\.us|\/app\/session\.html|\/session\.html|[?&](?:token|pin|secret|capability|recovery|auth)=/i.test(url)
        ? '[redacted secure link]'
        : url
    ));
}

function asSafeText(value, fallback = '') {
  return asTrimmedText(redactSensitiveText(value), fallback);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function toSafeKey(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function omitForbiddenFields(value) {
  if (Array.isArray(value)) {
    return value.map(omitForbiddenFields);
  }

  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.entries(value).reduce((safe, [key, child]) => {
    if (FORBIDDEN_KEY_PATTERN.test(toSafeKey(key))) {
      return safe;
    }
    safe[key] = omitForbiddenFields(child);
    return safe;
  }, {});
}

function getOrderedModules(session) {
  const modules = Array.isArray(session?.modules) ? session.modules : [];
  const byId = new Map(modules.map((module) => [module?.id, module]));
  const order = Array.isArray(session?.order) ? session.order : [];
  const ordered = order.map((id) => byId.get(id)).filter(Boolean);
  const orderedIds = new Set(ordered.map((module) => module.id));
  return [...ordered, ...modules.filter((module) => module?.id && !orderedIds.has(module.id))];
}

function normalizeScenarioSelection(activeScenarios, moduleId) {
  const byModule = asObject(activeScenarios);
  const selected = {};
  ['pbsScenarioId', 'pensionScenarioId', 'netRetirementScenarioId'].forEach((key) => {
    const values = byModule[key];
    if (values instanceof Map) {
      selected[key] = asTrimmedText(values.get(moduleId));
      return;
    }
    selected[key] = asTrimmedText(asObject(values)[moduleId]);
  });
  return selected;
}

function getPbsScenarios(generated) {
  const outputsBucketed = asObject(generated?.outputsBucketed);
  const current = {
    id: 'current',
    title: 'Current position',
    summaryHtml: typeof generated?.summaryHtml === 'string' ? generated.summaryHtml : '',
    sections: Array.isArray(outputsBucketed.sections) ? outputsBucketed.sections : [],
    movements: []
  };
  const alternatives = Array.isArray(outputsBucketed.scenarios) ? outputsBucketed.scenarios : [];
  return [current, ...alternatives
    .filter((scenario) => scenario && typeof scenario === 'object')
    .map((scenario) => ({
      id: asTrimmedText(scenario.id),
      title: asTrimmedText(scenario.title, 'Alternative position'),
      summaryHtml: typeof scenario.summaryHtml === 'string' ? scenario.summaryHtml : '',
      sections: Array.isArray(scenario.sections) ? scenario.sections : [],
      movements: Array.isArray(scenario.movements) ? scenario.movements : []
    }))
    .filter((scenario) => scenario.id)];
}

function getMediaAttachments(module) {
  const images = Array.isArray(module?.media?.images) ? module.media.images : [];
  return images
    .filter((image) => image && typeof image === 'object')
    .map((image, index) => ({
      moduleId: asTrimmedText(module?.id),
      imageId: asTrimmedText(image.id, `image-${index + 1}`),
      contentType: asTrimmedText(image.contentType),
      width: Number.isFinite(Number(image.width)) ? Number(image.width) : 0,
      height: Number.isFinite(Number(image.height)) ? Number(image.height) : 0,
      alt: asSafeText(image.alt, 'Module image'),
      attachSeparatelyInCodex: true
    }));
}

function makeClientSlug(value) {
  const slug = asTrimmedText(value, 'client')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
  return slug || 'client';
}

function todayIsoDate(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export function sanitizeCodexVideoClientContext(rawContext, fallbackClientName = 'Client') {
  const raw = asObject(rawContext);
  const rawClient = asObject(raw.client);
  const rawLeads = Array.isArray(raw.leads) ? raw.leads : [];
  const rawTimeline = Array.isArray(raw.timeline) ? raw.timeline : [];

  return {
    source: raw.source === 'client-pipeline' ? 'client-pipeline' : 'advisor-session',
    client: {
      fullName: asSafeText(rawClient.fullName, fallbackClientName),
      pipelineStage: asSafeText(rawClient.pipelineStage),
      pipelineStageLabel: asSafeText(rawClient.pipelineStageLabel),
      advisorNotes: asSafeText(rawClient.advisorNotes),
      createdAt: asTrimmedText(rawClient.createdAt),
      updatedAt: asTrimmedText(rawClient.updatedAt)
    },
    leads: rawLeads.map((lead) => {
      const value = asObject(lead);
      return {
        createdAt: asTrimmedText(value.createdAt),
        updatedAt: asTrimmedText(value.updatedAt),
        reason: asSafeText(value.reason),
        availabilityNotes: asSafeText(value.availabilityNotes),
        advisorNotes: asSafeText(value.advisorNotes),
        stage: asSafeText(value.stage),
        callOutcome: asSafeText(value.callOutcome),
        status: asSafeText(value.status),
        understandsRecordedCall: value.understandsRecordedCall === true,
        understandsEducationalOnly: value.understandsEducationalOnly === true,
        understandsEducationalContent: value.understandsEducationalContent === true,
        source: asSafeText(value.source)
      };
    }),
    timeline: rawTimeline.map((event) => {
      const value = asObject(event);
      return {
        sourceType: asSafeText(value.sourceType),
        actorType: asSafeText(value.actorType),
        eventType: asSafeText(value.eventType),
        createdAt: asTrimmedText(value.createdAt)
      };
    })
  };
}

export function buildCodexVideoBrief({
  session,
  clientContext,
  activeScenarios = {},
  now = new Date()
} = {}) {
  const clientName = asSafeText(session?.clientName, 'Client');
  const resolvedModules = getOrderedModules(session).map((module, index) => {
    const activeScenario = normalizeScenarioSelection(activeScenarios, module.id);
    const resolved = resolveModuleForVideo(module, activeScenario);
    const sourceModule = resolved.module;
    const kind = getVideoModuleKind(sourceModule);
    const generated = omitForbiddenFields(cloneJson(sourceModule.generated || {}));
    const item = {
      order: index + 1,
      id: asTrimmedText(sourceModule.id),
      title: asSafeText(sourceModule.title, `Module ${index + 1}`),
      notes: asSafeText(sourceModule.notes),
      moduleKind: kind.id,
      moduleKindLabel: kind.label,
      activeScenario: omitForbiddenFields(resolved.activeScenario),
      calculationStatus: resolved.calculationStatus,
      calculationError: asTrimmedText(resolved.calculationError),
      generated,
      media: getMediaAttachments(sourceModule)
    };

    if (kind.id === 'balance-sheet') {
      item.availablePbsScenarios = omitForbiddenFields(getPbsScenarios(sourceModule.generated));
    }
    return item;
  });
  const approvedClientContext = sanitizeCodexVideoClientContext(clientContext, clientName);
  const outputDate = todayIsoDate(now);
  const outputDirectory = `private/video-calls/${outputDate}-${makeClientSlug(clientName)}/`;
  const imagesToAttachSeparately = resolvedModules.flatMap((module) => module.media);

  return {
    version: CODEX_VIDEO_BRIEF_VERSION,
    kind: 'planeir.codex-video-brief',
    createdAt: new Date(now).toISOString(),
    reviewRequired: true,
    objectives: {
      privateCall: 'Create a truthful visual aid for the approved client conversation.',
      publicVideo: 'Create a clear public-facing story from approved facts while omitting operational access details.'
    },
    delivery: {
      format: 'single multi-scene 16:9 browser recording page',
      presenterSafeZone: 'right third by default; mirror only when the story requires it',
      outputDirectory,
      requiredFiles: ['index.html', 'storyboard.md', 'source-brief.json', 'quality-review.md'],
      privateLocalOnly: true,
      doNotCommit: true
    },
    privacy: {
      approvedClientDataIncluded: true,
      excludedRegardlessOfConsent: [
        'email and phone numbers',
        'schedule-response tokens and invite identifiers',
        'Zoom passwords, meeting identifiers, and join links',
        'capability keys, authentication hashes, recovery payloads, and R2 keys',
        'PIN data and secure client/advisor links'
      ]
    },
    clientContext: approvedClientContext,
    call: {
      clientName,
      moduleCount: resolvedModules.length,
      modules: resolvedModules
    },
    visualAssets: {
      imagesToAttachSeparately,
      instruction: imagesToAttachSeparately.length > 0
        ? 'Attach the listed local module images separately in Codex before requesting the bespoke page. Asset identifiers and URLs are intentionally omitted.'
        : 'No module images need to be attached separately.'
    }
  };
}

export function buildCodexVideoInstruction(brief) {
  const outputDirectory = asTrimmedText(brief?.delivery?.outputDirectory, 'private/video-calls/<date>-<client-slug>/');
  return `You are the Planeir Codex video director. Create one bespoke visual-first 16:9 HTML/CSS/JS browser recording page from the approved local brief below. Do not call any external AI service or add an API key. Work only in ${outputDirectory}. Create index.html, scoped CSS/JS as needed, storyboard.md, source-brief.json, and quality-review.md.\n\nTell the story with a 3-5 beat sequence: immediate hook, key number or choice, visual explanation, implication, then a quiet return to the presenter. Use charts, comparison, flow, and spatial motion to communicate meaning; keep on-screen copy short. Preserve a clean presenter-safe right third through every scene, unless the brief explicitly requests a mirrored composition. Use only approved data from the brief; public-facing scenes must omit operational details and access information. Make the output recording-ready in a browser at 1920x1080 and responsive at 1280x720.\n\nDesign for YouTube retention, not decoration: the first scene must immediately deliver the title/topic promise; each later scene must introduce a visual change, comparison, reveal, question, or motion beat before the screen feels static. Use purposeful continuous motion when it clarifies the story, such as flowing money paths, risk pulses, timeline sweeps, route highlighting, or chart emphasis. Avoid visual noise, tiny labels, dense text, and motion in the presenter-safe zone.\n\nBefore finishing, run a visible quality loop and document it in quality-review.md. Review every scene at 1920x1080 and 1280x720, preferably by opening the page or using a local browser/screenshot tool when available. Fix and explicitly check: duplicate or colliding Planeir marks; text overlapping lines, charts, cards, or controls; copy or important motion entering the presenter-safe third; illegible text at 1280x720; static dead time after the initial reveal; control UI covering recording content; and any visual mismatch between the brief and the first 30 seconds. If a browser preview tool is unavailable, do deterministic static/layout checks and state that limitation in quality-review.md.\n\nAttach any listed module images separately before using them. Do not invent client facts or financial figures.\n\nCODEX VIDEO BRIEF v${CODEX_VIDEO_BRIEF_VERSION}:\n${JSON.stringify(brief, null, 2)}`;
}

export function getCodexVideoBriefFilename(brief) {
  const name = makeClientSlug(brief?.call?.clientName || brief?.clientContext?.client?.fullName || 'client');
  const date = String(brief?.createdAt || new Date().toISOString()).slice(0, 10);
  return `planeir-codex-video-brief-${date}-${name}.json`;
}
