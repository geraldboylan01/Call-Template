import { getAiConsent, getConsumerInvite, hasCurrentVoiceConsent } from './store.js';
import { isSubscriptionAssistCohort } from './subscription_assist.js';

const STAGE_GROUPS = [
  {
    id: 'conversation',
    label: 'Your goals',
    stages: [
      'consent',
      'goal_discovery',
      'household',
      'income',
      'assets',
      'liabilities',
      'expenses',
      'goal_specific_questions'
    ]
  },
  { id: 'review', label: 'Review', stages: ['review'] },
  {
    id: 'recommendations',
    label: 'Your plan',
    stages: ['module_recommendation', 'missing_information', 'analysis']
  },
  { id: 'results', label: 'Results', stages: ['results'] },
  { id: 'handoff', label: 'Next step', stages: ['human_handoff'] }
];

const GROUP_LABELS = Object.freeze({
  primaryPerson: 'About you',
  partner: 'Your partner',
  dependants: 'Dependants',
  goals: 'Your goals',
  incomeSources: 'Income',
  expenses: 'Spending',
  assets: 'Savings and assets',
  liabilities: 'Mortgages and loans',
  pensions: 'Pensions',
  properties: 'Property',
  businesses: 'Business interests',
  preferences: 'Preferences',
  assumptions: 'Planning assumptions'
});

const MODULE_LABELS = Object.freeze({
  liquidity_analysis: 'Liquidity analysis',
  house_purchase: 'House purchase planner',
  pension_projection: 'Pension projection',
  net_retirement_cashflow: 'Net retirement cash flow',
  mortgage_analysis: 'Mortgage analysis',
  college_funding: 'College funding',
  retirement_goal_analysis: 'Retirement goal analysis',
  scenario_analysis: 'Scenario analysis'
});

const INTERNAL_FIELD_KEYS = new Set([
  'profileId',
  'schemaVersion',
  'revision',
  'source',
  'createdAt',
  'updatedAt',
  'confirmedAt',
  'fieldMetadata',
  'missingInformation',
  'consent',
  'calculationDateIso',
  'completionFacts',
  'riskDiscussionCompleted',
  'role',
  'ownerIds',
  'type',
  'currency',
  'liquid',
  'status',
  'priority',
  'employmentStatus',
  'baseCurrency'
]);

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null && text !== '') {
    node.textContent = String(text);
  }
  return node;
}

function append(parent, ...children) {
  children.flat().filter(Boolean).forEach((child) => parent.append(child));
  return parent;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function humanise(value) {
  const clean = String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'Detail';
}

function safeDate(value, options = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat('en-IE', options).format(date);
}

function formatPrimitive(value, { path = '', parent = null, format = '' } = {}) {
  if (value === null || value === undefined || value === '') {
    return 'Not provided';
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'number') {
    const key = path.split('/').pop()?.toLowerCase() || '';
    const currency = typeof parent?.currency === 'string' ? parent.currency : 'EUR';
    if (format === 'currency' || key === 'amount') {
      return new Intl.NumberFormat('en-IE', {
        style: 'currency',
        currency,
        maximumFractionDigits: 0
      }).format(value);
    }
    if (format === 'percent') {
      return new Intl.NumberFormat('en-IE', {
        style: 'percent',
        maximumFractionDigits: 1
      }).format(Math.abs(value) <= 1 ? value : value / 100);
    }
    if (format === 'months') {
      return `${new Intl.NumberFormat('en-IE', { maximumFractionDigits: 1 }).format(value)} months`;
    }
    return new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(value);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) {
    return safeDate(value, { day: 'numeric', month: 'short', year: 'numeric' }) || value;
  }
  if (typeof value === 'string' && /[_-]/.test(value)) {
    return humanise(value);
  }
  return String(value);
}

function getStage(session) {
  return String(firstDefined(session?.stage, session?.conversationStage, 'goal_discovery'));
}

function getViewIndex(view) {
  const index = STAGE_GROUPS.findIndex((group) => group.id === view);
  return index >= 0 ? index : 0;
}

function getProgressPercent(view) {
  const index = getViewIndex(view);
  return Math.round(((index + 1) / STAGE_GROUPS.length) * 100);
}

export function getAvailableViews(currentState) {
  const stage = getStage(currentState.session);
  const currentRevision = Number(firstDefined(
    currentState.session?.currentProfileRevision,
    currentState.session?.profileRevision,
    currentState.profile?.revision,
    0
  ) || 0);
  const analysisRevision = Number(currentState.analysis?.profileRevision || 0);
  const confirmedRevision = Number(currentState.session?.confirmedProfileRevision || 0);
  const hasCompletedResults = currentRevision > 0
    && analysisRevision === currentRevision
    && ['complete', 'partial'].includes(String(currentState.analysis?.status || ''))
    && getResultItems(currentState.analysis).length > 0;
  const planSlots = asArray(currentState.analysisPlan?.moduleSlots);
  const hasCompletedAdviserReviewPlan = currentRevision > 0
    && Number(currentState.analysisPlan?.profileRevision || 0) === currentRevision
    && String(currentState.analysisPlan?.status || '') === 'complete'
    && asArray(currentState.analysisPlan?.moduleIds).length === 0
    && planSlots.length === 3
    && planSlots.every((slot) => slot?.availability === 'adviser_review_required');
  const hasCompletedOutcome = hasCompletedResults || hasCompletedAdviserReviewPlan;
  const profileConfirmed = currentRevision > 0 && confirmedRevision === currentRevision;
  return {
    conversation: true,
    review: Boolean(currentState.profile),
    recommendations: profileConfirmed,
    results: hasCompletedOutcome,
    handoff: hasCompletedOutcome && currentState.bootstrap?.handoffEnabled === true
  };
}

function createConsentRefreshBanner(currentState) {
  const needsNewInvite = currentState.bootstrap?.inviteRequired === true && !getConsumerInvite();
  const banner = element('section', 'empty-state policy-refresh-banner');
  banner.setAttribute('role', 'status');
  append(
    banner,
    element('p', 'section-kicker', 'Processing paused'),
    element('h2', '', 'The planning disclosure has changed'),
    element(
      'p',
      '',
      needsNewInvite
        ? 'Your saved information and any matching results remain read-only, and the live Planéir meeting is paused. You may delete this session, but a new valid invitation link is required to start another. AI withdrawal and adviser-handoff withdrawal remain available under Privacy controls.'
        : 'Your saved information and any matching results remain read-only, and the live Planéir meeting is paused. Start again under the current disclosure or delete this session. AI withdrawal and adviser-handoff withdrawal remain available under Privacy controls.'
    )
  );
  const remove = element(
    'button',
    'primary-button destructive',
    needsNewInvite ? 'Delete this saved session' : 'Delete and start again'
  );
  remove.type = 'button';
  remove.dataset.action = 'open-delete-dialog';
  banner.append(remove);
  return banner;
}

function createProgressNav(currentState) {
  const wrapper = element('div');
  const nav = element('ol', 'progress-nav');
  const viewIndex = getViewIndex(currentState.view);
  const available = getAvailableViews(currentState);

  STAGE_GROUPS.forEach((step, index) => {
    const item = element('li');
    const button = element('button', 'step-button');
    button.type = 'button';
    button.dataset.action = 'navigate';
    button.dataset.view = step.id;
    button.disabled = !available[step.id];
    if (index === viewIndex) {
      button.classList.add('is-current');
      button.setAttribute('aria-current', 'step');
    } else if (index < viewIndex && available[step.id]) {
      button.classList.add('is-complete');
    }

    const indexNode = element(
      'span',
      'step-index',
      index < viewIndex && available[step.id] ? '✓' : String(index + 1)
    );
    indexNode.setAttribute('aria-hidden', 'true');
    append(button, indexNode, element('span', '', step.label));
    item.append(button);
    nav.append(item);
  });

  wrapper.append(nav);
  return wrapper;
}

function createModeCard(currentState) {
  const aiActive = currentState.bootstrap?.aiEnabled === true && getAiConsent();
  const aiUnavailable = currentState.ai?.status === 'unavailable'
    || currentState.ai?.status === 'fallback'
    || currentState.ai?.status === 'rules_only'
    || currentState.ai?.mode === 'rules_only';
  const usesAi = aiActive && !aiUnavailable;
  const card = element('aside', 'journey-aside-card');
  const pill = element('span', `status-pill${usesAi ? '' : ' is-rules'}`, usesAi ? 'AI-assisted intake' : 'Rules-only intake');
  const title = element('strong', '', usesAi ? 'AI organises your words' : 'A structured guided journey');
  const copy = element(
    'p',
    '',
    usesAi
      ? 'AI can extract draft details and ask clearer questions. You confirm every value; tested code, not AI, calculates results.'
      : 'Your answers follow fixed questions and readiness rules. Tested code performs every calculation.'
  );
  append(card, pill, title, copy);
  return card;
}

function createWorkspaceHeading(currentState, kicker, title, description) {
  const wrapper = element('header', 'workspace-heading');
  const copy = element('div');
  append(copy, element('p', 'section-kicker', kicker), element('h1', '', title));
  if (description) {
    copy.append(element('p', '', description));
  }

  const percent = getProgressPercent(currentState.view);
  const progress = element('div', 'progress-meter');
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', 'Planning journey progress');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.setAttribute('aria-valuenow', String(percent));
  const track = element('span', 'progress-track');
  const fill = element('span', `progress-fill progress-${percent}`);
  track.append(fill);
  append(progress, element('span', '', `${percent}%`), track);
  append(wrapper, copy, progress);
  return wrapper;
}

function createModeExplainer(currentState) {
  const usesAi = currentState.bootstrap?.aiEnabled === true && getAiConsent()
    && !['unavailable', 'fallback', 'rules_only'].includes(String(currentState.ai?.status || ''));
  const box = element('div', 'mode-explainer');
  append(
    box,
    element('span', 'mode-mark', usesAi ? 'AI' : '✓'),
    element(
      'span',
      '',
      usesAi
        ? 'AI is helping interpret this conversation. It may make mistakes, so extracted details stay approximate until you review them. All financial outputs come from deterministic calculation code.'
        : 'This session is using rules-only questions. All routing and financial outputs come from deterministic code; no AI is interpreting what you type.'
    )
  );
  return box;
}

function normaliseTurn(turn) {
  if (typeof turn === 'string') {
    return [{ role: 'assistant', text: turn }];
  }
  const item = asObject(turn) || {};
  if (typeof item.userMessage === 'string' || typeof item.assistantMessage === 'string') {
    return [
      { role: 'user', text: String(item.userMessage || '').trim() },
      { role: 'assistant', text: String(item.assistantMessage || '').trim() }
    ].filter((entry) => entry.text);
  }
  const content = firstDefined(item.message, item.text, item.content, item.responseText, '');
  const text = typeof content === 'string'
    ? content
    : String(firstDefined(asObject(content)?.text, asObject(content)?.value, '') || '');
  const rawRole = String(firstDefined(item.role, item.sender, item.author, 'assistant')).toLowerCase();
  const role = ['user', 'consumer', 'human'].includes(rawRole) ? 'user' : 'assistant';
  return [{ role, text: text.trim() }];
}

function normaliseQuestion(question) {
  if (typeof question === 'string') {
    return { prompt: question, reason: '', choices: [] };
  }
  const item = asObject(question) || {};
  const rawChoices = asArray(firstDefined(item.choices, item.options, item.suggestedResponses, item.answers));
  const choices = rawChoices.map((choice) => {
    if (typeof choice === 'string') {
      return choice;
    }
    return String(firstDefined(choice?.label, choice?.text, choice?.value, '') || '');
  }).filter(Boolean);
  return {
    prompt: String(firstDefined(item.prompt, item.question, item.text, item.message, '') || ''),
    reason: String(firstDefined(item.reason, item.helpText, item.context, '') || ''),
    choices
  };
}

function formatVoiceEuro(microEur) {
  const value = Number(microEur);
  if (!Number.isFinite(value) || value < 0) return '—';
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value / 1_000_000);
}

