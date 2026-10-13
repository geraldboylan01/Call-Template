// Public workspace wording and acknowledgements. Case-video consent stays in
// the legacy application contract and must never be translated into these.
export const WORKSPACE_POLICY = Object.freeze({
  version: 'workspace-v1',
  privacyNoticeId: 'workspace-privacy-v1',
  termsId: 'workspace-terms-v1',
  aiNoticeId: 'workspace-ai-v1',
  privacyUrl: 'https://planeir.ie/privacy/',
  termsUrl: 'https://planeir.ie/terms/'
});

// These capabilities need their own implementation and end-to-end proof.
// Editing public copy does not enable submission, storage or paid booking.
export const WORKSPACE_RELEASE = Object.freeze({
  automaticGeneration: false,
  persistentAccess: false,
  deletion: false,
  paidBooking: false,
  bookingUrl: ''
});

export function workspaceLaunchReady(release = WORKSPACE_RELEASE) {
  return ['automaticGeneration', 'persistentAccess', 'deletion', 'paidBooking']
    .every((key) => release[key] === true);
}

export const WORKSPACE_COPY = Object.freeze({
  headline: 'Personalised financial education shouldn’t be reserved for the few.',
  description: 'Financial education beyond the wealthy few. Planéir models your income, savings, pensions and mortgage using your own figures.',
  introduction: 'Detailed financial modelling has too often been reserved for those who can afford specialist advice. Planéir uses technology to bring it to your own income, savings, pensions and mortgage — and show how different choices change the outcome.',
  create: 'Create my workspace',
  closed: 'Workspace creation is unavailable in this preview. Your draft stays on this device and is not sent to Planéir.',
  founder: 'I’m Gerry Boylan, a Qualified Financial Adviser. I’ve worked with clients across every part of the financial advice process. I built Planéir because the depth of financial understanding available to wealthy clients should be within everyone’s reach.',
  founderContext: 'Technology lets us bring that depth to more people: a clear picture of where you stand, comparisons of the choices ahead, and the assumptions behind each outcome.',
  resultTitle: 'Your financial picture',
  comparisonTitle: 'Compare outcomes',
  assumptionsTitle: 'Assumptions used',
  missingTitle: 'Missing information',
  automaticNotice: 'These results are generated automatically. Gerry does not routinely review individual workspaces.',
  educationNotice: 'Planéir provides financial education. Figures are illustrations based on the information and assumptions shown, not regulated advice or product recommendations.',
  aiNotice: 'AI helps identify the scenarios to model from your objectives and organise the relevant modules. Financial calculations run in Planéir’s calculation engines.',
  assumptionsNotice: 'Read all the assumptions included with your results.'
});

// Call these only from real job events. A page visit or a timer is not a job.
export function workspaceStatusCopy(status) {
  const states = {
    unavailable: ['No workspace is being prepared', 'Nothing has been sent. Your draft stays on this device.'],
    preparing: ['Preparing your workspace', 'We’re working through your figures and organising the modules around your goals.'],
    calculating: ['Working through your figures', 'Planéir’s calculation engines are modelling the supported comparisons.'],
    organising: ['Organising your modules', 'The relevant modules are being arranged around your objectives and the scenarios modelled.'],
    needs_information: ['A few figures are missing', 'Check the highlighted details. Modules that need them cannot be calculated yet.'],
    failed: ['Your workspace could not be prepared', 'Your draft is still available. No completed result is being shown. Try again when the service is available.'],
    ready: [WORKSPACE_COPY.resultTitle, WORKSPACE_COPY.automaticNotice]
  };
  const [title, body] = states[status] || states.unavailable;
  return { title, body };
}

export function workspaceAcknowledgements(values) {
  const fields = ['adultConfirmed', 'educationAcknowledged', 'privacyNoticeAcknowledged', 'termsAccepted', 'aiProcessingAcknowledged'];
  if (fields.some((field) => values?.[field] !== true)) {
    throw new Error('Read and confirm each statement before creating your workspace.');
  }
  return { ...WORKSPACE_POLICY, ...Object.fromEntries(fields.map((field) => [field, true])) };
}

export const WORKSPACE_FAQS = Object.freeze([
  ['What is Planéir?', 'Planéir brings detailed financial education beyond the wealthy few. Designed by Gerry Boylan, who has worked with clients across every part of the financial advice process, it uses technology to help you understand your own figures and compare the effect of different choices.'],
  ['Is the workspace free?', 'Yes. Creating and using your workspace is free.'],
  ['Does Gerry review my result?', 'Results are generated automatically. Gerry designed the app but does not routinely review individual results. You can request an optional call after viewing your analysis.'],
  ['How does AI help?', `${WORKSPACE_COPY.aiNotice} ${WORKSPACE_COPY.assumptionsNotice}`],
  ['Is my workspace private?', 'Your workspace is not published. Service providers process information to run the app, and authorised support may access it when needed. The privacy notice explains this.'],
  ['Can I return to my workspace?', 'Yes. Your workspace stays saved until you delete it.'],
  ['What if I don’t know a figure?', 'Estimates are fine, and you can skip figures you do not know. Missing information may prevent a particular calculation. The app identifies what is needed.'],
  ['Is this financial advice?', 'Planéir provides financial education and modelled comparisons. It does not provide regulated advice or recommend financial products. Read all the assumptions and take appropriate professional advice before acting.'],
  ['Can I talk through my results with Gerry?', 'Yes. After you receive your analysis, you can request an optional call with Gerry Boylan, the person who created Planéir. You’ll find the details beside your results.']
]);
