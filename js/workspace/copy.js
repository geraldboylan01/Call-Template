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
  headline: 'See the different routes to your financial goals.',
  description: 'Explore different routes to your financial goals with Planéir. Currently available for demos only.',
  introduction: 'Use your goals and figures to explore different choices, compare the trade-offs and get a clearer picture of the way forward.',
  create: 'Request demo access',
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
  ['What is Planéir?', 'Planéir helps you understand the different routes to your financial goals through modelled comparisons of your choices, figures and assumptions. It is built for Ireland and currently available for demos only.'],
  ['How do I get demo access?', 'Share your goals and figures using the demo request form. We save your information and email you when access is available. If you already have a demo invitation, you can use it to continue directly.'],
  ['What can I do in this demo?', 'You can save, review and confirm your information. Analysis generation is not connected yet. No analysis starts when you request access or confirm your figures.'],
  ['How will AI help with the analysis?', `${WORKSPACE_COPY.aiNotice} AI processing is not connected to the demo request form.`],
  ['Is my information private?', 'Your saved information is not published. Service providers process information to run the service, and authorised support may access it when needed. The privacy notice explains this.'],
  ['Can I return to my information?', 'Yes. Use your private email link to reopen and update your saved form, including while waiting for approval. Your information stays saved until you delete it.'],
  ['What if I don’t know a figure?', 'Estimates are fine. Skip anything you don’t know. You can return to update your information later.'],
  ['Is this financial advice?', 'Planéir provides financial education and modelled comparisons. It does not provide regulated advice or recommend financial products. Read all the assumptions and take appropriate professional advice before acting.']
]);