function createVoicePanel(currentState, question) {
  const voice = currentState.voice || {};
  const configuredBudget = voice.budget || currentState.bootstrap?.voiceBudget || {};
  const limitMicroEur = Math.max(0, Number(firstDefined(configuredBudget.limitMicroEur, 2_000_000)) || 0);
  const spentMicroEur = Math.max(0, Number(firstDefined(configuredBudget.spentMicroEur, 0)) || 0);
  const remainingMicroEur = Math.max(0, Number(firstDefined(
    configuredBudget.remainingMicroEur,
    limitMicroEur - spentMicroEur
  )) || 0);
  const consentGranted = hasCurrentVoiceConsent();
  const configured = Boolean(
    currentState.bootstrap?.voiceNoticeId
    && currentState.bootstrap?.voicePolicyVersion
    && currentState.bootstrap?.voicePrivacyNoticeUrl
  );
  const panel = element('aside', 'voice-panel');
  panel.dataset.voicePanel = '';
  panel.setAttribute('aria-labelledby', 'voicePanelTitle');

  const heading = element('div', 'voice-panel-heading');
  const headingCopy = element('div');
  append(
    headingCopy,
    element('p', 'section-kicker', 'Adviser test · voice'),
    element('h3', '', 'Talk, review, then send')
  );
  headingCopy.querySelector('h3').id = 'voicePanelTitle';
  const aiBadge = element('span', 'voice-ai-badge', 'AI-generated voice');
  append(heading, headingCopy, aiBadge);
  panel.append(heading);
  panel.append(element(
    'p',
    'voice-intro',
    'Tap to record up to 45 seconds. Planéir adds the transcript to the same answer box so you can correct every word and figure before choosing Continue.'
  ));

  const budget = element('div', 'voice-budget');
  const budgetRow = element('div', 'voice-budget-row');
  append(
    budgetRow,
    element('strong', '', 'App voice allowance'),
    element('span', '', `${formatVoiceEuro(limitMicroEur)} app allowance · ${formatVoiceEuro(remainingMicroEur)} remaining`)
  );
  budgetRow.lastElementChild.dataset.voiceBudgetText = '';
  const meter = element('meter', 'voice-budget-meter');
  meter.dataset.voiceBudgetMeter = '';
  meter.min = 0;
  meter.max = Math.max(1, limitMicroEur);
  meter.low = Math.max(1, limitMicroEur * 0.2);
  meter.optimum = Math.max(1, limitMicroEur);
  meter.value = Math.min(limitMicroEur, remainingMicroEur);
  meter.setAttribute('aria-label', 'App voice allowance remaining');
  meter.setAttribute('aria-valuetext', `${formatVoiceEuro(remainingMicroEur)} app voice allowance remaining`);
  append(budget, budgetRow, meter, element('small', '', 'Each voice call uses a fixed conservative reservation. The app stops new voice calls at this allowance; typed answers remain available.'));
  panel.append(budget);

  const actions = element('div', 'voice-actions');
  const record = element('button', 'voice-record-button', consentGranted ? 'Tap to talk' : 'Set up voice');
  record.type = 'button';
  record.dataset.action = consentGranted ? 'voice-record' : 'voice-consent';
  record.disabled = currentState.busy || !configured || remainingMicroEur <= 0;
  record.setAttribute('aria-describedby', 'voiceStatus voiceDisclosure');
  record.setAttribute('aria-pressed', 'false');
  const speak = element('button', 'secondary-button voice-speak-button', 'Hear this question');
  speak.type = 'button';
  speak.dataset.action = consentGranted ? 'voice-speak' : 'voice-consent';
  speak.disabled = currentState.busy || !configured || remainingMicroEur <= 0 || !question.prompt;
  speak.setAttribute('aria-describedby', 'voiceDisclosure');
  speak.setAttribute('aria-pressed', 'false');
  append(actions, record, speak);
  const timer = element('span', 'voice-recording-timer', '0:45 remaining');
  timer.dataset.voiceTimer = '';
  timer.hidden = true;
  timer.setAttribute('aria-hidden', 'true');
  actions.append(timer);
  panel.append(actions);

  const status = element(
    'p',
    'voice-status',
    configured
      ? 'Voice never starts automatically. Your transcript stays in the text box until you choose Continue.'
      : 'Voice is temporarily unavailable because its disclosure configuration is incomplete. You can continue by typing.'
  );
  status.id = 'voiceStatus';
  status.dataset.voiceStatus = '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  panel.append(status);

  const disclosure = element('p', 'voice-disclosure');
  disclosure.id = 'voiceDisclosure';
  disclosure.append(
    `${currentState.bootstrap?.voiceAiGeneratedDisclosure || 'The playback voice is AI-generated.'} It reads the current server-owned Planéir question; it does not create financial calculations or advice. `
  );
  const privacy = element('a', '', 'Voice privacy details');
  privacy.href = /^https:\/\//i.test(String(currentState.bootstrap?.voicePrivacyNoticeUrl || ''))
    ? currentState.bootstrap.voicePrivacyNoticeUrl
    : './privacy.html#optional-voice';
  privacy.target = '_blank';
  privacy.rel = 'noopener noreferrer';
  disclosure.append(privacy, '.');
  panel.append(disclosure);
  return panel;
}

