import { readFile } from 'node:fs/promises';
import {
  buildCodexVideoBrief,
  buildCodexVideoInstruction,
  CODEX_VIDEO_BRIEF_VERSION
} from '../js/codex_video_brief.js';
import { importSession } from '../js/state.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const moduleUiState = importSession({
  version: 1,
  sessionId: 'codex-video-ui-state',
  clientName: 'Client',
  order: ['pbs'],
  activeModuleId: 'pbs',
  modules: [{
    id: 'pbs',
    title: 'Balance sheet',
    generated: { outputsBucketed: { sections: [], scenarios: [] } },
    ui: { pbsScenarioId: 'clear-debt' }
  }]
});
assert(moduleUiState.modules[0].ui.pbsScenarioId === 'clear-debt', 'PBS scenario selection must persist in module UI state.');

const secretValues = [
  'client@example.test',
  '+353-555-0100',
  'schedule-response-private',
  'zoom-password-private',
  'client-capability-private',
  'recovery-private',
  'r2-private',
  'pin-private',
  'secure-client-link-private',
  'module-token-private',
  'asset-private-id',
  'embedded-password-private',
  'secure-link-private'
];

const session = {
  clientName: 'Aisling Example',
  order: ['education', 'pbs'],
  modules: [
    {
      id: 'pbs',
      title: 'Balance sheet decision',
      notes: 'Show the debt trade-off visually. Password: embedded-password-private. https://example.test/app/session.html?token=secure-link-private',
      media: {
        images: [{
          id: 'house-photo',
          assetId: 'asset-private-id',
          contentType: 'image/jpeg',
          width: 1600,
          height: 900,
          alt: 'House exterior'
        }]
      },
      generated: {
        summaryHtml: '<p>Current position.</p>',
        moduleToken: 'module-token-private',
        outputsBucketed: {
          currencySymbol: '€',
          sections: [{ key: 'summary', title: 'Summary', rows: [['Net worth', 300000]] }],
          scenarios: [{
            id: 'clear-debt',
            title: 'Clear debt scenario',
            summaryHtml: '<p>Debt-free position.</p>',
            sections: [{ key: 'summary', title: 'Summary', rows: [['Net worth', 500000]] }],
            movements: [{ action: 'remove', rowLabel: 'Mortgage balance' }]
          }]
        },
        charts: []
      }
    },
    {
      id: 'education',
      title: 'Mortgage overpayment basics',
      notes: 'Explain the repayment path.',
      generated: {
        education: {
          topic: 'Mortgage overpayments',
          metrics: [{ label: 'Illustrative saving', value: '€12,000' }],
          steps: [{ id: 'one', title: 'Review the rate', bodyHtml: '<p>Compare the rate first.</p>' }]
        },
        charts: []
      }
    }
  ]
};

const rawClientContext = {
  source: 'client-pipeline',
  client: {
    fullName: 'Aisling Example',
    pipelineStage: 'session_in_progress',
    pipelineStageLabel: 'Session in progress',
    advisorNotes: 'Focus on clearing expensive debt.',
    email: 'client@example.test',
    phone: '+353-555-0100',
    capabilityKey: 'client-capability-private',
    createdAt: '2026-06-20T10:00:00.000Z'
  },
  leads: [{
    reason: 'Compare debt options.',
    advisorNotes: 'Use the simple visual.',
    understandsRecordedCall: true,
    understandsEducationalOnly: true,
    understandsEducationalContent: true,
    scheduleResponseToken: 'schedule-response-private',
    zoomMeetingPassword: 'zoom-password-private',
    pin: 'pin-private'
  }],
  timeline: [{
    sourceType: 'lead',
    actorType: 'advisor',
    eventType: 'call-confirmed',
    createdAt: '2026-06-21T10:00:00.000Z',
    metadata: { recoveryPayload: 'recovery-private', clientLink: 'secure-client-link-private', r2Key: 'r2-private' }
  }]
};

const brief = buildCodexVideoBrief({
  session,
  clientContext: rawClientContext,
  activeScenarios: { pbsScenarioId: { pbs: 'clear-debt' } },
  now: '2026-06-23T12:00:00.000Z'
});

assert(brief.version === CODEX_VIDEO_BRIEF_VERSION, 'Brief version mismatch.');
assert(brief.reviewRequired === true, 'Brief must require review.');
assert(brief.delivery.requiredFiles.includes('quality-review.md'), 'Brief must require a quality review file.');
assert(brief.call.modules.map((module) => module.id).join(',') === 'education,pbs', 'Brief must preserve session module order.');
assert(brief.call.modules[1].activeScenario.id === 'clear-debt', 'Brief must preserve the selected PBS scenario.');
assert(brief.call.modules[1].availablePbsScenarios.length === 2, 'Brief must include all PBS scenarios.');
assert(brief.visualAssets.imagesToAttachSeparately.length === 1, 'Brief must expose image attachment metadata.');
assert(!Object.hasOwn(brief.visualAssets.imagesToAttachSeparately[0], 'assetId'), 'Brief must not expose private asset ids.');
assert(brief.clientContext.leads[0].reason === 'Compare debt options.', 'Allowlisted lead context was not retained.');
assert(!Object.hasOwn(brief.clientContext.timeline[0], 'metadata'), 'Timeline metadata must never be copied.');

const serialized = JSON.stringify(brief);
secretValues.forEach((value) => {
  assert(!serialized.includes(value), `Brief leaked excluded value: ${value}`);
});

const instruction = buildCodexVideoInstruction(brief);
assert(instruction.includes('private/video-calls/2026-06-23-aisling-example/'), 'Instruction output directory mismatch.');
assert(instruction.includes('single multi-scene 16:9'), 'Instruction must request one multi-scene page.');
assert(instruction.includes('quality-review.md'), 'Instruction must request a quality review file.');
assert(instruction.includes('duplicate or colliding Planeir marks'), 'Instruction must enforce visual QA for brand collisions.');
assert(instruction.includes('static dead time'), 'Instruction must enforce continuous-motion review.');
assert(instruction.includes('manually navigable scenes'), 'Instruction must allow presenter-led manual scene navigation.');
assert(instruction.includes('metric rows and narrative copy sharing the same visual area'), 'Instruction must reject intra-card layout collisions.');
assert(instruction.includes('fixed/risk-free rates'), 'Instruction must preserve nuanced return-study comparisons.');
assert(instruction.includes('derived figure'), 'Instruction must require formula/rationale for derived figures.');
assert(instruction.includes('progress indicators including the last scene'), 'Instruction must enforce progress indicator QA.');
assert(instruction.includes('show that decision before derived implementation mechanics'), 'Instruction must enforce decision-first scene sequencing.');
assert(instruction.includes('define the two endpoints from the real client decision'), 'Instruction must prevent arbitrary middle-ground framing.');

const workerSource = await readFile(new URL('../worker/src/index.js', import.meta.url), 'utf8');
assert(workerSource.includes('buildCodexVideoClientContext'), 'Worker allowlisted video-context mapper is missing.');
assert(workerSource.includes('/codex-video-context'), 'Worker Codex video-context route is missing.');

console.log('Codex video brief checks passed.');
