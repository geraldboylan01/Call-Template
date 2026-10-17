import { WORKSPACE_COPY } from './copy.js';

// Text templates for the workspace transport when it is implemented. The
// historical service keeps its own receipts; it never sends these templates.
export function workspaceReceiptText(workspaceUrl) {
  const url = new URL(workspaceUrl);
  if (url.origin !== 'https://planeir.ie' || url.username || url.password) {
    throw new Error('A private Planéir return link is required.');
  }
  return [
    'Your Planéir workspace is ready.',
    `Return to your private workspace: ${url.href}`,
    'It remains saved until you delete it.',
    WORKSPACE_COPY.automaticNotice,
    WORKSPACE_COPY.assumptionsNotice,
    WORKSPACE_COPY.educationNotice,
    'Questions about access or deletion? Email hello@planeir.ie.'
  ].join('\n\n');
}

// The caller supplies already calculated text. No calculation or AI-authored
// value is introduced by the report formatter.
export function workspaceReportText({ comparisons = '', assumptions = '', figuresToCheck = '' } = {}) {
  return [
    WORKSPACE_COPY.resultTitle,
    WORKSPACE_COPY.automaticNotice,
    WORKSPACE_COPY.educationNotice,
    WORKSPACE_COPY.assumptionsNotice,
    WORKSPACE_COPY.comparisonTitle,
    String(comparisons),
    WORKSPACE_COPY.assumptionsTitle,
    String(assumptions),
    WORKSPACE_COPY.missingTitle,
    String(figuresToCheck)
  ].join('\n\n');
}