function createConversationView(currentState) {
  const section = element('section');
  append(
    section,
    createWorkspaceHeading(
      currentState,
      'Start with what matters',
      'Tell us what you are trying to work out',
      'Write naturally. You do not need financial terminology or every figure to hand.'
    ),
    createModeExplainer(currentState)
  );

  const turns = currentState.turns.flatMap(normaliseTurn).filter((turn) => turn.text);
  const thread = element('div', 'conversation-thread');
  thread.id = 'conversationThread';
  thread.setAttribute('role', 'log');
  thread.setAttribute('aria-live', 'polite');
  thread.setAttribute('aria-relevant', 'additions text');
  thread.setAttribute('aria-label', 'Planning conversation');

  if (turns.length === 0) {
    turns.push({
      role: 'assistant',
      text: 'What financial decision, goal, or worry would you most like to make clearer? Start wherever feels natural.'
    });
  }

  turns.slice(-16).forEach((turn) => {
    const row = element('div', `message-row${turn.role === 'user' ? ' is-user' : ''}`);
    if (turn.role !== 'user') {
      const avatar = element('span', 'message-avatar', 'P');
      avatar.setAttribute('aria-hidden', 'true');
      row.append(avatar);
    }
    const bubble = element('div', 'message-bubble', turn.text);
    bubble.setAttribute('aria-label', `${turn.role === 'user' ? 'You' : 'Planéir'}: ${turn.text}`);
    row.append(bubble);
    thread.append(row);
  });
  section.append(thread);

  const question = normaliseQuestion(currentState.nextQuestion);
  if (question.prompt && question.prompt !== turns.at(-1)?.text) {
    const questionCard = element('section', 'question-card');
    questionCard.setAttribute('aria-labelledby', 'activeQuestion');
    append(questionCard, element('h2', '', question.prompt));
    questionCard.querySelector('h2').id = 'activeQuestion';
    if (question.reason) {
      questionCard.append(element('p', '', question.reason));
    }
    if (question.choices.length > 0) {
      const choices = element('div', 'suggestion-list');
      question.choices.forEach((choice) => {
        const button = element('button', 'chip-button', choice);
        button.type = 'button';
        button.dataset.action = 'send-choice';
        button.dataset.message = choice;
        choices.append(button);
      });
      questionCard.append(choices);
    }
    section.append(questionCard);
  }

  if (currentState.bootstrap?.voiceEnabled === true
    && String(currentState.bootstrap?.cohort || '').toLowerCase() === 'adviser_test') {
    const boundedPanel = createVoicePanel(currentState, question);
    if (currentState.bootstrap?.voiceRealtimeEnabled === true) {
      const fallback = element('details', 'voice-fallback');
      const summary = element('summary', '', 'Prefer a short recording? Use bounded voice');
      fallback.append(summary, boundedPanel);
      section.append(fallback);
    } else {
      section.append(boundedPanel);
    }
  }

  const composer = element('form', 'composer');
  composer.id = 'conversationForm';
  composer.dataset.action = 'send-turn';
  const label = element('label', 'composer-label', question.prompt ? 'Your answer' : 'What is on your mind?');
  label.htmlFor = 'conversationInput';
  const row = element('div', 'composer-row');
  const textarea = element('textarea');
  textarea.id = 'conversationInput';
  textarea.name = 'message';
  textarea.maxLength = Number(firstDefined(
    currentState.bootstrap?.limits?.maxMessageLength,
    currentState.bootstrap?.limits?.maxTurnCharacters
  )) || 3000;
  textarea.placeholder = 'For example: I want to buy my first home in about three years, but I am unsure if my deposit and monthly savings are enough…';
  textarea.required = true;
  textarea.disabled = currentState.busy;
  const send = element('button', 'primary-button', currentState.busy ? 'Thinking…' : 'Continue');
  send.type = 'submit';
  send.disabled = currentState.busy;
  append(row, textarea, send);
  append(composer, label, row, element('p', 'micro-copy', 'Avoid sharing PPS numbers, bank login details, full account numbers, or identity documents. Press Ctrl/Command + Enter to send.'));
  if (isSubscriptionAssistCohort(currentState.bootstrap?.cohort)) {
    const assist = element('aside', 'subscription-assist');
    append(
      assist,
      element('strong', '', 'Use your Codex or ChatGPT subscription (manual)'),
      element('p', '', 'Write a draft above, then copy a bounded prompt. Nothing is sent automatically: review what is copied, paste it into your own Codex or ChatGPT task, and paste the rewritten answer back here.'),
      element('p', 'micro-copy', 'Planéir access credentials are removed from the copied text. Your personal OpenAI workspace has its own privacy and retention settings.')
    );
    const actions = element('div', 'subscription-assist-actions');
    const copy = element('button', 'secondary-button', 'Copy prompt for Codex');
    copy.type = 'button';
    copy.dataset.action = 'copy-subscription-prompt';
    const open = element('a', 'quiet-button', 'Open ChatGPT');
    open.href = 'https://chatgpt.com/';
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    append(actions, copy, open);
    assist.append(actions);
    composer.append(assist);
  }
  section.append(composer);
  return section;
}

function escapePointerSegment(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function findMetadata(profile, path) {
  const metadata = asObject(profile?.fieldMetadata) || {};
  let candidate = path;
  while (candidate) {
    if (asObject(metadata[candidate])) {
      return metadata[candidate];
    }
    candidate = candidate.replace(/\/[^/]+$/, '');
  }
  return null;
}

function fieldItemLabel(containerKey, item, index) {
  const label = String(firstDefined(item?.label, item?.displayName, item?.title, item?.name, '') || '').trim();
  if (label) {
    return label;
  }
  const singular = humanise(String(containerKey || '').replace(/s$/, ''));
  return `${singular} ${index + 1}`;
}

function collectFields(value, path, profile, fields, context = {}) {
  if (value === undefined || value === null || value === '') {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const itemPath = `${path}/${index}`;
      if (item && typeof item === 'object') {
        collectFields(item, itemPath, profile, fields, {
          ...context,
          itemLabel: fieldItemLabel(context.containerKey, item, index)
        });
      } else {
        fields.push({
          path: itemPath,
          label: `${context.itemLabel || humanise(context.containerKey)} ${index + 1}`,
          value: item,
          parent: value,
          metadata: findMetadata(profile, itemPath)
        });
      }
    });
    return;
  }

  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, childValue]) => {
      if (INTERNAL_FIELD_KEYS.has(key) || /(?:^|_)(?:id)$/i.test(key) || /Id$/.test(key)) {
        return;
      }
      const childPath = `${path}/${escapePointerSegment(key)}`;
      if (childValue && typeof childValue === 'object') {
        collectFields(childValue, childPath, profile, fields, {
          ...context,
          containerKey: key,
          parent: value
        });
        return;
      }
      if (childValue === undefined || childValue === null || childValue === '') {
        return;
      }
      const baseLabel = key === 'amount' && context.containerKey
        ? humanise(context.containerKey)
        : humanise(key);
      fields.push({
        path: childPath,
        label: context.itemLabel && !['label', 'displayName', 'title', 'name'].includes(key)
          ? `${context.itemLabel} · ${baseLabel}`
          : baseLabel,
        value: childValue,
        parent: value,
        metadata: findMetadata(profile, childPath)
      });
    });
    return;
  }

  fields.push({
    path,
    label: humanise(path.split('/').pop()),
    value,
    parent: context.parent,
    metadata: findMetadata(profile, path)
  });
}

export function getProfileFieldGroups(profile) {
  const result = [];
  if (!asObject(profile)) {
    return result;
  }
  Object.entries(profile).forEach(([key, value]) => {
    if (INTERNAL_FIELD_KEYS.has(key) || value === undefined || value === null) {
      return;
    }
    const fields = [];
    collectFields(value, `/${escapePointerSegment(key)}`, profile, fields, { containerKey: key });
    if (fields.length > 0) {
      result.push({ key, label: GROUP_LABELS[key] || humanise(key), fields });
    }
  });
  return result;
}

export function findProfileField(profile, path) {
  for (const group of getProfileFieldGroups(profile)) {
    const field = group.fields.find((item) => item.path === path);
    if (field) {
      return field;
    }
  }
  return null;
}

function getCertaintyBadge(metadata) {
  if (!metadata) {
    return null;
  }
  const confirmed = metadata.confirmedByUser === true;
  const certainty = String(metadata.certainty || '').toLowerCase();
  if (certainty === 'approximate') {
    return {
      text: confirmed ? 'Approximate · confirmed' : 'Approximate',
      className: '',
      title: confirmed
        ? 'You confirmed that this remains an approximate value.'
        : 'This was described as an approximate value.'
    };
  }
  if (certainty === 'range') {
    return {
      text: confirmed ? 'Range · confirmed' : 'Range',
      className: '',
      title: 'This was given as a range rather than an exact value.'
    };
  }
  if (certainty === 'inferred') {
    return {
      text: confirmed ? 'Inferred · confirmed' : 'Inferred',
      className: '',
      title: confirmed ? 'You confirmed this inferred value.' : 'This was inferred and needs your review.'
    };
  }
  if (certainty === 'unknown') {
    return { text: 'Unclear', className: '', title: 'This detail is not yet clear.' };
  }
  if (String(metadata.confidence || '').toLowerCase() === 'low') {
    return { text: 'Check this', className: '', title: 'This extraction has low confidence and needs your review.' };
  }
  if (confirmed) {
    return { text: 'Confirmed', className: ' is-confirmed', title: 'You have confirmed this value.' };
  }
  return null;
}

