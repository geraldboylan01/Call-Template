function clean(value, maximum = 4_000) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function redactPlanAccessCredentials(value) {
  return value
    .replace(/\bci1\.[A-Za-z0-9_-]{20,2000}\.[A-Za-z0-9_-]{40,80}\b/g, '[private Planéir invite removed]')
    .replace(/\bcs_[A-Za-z0-9_-]{20,80}\.[A-Za-z0-9_-]{40,80}\b/g, '[private Planéir session credential removed]');
}

export function isSubscriptionAssistCohort(value) {
  return clean(value, 80).toLowerCase() === 'adviser_test';
}

export function buildSubscriptionAssistPrompt({ question, draft }) {
  const activeQuestion = redactPlanAccessCredentials(clean(question, 1_500));
  const draftAnswer = redactPlanAccessCredentials(clean(draft, 4_000));
  if (!draftAnswer) {
    throw new Error('Write a draft answer first, then copy it for Codex.');
  }

  return [
    'Planéir adviser-beta answer-shaping task',
    '',
    'Rewrite my draft as a concise first-person answer to the Planéir question below.',
    'Use only facts already present in my draft. Do not infer, calculate, advise, recommend, or add figures.',
    'Preserve uncertainty explicitly (for example, "about", "I think", or "I do not know").',
    'Do not ask for or repeat PPS numbers, passwords, full account numbers, or identity-document details.',
    'Return only the rewritten answer in plain text, with no heading, JSON, or commentary.',
    '',
    `Planéir question: ${activeQuestion || 'What financial goal or concern would you like to explore?'}`,
    `My draft: ${draftAnswer}`
  ].join('\n');
}