function createReviewField(field, removableItem = null) {
  const row = element('div', 'review-field');
  const valueWrap = element('div', 'field-value-wrap');
  valueWrap.append(element('span', 'field-value', formatPrimitive(field.value, field)));
  const badgeInfo = getCertaintyBadge(field.metadata);
  if (badgeInfo) {
    const badge = element('span', `certainty-badge${badgeInfo.className}`, badgeInfo.text);
    badge.title = badgeInfo.title;
    valueWrap.append(badge);
  }
  const edit = element('button', 'edit-field-button', 'Edit');
  edit.type = 'button';
  edit.dataset.action = 'edit-field';
  edit.dataset.path = field.path;
  edit.setAttribute('aria-label', `Edit ${field.label}`);
  const actions = element('div', 'review-field-actions');
  actions.append(edit);
  if (removableItem) {
    const remove = element('button', 'edit-field-button danger-button', 'Remove item');
    remove.type = 'button';
    remove.dataset.action = 'remove-profile-item';
    remove.dataset.path = removableItem.path;
    remove.dataset.label = removableItem.label;
    remove.setAttribute('aria-label', `Remove ${removableItem.label}`);
    actions.append(remove);
  }
  append(row, element('span', 'field-name', field.label), valueWrap, actions);
  return row;
}

function removableCollectionItem(field, group) {
  const match = /^\/(dependants|assets|liabilities|incomeSources|pensions|properties|businesses|goals)\/(\d+)(?:\/|$)/.exec(field.path);
  if (!match) return null;
  const [, root, index] = match;
  const itemLabel = field.label.includes(' · ') ? field.label.split(' · ')[0] : `${humanise(root.replace(/s$/, ''))} ${Number(index) + 1}`;
  return { path: `/${root}/${index}`, label: itemLabel || group.label };
}

function createMissingPanel(profile) {
  const items = asArray(profile?.missingInformation);
  if (items.length === 0) {
    return null;
  }
  const panel = element('section', 'missing-panel');
  append(panel, element('h2', '', 'Details still worth checking'));
  const list = element('ul', 'plain-list');
  items.forEach((item) => {
    const value = typeof item === 'string'
      ? item
      : String(firstDefined(item?.reason, humanise(String(item?.fieldPath || '').split('/').pop()), 'Missing detail'));
    list.append(element('li', '', value));
  });
  panel.append(list);
  return panel;
}

function createReviewView(currentState) {
  const section = element('section');
  append(
    section,
    createWorkspaceHeading(
      currentState,
      'Nothing runs until you confirm',
      'Review the picture we have built',
      'Correct anything that is wrong. Approximate and inferred values stay clearly marked so results are not given false precision.'
    )
  );

  const groups = getProfileFieldGroups(currentState.profile);
  if (groups.length === 0) {
    const empty = element('section', 'empty-state');
    append(
      empty,
      element('h2', '', 'There are no extracted details to review yet'),
      element('p', '', 'Continue the conversation first. Your answers will appear here before any analysis is run.')
    );
    const back = element('button', 'secondary-button', 'Return to conversation');
    back.type = 'button';
    back.dataset.action = 'navigate';
    back.dataset.view = 'conversation';
    empty.append(back);
    section.append(empty);
    return section;
  }

  const fieldCount = groups.reduce((total, group) => total + group.fields.length, 0);
  const alreadyConfirmed = Boolean(
    currentState.session?.confirmedAt
    || currentState.session?.confirmedProfileRevision
  );
  const toolbar = element('div', 'review-toolbar');
  const copy = element('span', '', alreadyConfirmed
    ? `${fieldCount} ${fieldCount === 1 ? 'detail is' : 'details are'} confirmed for the current analysis revision. Editing any value will require a fresh confirmation.`
    : `${fieldCount} ${fieldCount === 1 ? 'detail' : 'details'} ready for your review. Confirmation freezes the exact revision used for analysis.`);
  const confirm = element(
    'button',
    'primary-button',
    alreadyConfirmed ? 'Continue to my analysis plan' : currentState.busy ? 'Confirming…' : 'Confirm this information'
  );
  confirm.type = 'button';
  confirm.dataset.action = alreadyConfirmed ? 'navigate' : 'confirm-profile';
  if (alreadyConfirmed) {
    confirm.dataset.view = 'recommendations';
  }
  confirm.disabled = currentState.busy;
  append(toolbar, copy, confirm);
  section.append(toolbar);

  const groupHost = element('div', 'review-groups');
  groups.forEach((group) => {
    const card = element('section', 'review-group');
    const header = element('header', 'review-group-header');
    append(header, element('h2', '', group.label), element('span', '', `${group.fields.length} ${group.fields.length === 1 ? 'detail' : 'details'}`));
    const list = element('div', 'review-field-list');
    const shownRemovePaths = new Set();
    group.fields.forEach((field) => {
      const removable = removableCollectionItem(field, group);
      const showRemove = removable && !shownRemovePaths.has(removable.path) ? removable : null;
      if (showRemove) shownRemovePaths.add(showRemove.path);
      list.append(createReviewField(field, showRemove));
    });
    append(card, header, list);
    groupHost.append(card);
  });
  append(section, groupHost, createMissingPanel(currentState.profile));
  return section;
}

function moduleName(item) {
  const id = String(firstDefined(item?.moduleId, item?.id, item?.module?.id, '') || '');
  return String(firstDefined(item?.name, item?.title, item?.moduleName, item?.module?.name, MODULE_LABELS[id], humanise(id)));
}

function normaliseReadiness(item) {
  const readiness = asObject(item?.readiness) || {};
  return String(firstDefined(readiness.status, item?.status, 'recommended'));
}

function createRecommendationCard(item, currentState) {
  const card = element('article', 'recommendation-card');
  const head = element('div', 'recommendation-head');
  const readiness = normaliseReadiness(item);
  const statusClass = readiness === 'ready'
    ? ' is-ready'
    : readiness === 'ready_with_assumptions'
      ? ' is-assumption'
      : '';
  append(head, element('h2', '', moduleName(item)), element('span', `module-status${statusClass}`, humanise(readiness)));
  card.append(head);

  const moduleId = String(firstDefined(item?.moduleId, item?.id, item?.module?.id, '') || '');
  const recommendationStatus = String(firstDefined(item?.status, 'recommended'));
  const required = recommendationStatus === 'required';
  const adviserOnly = readiness === 'adviser_review_required';
  const excluded = recommendationStatus === 'excluded'
    || ['adviser_review_required', 'unsupported', 'not_relevant'].includes(readiness);
  const selectionLabel = element('div', 'module-select-row');
  selectionLabel.dataset.moduleId = moduleId;
  const selectionCopy = element('span');
  append(
    selectionCopy,
    element('strong', '', adviserOnly
        ? 'Included · Gerry review'
        : excluded
          ? 'Included · not automated'
          : required
            ? 'Included · required for this goal'
            : 'Included in this three-analysis plan'),
    element('small', '', adviserOnly
        ? 'This analysis remains in your plan, but Gerry must review it before any result is produced.'
      : excluded
        ? 'This analysis remains visible, but the current readiness rules do not permit an automated result.'
      : required
        ? 'Deterministic planning rules require this slot and it cannot be removed here.'
        : 'This slot was selected by the confirmed persona and goal rules and cannot be removed here.')
  );
  selectionLabel.append(selectionCopy);
  card.append(selectionLabel);

  const description = String(firstDefined(item?.description, item?.module?.description, '') || '');
  if (description) {
    card.append(element('p', 'module-description', description));
  }

  const reasons = asArray(firstDefined(item?.rationale, item?.reasons, item?.selectionReasons, item?.explanation));
  const reasonStrings = reasons.map((reason) => typeof reason === 'string'
    ? reason
    : String(firstDefined(reason?.text, reason?.reason, reason?.message, '') || '')).filter(Boolean);
  if (reasonStrings.length > 0) {
    card.append(element('strong', 'reason-label', 'Why this is included'));
    const list = element('ul', 'reason-list');
    reasonStrings.forEach((reason) => list.append(element('li', '', reason)));
    card.append(list);
  }

  const readinessObject = asObject(item?.readiness) || {};
  const missing = asArray(firstDefined(readinessObject.requiredMissing, item?.missingInformation));
  if (missing.length > 0) {
    card.append(element('strong', 'reason-label', 'Still needed'));
    const list = element('ul', 'reason-list');
    missing.forEach((entry) => list.append(element('li', '', typeof entry === 'string'
      ? entry
      : String(firstDefined(entry?.reason, humanise(String(entry?.fieldPath || '').split('/').pop()), 'More information')))));
    card.append(list);
  }
  const readinessWarnings = asArray(readinessObject.warnings).filter((warning) => typeof warning === 'string' && warning.trim());
  if (readinessWarnings.length > 0) {
    card.append(element('strong', 'reason-label', adviserOnly ? 'Why this needs human review' : 'Important checks'));
    const list = element('ul', 'reason-list warning-list');
    readinessWarnings.forEach((warning) => list.append(element('li', '', warning)));
    card.append(list);
  }
  return card;
}

function createRecommendationsView(currentState) {
  const section = element('section');
  append(
    section,
    createWorkspaceHeading(
      currentState,
      'Selected from your confirmed goals',
      'Review and confirm your analysis plan',
      'Recommendations decide which educational calculators are relevant. AI may suggest a module, but deterministic rules and readiness checks decide what can run. Your final button confirms the displayed profile revision and selected modules together.'
    )
  );

  if (currentState.recommendations.length === 0) {
    const empty = element('section', 'empty-state');
    append(
      empty,
      element('h2', '', 'Your analysis plan is being prepared'),
      element('p', '', 'If more information is needed, return to the conversation. Otherwise confirm your reviewed profile to create the plan.')
    );
    const button = element('button', 'secondary-button', currentState.profile ? 'Review your information' : 'Continue conversation');
    button.type = 'button';
    button.dataset.action = 'navigate';
    button.dataset.view = currentState.profile ? 'review' : 'conversation';
    empty.append(button);
    section.append(empty);
    return section;
  }

  const toolbar = element('div', 'recommendation-toolbar');
  const selectedNeedsInformation = currentState.recommendations.some((item) => {
    const moduleId = String(firstDefined(item?.moduleId, item?.id, item?.module?.id, '') || '');
    return currentState.selectedModuleIds.includes(moduleId)
      && normaliseReadiness(item) === 'missing_information';
  });
  const text = currentState.bootstrap?.routingEnabled === false
    ? 'Analysis is currently paused for this beta cohort. Your reviewed information remains available.'
    : selectedNeedsInformation
      ? 'Answer the remaining questions before running the selected analyses.'
      : 'Every result will use the confirmed profile revision and versioned calculation rules shown in the result.';
  const displayedPlan = asObject(currentState.analysisPlan) || {};
  const displayedRevision = Number(firstDefined(
    currentState.session?.currentProfileRevision,
    currentState.session?.profileRevision,
    currentState.profile?.revision,
    0
  ) || 0);
  const planPrepared = String(displayedPlan.status || '') === 'prepared'
    && Number(displayedPlan.profileRevision || 0) === displayedRevision
    && asArray(displayedPlan.moduleIds).slice().sort().join('|')
      === currentState.selectedModuleIds.slice().sort().join('|');
  const actions = element('div', 'recommendation-actions');
  const addGoal = element(
    'button',
    'secondary-button',
    selectedNeedsInformation ? 'Answer remaining question' : 'Add another goal'
  );
  addGoal.type = 'button';
  addGoal.dataset.action = 'navigate';
  addGoal.dataset.view = 'conversation';
  const hasAuthoritativeThreeSlotPlan = currentState.recommendations.length === 3;
  const runnableCount = currentState.selectedModuleIds.length;
  const run = element(
    'button',
    'primary-button',
    currentState.busy
      ? 'Confirming…'
      : runnableCount > 0 ? 'Confirm profile & run analyses' : 'Confirm profile & save review plan'
  );
  run.type = 'button';
  run.dataset.action = 'run-analysis';
  run.disabled = currentState.busy
    || currentState.bootstrap?.routingEnabled === false
    || !hasAuthoritativeThreeSlotPlan
    || selectedNeedsInformation;
  const adviserReviewCount = currentState.recommendations.filter((item) => (
    normaliseReadiness(item) === 'adviser_review_required'
  )).length;
  const selectionSummary = hasAuthoritativeThreeSlotPlan
    ? `Your authoritative three-analysis plan is shown below. ${runnableCount} ${runnableCount === 1 ? 'analysis will' : 'analyses will'} run automatically.${adviserReviewCount > 0 ? ` ${adviserReviewCount} ${adviserReviewCount === 1 ? 'analysis remains' : 'analyses remain'} included and require${adviserReviewCount === 1 ? 's' : ''} Gerry’s review.` : ''}`
    : `${currentState.selectedModuleIds.length} selected.`;
  append(actions, addGoal, run);
  append(
    toolbar,
    element(
      'span',
      '',
      `${text} ${selectionSummary}${planPrepared ? ` Protected plan prepared for profile revision ${displayedRevision}.` : ' The protected plan will be refreshed before confirmation.'}`
    ),
    actions
  );
  section.append(toolbar);

  const grid = element('div', 'recommendation-grid');
  currentState.recommendations.forEach((item) => grid.append(createRecommendationCard(item, currentState)));
  section.append(grid);
  return section;
}

function getResultItems(analysis) {
  const root = asObject(analysis) || {};
  const nestedResults = asObject(root.results);
  const candidates = firstDefined(
    root.moduleRuns,
    root.moduleResults,
    root.modules,
    Array.isArray(root.results) ? root.results : null,
    nestedResults?.moduleRuns,
    nestedResults?.moduleResults,
    nestedResults?.modules
  );
  if (Array.isArray(candidates)) {
    return candidates;
  }
  if (asObject(candidates)) {
    return Object.entries(candidates).map(([moduleId, value]) => ({ moduleId, ...(asObject(value) || { value }) }));
  }
  if (root.outputs || root.semanticResult || root.highlights || root.summary) {
    return [root];
  }
  return [];
}

function metricFormatFromKey(key, value) {
  const clean = String(key || '').toLowerCase();
  if (/(?:rate|ratio|percent|percentage)$/.test(clean) && typeof value === 'number') {
    return 'percent';
  }
  if (/(?:amount|value|price|cost|deposit|income|payment|saving|savings|cash|capacity|required|balance|shortfall|gap|surplus|affordability|reserve|budget|monthly|annual)/.test(clean)
      && typeof value === 'number') {
    return 'currency';
  }
  return '';
}

function flattenMetrics(value, output, prefix = '', depth = 0) {
  if (output.length >= 10 || depth > 2 || value === null || value === undefined) {
    return;
  }
  if (['string', 'number', 'boolean'].includes(typeof value)) {
    output.push({ label: humanise(prefix), value, format: metricFormatFromKey(prefix, value) });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => ['string', 'number'].includes(typeof item))) {
      output.push({ label: humanise(prefix), value: value.join(', '), format: '' });
    }
    return;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => {
      if (['debug', 'tables', 'charts', 'assumptions', 'warnings', 'code'].includes(key)) {
        return;
      }
      flattenMetrics(child, output, prefix ? `${prefix} · ${key}` : key, depth + 1);
    });
  }
}

function getMetrics(item) {
  const semantic = asObject(item?.semanticResult);
  const currency = String(semantic?.currency || 'EUR');
  if (item?.moduleId === 'liquidity_analysis' && semantic) {
    return [
      { label: 'Current cash', value: semantic.currentCash, format: 'currency', currency },
      { label: 'Spending covered', value: semantic.monthsCovered, format: 'months' },
      { label: 'Target reserve', value: semantic.targetCash, format: 'currency', currency },
      semantic.shortfallCash > 0
        ? { label: 'Cash gap to target', value: semantic.shortfallCash, format: 'currency', currency }
        : { label: 'Cash above target', value: semantic.surplusCash, format: 'currency', currency }
    ].filter((metric) => metric.value !== null && metric.value !== undefined);
  }
  if (item?.moduleId === 'house_purchase' && semantic) {
    return [
      { label: 'Target property price', value: semantic.targetPropertyPrice, format: 'currency', currency },
      { label: 'Current supportable price', value: semantic.currentSupportablePrice, format: 'currency', currency },
      { label: 'Protected-cash gap', value: semantic.currentCashGap, format: 'currency', currency },
      semantic.monthsToReady !== null && semantic.monthsToReady !== undefined
        ? { label: 'Illustrated time to cash-ready', value: semantic.monthsToReady, format: 'months' }
        : { label: 'Illustrated cash-ready date', value: semantic.readyDateIso, format: '' }
    ].filter((metric) => metric.value !== null && metric.value !== undefined && metric.value !== '');
  }
  const rawHighlights = asArray(firstDefined(item?.highlights, item?.summaryMetrics));
  if (rawHighlights.length > 0) {
    return rawHighlights.slice(0, 10).map((metric) => {
      if (typeof metric !== 'object' || metric === null) {
        return { label: 'Result', value: metric, format: '' };
      }
      return {
        label: String(firstDefined(metric.label, metric.name, metric.title, metric.key, 'Result')),
        value: firstDefined(metric.value, metric.amount, metric.text, ''),
        format: String(firstDefined(metric.format, metric.type, '')),
        currency: metric.currency
      };
    });
  }

  const metrics = asObject(item?.metrics);
  const output = [];
  flattenMetrics(firstDefined(metrics, item?.semanticResult, item?.outputs, item?.result), output);
  return output;
}

function createResultCard(item) {
  const result = asObject(item?.result) && !item?.outputs ? { ...item, ...item.result } : item;
  const card = element('article', 'result-card');
  const head = element('div', 'result-head');
  const status = String(firstDefined(result?.status, 'complete'));
  append(
    head,
    element('h2', '', moduleName(result)),
    element('span', `result-status${status === 'complete' || status === 'completed' || status === 'success' ? ' is-complete' : ''}`, humanise(status))
  );
  card.append(head);

  const summary = firstDefined(result?.summary, result?.resultSummary, result?.headline, result?.description);
  if (typeof summary === 'string' && summary.trim()) {
    card.append(element('p', 'result-summary', summary.trim()));
  }

  const metrics = getMetrics(result);
  if (metrics.length > 0) {
    const list = element('dl', 'metric-grid');
    metrics.forEach((metric) => {
      const itemNode = element('div', 'metric-item');
      const formatted = formatPrimitive(metric.value, {
        path: metric.label,
        parent: metric.currency ? { currency: metric.currency } : null,
        format: metric.format
      });
      append(itemNode, element('dt', '', metric.label), element('dd', '', formatted));
      list.append(itemNode);
    });
    card.append(list);
  }

  const warnings = asArray(result?.warnings).map((warning) => typeof warning === 'string'
    ? warning
    : String(firstDefined(warning?.message, warning?.text, warning?.reason, '') || '')).filter(Boolean);
  if (warnings.length > 0) {
    const list = element('ul', 'warning-list');
    warnings.forEach((warning) => list.append(element('li', '', warning)));
    card.append(list);
  }

  const provenance = element('div', 'result-provenance');
  const calculatedAt = firstDefined(result?.calculatedAt, result?.completedAt);
  const calculationVersion = firstDefined(result?.calculationVersion, result?.engineVersion);
  const moduleVersion = result?.moduleVersion;
  if (calculatedAt) {
    provenance.append(element('span', '', `Calculated ${safeDate(calculatedAt, { dateStyle: 'medium', timeStyle: 'short' }) || calculatedAt}`));
  }
  if (calculationVersion) {
    provenance.append(element('span', '', `Calculation version ${calculationVersion}`));
  }
  if (moduleVersion) {
    provenance.append(element('span', '', `Module version ${moduleVersion}`));
  }
  if (provenance.childElementCount > 0) {
    card.append(provenance);
  }
  return card;
}

function collectAssumptions(analysis, resultItems) {
  const entries = [];
  const seen = new Set();
  const addEntry = (label, value, path = '') => {
    if (entries.length >= 24 || value === undefined || value === null || typeof value === 'object') {
      return;
    }
    const cleanLabel = humanise(label);
    const signature = `${cleanLabel}:${String(value)}`;
    if (!seen.has(signature)) {
      seen.add(signature);
      entries.push({ label: cleanLabel, value, path: path || label });
    }
  };
  const addObject = (value, prefix = '') => {
    if (!asObject(value)) {
      return;
    }
    Object.entries(value).forEach(([key, child]) => {
      if (entries.length >= 24) {
        return;
      }
      if (Array.isArray(child) && key === 'rows') {
        child.slice(0, 12).forEach((row) => {
          if (Array.isArray(row) && row.length >= 2) {
            addEntry(prefix ? `${prefix} · ${row[0]}` : row[0], row[1], String(row[0] || key));
          }
        });
        return;
      }
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        addObject(child, prefix ? `${prefix} · ${key}` : key);
        return;
      }
      if (child === undefined || child === null || typeof child === 'object') {
        return;
      }
      addEntry(prefix ? `${prefix} · ${key}` : key, child, key);
    });
  };
  const analysisRoot = asObject(analysis) || {};
  const plan = asObject(firstDefined(analysisRoot.analysisPlan, analysisRoot.plan)) || {};
  addObject(firstDefined(analysisRoot.assumptions, plan.assumptions), 'Plan');
  asArray(plan.selectedModules).forEach((selected) => {
    asArray(selected?.readiness?.assumptionsUsed).forEach((assumption) => {
      addEntry(
        `${moduleName(selected)} · ${firstDefined(assumption?.key, 'Assumption')}`,
        firstDefined(assumption?.value, ''),
        String(firstDefined(assumption?.key, '') || '')
      );
    });
  });
  resultItems.forEach((result) => addObject(asObject(result)?.assumptions, moduleName(result)));
  return entries;
}

function createAssumptionsSection(analysis, resultItems) {
  const assumptions = collectAssumptions(analysis, resultItems);
  if (assumptions.length === 0) {
    return null;
  }
  const section = element('section', 'assumptions-section');
  append(section, element('h2', '', 'Assumptions used'));
  const grid = element('div', 'assumption-grid');
  assumptions.forEach((assumption) => {
    const card = element('article', 'assumption-card');
    append(
      card,
      element('h3', '', assumption.label),
      element('p', '', formatPrimitive(assumption.value, {
        path: assumption.path,
        format: metricFormatFromKey(assumption.path, assumption.value)
      }))
    );
    grid.append(card);
  });
  section.append(grid);
  return section;
}

function createUncertaintyPanel(currentState, resultItems) {
  const messages = [];
  asArray(currentState.profile?.missingInformation).forEach((item) => {
    messages.push(typeof item === 'string'
      ? item
      : String(firstDefined(item?.reason, humanise(String(item?.fieldPath || '').split('/').pop()), 'A profile detail is missing.')));
  });
  resultItems.forEach((item) => {
    asArray(item?.warnings).forEach((warning) => {
      const text = typeof warning === 'string'
        ? warning
        : String(firstDefined(warning?.message, warning?.text, warning?.reason, '') || '');
      if (text) {
        messages.push(text);
      }
    });
  });
  const unique = [...new Set(messages.filter(Boolean))];
  if (unique.length === 0) {
    return null;
  }
  const panel = element('section', 'uncertainty-panel');
  append(panel, element('h2', '', 'Uncertainty and information gaps'));
  const list = element('ul', 'plain-list');
  unique.forEach((message) => list.append(element('li', '', message)));
  panel.append(list);
  return panel;
}

function summaryStrings(value) {
  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      return String(firstDefined(item?.text, item?.message, item?.title, item?.label, '') || '');
    }).filter(Boolean);
  }
  return [];
}

function createOverallSummary(analysis) {
  const summary = firstDefined(analysis?.summary, analysis?.resultSummary);
  if (!summary) {
    return null;
  }
  const card = element('section', 'result-card is-wide');
  const summaryObject = asObject(summary);
  const title = String(firstDefined(summaryObject?.headline, summaryObject?.title, 'What the analysis shows'));
  card.append(element('h2', '', title));
  const narrative = typeof summary === 'string'
    ? summary
    : firstDefined(summaryObject?.summary, summaryObject?.overview, summaryObject?.description);
  if (typeof narrative === 'string' && narrative.trim() && narrative.trim() !== title) {
    card.append(element('p', 'result-summary', narrative.trim()));
  }
  const findings = [
    ...summaryStrings(firstDefined(
      summaryObject?.priorityActions,
      summaryObject?.actions,
      summaryObject?.keyFindings,
      summaryObject?.findings,
      summaryObject?.points,
      summaryObject?.highlights
    )),
    ...summaryStrings(summaryObject?.nextSteps)
  ].filter((item, index, values) => values.indexOf(item) === index);
  if (findings.length > 0) {
    const list = element('ul', 'action-list');
    findings.forEach((finding) => list.append(element('li', '', finding)));
    card.append(list);
  }
  return card;
}

function createAnalysisErrors(analysis) {
  const errors = asArray(analysis?.errors).map((error) => {
    if (typeof error === 'string') {
      return error;
    }
    const module = firstDefined(error?.moduleName, MODULE_LABELS[error?.moduleId], humanise(error?.moduleId || 'Analysis'));
    const message = firstDefined(error?.message, error?.reason, error?.error, 'This analysis could not be completed.');
    return `${module}: ${message}`;
  }).filter(Boolean);
  if (errors.length === 0) {
    return null;
  }
  const panel = element('section', 'error-panel');
  append(
    panel,
    element('h2', '', 'Some analyses could not be completed'),
    element('p', '', 'Completed results are still shown. No missing figure has been guessed or filled by AI.')
  );
  const list = element('ul', 'warning-list');
  errors.forEach((message) => list.append(element('li', '', message)));
  panel.append(list);
  return panel;
}

function adviserReviewModuleSlots(currentState) {
  const persisted = asArray(currentState.analysisPlan?.moduleSlots)
    .filter((slot) => slot?.availability === 'adviser_review_required');
  if (persisted.length > 0) return persisted.slice(0, 3);
  return asArray(currentState.recommendations)
    .filter((item) => normaliseReadiness(item) === 'adviser_review_required')
    .map((item, index) => ({
      slot: Number(item?.slot || index + 1),
      moduleId: String(firstDefined(item?.moduleId, item?.id, item?.module?.id, '') || ''),
      availability: 'adviser_review_required'
    }))
    .filter((slot) => slot.moduleId)
    .slice(0, 3);
}

function createAdviserReviewOutcome(currentState) {
  const slots = adviserReviewModuleSlots(currentState);
  if (slots.length === 0) return null;
  const panel = element('section', 'uncertainty-panel adviser-review-outcome');
  append(
    panel,
    element('h2', '', slots.length === 3 ? 'Three-analysis plan saved for review' : 'Part of this plan requires Gerry’s review'),
    element(
      'p',
      '',
      slots.length === 3
        ? 'No automated financial result was produced for these analyses. They remain in your confirmed plan and can be shared with Gerry only if you separately choose and consent.'
        : 'The released analyses were calculated above. The analyses below remain in the same confirmed three-analysis plan, but no automated result was produced for them.'
    )
  );
  const list = element('ul', 'plain-list');
  slots.forEach((slot) => {
    const definition = { moduleId: slot.moduleId };
    list.append(element('li', '', `${moduleName(definition)} — Gerry review required`));
  });
  panel.append(list);
  return panel;
}

function createResultsView(currentState) {
  const adviserReviewSlots = adviserReviewModuleSlots(currentState);
  const gatedOnly = adviserReviewSlots.length === 3 && getResultItems(currentState.analysis).length === 0;
  const section = element('section');
  append(
    section,
    createWorkspaceHeading(
      currentState,
      gatedOnly ? 'Confirmed three-analysis plan' : 'Calculated from your confirmed information',
      gatedOnly ? 'Your plan is ready for adviser review' : 'Your educational analysis',
      gatedOnly
        ? 'These analyses are not released for automated calculation. Nothing has been calculated or shared with Gerry.'
        : 'These results are illustrations, not approvals or recommendations. Check the assumptions and uncertainties before relying on any figure.'
    )
  );

  const toolbar = element('div', 'results-toolbar');
  const text = element('span', '', gatedOnly
    ? 'Your authoritative three-module selection is saved. You decide whether to send the reviewed package to Gerry.'
    : 'AI does not calculate or change these numbers. Versioned deterministic engines produce the outputs shown below.');
  const next = element('button', 'primary-button', currentState.bootstrap?.handoffEnabled ? 'Discuss this with Gerry' : 'Review my information');
  next.type = 'button';
  next.dataset.action = 'navigate';
  next.dataset.view = currentState.bootstrap?.handoffEnabled ? 'handoff' : 'review';
  append(toolbar, text, next);
  section.append(toolbar);

  const resultItems = getResultItems(currentState.analysis);
  if (resultItems.length === 0) {
    if (gatedOnly) {
      append(section, createAdviserReviewOutcome(currentState));
    } else {
      const empty = element('section', 'empty-state');
      append(
        empty,
        element('h2', '', 'No completed result was returned'),
        element('p', '', 'Your profile remains safe. Return to your analysis plan and try the calculation again.')
      );
      const retry = element('button', 'secondary-button', 'Return to analysis plan');
      retry.type = 'button';
      retry.dataset.action = 'navigate';
      retry.dataset.view = 'recommendations';
      empty.append(retry);
      append(section, createAnalysisErrors(currentState.analysis), empty);
    }
    return section;
  }

  const stack = element('div', 'result-stack');
  append(
    stack,
    createOverallSummary(currentState.analysis),
    createAnalysisErrors(currentState.analysis),
    createAdviserReviewOutcome(currentState)
  );
  resultItems.forEach((item) => stack.append(createResultCard(item)));
  append(stack, createAssumptionsSection(currentState.analysis, resultItems), createUncertaintyPanel(currentState, resultItems));
  section.append(stack);
  return section;
}

function isSafeBookingUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : '';
  } catch (_error) {
    return '';
  }
}

function handoffSucceeded(handoff) {
  const status = String(firstDefined(handoff?.status, '')).toLowerCase();
  return Boolean(handoff?.leadId || ['linked', 'delivered'].includes(status));
}

function createHandoffPending(currentState) {
  const status = String(currentState.handoff?.status || 'pending');
  const failed = status === 'failed';
  const panel = element('section', failed ? 'empty-state' : 'success-panel');
  append(
    panel,
    element('p', 'section-kicker', failed ? 'Delivery paused' : 'Secure delivery in progress'),
    element('h2', '', failed ? 'Your saved request has not reached Gerry yet' : 'Your request is safely queued'),
    element('p', '', failed
      ? 'The original contact details and requested-help note are still encrypted. Retry sends that same consented request; it does not replace it with new text.'
      : 'Please wait a moment, then refresh the saved status. Do not submit a second request.')
  );
  const action = element('button', 'primary-button', failed ? 'Retry the saved request' : 'Refresh delivery status');
  action.type = 'button';
  action.dataset.action = failed ? 'retry-handoff' : 'refresh-session';
  panel.append(action);
  return panel;
}

function createHandoffSuccess(currentState) {
  const panel = element('section', 'success-panel');
  append(
    panel,
    element('p', 'section-kicker', 'Shared with your permission'),
    element('h2', '', 'Your request has been sent to Gerry'),
    element('p', '', 'Gerry can now follow up using the contact details and requested-help note you chose to share. Your free results remain available here.')
  );
  const actions = element('div', 'success-actions');
  const results = element('button', 'secondary-button', 'Return to my results');
  results.type = 'button';
  results.dataset.action = 'navigate';
  results.dataset.view = 'results';
  actions.append(results);

  const bookingUrl = isSafeBookingUrl(currentState.bootstrap?.bookingUrl);
  if (bookingUrl) {
    const booking = element('a', 'primary-button booking-link', 'Optionally choose a time');
    booking.href = bookingUrl;
    booking.target = '_blank';
    booking.rel = 'noopener noreferrer';
    actions.append(booking);
    panel.append(element('p', 'form-note', 'Booking is optional and is not required to keep or view your free analysis.'));
  }
  panel.append(actions);
  return panel;
}

function createHandoffView(currentState) {
  const section = element('section');
  append(
    section,
    createWorkspaceHeading(
      currentState,
      'Optional human help',
      'Ask Gerry to help you explore the next step',
      'Your free analysis is complete. Sharing it is optional and needs a separate, explicit consent.'
    )
  );

  if (!currentState.bootstrap?.handoffEnabled) {
    const unavailable = element('section', 'empty-state');
    append(
      unavailable,
      element('h2', '', 'Human handoff is not active for this beta'),
      element('p', '', 'Your results remain available. Nothing has been shared with Gerry.')
    );
    const back = element('button', 'secondary-button', 'Return to results');
    back.type = 'button';
    back.dataset.action = 'navigate';
    back.dataset.view = 'results';
    unavailable.append(back);
    section.append(unavailable);
    return section;
  }

  if (handoffSucceeded(currentState.handoff)) {
    section.append(createHandoffSuccess(currentState));
    return section;
  }
  if (currentState.handoff && ['revoked', 'purged'].includes(String(currentState.handoff.status))) {
    const withdrawn = element('section', 'empty-state');
    append(
      withdrawn,
      element('p', 'section-kicker', 'Handoff withdrawn'),
      element('h2', '', 'No saved package is waiting to be delivered'),
      element('p', '', 'The encrypted bridge copy has been purged. If information had already reached Gerry, contact hello@planeir.ie about that separate adviser record.')
    );
    const back = element('button', 'secondary-button', 'Return to results');
    back.type = 'button';
    back.dataset.action = 'navigate';
    back.dataset.view = 'results';
    withdrawn.append(back);
    section.append(withdrawn);
    return section;
  }
  if (currentState.handoff && ['pending', 'linking', 'failed'].includes(String(currentState.handoff.status))) {
    section.append(createHandoffPending(currentState));
    return section;
  }

  const grid = element('div', 'handoff-grid');
  const shareCard = element('aside', 'handoff-share-card');
  append(
    shareCard,
    element('h3', '', 'What Gerry will receive'),
    element('p', '', 'Only the contact details and requested-help note you enter below, plus a minimal consent receipt. Your profile and calculation results are not automatically copied into the adviser pipeline.')
  );
  const shareList = element('ul', 'share-list');
  [
    'Your full name and email address',
    'Your phone number, only if you choose to enter one',
    'The help you request below',
    'A consent receipt and a non-financial analysis/revision reference'
  ].forEach((item) => shareList.append(element('li', '', item)));
  shareCard.append(shareList);
  shareCard.append(element('p', '', 'This does not opt you into marketing, recommend a product, or make Gerry’s follow-up a condition of your free results.'));
  shareCard.append(element('p', '', 'This beta uses no adviser marketplace, bidding, sponsored ranking, or automatic matching. The chosen recipient is Gerry Boylan.'));
  const handoffPolicyUrl = isSafeBookingUrl(currentState.bootstrap?.handoffPolicyUrl);
  if (handoffPolicyUrl) {
    const policyCopy = element('p');
    policyCopy.append('The encrypted bridge package and the separate adviser lead have different retention boundaries. Read the ');
    const policyLink = element('a', '', 'handoff data and retention policy');
    policyLink.href = handoffPolicyUrl;
    policyLink.target = '_blank';
    policyLink.rel = 'noopener noreferrer';
    policyCopy.append(policyLink, ' before sharing.');
    shareCard.append(policyCopy);
  }

  const formCard = element('div', 'handoff-form-card');
  formCard.append(element('h3', '', 'Your contact and request'));
  const form = element('form');
  form.id = 'handoffForm';
  form.dataset.action = 'create-handoff';
  const formGrid = element('div', 'form-grid');

  const fields = [
    { name: 'fullName', label: 'Full name', type: 'text', autocomplete: 'name', required: true },
    { name: 'email', label: 'Email', type: 'email', autocomplete: 'email', required: true },
    { name: 'phone', label: 'Phone', type: 'tel', autocomplete: 'tel', required: false }
  ];
  fields.forEach((config) => {
    const wrapper = element('label', 'form-field');
    wrapper.append(element('span', 'field-label', config.label));
    const input = element('input', 'text-input');
    input.name = config.name;
    input.type = config.type;
    input.autocomplete = config.autocomplete;
    input.required = config.required;
    input.maxLength = config.name === 'fullName' ? 120 : 200;
    input.disabled = currentState.busy;
    wrapper.append(input);
    formGrid.append(wrapper);
  });

  const helpWrapper = element('label', 'form-field is-wide');
  helpWrapper.append(element('span', 'field-label', 'What would you like Gerry’s help with?'));
  const textarea = element('textarea', 'text-area');
  textarea.name = 'requestedHelp';
  textarea.required = true;
  textarea.maxLength = 2000;
  textarea.disabled = currentState.busy;
  helpWrapper.append(textarea);
  formGrid.append(helpWrapper);
  form.append(formGrid);

  const consentLabel = element('label', 'check-row handoff-consent');
  const consent = element('input');
  consent.type = 'checkbox';
  consent.name = 'handoffConsent';
  consent.required = true;
  consent.disabled = currentState.busy;
  const consentCopy = element('span');
  append(
    consentCopy,
    element('strong', '', 'I consent to send this reviewed package to Gerry Boylan'),
    element('small', '', 'I understand exactly what will be shared and that I can keep my free results without sharing it.')
  );
  append(consentLabel, consent, consentCopy);
  form.append(consentLabel);
  const retentionDays = Number(currentState.bootstrap?.handoffRetentionDays || 0);
  form.append(element(
    'p',
    'form-note',
    `An email address is required so Gerry can respond; a phone number is optional. This consent is for this handoff only.${retentionDays ? ` The encrypted bridge package is purged after ${retentionDays} days; the linked adviser record follows the separate policy above.` : ''}`
  ));
  const submit = element('button', 'primary-button', currentState.busy ? 'Sending securely…' : 'Send my request to Gerry');
  submit.type = 'submit';
  submit.disabled = currentState.busy;
  form.append(submit);
  formCard.append(form);
  append(grid, shareCard, formCard);
  section.append(grid);
  return section;
}

function createCurrentView(currentState) {
  switch (currentState.view) {
    case 'review':
      return createReviewView(currentState);
    case 'recommendations':
      return createRecommendationsView(currentState);
    case 'results':
      return createResultsView(currentState);
    case 'handoff':
      return createHandoffView(currentState);
    case 'conversation':
    default:
      return createConversationView(currentState);
  }
}

export function renderOnboarding(root, bootstrap, { busy = false, error = '' } = {}) {
  root.replaceChildren();
  const shell = element('section', 'onboarding-shell');
  const copy = element('div', 'onboarding-copy');
  append(
    copy,
    element('p', 'section-kicker', 'A private, guided financial education journey'),
    element('h1', '', 'See the shape of your next financial step.'),
    element('p', 'onboarding-intro', 'Start with the question on your mind. Planéir will organise the relevant facts, let you review every detail, and run only tested educational calculations that fit your goal.')
  );
  const trust = element('div', 'trust-grid');
  [
    ['01', 'You stay in control', 'Nothing is treated as confirmed until you review it. You can correct or delete the session.'],
    ['02', 'Clear about AI', 'AI may organise your words if you opt in. It never calculates your financial outputs.'],
    ['03', 'No hidden handoff', 'Nothing is sent to Gerry unless you separately choose and consent after seeing your results.']
  ].forEach(([index, title, description]) => {
    const item = element('article', 'trust-item');
    append(item, element('span', 'trust-icon', index), element('strong', '', title), element('p', '', description));
    trust.append(item);
  });
  copy.append(trust);

  const card = element('section', 'consent-card');
  card.setAttribute('aria-labelledby', 'consentTitle');
  append(
    card,
    element('p', 'section-kicker', 'Before we begin'),
    element('h2', '', 'Set up your private session')
  );
  card.querySelector('h2').id = 'consentTitle';
  card.append(element('p', 'consent-lead', 'This beta is for adults exploring their own finances. It is educational and does not replace professional advice.'));

  const form = element('form');
  form.id = 'consentForm';
  form.dataset.action = 'start-session';
  const checks = element('div', 'consent-list');
  const configs = [
    {
      name: 'adultConfirmed',
      title: 'I confirm I am 18 or older',
      detail: 'This private beta is not designed for children or minors.',
      required: true
    },
    {
      name: 'analysisConsent',
      title: 'I consent to my information being processed for this analysis',
      detail: 'Planéir needs to process the financial information I choose to provide to create and save this session.',
      required: true
    },
    {
      name: 'educationAcknowledged',
      title: 'I understand this is education, not advice',
      detail: 'Results are illustrations, not regulated financial, tax, legal, mortgage, product, or approval advice.',
      required: true
    }
  ];
  if (bootstrap.aiEnabled) {
    configs.push({
      name: 'aiProcessing',
      title: 'Let OpenAI help interpret what I type (optional)',
      detail: 'OpenAI receives my latest message, the current question, a bounded conversation summary, and the profile facts relevant to that question. It may propose drafts, but I review them and deterministic code calculates every result.',
      required: false
    });
  }

  configs.forEach((config) => {
    const label = element('label', 'check-row');
    const input = element('input');
    input.type = 'checkbox';
    input.name = config.name;
    input.required = config.required;
    input.disabled = busy;
    const text = element('span');
    append(text, element('strong', '', config.title), element('small', '', config.detail));
    append(label, input, text);
    checks.append(label);
  });
  form.append(checks);
  form.append(element('p', 'consent-detail', 'Your private access credential stays only in this browser tab. Do not enter PPS numbers, account passwords, complete account numbers, or upload identity documents.'));
  const privacy = element('p', 'consent-detail');
  privacy.append('Read the ');
  const privacyLink = element('a', '', 'consumer journey privacy notice');
  privacyLink.href = /^https:\/\//i.test(String(bootstrap.privacyNoticeUrl || ''))
    ? bootstrap.privacyNoticeUrl
    : './privacy.html';
  privacyLink.target = '_blank';
  privacyLink.rel = 'noopener noreferrer';
  privacy.append(privacyLink, ` (policy ${bootstrap.policyVersion}).`);
  form.append(privacy);
  if (error) {
    form.append(element('p', 'form-error', error));
  }
  const submit = element('button', 'primary-button', busy ? 'Creating your space…' : 'Begin my journey');
  submit.type = 'submit';
  submit.disabled = busy;
  form.append(submit);
  card.append(form);
  append(shell, copy, card);
  root.append(shell);
  root.setAttribute('aria-busy', busy ? 'true' : 'false');
}

export function renderUnavailable(root, { connectionError = false, message = '' } = {}) {
  root.replaceChildren();
  const card = element('section', 'unavailable-card');
  append(
    card,
    element('p', 'section-kicker', connectionError ? 'Service unavailable' : 'Private beta'),
    element('h1', '', connectionError ? 'We could not open the planning journey.' : 'The planning journey is not open just yet.'),
    element(
      'p',
      '',
      message || (connectionError
        ? 'The private-beta service could not be reached. No information has been submitted. Please try again later.'
        : 'Planéir is releasing this guided experience carefully. The main Planéir website and existing adviser workflow are unaffected.')
    )
  );
  const home = element('a', 'secondary-button', 'Return to Planéir.ie');
  home.href = '../';
  if (connectionError) {
    const retry = element('button', 'primary-button', 'Try again');
    retry.type = 'button';
    retry.dataset.action = 'reload-page';
    card.append(retry);
  }
  card.append(home);
  root.append(card);
  root.setAttribute('aria-busy', 'false');
}

export function renderJourney(root, currentState) {
  root.replaceChildren();
  const shell = element('div', 'journey-shell');
  const aside = element('aside', 'journey-aside');
  aside.setAttribute('aria-label', 'Journey progress');
  append(aside, createProgressNav(currentState), createModeCard(currentState));
  const main = element('div', 'journey-main');
  if (currentState.consentRefreshRequired) {
    main.append(createConsentRefreshBanner(currentState));
  }
  const workspace = element('article', 'workspace-card');
  workspace.append(createCurrentView(currentState));
  main.append(workspace);
  append(shell, aside, main);
  root.append(shell);
  root.setAttribute('aria-busy', currentState.busy ? 'true' : 'false');

  window.requestAnimationFrame(() => {
    const thread = document.getElementById('conversationThread');
    if (thread) {
      thread.scrollTop = thread.scrollHeight;
    }
  });
}
