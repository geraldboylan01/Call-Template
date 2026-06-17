import {
  loadSession,
  hasStoredSession,
  createStateManager,
  getModuleById,
  getOrderedModules,
  ensureActiveModule,
  createEmptyGenerated,
  normalizeGenerated,
  normalizePbsInputs,
  exportSession,
  exportPublishedSession,
  importSession,
  importPublishedSession,
  newSession
} from './state.js';
import { computeBestOverviewLayout } from './layout.js';
import {
  zoomToModuleFromOverview,
  zoomOutToOverview,
  getIsZoomAnimating
} from './zoom.js';
import { mountInitialPane, swipeToPane } from './swipe.js';
import {
  renderChartsForPane,
  updateChartsForPane,
  cleanupDetachedCharts,
  destroyAllCharts
} from './charts.js';
import {
  getUiElements,
  renderGreeting,
  buildFocusedPane,
  patchFocusedGeneratedCards,
  getChartHydrationModule,
  renderOverview,
  renderMobileModuleSheet,
  setMode,
  updateControls,
  updateSessionStatus,
  getFocusedCardElement,
  getOverviewCardElement,
  ensureLayerVisibleForMeasure
} from './render.js';
import {
  normalizePensionInputs,
  computePensionProjection,
  getDefaultPensionScenarioId,
  getPensionScenarioCases
} from './pension_math.js';
import {
  normalizeCollegeFundingInputs,
  computeCollegeFundingProjection
} from './college_funding_math.js';
import {
  normalizeNetRetirementInputs,
  computeNetRetirementProjection,
  getDefaultNetRetirementScenarioId,
  getNetRetirementScenarioCases
} from './net_retirement_math.js';
import { normalizeMortgageInputs, computeMortgageProjection } from './mortgage_math.js';
import { runMortgageMathTests } from './tests_mortgage_math.js';
import { runPensionMathTests } from './tests_pension_math.js';
import { runCollegeFundingMathTests } from './tests_college_funding_math.js';
import { runNetRetirementMathTests } from './tests_net_retirement_math.js';
import { normalizeEditorJsonInput } from './dev_payload_input.js';
import {
  buildPublishedCapabilityToken,
  decryptPublishedSessionV2ForAdvisor,
  encryptPublishedSessionV3,
  encryptPublishedSessionV4,
  rotatePublishedClientAccessV4
} from './crypto_session.js';
import { debugNormalizeComparisonGrid } from './education_svg.js';
import { validateReportPayload } from './report.js';
import { createSuccessTakeover } from './success_takeover.js';

function getMetaContent(name) {
  const element = document.querySelector(`meta[name="${name}"]`);
  return element?.getAttribute('content')?.trim() || '';
}

const ui = getUiElements();
const appShell = document.getElementById('app');
const publishSuccessOverlay = document.getElementById('publishSuccessOverlay');
const publishSuccessGhost = document.getElementById('publishSuccessGhost');
const publishSuccessTarget = document.getElementById('publishSuccessTarget');
const publishSuccessTitle = document.getElementById('publishSuccessTitle');
const publishSuccessBody = document.getElementById('publishSuccessBody');
const publishSuccessOrigin = document.getElementById('publishSuccessOrigin');
const publishedRecoveryLayer = document.getElementById('publishedRecoveryLayer');
const publishedRecoveryMessage = document.getElementById('publishedRecoveryMessage');
const publishedRecoveryRetryButton = document.getElementById('publishedRecoveryRetryBtn');
const publishedRecoveryLocalButton = document.getElementById('publishedRecoveryLocalBtn');
const publishedRecoveryFreshButton = document.getElementById('publishedRecoveryFreshBtn');
const advisorAuthLayer = document.getElementById('advisorAuthLayer');
const advisorAuthHint = document.getElementById('advisorAuthHint');
const advisorAuthPasswordInput = document.getElementById('advisorAuthPasswordInput');
const advisorAuthLoginButton = document.getElementById('advisorAuthLoginBtn');
const advisorAuthError = document.getElementById('advisorAuthError');
const advisorAuthStatus = document.getElementById('advisorAuthStatus');
const advisorLogoutButton = document.getElementById('advisorLogoutBtn');
const publishSuccessTakeover = createSuccessTakeover({
  overlay: publishSuccessOverlay,
  origin: publishSuccessOrigin,
  ghost: publishSuccessGhost,
  target: publishSuccessTarget,
  title: publishSuccessTitle,
  body: publishSuccessBody,
  holdMs: 10000,
  lockTargets: [appShell, advisorAuthLayer, publishedRecoveryLayer].filter(Boolean)
});
const runtimeConfig = {
  readOnly: false,
  allowDevPanel: true,
  allowPublish: true,
  showPensionToggle: true,
  persistLocalSession: true
};

const IS_LOCAL_DEV_HOST = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
const WORKER_BASE_URL = (() => {
  const override = getMetaContent('call-canvas-worker-base-url');

  if (override) {
    return override.replace(/\/+$/, '');
  }

  if (IS_LOCAL_DEV_HOST) {
    return 'http://127.0.0.1:8787';
  }

  return '';
})();

const stateManager = createStateManager(300, {
  onDirtyChange: (isDirty) => {
    if (runtimeConfig.readOnly) {
      if (ui.sessionStatus) {
        ui.sessionStatus.textContent = 'Read only';
        ui.sessionStatus.classList.remove('is-dirty');
      }
      return;
    }
    updateSessionStatus(ui, isDirty);
  }
});

const ASSUMPTIONS_UPDATED_FEEDBACK_MS = 800;
const OVERVIEW_UNDO_SECONDS = 15;
const TABLE_HIGHLIGHT_KINDS = Object.freeze(['assumptions', 'outputs']);
const MOBILE_LAYOUT_MEDIA_QUERY = '(max-width: 1024px)';
const MOBILE_SHEET_SWIPE_CLOSE_THRESHOLD = 72;

async function recordPublishedUnlock(publishedId, secretB64u, role, source) {
  const sessionId = typeof publishedId === 'string' ? publishedId.trim() : '';
  const secret = typeof secretB64u === 'string' ? secretB64u.trim() : '';
  const normalizedRole = role === 'advisor' ? 'advisor' : 'client';
  if (!sessionId || !secret || !WORKER_BASE_URL) {
    return;
  }

  try {
    const capability = await buildPublishedCapabilityToken(secret, normalizedRole);
    await fetch(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(sessionId)}/unlocked`, buildAdvisorRequestInit({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Published-Capability': capability
      },
      body: JSON.stringify({
        role: normalizedRole,
        source: typeof source === 'string' && source.trim()
          ? source.trim()
          : (normalizedRole === 'advisor' ? 'advisor-reopen' : 'viewer')
      }),
      keepalive: true
    }, {
      includeCsrf: normalizedRole === 'advisor'
    }));
  } catch (_error) {
    // Unlock telemetry must never block the session open path.
  }
}

const appState = {
  session: newSession('Client'),
  mode: 'greeting',
  sortable: null,
  transitionLock: false,
  devPanelOpen: false,
  overviewMultiSelectArmed: false,
  overviewSelection: [],
  compare: null,
  compareScrollCleanup: null,
  undoAction: null,
  lastDeletedBatch: null,
  pensionShowMaxByModuleId: new Map(),
  pensionScenarioByModuleId: new Map(),
  netRetirementScenarioByModuleId: new Map(),
  assumptionsEditorStateByModuleId: new Map(),
  lastValidProjectionByModuleId: new Map(),
  chartHydrationRunId: 0,
  publishedAccess: null,
  pipelineContext: null
};

const advisorAuthState = {
  enabled: false,
  authenticated: false,
  csrfToken: '',
  expiresAt: null
};

let mobileSheetRestoreFocusTarget = null;
let mobileSheetTouchStartY = null;
let mobileSheetTouchDeltaY = 0;
let mobileModuleSheetRestoreFocusTarget = null;
let mobileModuleSheetTouchStartY = null;
let mobileModuleSheetTouchDeltaY = 0;
let advisorAuthWaiters = [];
let advisorAuthEventsBound = false;

function setAdvisorAuthVisible(visible) {
  if (!advisorAuthLayer) {
    return;
  }

  advisorAuthLayer.classList.toggle('is-hidden', !visible);
  advisorAuthLayer.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function setAdvisorAuthError(message) {
  if (!advisorAuthError) {
    return;
  }

  advisorAuthError.textContent = String(message || '');
}

function setAdvisorAuthLoading(isLoading, label = 'Sign In') {
  if (!advisorAuthLoginButton) {
    return;
  }

  advisorAuthLoginButton.disabled = isLoading;
  advisorAuthLoginButton.textContent = isLoading ? label : 'Sign In';
}

function updateAdvisorAuthChrome() {
  if (advisorAuthStatus) {
    if (!advisorAuthState.enabled) {
      advisorAuthStatus.textContent = 'Advisor auth disabled';
    } else if (advisorAuthState.authenticated) {
      advisorAuthStatus.textContent = 'Advisor signed in';
    } else {
      advisorAuthStatus.textContent = 'Advisor sign-in required';
    }
  }

  if (advisorLogoutButton) {
    advisorLogoutButton.classList.toggle('is-hidden', !(advisorAuthState.enabled && advisorAuthState.authenticated));
  }
}

function buildAdvisorRequestInit(init = {}, options = {}) {
  const headers = new Headers(init.headers || {});
  if (options.includeCsrf && advisorAuthState.csrfToken) {
    headers.set('X-Advisor-CSRF', advisorAuthState.csrfToken);
  }

  return {
    ...init,
    headers,
    credentials: 'include'
  };
}

async function fetchAdvisorAuthSession() {
  if (!WORKER_BASE_URL) {
    return {
      authEnabled: false,
      authenticated: false,
      csrfToken: '',
      expiresAt: null
    };
  }

  const response = await fetch(`${WORKER_BASE_URL}/api/auth/session`, buildAdvisorRequestInit({
    method: 'GET',
    cache: 'no-store'
  }));
  if (!response.ok) {
    throw new Error(`Unable to check advisor session (${response.status}).`);
  }
  return response.json();
}

async function syncAdvisorAuthState() {
  const payload = await fetchAdvisorAuthSession();
  advisorAuthState.enabled = payload?.authEnabled === true;
  advisorAuthState.authenticated = payload?.authenticated === true;
  advisorAuthState.csrfToken = advisorAuthState.authenticated ? String(payload?.csrfToken || '') : '';
  advisorAuthState.expiresAt = advisorAuthState.authenticated ? payload?.expiresAt || null : null;
  updateAdvisorAuthChrome();
  return advisorAuthState;
}

function resolveAdvisorAuthWaiters() {
  if (advisorAuthWaiters.length === 0) {
    return;
  }

  const waiters = advisorAuthWaiters;
  advisorAuthWaiters = [];
  waiters.forEach((resolve) => resolve());
}

function isAdvisorAuthFailureStatus(status) {
  return status === 401 || status === 403;
}

async function fetchWithAdvisorAuth(url, init = {}, options = {}) {
  const { includeCsrf = false, authPrompt = 'Sign in to continue.', retryOnAuthFailure = true } = options;
  let response = await fetch(url, buildAdvisorRequestInit(init, { includeCsrf }));

  if (!retryOnAuthFailure || !isAdvisorAuthFailureStatus(response.status)) {
    return response;
  }

  let authState = advisorAuthState;
  try {
    authState = await syncAdvisorAuthState();
  } catch (_error) {
    authState = advisorAuthState;
  }

  if (!authState.enabled) {
    return response;
  }

  await ensureAdvisorAuthenticated(authPrompt);
  response = await fetch(url, buildAdvisorRequestInit(init, { includeCsrf }));
  return response;
}

async function handleAdvisorLoginSubmit() {
  if (!WORKER_BASE_URL) {
    return;
  }

  const password = String(advisorAuthPasswordInput?.value || '');
  if (!password.trim()) {
    setAdvisorAuthError('Enter the advisor password.');
    return;
  }

  setAdvisorAuthError('');
  setAdvisorAuthLoading(true, 'Signing in...');

  try {
    const response = await fetch(`${WORKER_BASE_URL}/api/auth/login`, buildAdvisorRequestInit({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password })
    }));
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || `Sign-in failed (${response.status}).`);
    }

    advisorAuthState.enabled = payload?.authEnabled === true;
    advisorAuthState.authenticated = payload?.authenticated === true;
    advisorAuthState.csrfToken = String(payload?.csrfToken || '');
    advisorAuthState.expiresAt = payload?.expiresAt || null;
    if (advisorAuthPasswordInput) {
      advisorAuthPasswordInput.value = '';
    }
    setAdvisorAuthVisible(false);
    updateAdvisorAuthChrome();
    resolveAdvisorAuthWaiters();
  } catch (error) {
    setAdvisorAuthError(error?.message || 'Could not sign in.');
  } finally {
    setAdvisorAuthLoading(false);
  }
}

async function ensureAdvisorAuthenticated(message = 'Sign in to publish, reopen, revoke, extend, and send final client emails.') {
  const authState = await syncAdvisorAuthState();
  if (!authState.enabled || authState.authenticated) {
    setAdvisorAuthVisible(false);
    return;
  }

  setAdvisorAuthError('');
  if (advisorAuthHint) {
    advisorAuthHint.textContent = String(message || 'Sign in to continue.');
  }
  setAdvisorAuthVisible(true);
  if (advisorAuthPasswordInput) {
    advisorAuthPasswordInput.focus();
  }

  await new Promise((resolve) => {
    advisorAuthWaiters.push(resolve);
  });
}

async function handleAdvisorLogout() {
  if (!WORKER_BASE_URL || !advisorAuthState.enabled || !advisorAuthState.authenticated) {
    return;
  }

  const response = await fetch(`${WORKER_BASE_URL}/api/auth/logout`, buildAdvisorRequestInit({
    method: 'POST'
  }, {
    includeCsrf: true
  }));

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Logout failed (${response.status}).`);
  }

  advisorAuthState.authenticated = false;
  advisorAuthState.csrfToken = '';
  advisorAuthState.expiresAt = null;
  updateAdvisorAuthChrome();
  window.location.replace(new URL('../', window.location.href).toString());
}

function bindAdvisorAuthEvents() {
  if (advisorAuthEventsBound) {
    return;
  }

  if (advisorAuthLoginButton) {
    advisorAuthLoginButton.addEventListener('click', async () => {
      await handleAdvisorLoginSubmit();
    });
  }

  if (advisorAuthPasswordInput) {
    advisorAuthPasswordInput.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') {
        return;
      }

      event.preventDefault();
      await handleAdvisorLoginSubmit();
    });
  }

  if (advisorLogoutButton) {
    advisorLogoutButton.addEventListener('click', async () => {
      try {
        await handleAdvisorLogout();
        showToast('Advisor signed out.');
      } catch (error) {
        showToast(error?.message || 'Could not sign out.', 'error');
      }
    });
  }

  advisorAuthEventsBound = true;
}

const EXAMPLE_PAYLOADS = [
  {
    id: 'summary-kpis',
    label: 'Summary + KPI Charts',
    payload: {
      title: 'Q2 Revenue and Margin Outlook',
      generated: {
        summaryHtml: '<p><strong>Headline:</strong> Revenue is tracking above plan while margin remains stable under current spend assumptions.</p><ul><li>Upside driven by enterprise segment.</li><li>Primary risk is slower onboarding in mid-market.</li></ul>',
        assumptions: {
          columns: ['Assumption', 'Value', 'Notes'],
          rows: [
            ['Pipeline conversion', '32%', 'Assumes stronger outbound response'],
            ['Avg contract value', '$42,000', 'Weighted enterprise mix'],
            ['CAC growth', '4%', 'Conservative against Q1 baseline']
          ]
        },
        outputs: {
          columns: ['Metric', 'Q1 Actual', 'Q2 Forecast'],
          rows: [
            ['Revenue', 1.9, 2.2],
            ['Gross Margin %', 58, 59],
            ['New Logos', 28, 35]
          ]
        },
        charts: [
          {
            title: 'Revenue by Month',
            type: 'line',
            labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
            datasets: [
              { label: 'Actual / Forecast', data: [0.54, 0.62, 0.74, 0.69, 0.78, 0.82] }
            ]
          },
          {
            title: 'Segment Contribution',
            type: 'bar',
            labels: ['Enterprise', 'Mid-Market', 'SMB'],
            datasets: [
              { label: 'Q2', data: [1.12, 0.72, 0.36] }
            ]
          }
        ]
      }
    }
  },
  {
    id: 'scenario',
    label: 'Scenario Comparison',
    payload: {
      title: 'Scenario Planning Snapshot',
      generated: {
        summaryHtml: '<p>We modeled <em>base</em>, <em>upside</em>, and <em>downside</em> outcomes. Base case still clears target ARR with room for efficiency gains.</p>',
        assumptions: {
          columns: ['Scenario', 'Win Rate', 'Spend Delta'],
          rows: [
            ['Base', '31%', '+2%'],
            ['Upside', '35%', '+4%'],
            ['Downside', '26%', '0%']
          ]
        },
        outputs: {
          columns: ['Scenario', 'ARR', 'EBITDA'],
          rows: [
            ['Base', 4.8, 1.1],
            ['Upside', 5.4, 1.3],
            ['Downside', 4.1, 0.8]
          ]
        },
        charts: [
          {
            title: 'ARR by Scenario',
            type: 'bar',
            labels: ['Base', 'Upside', 'Downside'],
            datasets: [
              { label: 'ARR ($M)', data: [4.8, 5.4, 4.1] }
            ]
          }
        ]
      }
    }
  },
  {
    id: 'pbs-balance-sheet-artifact-demo',
    label: 'PBS: Balance Sheet Artifact Demo',
    payload: {
      title: 'Personal Balance Sheet - Client',
      generated: {
        summaryHtml: '<p>The balance sheet separates assets by job: lifestyle, liquidity, longevity, and legacy. This view keeps the conversation focused on what is available for near-term resilience, what supports future income, and what is more optional or concentrated.</p>',
        pbsInputs: {
          annualExpenditure: 42000,
          currentAge: 44
        },
        outputsBucketed: {
          currencySymbol: '€',
          sections: [
            {
              key: 'lifestyle',
              title: 'Lifestyle',
              columns: ['Asset', 'Amount (€)'],
              rows: [
                ['Family home', 525000],
                ['Car', 18000]
              ],
              subtotalLabel: 'Lifestyle assets',
              subtotalValue: 543000,
              notes: 'Lifestyle assets support day-to-day living but are not usually treated as spendable reserves.'
            },
            {
              key: 'liquidity',
              title: 'Liquidity',
              columns: ['Asset', 'Amount (€)'],
              rows: [
                ['Cash', 12000],
                ['Savings', 18000]
              ],
              subtotalLabel: 'Liquid reserves',
              subtotalValue: 30000,
              notes: 'Liquid reserves are the first line of defense for unexpected expenditure.'
            },
            {
              key: 'longevity',
              title: 'Longevity',
              columns: ['Asset', 'Amount (€)'],
              rows: [
                ['PRSA', 95000],
                ['Employer pension', 240000],
                ['Long-term ETF portfolio', 42000]
              ],
              subtotalLabel: 'Longevity assets',
              subtotalValue: 377000,
              notes: 'These assets are framed around future income and retirement resilience.'
            },
            {
              key: 'legacy',
              title: 'Legacy',
              columns: ['Asset', 'Amount (€)'],
              rows: [
                ['Business value', 110000],
                ['Crypto', 5000]
              ],
              subtotalLabel: 'Legacy / concentrated assets',
              subtotalValue: 115000,
              notes: 'Business value and crypto are shown separately because liquidity and valuation can be less certain.'
            },
            {
              key: 'liabilities',
              title: 'Liabilities',
              columns: ['Liability', 'Amount (€)'],
              rows: [
                ['Mortgage', 220000],
                ['Credit card', 900]
              ],
              subtotalLabel: 'Total liabilities',
              subtotalValue: 220900
            },
            {
              key: 'summary',
              title: 'Summary',
              columns: ['Metric', 'Amount (€)'],
              rows: [
                ['Gross assets', 1065000],
                ['Total liabilities', 220900],
                ['Net worth', 844100]
              ],
              subtotalLabel: 'Net worth',
              subtotalValue: 844100
            }
          ]
        },
        charts: [
          {
            title: 'Assets by bucket',
            subtitle: 'The split shows what each part of the balance sheet is meant to do.',
            type: 'bar',
            labels: ['Lifestyle', 'Liquidity', 'Longevity', 'Legacy'],
            display: {
              variant: 'wide',
              valueFormat: 'currency',
              yAxisTitle: 'Asset value'
            },
            insights: [
              { label: 'Liquid buffer', value: '€30,000', detail: 'About 8.6 months of stated annual expenditure.', tone: 'positive' },
              { label: 'Largest bucket', value: 'Lifestyle', detail: 'The home dominates gross assets, so spendable wealth is lower than headline wealth.' }
            ],
            datasets: [
              { label: 'Assets', data: [543000, 30000, 377000, 115000] }
            ]
          }
        ]
      }
    }
  },
  {
    id: 'education-htb-flowchart-demo',
    label: 'Education: HTB Flowchart Demo',
    payload: {
      title: 'Education - Help to Buy',
      generated: {
        summaryHtml: '<p>Use this education module to explain the Help to Buy path from eligibility checks to claim submission.</p>',
        education: {
          topic: 'Help to Buy (Ireland)',
          audience: 'First-time buyers',
          sections: [
            {
              id: 'what-it-is',
              title: 'What It Is',
              bodyHtml: '<p>Help to Buy can provide a tax refund contribution toward a qualifying new-build purchase.</p>',
              bullets: [
                'Eligibility depends on buyer and property criteria.',
                'Refund limits can change over time.',
                'Use current Revenue guidance before applying.'
              ]
            },
            {
              id: 'how-to-apply',
              title: 'How To Apply',
              bodyHtml: '<p>The process usually starts with eligibility checks, then proceeds through mortgage and builder milestones.</p>',
              bullets: [
                'Collect identity and tax-compliance documents.',
                'Confirm your loan and property meet current thresholds.',
                'Submit in sequence to avoid rework.'
              ]
            }
          ],
          visuals: [
            {
              type: 'svg',
              title: 'Help to Buy Flow',
              subtitle: 'Eligibility through claim',
              svgSpec: {
                kind: 'flowchart',
                theme: 'dark',
                layout: {
                  direction: 'TB',
                  nodeWidth: 216,
                  nodeHeight: 72,
                  gapX: 48,
                  gapY: 34,
                  connector: 'elbow'
                },
                nodes: [
                  { id: 'check', label: 'Check eligibility' },
                  { id: 'prepare', label: 'Prepare supporting docs' },
                  { id: 'mortgage', label: 'Mortgage approval in principle' },
                  { id: 'contract', label: 'Sign contract with builder' },
                  { id: 'submit', label: 'Submit HTB claim details' },
                  { id: 'confirm', label: 'Claim confirmed for drawdown' }
                ],
                edges: [
                  { from: 'check', to: 'prepare' },
                  { from: 'prepare', to: 'mortgage' },
                  { from: 'mortgage', to: 'contract' },
                  { from: 'contract', to: 'submit' },
                  { from: 'submit', to: 'confirm' }
                ]
              }
            },
            {
              type: 'chart',
              chart: {
                title: 'HTB Example Size and Cap',
                type: 'bar',
                labels: ['Property price', 'Illustrative max rebate'],
                datasets: [
                  { label: '€', data: [500000, 30000] }
                ]
              }
            }
          ],
          references: [
            {
              label: 'Revenue - Help to Buy',
              kind: 'official',
              note: 'Verify current limits before client recommendations.'
            }
          ]
        }
      }
    }
  },
  {
    id: 'education-artifact-htb-demo',
    label: 'Education: Guided HTB Artifact Demo',
    payload: {
      title: 'Education - Help to Buy Decision Path',
      generated: {
        summaryHtml: '<p>Help to Buy is easiest to understand as a sequence of checks rather than a single grant figure. The key question is whether the buyer, property, tax record, and purchase structure all qualify before relying on the refund in the funding plan.</p>',
        education: {
          topic: 'Help to Buy for first-time buyers',
          audience: 'First-time buyer couple in Ireland',
          metrics: [
            { label: 'Main dependency', value: 'Eligibility', detail: 'Buyer and property rules matter before the refund amount.' },
            { label: 'Funding role', value: 'Deposit support', detail: 'Treat it as conditional support, not guaranteed cash.', tone: 'warning' },
            { label: 'Best live-call use', value: 'Sequence', detail: 'Walk through checks in order to avoid false confidence.' }
          ],
          steps: [
            {
              id: 'buyer',
              kicker: 'Step 1',
              title: 'Confirm buyer status',
              bodyHtml: '<p>Start with whether each buyer meets the first-time buyer and tax compliance conditions.</p>',
              bullets: ['Check prior ownership history.', 'Confirm Revenue compliance before relying on the claim.'],
              focus: 'This decides whether the conversation continues to property and funding checks.'
            },
            {
              id: 'property',
              kicker: 'Step 2',
              title: 'Check the property',
              bodyHtml: '<p>The property must fit the current scheme conditions, including new-build and value limits where relevant.</p>',
              focus: 'A good buyer can still fail the scheme if the property does not qualify.'
            },
            {
              id: 'funding',
              kicker: 'Step 3',
              title: 'Place it in the funding stack',
              bodyHtml: '<p>Show the mortgage, deposit, savings, and conditional refund together so the client sees the dependency clearly.</p>',
              bullets: ['Separate confirmed savings from conditional support.', 'Stress-test the fallback if the claim is delayed.']
            }
          ],
          visuals: [
            {
              type: 'chart',
              title: 'Illustrative funding stack',
              subtitle: 'Example only: use live figures before relying on any amount.',
              chart: {
                title: 'Funding stack',
                subtitle: 'Conditional support should be separated from confirmed funds.',
                type: 'bar',
                labels: ['Savings', 'HTB support', 'Mortgage'],
                display: {
                  variant: 'hero',
                  valueFormat: 'currency',
                  yAxisTitle: 'Funding amount',
                  highlightDataset: 'Amount'
                },
                annotations: [
                  { label: 'Conditional', xLabel: 'HTB support', yValue: 30000, tone: 'warning', body: 'Only use once eligibility is confirmed.' }
                ],
                insights: [
                  { label: 'Presenter focus', value: 'Conditional layer', detail: 'The client should see which part is not yet guaranteed.', tone: 'warning', featured: true }
                ],
                datasets: [
                  { label: 'Amount', data: [60000, 30000, 360000] }
                ]
              }
            },
            {
              type: 'svg',
              title: 'Eligibility route',
              subtitle: 'A compact decision path for the live explanation',
              svgSpec: {
                kind: 'decisionTree',
                theme: 'dark',
                layout: {
                  direction: 'TB',
                  nodeWidth: 210,
                  nodeHeight: 72,
                  gapX: 52,
                  gapY: 34,
                  connector: 'elbow'
                },
                nodes: [
                  { id: 'buyer', label: 'Buyer qualifies?' },
                  { id: 'tax', label: 'Tax record clean?' },
                  { id: 'property', label: 'Property qualifies?' },
                  { id: 'claim', label: 'Claim can support deposit' },
                  { id: 'fallback', label: 'Use fallback funding plan' }
                ],
                edges: [
                  { from: 'buyer', to: 'tax', label: 'Yes' },
                  { from: 'buyer', to: 'fallback', label: 'No' },
                  { from: 'tax', to: 'property', label: 'Yes' },
                  { from: 'tax', to: 'fallback', label: 'No' },
                  { from: 'property', to: 'claim', label: 'Yes' },
                  { from: 'property', to: 'fallback', label: 'No' }
                ]
              }
            }
          ],
          sections: [
            {
              id: 'plain-english',
              title: 'Plain English Frame',
              bodyHtml: '<p>Help to Buy is a tax refund mechanism that may support the deposit on a qualifying new-build home.</p>',
              bullets: ['It is not a universal grant.', 'It should be checked before being treated as part of confirmed funds.'],
              whyItMatters: 'Clients often anchor on the headline amount before checking whether the purchase path qualifies.'
            },
            {
              id: 'call-structure',
              title: 'How To Explain It Live',
              bodyHtml: '<p>Use the chart for the funding stack and the decision tree for the eligibility route. Keep the explanation anchored to what is confirmed versus conditional.</p>',
              defaultOpen: false
            }
          ],
          references: [
            {
              label: 'Revenue - Help to Buy',
              url: 'https://www.revenue.ie/en/property/help-to-buy-incentive/index.aspx',
              kind: 'official',
              note: 'Use the current Revenue page before relying on limits or eligibility wording.'
            }
          ]
        }
      }
    }
  },
  {
    id: 'education-trusts-timeline-demo',
    label: 'Education: Trusts Timeline Demo',
    payload: {
      title: 'Education - Trusts Timeline',
      generated: {
        summaryHtml: '<p>This module gives a timeline view for a simple trust setup and review cycle.</p>',
        education: {
          topic: 'How a Trust Is Set Up and Managed',
          sections: [
            {
              id: 'timeline-overview',
              title: 'Timeline Overview',
              bodyHtml: '<p>Trust planning usually moves from intent, to setup, to funded operation, then ongoing review.</p>',
              bullets: [
                'Legal and tax advice should be coordinated early.',
                'Trustee responsibilities continue after setup.'
              ]
            }
          ],
          visuals: [
            {
              type: 'svg',
              title: 'Trust Lifecycle Timeline',
              subtitle: 'Chronological view across roles',
              svgSpec: {
                kind: 'timeline',
                theme: 'dark',
                layout: {
                  eventGap: 210,
                  laneGap: 130,
                  nodeWidth: 180,
                  nodeHeight: 84
                },
                lanes: [
                  { id: 'settlor', title: 'Settlor' },
                  { id: 'trustee', title: 'Trustee' },
                  { id: 'beneficiary', title: 'Beneficiary' }
                ],
                events: [
                  {
                    id: 'intent',
                    label: 'Define trust objective',
                    lane: 'settlor',
                    when: 'Week 1',
                    order: 1
                  },
                  {
                    id: 'deed',
                    label: 'Execute trust deed',
                    lane: 'settlor',
                    when: 'Week 2',
                    order: 2
                  },
                  {
                    id: 'fund',
                    label: 'Transfer assets into trust',
                    lane: 'trustee',
                    when: 'Week 3',
                    order: 3
                  },
                  {
                    id: 'admin',
                    label: 'Admin and compliance setup',
                    lane: 'trustee',
                    when: 'Week 4',
                    order: 4
                  },
                  {
                    id: 'review',
                    label: 'Annual beneficiary review',
                    lane: 'beneficiary',
                    when: 'Yearly',
                    order: 5
                  }
                ]
              }
            }
          ],
          references: [
            {
              label: 'Citizens Information - Trusts',
              kind: 'official',
              note: 'Use legal counsel for trust deed drafting.'
            }
          ]
        }
      }
    }
  },
  {
    id: 'education-first-home-decision-demo',
    label: 'Education: First Home Decision Demo',
    payload: {
      title: 'Education - First Home Decision Tree',
      generated: {
        summaryHtml: '<p>A decision tree can help first-home buyers evaluate readiness before offering on a property.</p>',
        education: {
          topic: 'First Home Purchase Decision Tree',
          audience: 'First-time buyers',
          sections: [
            {
              id: 'decision-logic',
              title: 'Decision Logic',
              bodyHtml: '<p>Progress through each branch in order to reduce avoidable delays or financing surprises.</p>',
              bullets: [
                'Branch outcomes should be evidence-based.',
                'Use lender and solicitor feedback before proceeding.'
              ]
            }
          ],
          visuals: [
            {
              type: 'svg',
              title: 'First Home Decision Tree',
              subtitle: 'Go / hold checkpoints',
              svgSpec: {
                kind: 'decisionTree',
                theme: 'dark',
                layout: {
                  direction: 'TB',
                  nodeWidth: 210,
                  nodeHeight: 74,
                  gapX: 56,
                  gapY: 36,
                  connector: 'elbow'
                },
                nodes: [
                  { id: 'start', label: 'Deposit target met?' },
                  { id: 'credit', label: 'Credit profile acceptable?' },
                  { id: 'income', label: 'Income supports repayments?' },
                  { id: 'go', label: 'Proceed to property search' },
                  { id: 'wait', label: 'Pause and improve readiness' }
                ],
                edges: [
                  { from: 'start', to: 'credit', label: 'Yes' },
                  { from: 'start', to: 'wait', label: 'No' },
                  { from: 'credit', to: 'income', label: 'Yes' },
                  { from: 'credit', to: 'wait', label: 'No' },
                  { from: 'income', to: 'go', label: 'Yes' },
                  { from: 'income', to: 'wait', label: 'No' }
                ]
              }
            }
          ],
          references: [
            {
              label: 'Central Bank mortgage rules',
              kind: 'official',
              note: 'Confirm latest lending limits and exceptions.'
            }
          ]
        }
      }
    }
  },
  {
    id: 'education-diversification-comparisonGrid-demo',
    label: 'Education: Diversification Comparison Grid (Graph Mode)',
    payload: {
      title: 'Education - Diversification Comparison Grid',
      generated: {
        summaryHtml: '<p>This demo uses graph-style nodes and edges for comparisonGrid. The renderer should normalize it into a table layout.</p>',
        education: {
          topic: 'Diversification by Risk Profile',
          audience: 'Retail investor education',
          sections: [
            {
              id: 'why-diversify',
              title: 'Why Diversify',
              bodyHtml: '<p>Different risk profiles can favor different mixes of asset classes and wrappers.</p>',
              bullets: [
                'Avoid concentration risk in a single asset class.',
                'Use profile-specific allocations as a starting point.',
                'Review suitability with regulated advice before implementation.'
              ]
            }
          ],
          visuals: [
            {
              type: 'svg',
              title: 'Diversification Comparison Grid',
              subtitle: 'Graph-mode nodes and edges',
              svgSpec: {
                kind: 'comparisonGrid',
                theme: 'dark',
                layout: {
                  nodeWidth: 210,
                  nodeHeight: 116,
                  gapX: 10,
                  gapY: 10
                },
                nodes: [
                  { id: 'col-a', label: 'Core equities', note: 'Global diversified equity funds.' },
                  { id: 'col-b', label: 'Stabilizers', note: 'Bonds, short-duration credit, cash.' },
                  { id: 'col-c', label: 'Alternatives', note: 'Property, infrastructure, diversifiers.' },
                  { id: 'row-1', label: 'Balanced profile' },
                  { id: 'row-2', label: 'Growth profile' },
                  { id: 'a-r', group: 'col-a', label: '50%', note: 'Broad developed + emerging equities.' },
                  { id: 'b-r', group: 'col-b', label: '35%', note: 'High-quality bonds and cash buffers.' },
                  { id: 'c-r', group: 'col-c', label: '15%', note: 'Low-correlation alternatives.' },
                  { id: 'a-s', group: 'col-a', label: '70%', note: 'Higher equity weight for long horizon.' },
                  { id: 'b-s', group: 'col-b', label: '20%', note: 'Smaller defensive allocation.' },
                  { id: 'c-s', group: 'col-c', label: '10%', note: 'Targeted diversifiers.' }
                ],
                edges: [
                  { from: 'row-1', to: 'a-r' },
                  { from: 'row-1', to: 'b-r' },
                  { from: 'row-1', to: 'c-r' },
                  { from: 'row-2', to: 'a-s' },
                  { from: 'row-2', to: 'b-s' },
                  { from: 'row-2', to: 'c-s' }
                ]
              }
            }
          ],
          references: [
            {
              label: 'Investor education materials',
              kind: 'guidance',
              note: 'Educational ranges only; not a personalized recommendation.'
            }
          ]
        }
      }
    }
  },
  {
    id: 'report-research-demo',
    label: 'Report: Research Blocks Demo',
    payload: {
      title: 'Report - Income Research',
      generated: {
        report: {
          title: 'Income progression and affordability',
          rawMarkdown: '# Income progression\\n\\nThis report uses block rendering.',
          blocks: [
            {
              type: 'callout',
              title: 'Executive takeaway',
              tone: 'info',
              markdown: 'Income accelerates through the late 20s and 30s, but housing cost pressure also rises in the same window.'
            },
            {
              type: 'kpiRow',
              title: 'Headline KPIs',
              items: [
                { label: 'Peak growth window', value: '25 to 39', detail: 'Largest step-up in mean earnings' },
                { label: 'Age 30 to 39 income', value: '€53,269', detail: 'Illustrative annual average' },
                { label: 'Affordability pressure', value: 'High', detail: 'Rent and deposit drag grow with age' }
              ]
            },
            {
              type: 'markdown',
              title: 'Context',
              markdown: '## Labour market context\\n\\nEarly-career earnings remain compressed. By the late 20s, promotion velocity and full-time participation tend to lift averages.\\n\\n- Entry level cohorts stay most exposed to volatility\\n- Household formation raises outgoings during the same period'
            },
            {
              type: 'chart',
              chart: {
                title: 'Average annual income by age group',
                type: 'bar',
                labels: ['15 to 24', '25 to 29', '30 to 39'],
                datasets: [
                  { label: 'Mean annual income', data: [21453, 39997, 53269] }
                ]
              }
            },
            {
              type: 'table',
              title: 'Illustrative housing cost pressure',
              table: {
                columns: ['Age group', 'Average income', 'Illustrative rent burden'],
                rows: [
                  ['15 to 24', '€21,453', '41%'],
                  ['25 to 29', '€39,997', '34%'],
                  ['30 to 39', '€53,269', '31%']
                ]
              }
            },
            {
              type: 'chart',
              chart: {
                title: 'Illustrative savings rate by age group',
                type: 'line',
                labels: ['15 to 24', '25 to 29', '30 to 39'],
                datasets: [
                  { label: 'Savings rate', data: [6, 11, 15] }
                ]
              }
            },
            {
              type: 'svg',
              title: 'Income ladder',
              subtitle: 'Career progression concept',
              svgSpec: {
                kind: 'flowchart',
                theme: 'dark',
                layout: {
                  direction: 'TB',
                  nodeWidth: 200,
                  nodeHeight: 66,
                  gapX: 36,
                  gapY: 28,
                  connector: 'elbow'
                },
                nodes: [
                  { id: 'entry', label: 'Entry role' },
                  { id: 'specialist', label: 'Specialist growth' },
                  { id: 'manager', label: 'Manager track' }
                ],
                edges: [
                  { from: 'entry', to: 'specialist' },
                  { from: 'specialist', to: 'manager' }
                ]
              }
            },
            {
              type: 'timeline',
              title: 'Household formation timeline',
              timeline: {
                theme: 'dark',
                lanes: [
                  { id: 'career', title: 'Career' },
                  { id: 'housing', title: 'Housing' }
                ],
                events: [
                  { id: 'first-role', lane: 'career', label: 'First full-time role', when: 'Ages 21-24', order: 1 },
                  { id: 'promotion', lane: 'career', label: 'Promotion cycle', when: 'Ages 25-29', order: 2 },
                  { id: 'rent', lane: 'housing', label: 'Independent renting', when: 'Ages 24-30', order: 3 },
                  { id: 'deposit', lane: 'housing', label: 'Deposit accumulation', when: 'Ages 28-35', order: 4 }
                ]
              }
            },
            {
              type: 'checklist',
              title: 'Advisor checklist',
              items: [
                { label: 'Pressure-test rent and savings assumptions', checked: true },
                { label: 'Segment advice by age cohort', checked: true },
                { label: 'Validate current income dataset before publishing', checked: false, note: 'Replace demo values with live source data' }
              ]
            },
            {
              type: 'sourceList',
              title: 'Sources',
              items: [
                {
                  label: 'CSO earnings reference',
                  kind: 'official',
                  url: 'https://www.cso.ie/',
                  note: 'Use the latest published earnings tables for production outputs.'
                },
                {
                  label: 'Internal affordability model',
                  kind: 'internal',
                  note: 'Scenario assumptions for housing cost burden.'
                }
              ]
            }
          ]
        }
      }
    }
  },
  {
    id: 'report-artifact-client-demo',
    label: 'Report: Artifact Blocks Demo',
    payload: {
      title: 'Report - Retirement Readiness Review',
      generated: {
        summaryHtml: '<p>This report frames retirement readiness around resilience, funding path, and decision points. The aim is to give the client a structured view of what is strong, what needs testing, and what should be verified before acting.</p>',
        report: {
          title: 'Retirement readiness review',
          blocks: [
            {
              type: 'insightGrid',
              title: 'Executive picture',
              layout: 'featured',
              items: [
                { label: 'Readiness signal', value: 'Moderate', detail: 'Current assets support the target path, but contribution discipline remains important.', tone: 'warning', featured: true },
                { label: 'Strongest point', value: 'Pension base', detail: 'Existing accumulated fund gives the plan a meaningful starting point.', tone: 'positive' },
                { label: 'Main risk', value: 'Income gap', detail: 'The desired income depends on sustained contributions and market assumptions.' }
              ]
            },
            {
              type: 'chart',
              title: 'Projected pension path',
              chart: {
                title: 'Projected pension path',
                subtitle: 'Illustrative path using current assumptions.',
                type: 'line',
                labels: ['2026', '2031', '2036', '2041', '2046', '2051'],
                display: {
                  variant: 'wide',
                  valueFormat: 'currency',
                  yAxisTitle: 'Projected fund value'
                },
                annotations: [
                  { label: 'Retirement', xLabel: '2051', tone: 'positive', body: 'Target retirement point in this example.' }
                ],
                insights: [
                  { label: 'Compounding window', value: '25 years', detail: 'The slope depends heavily on contribution consistency.' }
                ],
                datasets: [
                  { label: 'Current path', data: [180000, 260000, 370000, 520000, 720000, 980000] },
                  { label: 'Lower-return path', data: [180000, 245000, 330000, 445000, 590000, 760000] }
                ]
              }
            },
            {
              type: 'scenarioCompare',
              title: 'Scenario comparison',
              scenarios: [
                {
                  label: 'Current path',
                  summary: 'Maintains current contributions and assumptions.',
                  tone: 'positive',
                  metrics: [
                    { label: 'Estimated fund', value: '€980k', detail: 'Illustrative retirement value' },
                    { label: 'Client message', value: 'Stay disciplined', detail: 'The plan is sensitive to consistency.' }
                  ],
                  callout: 'Useful as the base case, not a guarantee.'
                },
                {
                  label: 'Lower-return path',
                  summary: 'Shows the effect of a more cautious growth assumption.',
                  tone: 'warning',
                  metrics: [
                    { label: 'Estimated fund', value: '€760k', detail: 'Lower projected retirement value' },
                    { label: 'Client message', value: 'Build margin', detail: 'Higher contributions or flexibility may be needed.' }
                  ],
                  callout: 'Use this to discuss resilience rather than fear.'
                }
              ]
            },
            {
              type: 'accordion',
              title: 'What needs verifying',
              items: [
                {
                  title: 'Contribution affordability',
                  markdown: 'Check whether the current monthly contribution can be maintained through housing, family, and business-cycle changes.',
                  defaultOpen: true
                },
                {
                  title: 'Tax and product assumptions',
                  markdown: 'Verify pension rules, tax relief, charges, and fund assumptions before turning this into advice.'
                },
                {
                  title: 'Retirement income target',
                  markdown: 'Confirm whether the target is essential spending, desired lifestyle spending, or a blended figure.'
                }
              ]
            },
            {
              type: 'callout',
              title: 'Client-facing interpretation',
              tone: 'info',
              markdown: 'The current path is workable enough to discuss seriously, but not strong enough to ignore assumptions. The best next step is to test contribution capacity and retirement-income flexibility together.'
            }
          ]
        }
      }
    }
  },
  {
    id: 'report-malformed-demo',
    label: 'Report: Malformed Blocks Demo',
    payload: {
      title: 'Report - Malformed Blocks',
      generated: {
        report: {
          title: 'Malformed block handling',
          blocks: [
            {
              type: 'markdown',
              markdown: 'This block should render even when later blocks fail.'
            },
            {
              type: 'chart',
              chart: {
                title: 'Broken chart',
                type: 'bar',
                labels: ['A', 'B', 'C']
              }
            },
            {
              type: 'svg',
              title: 'Broken svg',
              svgSpec: {
                kind: 'flowchart',
                nodes: []
              }
            }
          ]
        }
      }
    }
  },
  {
    id: 'report-raw-markdown-fallback-demo',
    label: 'Report: Raw Markdown Fallback',
    payload: {
      title: 'Report - Raw Markdown Fallback',
      generated: {
        report: {
          title: 'Raw markdown fallback',
          rawMarkdown: '# Fallback content\\n\\nNo structured blocks were supplied, so the module should render this markdown instead.\\n\\n- Bullet one\\n- Bullet two',
          blocks: []
        }
      }
    }
  },
  {
    id: 'college-funding-twins-demo',
    label: 'College Funding: Twins Scenario Demo',
    payload: {
      title: 'College Funding - Twins',
      generated: {
        summaryHtml: '<p>This module compares possible college funding targets for two children, showing living at home versus going away and the effect of one-off car support. The key planning decision is how much liquidity to ring-fence for education before deciding what can be moved into longer-term retirement assets.</p>',
        collegeFundingInputs: {
          currentYear: 2026,
          childrenCount: 2,
          childCurrentAge: 13,
          collegeStartAge: 18,
          collegeDurationYears: 4,
          inflationRate: 0.02,
          planningNote: 'Education costs are modelled separately from normal household spending because they may overlap with early retirement.',
          scenarios: [
            {
              id: 'at-home-no-car',
              title: 'At home, no car support',
              category: 'At home',
              annualCostTodayPerChild: 5000,
              oneOffCostTodayPerChild: 0,
              interpretation: 'Lower education funding target if both children live at home during college.'
            },
            {
              id: 'at-home-with-car',
              title: 'At home, with car support',
              category: 'At home',
              annualCostTodayPerChild: 5000,
              oneOffCostTodayPerChild: 10000,
              interpretation: 'Adds car support to the at-home college scenario.'
            },
            {
              id: 'away-no-car',
              title: 'Away from home, no car support',
              category: 'Away from home',
              annualCostTodayPerChild: 15000,
              oneOffCostTodayPerChild: 0,
              interpretation: 'Higher funding target reflecting accommodation and wider living costs.'
            },
            {
              id: 'away-with-car',
              title: 'Away from home, with car support',
              category: 'Away from home',
              annualCostTodayPerChild: 15000,
              oneOffCostTodayPerChild: 10000,
              interpretation: 'Stress-test scenario including away-from-home college costs and car support.',
              tone: 'warning'
            }
          ]
        }
      }
    }
  },
  {
    id: 'net-retirement-cashflow-demo',
    label: 'Net Retirement Cash Flow Demo',
    payload: {
      title: 'Net Retirement Cash Flow - Property Income Scenarios',
      generated: {
        summaryHtml: '<p>This projection compares the household net spending need against net income sources and converts the annual shortfalls into a required net investment fund today. It uses the stated expenditure, rental income, assumed 50% Irish State Pension from age 66, and the selected after-tax net growth rate. Start with the required net fund and income-versus-expenditure chart, then use the scenario buttons to see how losing the Irish rental income changes the result.</p>',
        netRetirementInputs: {
          currentYear: 2026,
          currentAge: 60,
          horizonEndAge: 100,
          annualExpenditureToday: 90000,
          expenditureInflationRate: 0.02,
          presentValueRate: 0.04,
          availableInvestmentFundToday: 1027000,
          planningNote: 'All income and expenditure figures are treated as after-tax net amounts. Pension funds are pre-tax and should not be compared directly with the required net fund unless pension withdrawal tax has been allowed for separately.',
          incomeSources: [
            {
              id: 'irish-rent',
              title: 'Irish rental income',
              annualAmountToday: 10000,
              startAge: 60,
              inflationIndexed: true
            },
            {
              id: 'eu-rent',
              title: 'Non-Irish EU rental income',
              annualAmountToday: 14000,
              startAge: 60,
              inflationIndexed: true
            },
            {
              id: 'half-irish-state-pension',
              title: '50% Irish State Pension',
              annualAmountToday: 7781.8,
              startAge: 66,
              inflationIndexed: true
            }
          ],
          baseScenarioId: 'keep-irish-rental',
          scenarios: [
            {
              id: 'keep-irish-rental',
              title: 'Keep Irish rental',
              availableInvestmentFundToday: 1027000
            },
            {
              id: 'sell-irish-rental',
              title: 'Sell Irish rental',
              availableInvestmentFundToday: 1477000,
              excludedIncomeSourceIds: ['irish-rent'],
              description: 'Irish rental income is removed and gross sale proceeds are added to investable assets after the cash reserve top-up.'
            }
          ]
        }
      }
    }
  },
  {
    id: 'pension-inline-assumptions-demo',
    label: 'Retirement Inline Assumptions Demo',
    payload: {
      title: 'Retirement Projection (Inline Assumptions Demo)',
      generated: {
        summaryHtml: '<p>This retirement projection tests whether the current pension value, salary, contributions, and retirement age support the chosen income target. Start with the required pension pot and chart, then check the assumptions table to see which facts drive the result.</p>',
        pensionInputs: {
          currentAge: 42,
          retirementAge: 67,
          currentSalary: 85000,
          currentPot: 180000,
          personalPct: 0.08,
          employerPct: 0.06,
          growthRate: 0.05,
          inflationRate: 0.02,
          wageGrowthRate: 0.02,
          horizonEndAge: 92,
          targetIncomeToday: 42000,
          currentYear: 2026,
          minDrawdownMode: false
        }
      }
    }
  },
  {
    id: 'pension-affordable-income-demo',
    label: 'Retirement Affordable Income Demo',
    payload: {
      title: 'Retirement Projection (Affordable Income Mode Demo)',
      generated: {
        summaryHtml: '<p>This retirement projection estimates the income the pension could support across different planning end ages. Start with the affordable-income outputs and chart, then check the assumptions that drive the sustainable income range.</p>',
        pensionInputs: {
          currentAge: 43,
          retirementAge: 67,
          currentSalary: 90000,
          currentPot: 210000,
          personalPct: 0.09,
          employerPct: 0.06,
          growthRate: 0.05,
          inflationRate: 0.02,
          wageGrowthRate: 0.02,
          incomeMode: 'affordable',
          affordableEndAges: [85, 90, 95, 100],
          currentYear: 2026
        }
      }
    }
  },
  {
    id: 'pension-rental-income-scenarios-demo',
    label: 'Retirement Rental Income Scenarios Demo',
    payload: {
      title: 'Retirement Projection (Rental Income Scenarios Demo)',
      generated: {
        summaryHtml: '<p>This retirement projection compares the retirement path with gross rental income continuing and with that rental income removed. Start with the required pension pot and scenario cards to see how the rental income changes the pension balance needed.</p>',
        pensionInputs: {
          currentAge: 42,
          retirementAge: 67,
          currentSalary: 85000,
          currentPot: 180000,
          personalPct: 0.08,
          employerPct: 0.06,
          growthRate: 0.05,
          inflationRate: 0.02,
          wageGrowthRate: 0.02,
          horizonEndAge: 92,
          incomeMode: 'target',
          targetIncomeToday: 42000,
          currentYear: 2026,
          rentalIncomeToday: 18000,
          baseScenarioId: 'with-rent',
          rentalIncomeScenarios: [
            { id: 'with-rent', title: 'With rental income', rentalIncomeToday: 18000 },
            { id: 'rent-lost', title: 'Rental income lost', rentalIncomeToday: 0 }
          ]
        }
      }
    }
  },
  {
    id: 'pension-couple-income-stack-demo',
    label: 'Retirement Couple Income Stack Demo',
    payload: {
      title: 'Retirement Projection (Couple Income Stack Demo)',
      generated: {
        summaryHtml: '<p>This retirement projection models two pensions working toward a shared household retirement income target, with State Pension, rental income, DB income, and ARF minimum withdrawals included. Start with the required pension pot and household income chart, then check the assumptions that need verifying.</p>',
        pensionInputs: {
          currentYear: 2026,
          inflationRate: 0.02,
          growthRate: 0.05,
          wageGrowthRate: 0.02,
          incomeMode: 'target',
          targetIncomeToday: 70000,
          targetStartYear: 2052,
          horizonEndAge: 95,
          currentAge: 42,
          retirementAge: 67,
          currentSalary: 155000,
          currentPot: 300000,
          personalPct: 0.07548,
          employerPct: 0.05548,
          rentalIncomeToday: 18000,
          pensions: [
            {
              id: 'john',
              title: 'John',
              currentAge: 42,
              retirementAge: 67,
              currentSalary: 85000,
              currentPot: 180000,
              personalPct: 0.08,
              employerPct: 0.06
            },
            {
              id: 'mary',
              title: 'Mary',
              currentAge: 40,
              retirementAge: 66,
              currentSalary: 70000,
              currentPot: 120000,
              personalPct: 0.07,
              employerPct: 0.05
            }
          ],
          otherIncomeSources: [
            {
              id: 'mary-db',
              title: 'Mary DB pension',
              type: 'db',
              ownerId: 'mary',
              annualAmountToday: 12000,
              startAge: 66,
              inflationIndexed: true
            }
          ]
        }
      }
    }
  },
  {
    id: 'mortgage-inline-assumptions-demo',
    label: 'Mortgage Inline Assumptions Demo',
    payload: {
      title: 'Mortgage Projection (Inline Assumptions Demo)',
      generated: {
        summaryHtml: '<p>Use the Assumptions pencil to edit mortgage inputs inline.</p>',
        mortgageInputs: {
          currentBalance: 320000,
          annualInterestRate: 0.0425,
          startDateIso: '2026-01-01',
          endDateIso: '2052-12-01',
          repaymentType: 'repayment',
          fixedPaymentAmount: null,
          oneOffOverpayment: 0,
          annualOverpayment: 3000
        }
      }
    }
  },
  {
    id: 'loan-inline-assumptions-demo',
    label: 'Loan Inputs Demo',
    payload: {
      title: 'Loan Projection (Inline Assumptions Demo)',
      generated: {
        summaryHtml: '<p>Use the Assumptions pencil to edit loan inputs inline.</p>',
        loanInputs: {
          loanKind: 'loan',
          currentBalance: 320000,
          annualInterestRate: 0.0425,
          startDateIso: '2026-01-01',
          endDateIso: '2052-12-01',
          repaymentType: 'repayment',
          fixedPaymentAmount: null,
          oneOffOverpayment: 0,
          annualOverpayment: 3000
        }
      }
    }
  },
  {
    id: 'outputsbucketed-auto-repair',
    label: 'OutputsBucketed Auto-Repair',
    payload: {
      title: 'OutputsBucketed Repair Demo',
      generated: {
        summaryHtml: '<p>This payload intentionally includes outputsBucketed issues for auto-repair.</p>',
        outputsBucketed: {
          sections: [
            {
              key: 'liquidity',
              title: 'Liquidity',
              columns: ['Asset', 'Amount (€)'],
              rows: [
                ['Cash', 12000],
                ['Savings', 4500]
              ]
            },
            {
              key: 'cashflow',
              title: 'Cashflow by Year',
              columns: ['Year', 'Income', 'Expenses', 'Net'],
              rows: [
                ['2026', 120000, 80000, 40000],
                ['2027', 128000, 85000, 43000]
              ]
            }
          ]
        }
      }
    }
  }
];

function runDevEducationSvgAssertions() {
  if (!IS_LOCAL_DEV_HOST) {
    return;
  }

  const comparisonDemo = EXAMPLE_PAYLOADS.find((example) => example.id === 'education-diversification-comparisonGrid-demo');
  const svgSpec = comparisonDemo?.payload?.generated?.education?.visuals?.find((visual) => visual?.type === 'svg')?.svgSpec;
  if (!svgSpec) {
    return;
  }

  try {
    const normalized = debugNormalizeComparisonGrid(svgSpec);
    const hasCells = Array.isArray(normalized?.cells) && normalized.cells.length > 0;
    console.assert(hasCells, '[CallCanvas][DevAssert] comparisonGrid graph demo should normalize into non-empty cells.', normalized);
    if (hasCells) {
      console.info('[CallCanvas][DevAssert] comparisonGrid graph demo normalized', {
        mode: normalized.mode,
        rows: normalized.groups.length,
        columns: normalized.columns.length,
        cells: normalized.cells.length
      });
    }
  } catch (error) {
    console.error('[CallCanvas][DevAssert] comparisonGrid graph demo normalization failed', error);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function makeModuleId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }

  return `module-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toSlug(value, fallback) {
  const clean = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return clean || fallback;
}

function makeChartId(moduleId, chartTitle, index) {
  return `${moduleId}-${toSlug(chartTitle, `chart-${index + 1}`)}-${index + 1}`;
}

function createBlankModule() {
  const timestamp = nowIso();
  return {
    id: makeModuleId(),
    createdAt: timestamp,
    updatedAt: timestamp,
    title: '',
    notes: '',
    generated: createEmptyGenerated(),
    ui: {
      tableHighlights: {
        assumptions: {
          selected: [],
          anchor: null
        },
        outputs: {
          selected: [],
          anchor: null
        }
      }
    }
  };
}

function getModulesInOrder() {
  return getOrderedModules(appState.session);
}

function getActiveIndex() {
  return appState.session.order.indexOf(appState.session.activeModuleId);
}

function hasModules() {
  return appState.session.modules.length > 0;
}

function hasNextModule() {
  const activeIndex = getActiveIndex();
  return activeIndex >= 0 && activeIndex < appState.session.order.length - 1;
}

function getModuleIdSet(session = appState.session) {
  return new Set(Array.isArray(session?.order) ? session.order : []);
}

function pruneOverviewSelection() {
  const validIds = getModuleIdSet();
  const nextSelection = appState.overviewSelection.filter((moduleId) => validIds.has(moduleId));
  appState.overviewSelection = [...new Set(nextSelection)];

  const nextPensionMap = new Map();
  appState.pensionShowMaxByModuleId.forEach((value, moduleId) => {
    if (validIds.has(moduleId)) {
      nextPensionMap.set(moduleId, value);
    }
  });
  appState.pensionShowMaxByModuleId = nextPensionMap;

  return appState.overviewSelection;
}

function isSelected(moduleId) {
  return typeof moduleId === 'string' && appState.overviewSelection.includes(moduleId);
}

function toggleSelected(moduleId) {
  if (typeof moduleId !== 'string' || !moduleId) {
    return appState.overviewSelection;
  }

  const validIds = getModuleIdSet();
  if (!validIds.has(moduleId)) {
    return appState.overviewSelection;
  }

  if (isSelected(moduleId)) {
    appState.overviewSelection = appState.overviewSelection.filter((id) => id !== moduleId);
  } else {
    appState.overviewSelection = [...appState.overviewSelection, moduleId];
  }

  return appState.overviewSelection;
}

function clearSelection() {
  appState.overviewSelection = [];
  return appState.overviewSelection;
}

function keepMostRecentTwoSelected() {
  if (appState.overviewSelection.length <= 2) {
    return appState.overviewSelection;
  }

  appState.overviewSelection = appState.overviewSelection.slice(-2);
  return appState.overviewSelection;
}

function getSelectedPair() {
  const selected = pruneOverviewSelection();
  if (selected.length !== 2) {
    return null;
  }

  return [selected[0], selected[1]];
}

function isMultiSelectModifier(event) {
  return Boolean(event && (event.metaKey || event.ctrlKey));
}

function setOverviewMultiSelectArmed(armed) {
  appState.overviewMultiSelectArmed = Boolean(armed);
  const shouldShowArmedCursor = appState.mode === 'overview' && appState.overviewMultiSelectArmed;
  document.body.classList.toggle('multi-select-armed', shouldShowArmedCursor);
}

function normalizeClientName(value) {
  return value.trim();
}

function getClientPipelineContextFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get('client')?.trim() || '';
  const leadId = params.get('lead')?.trim() || '';
  const clientName = params.get('name')?.trim() || '';
  const clientEmail = params.get('email')?.trim().toLowerCase() || '';
  if (!clientId && !leadId && !clientName && !clientEmail) {
    return null;
  }

  return {
    clientId,
    leadId,
    clientName,
    clientEmail
  };
}

function applyClientPipelineContextToSession() {
  if (runtimeConfig.readOnly) {
    return;
  }

  const context = appState.pipelineContext;
  if (!context) {
    return;
  }

  if (context.clientName) {
    appState.session.clientName = normalizeClientName(context.clientName) || appState.session.clientName;
    if (ui.clientNameInput) {
      ui.clientNameInput.value = appState.session.clientName;
    }
  }

  if (context.clientEmail && ui.publishClientEmailInput) {
    ui.publishClientEmailInput.value = context.clientEmail;
  }
}

function ensureGenerated(module) {
  if (!module.generated || typeof module.generated !== 'object') {
    module.generated = createEmptyGenerated();
  }

  module.generated = normalizeGenerated(module.generated);
  ensureModuleUi(module);
}

function createEmptyTableHighlightState() {
  return {
    selected: [],
    anchor: null
  };
}

function normalizeTableHighlightAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
    return null;
  }

  const key = typeof anchor.key === 'string' ? anchor.key.trim() : '';
  const rowIndex = Number(anchor.rowIndex);
  const colIndex = Number(anchor.colIndex);
  if (!key || !Number.isInteger(rowIndex) || !Number.isInteger(colIndex)) {
    return null;
  }

  return {
    key,
    rowIndex,
    colIndex
  };
}

function ensureModuleUi(module) {
  if (!module || typeof module !== 'object') {
    return null;
  }

  if (!module.ui || typeof module.ui !== 'object' || Array.isArray(module.ui)) {
    module.ui = {};
  }

  if (!module.ui.tableHighlights || typeof module.ui.tableHighlights !== 'object' || Array.isArray(module.ui.tableHighlights)) {
    module.ui.tableHighlights = {};
  }

  TABLE_HIGHLIGHT_KINDS.forEach((tableKind) => {
    const current = module.ui.tableHighlights[tableKind];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      module.ui.tableHighlights[tableKind] = createEmptyTableHighlightState();
      return;
    }

    const selected = Array.isArray(current.selected)
      ? [...new Set(current.selected
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean))]
      : [];
    module.ui.tableHighlights[tableKind] = {
      selected,
      anchor: normalizeTableHighlightAnchor(current.anchor)
    };
  });

  return module.ui;
}

function getModuleTableHighlightState(module, tableKind) {
  if (!TABLE_HIGHLIGHT_KINDS.includes(tableKind)) {
    return null;
  }

  const uiState = ensureModuleUi(module);
  if (!uiState) {
    return null;
  }

  return uiState.tableHighlights[tableKind];
}

function getTableHighlightCells(moduleId, tableKind) {
  if (!ui.swipeStage || !moduleId || !TABLE_HIGHLIGHT_KINDS.includes(tableKind)) {
    return [];
  }

  const allCells = [...ui.swipeStage.querySelectorAll(`td[data-table-kind="${tableKind}"][data-cell-key]`)];
  return allCells.filter((cell) => cell.dataset.moduleId === moduleId);
}

function updateTableHighlightDom(moduleId, tableKind) {
  const module = getModuleById(appState.session, moduleId);
  const tableState = module ? getModuleTableHighlightState(module, tableKind) : null;
  const selected = new Set(Array.isArray(tableState?.selected) ? tableState.selected : []);
  const cells = getTableHighlightCells(moduleId, tableKind);
  cells.forEach((cell) => {
    cell.classList.toggle('cc-cell-selected', selected.has(cell.dataset.cellKey || ''));
  });
}

function updateModuleHighlightDom(moduleId) {
  TABLE_HIGHLIGHT_KINDS.forEach((tableKind) => {
    updateTableHighlightDom(moduleId, tableKind);
  });
}

function getColumnRangeCellKeys(moduleId, tableKind, colIndex, rowStart, rowEnd) {
  if (!Number.isInteger(colIndex) || !Number.isInteger(rowStart) || !Number.isInteger(rowEnd)) {
    return [];
  }

  const minRow = Math.min(rowStart, rowEnd);
  const maxRow = Math.max(rowStart, rowEnd);
  const cells = getTableHighlightCells(moduleId, tableKind)
    .filter((cell) => Number(cell.dataset.colIndex) === colIndex)
    .map((cell) => ({
      rowIndex: Number(cell.dataset.rowIndex),
      key: cell.dataset.cellKey || ''
    }))
    .filter((entry) => Number.isInteger(entry.rowIndex) && entry.key);

  const rowToKey = new Map();
  cells.forEach((entry) => {
    if (!rowToKey.has(entry.rowIndex)) {
      rowToKey.set(entry.rowIndex, entry.key);
    }
  });

  return [...rowToKey.entries()]
    .sort((left, right) => left[0] - right[0])
    .filter(([rowIndex]) => rowIndex >= minRow && rowIndex <= maxRow)
    .map(([, key]) => key);
}

function handleTableCellHighlightClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.closest('input, textarea, select, button, a, [contenteditable="true"]')) {
    return;
  }

  const cell = target.closest('td[data-cell-key][data-table-kind][data-module-id]');
  if (!(cell instanceof HTMLTableCellElement)) {
    return;
  }

  const moduleId = String(cell.dataset.moduleId || '').trim();
  const tableKind = String(cell.dataset.tableKind || '').trim();
  const cellKey = String(cell.dataset.cellKey || '').trim();
  const rowIndex = Number(cell.dataset.rowIndex);
  const colIndex = Number(cell.dataset.colIndex);
  if (!moduleId || !cellKey || !TABLE_HIGHLIGHT_KINDS.includes(tableKind)) {
    return;
  }
  if (!Number.isInteger(rowIndex) || !Number.isInteger(colIndex)) {
    return;
  }

  const module = getModuleById(appState.session, moduleId);
  if (!module) {
    return;
  }

  const tableState = getModuleTableHighlightState(module, tableKind);
  if (!tableState) {
    return;
  }

  const isMulti = isMultiSelectModifier(event);
  const isShift = Boolean(event.shiftKey);
  let nextSelected = new Set(Array.isArray(tableState.selected) ? tableState.selected : []);
  let nextAnchor = {
    key: cellKey,
    rowIndex,
    colIndex
  };

  if (isShift) {
    const anchor = normalizeTableHighlightAnchor(tableState.anchor);
    if (anchor && anchor.colIndex === colIndex) {
      const rangeKeys = getColumnRangeCellKeys(moduleId, tableKind, colIndex, anchor.rowIndex, rowIndex);
      const effectiveRange = rangeKeys.length > 0 ? rangeKeys : [cellKey];
      if (isMulti) {
        effectiveRange.forEach((key) => {
          nextSelected.add(key);
        });
      } else {
        nextSelected = new Set(effectiveRange);
      }
    } else {
      nextSelected = new Set([cellKey]);
    }
  } else if (isMulti) {
    if (nextSelected.has(cellKey)) {
      nextSelected.delete(cellKey);
    } else {
      nextSelected.add(cellKey);
    }
  } else {
    nextSelected = new Set([cellKey]);
  }

  tableState.selected = [...nextSelected];
  tableState.anchor = nextAnchor;
  module.updatedAt = nowIso();
  scheduleSessionSave();
  updateTableHighlightDom(moduleId, tableKind);
  event.preventDefault();
}

function clearModuleTableHighlights(moduleId) {
  const module = getModuleById(appState.session, moduleId);
  if (!module) {
    return false;
  }

  let changed = false;
  TABLE_HIGHLIGHT_KINDS.forEach((tableKind) => {
    const tableState = getModuleTableHighlightState(module, tableKind);
    if (!tableState) {
      return;
    }

    const hadSelected = Array.isArray(tableState.selected) && tableState.selected.length > 0;
    const hadAnchor = Boolean(normalizeTableHighlightAnchor(tableState.anchor));
    if (!hadSelected && !hadAnchor) {
      return;
    }

    tableState.selected = [];
    tableState.anchor = null;
    changed = true;
  });

  if (!changed) {
    return false;
  }

  module.updatedAt = nowIso();
  scheduleSessionSave();
  updateModuleHighlightDom(moduleId);
  return true;
}

function getAssumptionsEditorState(moduleId) {
  if (!appState.assumptionsEditorStateByModuleId.has(moduleId)) {
    appState.assumptionsEditorStateByModuleId.set(moduleId, {
      isEditing: false,
      phase: 'idle',
      errors: {},
      draftValues: {},
      phaseTimerId: 0
    });
  }

  return appState.assumptionsEditorStateByModuleId.get(moduleId);
}

function clearAssumptionsEditorTimers(state) {
  if (!state) {
    return;
  }

  if (state.phaseTimerId) {
    window.clearTimeout(state.phaseTimerId);
    state.phaseTimerId = 0;
  }
}

function resetAssumptionsEditorState(moduleId) {
  const state = appState.assumptionsEditorStateByModuleId.get(moduleId);
  if (!state) {
    return;
  }

  clearAssumptionsEditorTimers(state);
  state.isEditing = false;
  state.phase = 'idle';
  state.errors = {};
  state.draftValues = {};
}

function clearAllAssumptionsEditorState() {
  appState.assumptionsEditorStateByModuleId.forEach((state) => {
    clearAssumptionsEditorTimers(state);
  });
  appState.assumptionsEditorStateByModuleId.clear();
}

function getAssumptionsEditorRenderStatus(moduleId) {
  const state = appState.assumptionsEditorStateByModuleId.get(moduleId);
  if (!state) {
    return {
      isEditing: false,
      phase: 'idle',
      errors: {},
      draftValues: {}
    };
  }

  return {
    isEditing: Boolean(state.isEditing),
    phase: state.phase,
    errors: { ...state.errors },
    draftValues: { ...state.draftValues }
  };
}

function getActiveFocusedModuleCard(moduleId) {
  if (!ui.swipeStage || typeof moduleId !== 'string' || !moduleId) {
    return null;
  }

  return ui.swipeStage.querySelector(`.focused-module-card[data-module-id="${moduleId}"]`);
}

function patchFocusedModuleGeneratedContent(moduleId, {
  patchSummary = true,
  patchAssumptions = true,
  patchOutputs = true,
  updateCharts = true,
  replaceCharts = false
} = {}) {
  if (appState.mode !== 'focused' || appState.session.activeModuleId !== moduleId) {
    return;
  }

  const module = getModuleById(appState.session, moduleId);
  if (!module) {
    return;
  }

  const focusedCard = getActiveFocusedModuleCard(moduleId);
  if (!focusedCard) {
    return;
  }

  patchFocusedGeneratedCards({
    focusedCard,
    module,
    onPatchInputs: (action) => handleAssumptionsEditorPatch(action),
    assumptionsEditorStatus: getAssumptionsEditorRenderStatus(moduleId),
    readOnly: runtimeConfig.readOnly,
    patchSummary,
    patchAssumptions,
    patchOutputs,
    patchCharts: replaceCharts
  });

  if (!updateCharts) {
    return;
  }

  const activePane = focusedCard.closest('.swipe-pane')
    || ui.swipeStage.querySelector('.swipe-pane.active');
  if (!activePane) {
    return;
  }

  const chartModule = getChartHydrationModule(module);
  updateChartsForPane(activePane, chartModule, {
    clientName: appState.session.clientName || 'Client',
    moduleTitle: module.title?.trim() || 'Untitled Module',
    paneKey: 'focused-active'
  });
}

function refreshInlineAssumptionsCard(moduleId) {
  patchFocusedModuleGeneratedContent(moduleId, {
    patchSummary: false,
    patchAssumptions: true,
    patchOutputs: false,
    updateCharts: false
  });
}

function setAssumptionsEditorPhase(moduleId, phase) {
  const state = getAssumptionsEditorState(moduleId);

  if (state.phaseTimerId) {
    window.clearTimeout(state.phaseTimerId);
    state.phaseTimerId = 0;
  }

  state.phase = phase;
  refreshInlineAssumptionsCard(moduleId);

  if (phase === 'updated') {
    state.phaseTimerId = window.setTimeout(() => {
      const liveState = getAssumptionsEditorState(moduleId);
      if (liveState.phase === 'updated') {
        liveState.phase = 'idle';
        refreshInlineAssumptionsCard(moduleId);
      }
      liveState.phaseTimerId = 0;
    }, ASSUMPTIONS_UPDATED_FEEDBACK_MS);
  }
}

function normalizeNumericInputText(rawValue) {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return String(rawValue);
  }

  return String(rawValue ?? '')
    .trim()
    .replace(/\u00A0/g, ' ')
    .replace(/[\s,]+/g, '')
    .replace(/[€$£]/g, '');
}

function parseIsoDateToMonthDate(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, 1));
}

function deriveRemainingTermYearsFromMortgageInputs(mortgageInputs) {
  if (Number.isFinite(mortgageInputs?.remainingTermYears) && mortgageInputs.remainingTermYears > 0) {
    return mortgageInputs.remainingTermYears;
  }

  const startMonthDate = parseIsoDateToMonthDate(mortgageInputs?.startDateIso);
  const endMonthDate = parseIsoDateToMonthDate(mortgageInputs?.endDateIso);
  if (!startMonthDate || !endMonthDate) {
    return null;
  }

  const deltaMonths = ((endMonthDate.getUTCFullYear() - startMonthDate.getUTCFullYear()) * 12)
    + (endMonthDate.getUTCMonth() - startMonthDate.getUTCMonth());
  const monthCount = deltaMonths + 1;
  if (!Number.isInteger(monthCount) || monthCount <= 0) {
    return null;
  }

  return monthCount / 12;
}

function getLoanEngineInputs(module) {
  return module?.generated?.loanInputs || module?.generated?.mortgageInputs || null;
}

function getLoanEngineSource(module) {
  if (module?.generated?.loanInputs) {
    return 'loanInputs';
  }
  if (module?.generated?.mortgageInputs) {
    return 'mortgageInputs';
  }
  return 'mortgageInputs';
}

function getDefaultLoanKindForSource(source, loanEngineInputs = null) {
  if (loanEngineInputs?.loanKind === 'loan') {
    return 'loan';
  }
  if (loanEngineInputs?.loanKind === 'mortgage') {
    return 'mortgage';
  }
  return source === 'loanInputs' ? 'loan' : 'mortgage';
}

function setLoanEngineInputs(module, normalizedInputs, { source = null } = {}) {
  const targetSource = source || getLoanEngineSource(module);
  if (targetSource === 'loanInputs') {
    module.generated.loanInputs = normalizedInputs;
    module.generated.mortgageInputs = null;
    return 'loanInputs';
  }

  module.generated.mortgageInputs = normalizedInputs;
  module.generated.loanInputs = null;
  return 'mortgageInputs';
}

function parseLooseNumber(rawValue, { label, required = true } = {}) {
  const cleaned = normalizeNumericInputText(rawValue);
  if (!cleaned) {
    if (required) {
      return { error: `${label} is required.` };
    }
    return { value: null };
  }

  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric)) {
    return { error: `${label} must be a valid number.` };
  }

  return { value: numeric };
}

function parseRateInput(rawValue, { label }) {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return { value: rawValue };
  }

  const original = String(rawValue ?? '').trim();
  const cleaned = normalizeNumericInputText(original).replace(/%/g, '');
  if (!cleaned) {
    return { error: `${label} is required.` };
  }

  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric)) {
    return { error: `${label} must be a valid rate.` };
  }

  const hasPercentSymbol = original.includes('%');
  const decimal = hasPercentSymbol || Math.abs(numeric) > 1
    ? (numeric / 100)
    : numeric;

  return { value: decimal };
}

function parseIntegerInput(rawValue, { label }) {
  const parsed = parseLooseNumber(rawValue, { label });
  if (parsed.error) {
    return parsed;
  }

  if (!Number.isInteger(parsed.value)) {
    return { error: `${label} must be a whole number.` };
  }

  return { value: parsed.value };
}

function parsePositiveNumberInput(rawValue, { label }) {
  const parsed = parseLooseNumber(rawValue, { label });
  if (parsed.error) {
    return parsed;
  }

  if (!(parsed.value > 0)) {
    return { error: `${label} must be greater than 0.` };
  }

  return parsed;
}

function parseNonNegativeNumberInput(rawValue, { label }) {
  const parsed = parseLooseNumber(rawValue, { label });
  if (parsed.error) {
    return parsed;
  }

  if (parsed.value < 0) {
    return { error: `${label} must be greater than or equal to 0.` };
  }

  return parsed;
}

function mapPensionNormalizationErrorToField(message) {
  if (message.includes('.currentAge')) {
    return 'currentAge';
  }
  if (message.includes('.growthRate')) {
    return 'growthRate';
  }
  if (message.includes('.wageGrowthRate')) {
    return 'wageGrowthRate';
  }
  if (message.includes('.inflationRate')) {
    return 'inflationRate';
  }
  if (message.includes('.retirementAge')) {
    return 'retirementAge';
  }
  if (message.includes('.currentSalary')) {
    return 'currentSalary';
  }
  if (message.includes('.currentPot')) {
    return 'currentPot';
  }
  if (message.includes('.personalPct')) {
    return 'personalPct';
  }
  if (message.includes('.employerPct')) {
    return 'employerPct';
  }
  if (message.includes('.targetIncomeToday')) {
    return 'targetIncomeToday';
  }
  if (message.includes('.rentalIncomeToday')) {
    return 'rentalIncomeToday';
  }
  if (message.includes('.horizonEndAge')) {
    return 'horizonEndAge';
  }
  return null;
}

function mapNetRetirementNormalizationErrorToField(message) {
  if (message.includes('.currentAge')) {
    return 'currentAge';
  }
  if (message.includes('.horizonEndAge')) {
    return 'horizonEndAge';
  }
  if (message.includes('.annualExpenditureToday')) {
    return 'annualExpenditureToday';
  }
  if (message.includes('.expenditureInflationRate')) {
    return 'expenditureInflationRate';
  }
  if (message.includes('.presentValueRate')) {
    return 'presentValueRate';
  }
  if (message.includes('.availableInvestmentFundToday')) {
    return 'availableInvestmentFundToday';
  }
  return null;
}

function mapMortgageNormalizationErrorToField(message) {
  if (message.includes('.currentBalance')) {
    return 'currentBalance';
  }
  if (message.includes('.annualInterestRate')) {
    return 'annualInterestRate';
  }
  if (message.includes('.remainingTermYears') || message.includes('.endDateIso')) {
    return 'termMonths';
  }
  if (message.includes('.oneOffOverpayment')) {
    return 'oneOffOverpayment';
  }
  if (message.includes('.annualOverpayment')) {
    return 'annualOverpayment';
  }
  if (message.includes('.fixedPaymentAmount')) {
    return 'fixedPaymentAmount';
  }
  return null;
}

function shouldRefreshMortgageSummary(summaryHtml) {
  const text = String(summaryHtml || '');
  if (!text.trim()) {
    return true;
  }

  return /[\d€%]/.test(text);
}

function hasOwnPropertyValue(object, key) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

function parseTermMonthsInput(rawValue, { label }) {
  const normalized = String(rawValue ?? '')
    .toLowerCase()
    .replace(/months?/g, '')
    .trim();
  const parsed = parseIntegerInput(normalized, { label });
  if (parsed.error) {
    return parsed;
  }

  if (parsed.value <= 0) {
    return { error: `${label} must be greater than 0.` };
  }

  return parsed;
}

function parsePensionFieldInput(field, rawValue) {
  switch (field) {
    case 'currentAge':
      return parseIntegerInput(rawValue, { label: 'Current age' });
    case 'retirementAge':
      return parseIntegerInput(rawValue, { label: 'Retirement age' });
    case 'currentSalary':
      return parseNonNegativeNumberInput(rawValue, { label: 'Current salary' });
    case 'currentPot':
      return parseNonNegativeNumberInput(rawValue, { label: 'Current pension value' });
    case 'personalPct':
      return parseRateInput(rawValue, { label: 'Personal contribution' });
    case 'employerPct':
      return parseRateInput(rawValue, { label: 'Employer contribution' });
    case 'growthRate':
      return parseRateInput(rawValue, { label: 'Growth rate' });
    case 'wageGrowthRate':
      return parseRateInput(rawValue, { label: 'Wage growth' });
    case 'inflationRate':
      return parseRateInput(rawValue, { label: 'Inflation' });
    case 'targetIncomeToday':
      return parseNonNegativeNumberInput(rawValue, { label: 'Target retirement income' });
    case 'rentalIncomeToday':
      return parseNonNegativeNumberInput(rawValue, { label: 'Gross rental income' });
    default:
      return { error: 'Unsupported pension assumption field.' };
  }
}

function parseNetRetirementFieldInput(field, rawValue) {
  switch (field) {
    case 'currentAge':
      return parseIntegerInput(rawValue, { label: 'Current age' });
    case 'horizonEndAge':
      return parseIntegerInput(rawValue, { label: 'Projection end age' });
    case 'annualExpenditureToday':
      return parseNonNegativeNumberInput(rawValue, { label: 'Annual net expenditure' });
    case 'expenditureInflationRate':
      return parseRateInput(rawValue, { label: 'Expenditure inflation' });
    case 'presentValueRate':
      return parseRateInput(rawValue, { label: 'Present value net growth rate' });
    case 'availableInvestmentFundToday':
      return parseNonNegativeNumberInput(rawValue, { label: 'Available investment fund' });
    default:
      return { error: 'Unsupported net retirement assumption field.' };
  }
}

function parseMortgageFieldInput(field, rawValue) {
  switch (field) {
    case 'currentBalance':
      return parsePositiveNumberInput(rawValue, { label: 'Current balance' });
    case 'annualInterestRate':
      return parseRateInput(rawValue, { label: 'Annual interest rate' });
    case 'termMonths':
      return parseTermMonthsInput(rawValue, { label: 'Term (months)' });
    case 'oneOffOverpayment':
      return parseNonNegativeNumberInput(rawValue, { label: 'One-off overpayment' });
    case 'annualOverpayment':
      return parseNonNegativeNumberInput(rawValue, { label: 'Annual overpayment' });
    case 'fixedPaymentAmount':
      return parsePositiveNumberInput(rawValue, { label: 'Fixed monthly payment' });
    default:
      return { error: 'Unsupported mortgage assumption field.' };
  }
}

function clearAssumptionsFieldErrors(state, fields) {
  const nextErrors = { ...(state.errors || {}) };
  fields.forEach((field) => {
    delete nextErrors[field];
  });
  state.errors = nextErrors;
}

function setAssumptionsFieldError(state, field, message) {
  state.errors = {
    ...(state.errors || {}),
    [field]: message
  };
}

function clearAssumptionsDraftFields(state, fields) {
  const nextDraft = { ...(state.draftValues || {}) };
  fields.forEach((field) => {
    delete nextDraft[field];
  });
  state.draftValues = nextDraft;
}

function applyUpdatedProjectionToModule({
  module,
  calculator,
  normalizedInputs
}) {
  if (calculator === 'pension') {
    module.generated.pensionInputs = normalizedInputs;
    module.generated.mortgageInputs = null;
    module.generated.loanInputs = null;
    module.generated.netRetirementInputs = null;
    applyPensionProjectionToModule(module, { updateSummary: true });
    return;
  }

  if (calculator === 'netRetirement') {
    module.generated.netRetirementInputs = normalizedInputs;
    module.generated.pensionInputs = null;
    module.generated.mortgageInputs = null;
    module.generated.loanInputs = null;
    module.generated.collegeFundingInputs = null;
    applyNetRetirementProjectionToModule(module);
    return;
  }

  if (calculator === 'mortgage') {
    const existingSource = getLoanEngineSource(module);
    const targetSource = existingSource === 'loanInputs' || normalizedInputs?.loanKind === 'loan'
      ? 'loanInputs'
      : 'mortgageInputs';
    setLoanEngineInputs(module, normalizedInputs, { source: targetSource });
    module.generated.pensionInputs = null;
    module.generated.netRetirementInputs = null;
    const shouldUpdateSummary = shouldRefreshMortgageSummary(module.generated.summaryHtml);
    applyMortgageProjectionToModule(module, { updateSummary: shouldUpdateSummary });
  }
}

function commitPensionAssumptionField({
  module,
  state,
  field,
  rawValue
}) {
  const baseInputs = module?.generated?.pensionInputs;
  if (!baseInputs) {
    return {
      ok: false,
      field,
      message: 'Pension inputs are unavailable for this module.'
    };
  }

  const candidate = { ...baseInputs };
  const parsed = parsePensionFieldInput(field, rawValue);
  if (parsed.error) {
    return {
      ok: false,
      field,
      message: parsed.error
    };
  }
  candidate[field] = parsed.value;

  if (field === 'rentalIncomeToday' && Array.isArray(candidate.rentalIncomeScenarios)) {
    const selectedScenarioId = getPensionScenarioForModule(module.id);
    let updatedSelectedScenario = false;
    candidate.rentalIncomeScenarios = candidate.rentalIncomeScenarios.map((scenario) => {
      if (scenario?.id !== selectedScenarioId) {
        return scenario;
      }

      updatedSelectedScenario = true;
      return {
        ...scenario,
        rentalIncomeToday: parsed.value
      };
    });

    if (updatedSelectedScenario && candidate.baseScenarioId !== selectedScenarioId) {
      candidate.rentalIncomeToday = baseInputs.rentalIncomeToday ?? 0;
    }
  }

  let normalizedInputs;
  try {
    normalizedInputs = normalizePensionInputs(candidate);
  } catch (error) {
    const message = error?.message || 'Invalid pension assumptions.';
    const mappedField = mapPensionNormalizationErrorToField(message) || field;
    return {
      ok: false,
      field: mappedField,
      message
    };
  }

  applyUpdatedProjectionToModule({
    module,
    calculator: 'pension',
    normalizedInputs
  });
  clearAssumptionsDraftFields(state, [field]);
  return {
    ok: true
  };
}

function commitNetRetirementAssumptionField({
  module,
  state,
  field,
  rawValue
}) {
  const baseInputs = module?.generated?.netRetirementInputs;
  if (!baseInputs) {
    return {
      ok: false,
      field,
      message: 'Net retirement inputs are unavailable for this module.'
    };
  }

  const candidate = { ...baseInputs };
  const parsed = parseNetRetirementFieldInput(field, rawValue);
  if (parsed.error) {
    return {
      ok: false,
      field,
      message: parsed.error
    };
  }
  candidate[field] = parsed.value;

  let normalizedInputs;
  try {
    normalizedInputs = normalizeNetRetirementInputs(candidate);
  } catch (error) {
    const message = error?.message || 'Invalid net retirement assumptions.';
    const mappedField = mapNetRetirementNormalizationErrorToField(message) || field;
    return {
      ok: false,
      field: mappedField,
      message
    };
  }

  applyUpdatedProjectionToModule({
    module,
    calculator: 'netRetirement',
    normalizedInputs
  });
  clearAssumptionsDraftFields(state, [field]);
  return {
    ok: true
  };
}

function getMortgagePaymentModeForCommit({ state, baseInputs, modeOverride = null }) {
  if (modeOverride === 'fixed' || modeOverride === 'calculated') {
    return modeOverride;
  }

  const draftMode = String(state?.draftValues?.fixedPaymentMode || '').trim().toLowerCase();
  if (draftMode === 'fixed' || draftMode === 'calculated') {
    return draftMode;
  }

  return Number.isFinite(baseInputs?.fixedPaymentAmount) && baseInputs.fixedPaymentAmount > 0
    ? 'fixed'
    : 'calculated';
}

function commitMortgageAssumptionField({
  module,
  state,
  field,
  rawValue,
  modeOverride = null
}) {
  const baseInputs = getLoanEngineInputs(module);
  if (!baseInputs) {
    return {
      ok: false,
      field: field || 'currentBalance',
      message: 'Loan inputs are unavailable for this module.'
    };
  }

  const candidate = { ...baseInputs, repaymentType: 'repayment' };
  let nextMode = getMortgagePaymentModeForCommit({
    state,
    baseInputs,
    modeOverride
  });

  if (field && field !== 'fixedPaymentMode') {
    const parsed = parseMortgageFieldInput(field, rawValue);
    if (parsed.error) {
      return {
        ok: false,
        field,
        message: parsed.error
      };
    }

    if (field === 'termMonths') {
      const termYears = Number((parsed.value / 12).toFixed(2));
      candidate.remainingTermYears = termYears;
      candidate.endDateIso = null;
    } else {
      candidate[field] = parsed.value;
    }
  }

  if (field === 'fixedPaymentMode') {
    nextMode = modeOverride === 'fixed' ? 'fixed' : 'calculated';
  }

  if (nextMode === 'fixed') {
    const fixedRawValue = field === 'fixedPaymentAmount'
      ? rawValue
      : (
        hasOwnPropertyValue(state?.draftValues, 'fixedPaymentAmount')
          ? state.draftValues.fixedPaymentAmount
          : baseInputs.fixedPaymentAmount
      );
    const fixedParsed = parsePositiveNumberInput(fixedRawValue, { label: 'Fixed monthly payment' });
    if (fixedParsed.error) {
      return {
        ok: false,
        field: 'fixedPaymentAmount',
        message: fixedParsed.error
      };
    }
    candidate.fixedPaymentAmount = fixedParsed.value;
  } else {
    candidate.fixedPaymentAmount = null;
  }

  if (!Number.isFinite(candidate.remainingTermYears) && !candidate.endDateIso) {
    candidate.remainingTermYears = deriveRemainingTermYearsFromMortgageInputs(baseInputs);
  }

  let normalizedInputs;
  try {
    const source = getLoanEngineSource(module);
    const defaultLoanKind = getDefaultLoanKindForSource(source, baseInputs);
    normalizedInputs = normalizeMortgageInputs(candidate, { defaultLoanKind });
  } catch (error) {
    const message = error?.message || 'Invalid mortgage assumptions.';
    const mappedField = mapMortgageNormalizationErrorToField(message) || field || 'currentBalance';
    return {
      ok: false,
      field: mappedField,
      message
    };
  }

  applyUpdatedProjectionToModule({
    module,
    calculator: 'mortgage',
    normalizedInputs
  });
  const clearedFields = [
    field,
    'fixedPaymentMode',
    nextMode === 'fixed' ? 'fixedPaymentAmount' : null
  ].filter(Boolean);
  clearAssumptionsDraftFields(state, clearedFields);
  return {
    ok: true
  };
}

function applyPensionProjectionToModule(module, { updateSummary = true } = {}) {
  const projection = computePensionProjection(module.generated.pensionInputs);
  const currentScenario = projection.debug?.currentScenario || {
    contribEurSeries: [],
    growthEurSeries: []
  };

  module.generated.assumptions = projection.assumptionsTable;
  module.generated.outputs = projection.outputsTable;
  module.generated.outputsBucketed = null;
  module.generated.charts = projection.charts.map((chart, index) => ({
    ...chart,
    id: chart.id || makeChartId(module.id, chart.title, index)
  }));

  if (updateSummary) {
    module.generated.summaryHtml = injectAutoPensionSummarySentences(
      module.generated.summaryHtml,
      {
        readinessSentence: projection.debug.readinessSentence,
        sftSentence: projection.debug.sftSentence,
        personalCapSentence: projection.debug.currentPersonalCapSentence
      }
    );
  }

  console.info('[CallCanvas] pension projection computed', {
    inputs: projection.debug.inputs,
    projectedPotCurrent: projection.debug.projectedPotCurrent,
    projectedPotMaxPersonal: projection.debug.projectedPotMaxPersonal,
    requiredPot: projection.debug.requiredPot,
    retirementYear: projection.debug.retirementYear,
    sftValue: projection.debug.sftValue,
    sftYearUsed: projection.debug.sftYearUsed,
    heldConstantBeyond2029: projection.debug.sftHeldConstantBeyond2029,
    breaches: projection.debug.sftBreaches
  });
  console.info('[pension] chart1 dataset labels', projection.charts[0].datasets.map((dataset) => dataset.label));
  console.info(
    '[pension] contrib sample',
    currentScenario.contribEurSeries.slice(0, 3),
    currentScenario.growthEurSeries.slice(0, 3)
  );

  if (Array.isArray(projection.debug.maxSeriesMonotonicIssues) && projection.debug.maxSeriesMonotonicIssues.length > 0) {
    console.warn('[CallCanvas] max personal series is not monotonic non-decreasing', {
      issues: projection.debug.maxSeriesMonotonicIssues
    });
  }

  appState.lastValidProjectionByModuleId.set(module.id, {
    calculator: 'pension',
    inputs: { ...module.generated.pensionInputs },
    debug: projection.debug
  });

  return projection;
}

function applyCollegeFundingProjectionToModule(module) {
  const projection = computeCollegeFundingProjection(module.generated.collegeFundingInputs);

  module.generated.assumptions = projection.assumptionsTable;
  module.generated.outputs = projection.outputsTable;
  module.generated.outputsBucketed = null;
  module.generated.charts = projection.charts.map((chart, index) => ({
    ...chart,
    id: chart.id || makeChartId(module.id, chart.title, index)
  }));

  console.info('[CallCanvas] college funding projection computed', {
    inputs: projection.debug.inputs,
    yearsUntilCollege: projection.debug.yearsUntilCollege,
    todayRange: projection.debug.todayRange,
    nominalRange: projection.debug.nominalRange,
    stressScenario: projection.debug.stressScenario?.title
  });

  appState.lastValidProjectionByModuleId.set(module.id, {
    calculator: 'collegeFunding',
    inputs: { ...module.generated.collegeFundingInputs },
    debug: projection.debug
  });

  return projection;
}

function applyNetRetirementProjectionToModule(module) {
  const projection = computeNetRetirementProjection(module.generated.netRetirementInputs);

  module.generated.assumptions = projection.assumptionsTable;
  module.generated.outputs = projection.outputsTable;
  module.generated.outputsBucketed = null;
  module.generated.tables = projection.tables;
  module.generated.charts = projection.charts.map((chart, index) => ({
    ...chart,
    id: chart.id || makeChartId(module.id, chart.title, index)
  }));

  console.info('[CallCanvas] net retirement projection computed', {
    inputs: projection.debug.inputs,
    scenarioId: projection.debug.scenarioId,
    firstYearShortfall: projection.debug.firstYearShortfall,
    requiredFundToday: projection.debug.requiredFundToday,
    surplusVsRequired: projection.debug.surplusVsRequired
  });

  appState.lastValidProjectionByModuleId.set(module.id, {
    calculator: 'netRetirement',
    inputs: { ...module.generated.netRetirementInputs },
    debug: projection.debug
  });

  return projection;
}

function applyMortgageProjectionToModule(module, { updateSummary = true } = {}) {
  const loanEngineInputs = getLoanEngineInputs(module);
  if (!loanEngineInputs) {
    throw new Error('Loan inputs are unavailable for this module.');
  }
  const source = getLoanEngineSource(module);
  const defaultLoanKind = getDefaultLoanKindForSource(source, loanEngineInputs);
  const normalizedInputs = normalizeMortgageInputs(loanEngineInputs, { defaultLoanKind });
  const resolvedSource = setLoanEngineInputs(module, normalizedInputs, { source });
  const projection = computeMortgageProjection(normalizedInputs, { defaultLoanKind });

  module.generated.assumptions = projection.assumptionsTable;
  module.generated.outputs = projection.outputsTable;
  module.generated.outputsBucketed = null;
  module.generated.charts = projection.charts.map((chart, index) => ({
    ...chart,
    id: chart.id || makeChartId(module.id, chart.title, index)
  }));

  if (updateSummary) {
    module.generated.summaryHtml = projection.summaryHtml;
  }

  console.info('[CallCanvas] mortgage projection computed', {
    loanSource: resolvedSource,
    inputs: normalizedInputs,
    monthsPlanned: projection.debug?.monthsPlanned,
    monthsSimulated: projection.debug?.monthsSimulated,
    monthlyPayment: projection.debug?.paymentUsedMonthly,
    payoffYear: projection.debug?.payoffYear,
    totalInterestLifetime: projection.debug?.totalInterestLifetime,
    totalPaidLifetime: projection.debug?.totalPaidLifetime
  });

  appState.lastValidProjectionByModuleId.set(module.id, {
    calculator: 'mortgage',
    inputs: { ...normalizedInputs },
    debug: projection.debug
  });

  return projection;
}

function clearCompareScrollSyncCleanup() {
  if (typeof appState.compareScrollCleanup === 'function') {
    appState.compareScrollCleanup();
  }
  appState.compareScrollCleanup = null;
}

function clearUndoActionState() {
  const undo = appState.undoAction;
  if (ui.toastHost) {
    ui.toastHost.classList.remove('has-interactive-toast');
  }
  appState.lastDeletedBatch = null;
  if (!undo) {
    return;
  }

  if (undo.intervalId) {
    window.clearInterval(undo.intervalId);
  }
  if (undo.timeoutId) {
    window.clearTimeout(undo.timeoutId);
  }
  if (undo.toastEl?.isConnected) {
    undo.toastEl.remove();
  }

  appState.undoAction = null;
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildDeleteUndoSnapshot(selectedIds, orderBefore, activeModuleIdBeforeDelete) {
  const modulesById = new Map(appState.session.modules.map((module, index) => [module.id, {
    moduleIndex: index,
    module
  }]));
  const orderIndexById = new Map(orderBefore.map((moduleId, index) => [moduleId, index]));
  const selectedSet = new Set(selectedIds);

  const entries = selectedIds
    .map((moduleId) => {
      const moduleEntry = modulesById.get(moduleId);
      const orderIndex = orderIndexById.get(moduleId);
      if (!moduleEntry || !Number.isInteger(orderIndex)) {
        return null;
      }

      return {
        moduleId,
        moduleIndex: moduleEntry.moduleIndex,
        orderIndex,
        module: cloneSerializable(moduleEntry.module)
      };
    })
    .filter(Boolean);

  return {
    selectedIds: [...selectedIds],
    entries,
    deletedActiveModuleId: selectedSet.has(activeModuleIdBeforeDelete) ? activeModuleIdBeforeDelete : null,
    selectionBeforeDelete: [...appState.overviewSelection]
  };
}

async function restoreDeletedBatch(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.entries) || snapshot.entries.length === 0) {
    return;
  }

  const existingModuleIds = new Set(appState.session.modules.map((module) => module.id));
  const entriesByModuleIndex = [...snapshot.entries]
    .sort((a, b) => a.moduleIndex - b.moduleIndex);

  entriesByModuleIndex.forEach((entry) => {
    if (!entry?.moduleId || existingModuleIds.has(entry.moduleId)) {
      return;
    }
    const insertionIndex = Math.max(0, Math.min(appState.session.modules.length, entry.moduleIndex));
    appState.session.modules.splice(insertionIndex, 0, cloneSerializable(entry.module));
    existingModuleIds.add(entry.moduleId);
  });

  const orderEntries = [...snapshot.entries].sort((a, b) => a.orderIndex - b.orderIndex);
  const orderSet = new Set(appState.session.order);
  orderEntries.forEach((entry) => {
    if (!entry?.moduleId || orderSet.has(entry.moduleId)) {
      return;
    }
    const insertionIndex = Math.max(0, Math.min(appState.session.order.length, entry.orderIndex));
    appState.session.order.splice(insertionIndex, 0, entry.moduleId);
    orderSet.add(entry.moduleId);
  });

  const validModuleIds = new Set(appState.session.modules.map((module) => module.id));
  appState.session.order = appState.session.order.filter((moduleId, index, source) => (
    validModuleIds.has(moduleId) && source.indexOf(moduleId) === index
  ));

  if (snapshot.deletedActiveModuleId && validModuleIds.has(snapshot.deletedActiveModuleId)) {
    appState.session.activeModuleId = snapshot.deletedActiveModuleId;
  } else if (!validModuleIds.has(appState.session.activeModuleId)) {
    ensureActiveModule(appState.session);
  }

  appState.overviewSelection = Array.isArray(snapshot.selectionBeforeDelete)
    ? snapshot.selectionBeforeDelete.filter((moduleId) => validModuleIds.has(moduleId))
    : [];
  pruneOverviewSelection();

  if (!hasModules()) {
    appState.mode = 'greeting';
    ui.swipeStage.innerHTML = '';
    setMode(ui, 'greeting');
    updateUiChrome();
    return;
  }

  if (appState.mode === 'focused') {
    await renderFocused({ useSwipe: false, revealMode: true });
    return;
  }

  if (appState.mode === 'compare') {
    await exitCompareView({ preserveSelection: true });
    return;
  }

  appState.mode = 'overview';
  setMode(ui, 'overview');
  refreshOverview({ enableSortable: true });
  updateUiChrome();
}

function startDeleteUndoSnackbar({
  deletedCount,
  snapshot
}) {
  if (!ui.toastHost || !snapshot) {
    return;
  }

  clearUndoActionState();
  ui.toastHost.classList.add('has-interactive-toast');

  const createdAt = Date.now();
  const expiresAt = createdAt + (OVERVIEW_UNDO_SECONDS * 1000);
  appState.lastDeletedBatch = {
    timestamp: createdAt,
    expiresAt,
    snapshot
  };

  const toast = document.createElement('div');
  toast.className = 'toast toast-undo';

  const messageEl = document.createElement('span');
  messageEl.className = 'toast-undo-message';
  messageEl.textContent = `${deletedCount} module${deletedCount === 1 ? '' : 's'} deleted`;
  toast.appendChild(messageEl);

  const undoButton = document.createElement('button');
  undoButton.type = 'button';
  undoButton.className = 'toast-undo-btn';
  toast.appendChild(undoButton);
  ui.toastHost.appendChild(toast);

  const undoState = {
    toastEl: toast,
    undoButtonEl: undoButton,
    remainingSeconds: OVERVIEW_UNDO_SECONDS,
    intervalId: 0,
    timeoutId: 0
  };

  const renderCountdown = () => {
    undoButton.textContent = `Undo · ${undoState.remainingSeconds}s`;
  };

  undoButton.addEventListener('click', async () => {
    if (appState.undoAction !== undoState) {
      return;
    }

    const batch = appState.lastDeletedBatch;
    if (!batch || Date.now() > batch.expiresAt) {
      clearUndoActionState();
      return;
    }

    undoButton.disabled = true;
    try {
      await restoreDeletedBatch(batch.snapshot);
      markSessionDirty();
      saveSessionNow();
    } catch (error) {
      console.error('[CallCanvas] failed to restore deleted modules batch', error);
      showToast('Could not restore deleted modules.', 'error');
    } finally {
      clearUndoActionState();
    }
  });

  renderCountdown();
  undoState.intervalId = window.setInterval(() => {
    if (appState.undoAction !== undoState) {
      return;
    }
    undoState.remainingSeconds = Math.max(0, undoState.remainingSeconds - 1);
    renderCountdown();
  }, 1000);
  undoState.timeoutId = window.setTimeout(() => {
    if (appState.undoAction === undoState) {
      clearUndoActionState();
    }
  }, OVERVIEW_UNDO_SECONDS * 1000);

  appState.undoAction = undoState;
}

function showToast(message, type = 'success') {
  if (!ui.toastHost) {
    return;
  }

  const toast = document.createElement('div');
  toast.className = `toast${type === 'error' ? ' error' : ''}`;
  toast.textContent = message;

  ui.toastHost.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 2600);
}

function saveSessionNow() {
  if (!runtimeConfig.persistLocalSession) {
    return;
  }

  stateManager.saveNow(appState.session);
}

function scheduleSessionSave() {
  if (!runtimeConfig.persistLocalSession) {
    return;
  }

  stateManager.scheduleSave(appState.session);
}

function markSessionDirty() {
  if (!runtimeConfig.persistLocalSession) {
    return;
  }

  stateManager.markDirty();
}

function markSessionClean() {
  if (!runtimeConfig.persistLocalSession) {
    return;
  }

  stateManager.markClean();
}

function setDevPanelOpen(open) {
  if (appState.mode === 'compare' && open) {
    open = false;
  }

  appState.devPanelOpen = open;

  if (!ui.devPanel) {
    return;
  }

  ui.devPanel.classList.toggle('is-hidden', !open);
  ui.devPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function populateDevExamples() {
  if (!ui.devExampleSelect) {
    return;
  }

  ui.devExampleSelect.innerHTML = '';

  EXAMPLE_PAYLOADS.forEach((example) => {
    const option = document.createElement('option');
    option.value = example.id;
    option.textContent = example.label;
    ui.devExampleSelect.appendChild(option);
  });
}

function isMobileLayoutActive() {
  return window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY).matches;
}

function isMobileOverflowOpen() {
  return document.body.classList.contains('mobile-overflow-open');
}

function isMobileModuleSheetOpen() {
  return document.body.classList.contains('mobile-module-sheet-open');
}

function setMobileMoreButtonsExpanded(expanded) {
  [ui.mobileHeaderMoreButton, ui.mobileActionMoreButton].forEach((button) => {
    if (button) {
      button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
  });
}

function setMobileModulesButtonExpanded(expanded) {
  if (ui.mobileFocusModulesButton) {
    ui.mobileFocusModulesButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

function getFirstMobileOverflowAction() {
  if (!ui.mobileOverflowPanel) {
    return null;
  }

  return ui.mobileOverflowPanel.querySelector('select:not(:disabled):not(.is-hidden), button:not(:disabled):not(.is-hidden)');
}

function resetMobileOverflowSwipeStyles() {
  if (ui.mobileOverflowPanel) {
    ui.mobileOverflowPanel.style.transition = '';
    ui.mobileOverflowPanel.style.transform = '';
  }
  if (ui.mobileOverflowBackdrop) {
    ui.mobileOverflowBackdrop.style.opacity = '';
  }
  mobileSheetTouchStartY = null;
  mobileSheetTouchDeltaY = 0;
}

function getFirstMobileModuleSheetAction() {
  if (!ui.mobileModulePanel) {
    return null;
  }

  return ui.mobileModulePanel.querySelector('.mobile-module-item.is-active, .mobile-module-item');
}

function resetMobileModuleSheetSwipeStyles() {
  if (ui.mobileModulePanel) {
    ui.mobileModulePanel.style.transition = '';
    ui.mobileModulePanel.style.transform = '';
  }
  if (ui.mobileModuleBackdrop) {
    ui.mobileModuleBackdrop.style.opacity = '';
  }
  mobileModuleSheetTouchStartY = null;
  mobileModuleSheetTouchDeltaY = 0;
}

function renderMobileModuleSheetState() {
  renderMobileModuleSheet(ui, {
    modules: getModulesInOrder(),
    activeModuleId: appState.session.activeModuleId,
    onModuleSelect: (moduleId) => {
      void handleMobileModuleSelect(moduleId);
    }
  });
}

function syncMobileActionState() {
  const syncButton = (mobileButton, desktopButton) => {
    if (!mobileButton) {
      return false;
    }

    const unavailable = !desktopButton || desktopButton.classList.contains('is-hidden');
    mobileButton.classList.toggle('is-hidden', unavailable);
    mobileButton.disabled = unavailable || Boolean(desktopButton?.disabled);
    return !unavailable;
  };

  syncButton(ui.mobileActionNewCallButton, ui.newCallButton);
  syncButton(ui.mobileActionNewModuleButton, ui.newModuleButton);
  syncButton(ui.mobileActionZoomButton, ui.zoomButton);
  syncButton(ui.mobileOverflowNewModuleButton, ui.newModuleButton);
  syncButton(ui.mobileOverflowPublishButton, ui.publishSessionButton);
  syncButton(ui.mobileOverflowClientAccessButton, ui.openClientAccessButton);
  syncButton(ui.mobileOverflowResetButton, ui.resetButton);

  if (ui.mobileActionZoomLabel && ui.zoomButton) {
    const zoomText = (ui.zoomButton.textContent || '').trim();
    const compactLabel = zoomText === 'Zoom In' ? 'Zoom In' : 'Modules';
    ui.mobileActionZoomLabel.textContent = compactLabel;
    if (ui.mobileActionZoomButton) {
      ui.mobileActionZoomButton.title = zoomText || compactLabel;
      ui.mobileActionZoomButton.setAttribute('aria-label', zoomText || compactLabel);
    }
  }

  const hasOverflowAction = Boolean(
    (ui.mobileOverflowNewModuleButton && !ui.mobileOverflowNewModuleButton.classList.contains('is-hidden'))
    || (ui.mobileOverflowPublishButton && !ui.mobileOverflowPublishButton.classList.contains('is-hidden'))
    || (ui.mobileOverflowClientAccessButton && !ui.mobileOverflowClientAccessButton.classList.contains('is-hidden'))
    || (ui.mobileOverflowResetButton && !ui.mobileOverflowResetButton.classList.contains('is-hidden'))
  );
  const canUseOverflow = isMobileLayoutActive() && hasOverflowAction;

  [ui.mobileHeaderMoreButton, ui.mobileActionMoreButton].forEach((button) => {
    if (!button) {
      return;
    }
    button.classList.toggle('is-hidden', !canUseOverflow);
    button.disabled = !canUseOverflow;
  });

  if (!canUseOverflow) {
    closeMobileOverflowSheet({ restoreFocus: false });
  }
}

function syncMobileFocusedNavState() {
  const showFocusedNav = appState.mode === 'focused' && hasModules();
  const activeIndex = getActiveIndex();
  const hasPrevious = showFocusedNav && activeIndex > 0;
  const hasNext = showFocusedNav && activeIndex >= 0 && activeIndex < appState.session.order.length - 1;

  if (ui.mobileFocusNav) {
    ui.mobileFocusNav.classList.toggle('is-hidden', !showFocusedNav);
  }

  if (ui.mobileActionBar) {
    ui.mobileActionBar.classList.toggle('is-hidden', showFocusedNav);
  }

  if (ui.mobileFocusModulesButton) {
    ui.mobileFocusModulesButton.disabled = !showFocusedNav || appState.transitionLock;
  }

  if (ui.mobileFocusPrevButton) {
    ui.mobileFocusPrevButton.disabled = !hasPrevious || appState.transitionLock;
  }

  if (ui.mobileFocusNextButton) {
    ui.mobileFocusNextButton.disabled = !hasNext || appState.transitionLock;
  }

  if (showFocusedNav) {
    renderMobileModuleSheetState();
  } else {
    closeMobileModuleSheet({ restoreFocus: false });
  }
}

function openMobileOverflowSheet(triggerButton = null) {
  if (!ui.mobileOverflowSheet || !isMobileLayoutActive() || isMobileOverflowOpen()) {
    return;
  }

  closeMobileModuleSheet({ restoreFocus: false });
  syncMobileActionState();
  mobileSheetRestoreFocusTarget = triggerButton || document.activeElement;
  resetMobileOverflowSwipeStyles();
  ui.mobileOverflowSheet.setAttribute('aria-hidden', 'false');
  document.body.classList.add('mobile-overflow-open');
  setMobileMoreButtonsExpanded(true);

  window.requestAnimationFrame(() => {
    const firstAction = getFirstMobileOverflowAction();
    if (firstAction) {
      firstAction.focus();
    }
  });
}

function closeMobileOverflowSheet({ restoreFocus = true } = {}) {
  if (!ui.mobileOverflowSheet || !isMobileOverflowOpen()) {
    return;
  }

  document.body.classList.remove('mobile-overflow-open');
  ui.mobileOverflowSheet.setAttribute('aria-hidden', 'true');
  setMobileMoreButtonsExpanded(false);
  resetMobileOverflowSwipeStyles();

  const focusTarget = mobileSheetRestoreFocusTarget && mobileSheetRestoreFocusTarget instanceof HTMLElement && mobileSheetRestoreFocusTarget.isConnected
    ? mobileSheetRestoreFocusTarget
    : (ui.mobileHeaderMoreButton || ui.mobileActionMoreButton || null);

  mobileSheetRestoreFocusTarget = null;

  if (restoreFocus && focusTarget) {
    window.requestAnimationFrame(() => {
      focusTarget.focus();
    });
  }
}

function toggleMobileOverflowSheet(triggerButton = null) {
  if (isMobileOverflowOpen()) {
    closeMobileOverflowSheet();
  } else {
    openMobileOverflowSheet(triggerButton);
  }
}

function openMobileModuleSheet(triggerButton = null) {
  if (
    !ui.mobileModuleSheet
    || !isMobileLayoutActive()
    || appState.mode !== 'focused'
    || !hasModules()
    || isMobileModuleSheetOpen()
  ) {
    return;
  }

  closeMobileOverflowSheet({ restoreFocus: false });
  syncMobileFocusedNavState();
  renderMobileModuleSheetState();
  mobileModuleSheetRestoreFocusTarget = triggerButton || document.activeElement;
  resetMobileModuleSheetSwipeStyles();
  ui.mobileModuleSheet.setAttribute('aria-hidden', 'false');
  document.body.classList.add('mobile-module-sheet-open');
  setMobileModulesButtonExpanded(true);

  window.requestAnimationFrame(() => {
    const firstAction = getFirstMobileModuleSheetAction();
    if (firstAction) {
      firstAction.focus();
    }
  });
}

function closeMobileModuleSheet({ restoreFocus = true } = {}) {
  if (!ui.mobileModuleSheet || !isMobileModuleSheetOpen()) {
    return;
  }

  document.body.classList.remove('mobile-module-sheet-open');
  ui.mobileModuleSheet.setAttribute('aria-hidden', 'true');
  setMobileModulesButtonExpanded(false);
  resetMobileModuleSheetSwipeStyles();

  const focusTarget = mobileModuleSheetRestoreFocusTarget && mobileModuleSheetRestoreFocusTarget instanceof HTMLElement && mobileModuleSheetRestoreFocusTarget.isConnected
    ? mobileModuleSheetRestoreFocusTarget
    : (ui.mobileFocusModulesButton || null);

  mobileModuleSheetRestoreFocusTarget = null;

  if (restoreFocus && focusTarget) {
    window.requestAnimationFrame(() => {
      focusTarget.focus();
    });
  }
}

function toggleMobileModuleSheet(triggerButton = null) {
  if (isMobileModuleSheetOpen()) {
    closeMobileModuleSheet();
  } else {
    openMobileModuleSheet(triggerButton);
  }
}

function triggerDesktopAction(desktopButton, { closeOverflow = false } = {}) {
  if (!desktopButton || desktopButton.disabled || desktopButton.classList.contains('is-hidden')) {
    return;
  }

  desktopButton.click();

  if (closeOverflow) {
    closeMobileOverflowSheet({ restoreFocus: false });
  }
}

function handleMobileOverflowTouchStart(event) {
  if (!isMobileOverflowOpen() || event.touches.length !== 1) {
    return;
  }

  mobileSheetTouchStartY = event.touches[0].clientY;
  mobileSheetTouchDeltaY = 0;
  if (ui.mobileOverflowPanel) {
    ui.mobileOverflowPanel.style.transition = 'none';
  }
}

function handleMobileOverflowTouchMove(event) {
  if (!isMobileOverflowOpen() || mobileSheetTouchStartY == null || event.touches.length !== 1 || !ui.mobileOverflowPanel) {
    return;
  }

  const delta = event.touches[0].clientY - mobileSheetTouchStartY;
  if (delta <= 0) {
    return;
  }

  mobileSheetTouchDeltaY = delta;
  ui.mobileOverflowPanel.style.transform = `translateY(${delta}px)`;
  if (ui.mobileOverflowBackdrop) {
    const opacity = Math.max(0, 1 - (delta / 220));
    ui.mobileOverflowBackdrop.style.opacity = String(opacity);
  }
}

function handleMobileOverflowTouchEnd() {
  if (mobileSheetTouchStartY == null) {
    return;
  }

  const shouldClose = mobileSheetTouchDeltaY > MOBILE_SHEET_SWIPE_CLOSE_THRESHOLD;
  resetMobileOverflowSwipeStyles();
  if (shouldClose) {
    closeMobileOverflowSheet({ restoreFocus: false });
  }
}

function handleMobileModuleTouchStart(event) {
  if (!isMobileModuleSheetOpen() || event.touches.length !== 1) {
    return;
  }

  mobileModuleSheetTouchStartY = event.touches[0].clientY;
  mobileModuleSheetTouchDeltaY = 0;
  if (ui.mobileModulePanel) {
    ui.mobileModulePanel.style.transition = 'none';
  }
}

function handleMobileModuleTouchMove(event) {
  if (
    !isMobileModuleSheetOpen()
    || mobileModuleSheetTouchStartY == null
    || event.touches.length !== 1
    || !ui.mobileModulePanel
  ) {
    return;
  }

  const delta = event.touches[0].clientY - mobileModuleSheetTouchStartY;
  if (delta <= 0) {
    return;
  }

  mobileModuleSheetTouchDeltaY = delta;
  ui.mobileModulePanel.style.transform = `translateY(${delta}px)`;
  if (ui.mobileModuleBackdrop) {
    const opacity = Math.max(0, 1 - (delta / 240));
    ui.mobileModuleBackdrop.style.opacity = String(opacity);
  }
}

function handleMobileModuleTouchEnd() {
  if (mobileModuleSheetTouchStartY == null) {
    return;
  }

  const shouldClose = mobileModuleSheetTouchDeltaY > MOBILE_SHEET_SWIPE_CLOSE_THRESHOLD;
  resetMobileModuleSheetSwipeStyles();
  if (shouldClose) {
    closeMobileModuleSheet({ restoreFocus: false });
  }
}

function loadSelectedExampleIntoEditor() {
  if (!ui.devExampleSelect || !ui.devPayloadInput) {
    return;
  }

  const selected = EXAMPLE_PAYLOADS.find((example) => example.id === ui.devExampleSelect.value) || EXAMPLE_PAYLOADS[0];
  if (!selected) {
    return;
  }

  ui.devPayloadInput.value = JSON.stringify(selected.payload, null, 2);
  renderDevPayloadWarnings([]);
}

function ensureDevPayloadWarningHost() {
  if (!ui.devPanel) {
    return null;
  }

  let host = ui.devPanel.querySelector('[data-dev-payload-warnings]');
  if (host) {
    return host;
  }

  host = document.createElement('div');
  host.setAttribute('data-dev-payload-warnings', 'true');
  Object.assign(host.style, {
    display: 'none',
    margin: '10px 16px 0',
    padding: '10px 12px',
    border: '1px solid rgba(255, 209, 102, 0.45)',
    background: 'rgba(54, 36, 7, 0.45)',
    borderRadius: '10px',
    color: '#ffe5a8',
    fontSize: '12px',
    lineHeight: '1.4'
  });

  const actions = ui.devPanel.querySelector('.dev-panel-actions');
  if (actions && actions.parentElement) {
    actions.parentElement.insertBefore(host, actions);
  } else {
    ui.devPanel.appendChild(host);
  }

  return host;
}

function renderDevPayloadWarnings(warnings, { errorMessage = '' } = {}) {
  const host = ensureDevPayloadWarningHost();
  if (!host) {
    return;
  }

  host.innerHTML = '';
  const hasError = typeof errorMessage === 'string' && errorMessage.trim();
  const hasWarnings = Array.isArray(warnings) && warnings.length > 0;
  if (!hasError && !hasWarnings) {
    host.style.display = 'none';
    return;
  }

  host.style.display = 'block';
  host.style.borderColor = hasError ? 'rgba(255, 132, 153, 0.5)' : 'rgba(255, 209, 102, 0.45)';
  host.style.background = hasError ? 'rgba(70, 16, 28, 0.48)' : 'rgba(54, 36, 7, 0.45)';
  host.style.color = hasError ? '#ffd7df' : '#ffe5a8';

  const title = document.createElement('div');
  title.textContent = hasError ? 'Payload error:' : 'Auto-repairs applied:';
  title.style.fontWeight = '700';
  title.style.marginBottom = '6px';
  host.appendChild(title);

  if (hasError) {
    const error = document.createElement('div');
    error.textContent = errorMessage.trim();
    host.appendChild(error);
  }

  if (!hasWarnings) {
    return;
  }

  const list = document.createElement('ul');
  list.style.margin = hasError ? '8px 0 0' : '0';
  list.style.padding = '0 0 0 16px';

  warnings.forEach((warning) => {
    const item = document.createElement('li');
    item.textContent = warning;
    list.appendChild(item);
  });

  host.appendChild(list);
}

function toGenericTableRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map((row) => {
    if (!Array.isArray(row)) {
      return [];
    }

    return row.map((value) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      return String(value ?? '');
    });
  });
}

function isPlainPayloadObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasGeneratedTableShape(value) {
  return isPlainPayloadObject(value) && Array.isArray(value.columns) && Array.isArray(value.rows);
}

function hasLabelValueItemShape(value) {
  return isPlainPayloadObject(value)
    && (
      'label' in value
      || 'title' in value
      || 'name' in value
      || 'value' in value
      || 'detail' in value
      || 'body' in value
    );
}

function normalizeLabelValueItem(item, index) {
  const label = String(item.label || item.title || item.name || `Assumption ${index + 1}`).trim();
  const value = 'value' in item
    ? item.value
    : ('detail' in item ? item.detail : item.body);
  return [
    label || `Assumption ${index + 1}`,
    formatGeneratedObjectValue(value)
  ];
}

function formatGeneratedObjectValue(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function humanizePayloadKey(key) {
  const value = String(key ?? '').trim();
  if (!value) {
    return 'Assumption';
  }

  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parsePayloadNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/[,$€£\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    const leadingNumber = normalized.match(/^-?\d+(\.\d+)?/);
    if (!leadingNumber) {
      return null;
    }

    const leadingParsed = Number(leadingNumber[0]);
    return Number.isFinite(leadingParsed) ? leadingParsed : null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function getFirstPayloadNumber(source, keys) {
  if (!isPlainPayloadObject(source)) {
    return null;
  }

  for (const key of keys) {
    if (key in source) {
      const parsed = parsePayloadNumber(source[key]);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return null;
}

function normalizePayloadToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findPayloadAmountColumnIndex(columns, rows = []) {
  const preferredTokens = new Set([
    'amount',
    'assetvalue',
    'balance',
    'currentbalance',
    'netvalue',
    'value'
  ]);
  const exactIndex = columns.findIndex((column) => preferredTokens.has(normalizePayloadToken(column)));
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const likelyIndex = columns.findIndex((column) => {
    const token = normalizePayloadToken(column);
    return token.includes('amount') || token.includes('balance') || token.includes('value');
  });
  if (likelyIndex >= 0) {
    return likelyIndex;
  }

  const maxColumns = columns.length;
  for (let columnIndex = 1; columnIndex < maxColumns; columnIndex += 1) {
    const hasNumericValue = rows.some((row) => Array.isArray(row) && parsePayloadNumber(row[columnIndex]) !== null);
    if (hasNumericValue) {
      return columnIndex;
    }
  }

  return -1;
}

function repairOutputBucketedSectionColumns(section, columns, rows, sectionTitle, warnings) {
  if (columns.length === 2) {
    return null;
  }

  const amountColumnIndex = findPayloadAmountColumnIndex(columns, rows);
  if (amountColumnIndex < 0) {
    return null;
  }

  const labelColumnIndex = amountColumnIndex === 0 ? 1 : 0;
  const ownerColumnIndex = columns.findIndex((column, columnIndex) => (
    columnIndex !== labelColumnIndex
    && columnIndex !== amountColumnIndex
    && normalizePayloadToken(column) === 'owner'
  ));
  const labelColumn = columns[labelColumnIndex] || 'Item';
  const amountColumn = columns[amountColumnIndex] || 'Amount';
  const repairedRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => Array.isArray(row) && row.length > Math.max(labelColumnIndex, amountColumnIndex))
    .map((row) => {
      let label = String(row[labelColumnIndex] ?? '').trim();
      const owner = ownerColumnIndex >= 0 ? String(row[ownerColumnIndex] ?? '').trim() : '';
      if (owner && normalizePayloadToken(owner) !== 'household' && !normalizePayloadToken(label).includes(normalizePayloadToken(owner))) {
        label = `${owner} ${label}`.trim();
      }
      const value = parsePayloadNumber(row[amountColumnIndex]);
      if (value === null) {
        warnings.push(`Normalized non-numeric value to 0 in outputsBucketed section '${sectionTitle}'.`);
        return [label, 0];
      }
      return [label, value];
    });

  warnings.push(`Reduced outputsBucketed section '${sectionTitle}' to 2 columns using '${amountColumn}' as the amount column.`);

  return {
    columns: [labelColumn, amountColumn],
    rows: repairedRows
  };
}

function inferCurrencySymbol(value) {
  const rawValue = String(value ?? '').trim();
  const upperValue = rawValue.toUpperCase();

  if (!upperValue) {
    return '€';
  }

  if (rawValue === '$' || upperValue === 'USD') {
    return '$';
  }

  if (rawValue === '€' || upperValue === 'EUR') {
    return '€';
  }

  if (rawValue === '£' || upperValue === 'GBP') {
    return '£';
  }

  return rawValue;
}

function extractPbsItemRows(items, fallbackPrefix) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item, index) => {
      if (!isPlainPayloadObject(item)) {
        return null;
      }

      const label = String(item.name || item.label || item.title || `${fallbackPrefix} ${index + 1}`).trim();
      const value = getFirstPayloadNumber(item, ['value', 'amount', 'balance', 'currentBalance']);

      if (!label || value === null) {
        return null;
      }

      return [label, value];
    })
    .filter(Boolean);
}

function findPbsProjectBucket(buckets, bucketKey) {
  const targetToken = normalizePayloadToken(bucketKey);
  return buckets.find((bucket) => (
    isPlainPayloadObject(bucket)
    && (
      normalizePayloadToken(bucket.key) === targetToken
      || normalizePayloadToken(bucket.name) === targetToken
      || normalizePayloadToken(bucket.title) === targetToken
    )
  )) || null;
}

function buildOutputsBucketedFromProjectPbs(generated, sourceAssumptions = null) {
  if (!Array.isArray(generated?.buckets)) {
    return null;
  }

  const assumptions = isPlainPayloadObject(sourceAssumptions) && !hasGeneratedTableShape(sourceAssumptions)
    ? sourceAssumptions
    : {};
  const metrics = isPlainPayloadObject(generated.metrics) ? generated.metrics : {};
  const currencySymbol = inferCurrencySymbol(assumptions.currency || generated.currencySymbol || generated.currency);
  const amountColumn = `Amount (${currencySymbol})`;
  const assetBucketMeta = [
    { key: 'lifestyle', title: 'Lifestyle', subtotalLabel: 'Lifestyle assets' },
    { key: 'liquidity', title: 'Liquidity', subtotalLabel: 'Liquid reserves' },
    { key: 'longevity', title: 'Longevity', subtotalLabel: 'Longevity assets' },
    { key: 'legacy', title: 'Legacy', subtotalLabel: 'Legacy assets' }
  ];

  const assetSections = assetBucketMeta.map((meta) => {
    const bucket = findPbsProjectBucket(generated.buckets, meta.key);
    const rows = extractPbsItemRows(bucket?.assets, 'Asset');
    const subtotalValue = getFirstPayloadNumber(bucket, ['grossValue', 'assetValue', 'netValue'])
      ?? rows.reduce((total, row) => total + row[1], 0);

    return {
      key: meta.key,
      title: meta.title,
      columns: ['Asset', amountColumn],
      rows,
      subtotalLabel: meta.subtotalLabel,
      subtotalValue,
      notes: typeof bucket?.description === 'string' ? bucket.description : ''
    };
  });

  const bucketLiabilityRows = generated.buckets.flatMap((bucket) => extractPbsItemRows(bucket?.liabilities, 'Liability'));
  const payloadLiabilityRows = extractPbsItemRows(generated.liabilities, 'Liability');
  const liabilityRows = bucketLiabilityRows.length > 0 ? bucketLiabilityRows : payloadLiabilityRows;
  const totalLiabilities = getFirstPayloadNumber(metrics, ['totalLiabilities', 'liabilities'])
    ?? liabilityRows.reduce((total, row) => total + row[1], 0);
  const grossAssets = getFirstPayloadNumber(metrics, ['grossAssets', 'totalAssets'])
    ?? assetSections.reduce((total, section) => total + section.subtotalValue, 0);
  const netWorth = getFirstPayloadNumber(metrics, ['netWorth'])
    ?? (grossAssets - totalLiabilities);

  return {
    currencySymbol,
    sections: [
      ...assetSections,
      {
        key: 'liabilities',
        title: 'Liabilities',
        columns: ['Liability', amountColumn],
        rows: liabilityRows,
        subtotalLabel: 'Total liabilities',
        subtotalValue: totalLiabilities
      },
      {
        key: 'summary',
        title: 'Summary',
        columns: ['Metric', amountColumn],
        rows: [
          ['Gross assets', grossAssets],
          ['Total liabilities', totalLiabilities],
          ['Net worth', netWorth]
        ],
        subtotalLabel: 'Net worth',
        subtotalValue: netWorth
      }
    ]
  };
}

function looksLikePbsProjectPayload(payload, generated) {
  const moduleToken = normalizePayloadToken(payload.module || payload.moduleType || payload.type);
  const titleToken = normalizePayloadToken(payload.title);

  return moduleToken === 'pbs'
    || titleToken.includes('personalbalancesheet')
    || Array.isArray(generated?.buckets)
    || isPlainPayloadObject(generated?.metrics);
}

function repairChartMetadataPayload(generated, warnings) {
  if (!Array.isArray(generated?.charts)) {
    return;
  }

  generated.charts.forEach((chart, chartIndex) => {
    if (!isPlainPayloadObject(chart)) {
      return;
    }

    if (Array.isArray(chart.insights)) {
      let repairedInsights = false;
      chart.insights = chart.insights
        .map((insight, insightIndex) => {
          if (isPlainPayloadObject(insight)) {
            return insight;
          }

          if (typeof insight === 'string' && insight.trim()) {
            repairedInsights = true;
            return {
              label: `Insight ${insightIndex + 1}`,
              detail: insight.trim()
            };
          }

          repairedInsights = true;
          return null;
        })
        .filter(Boolean);

      if (repairedInsights) {
        warnings.push(`Converted Chart ${chartIndex + 1}.insights entries into insight objects.`);
      }
    }

    if (Array.isArray(chart.annotations)) {
      let repairedAnnotations = false;
      chart.annotations = chart.annotations
        .map((annotation, annotationIndex) => {
          if (isPlainPayloadObject(annotation)) {
            return annotation;
          }

          if (typeof annotation === 'string' && annotation.trim()) {
            repairedAnnotations = true;
            return {
              label: `Annotation ${annotationIndex + 1}`,
              body: annotation.trim()
            };
          }

          repairedAnnotations = true;
          return null;
        })
        .filter(Boolean);

      if (repairedAnnotations) {
        warnings.push(`Converted Chart ${chartIndex + 1}.annotations entries into annotation objects.`);
      }
    }
  });
}

function getPayloadTableRows(table) {
  return Array.isArray(table?.rows) ? table.rows.filter((row) => Array.isArray(row)) : [];
}

function findPayloadTableValue(table, labelPatterns) {
  const patterns = labelPatterns.map((pattern) => (
    pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i')
  ));
  const row = getPayloadTableRows(table).find((candidate) => {
    const label = String(candidate[0] ?? '');
    return patterns.some((pattern) => pattern.test(label));
  });
  return row ? row[1] : undefined;
}

function parsePayloadPercent(value) {
  const parsed = parsePayloadNumber(value);
  if (parsed === null) {
    return null;
  }
  return parsed > 1 ? parsed / 100 : parsed;
}

function looksLikeCollegeFundingPayload(payload, generated) {
  const moduleToken = normalizePayloadToken(payload.module || payload.moduleType || payload.type);
  const titleToken = normalizePayloadToken(payload.title);
  const outputColumns = Array.isArray(generated?.outputs?.columns)
    ? generated.outputs.columns.map((column) => normalizePayloadToken(column)).join(' ')
    : '';

  return moduleToken === 'collegefunding'
    || moduleToken === 'educationfunding'
    || titleToken.includes('collegefunding')
    || titleToken.includes('educationfunding')
    || (
      outputColumns.includes('scenario')
      && outputColumns.includes('todaysterms')
      && outputColumns.includes('futurenominalcost')
    );
}

function buildCollegeFundingInputsFromLegacyTables(payload, generated) {
  if (!looksLikeCollegeFundingPayload(payload, generated)) {
    return null;
  }

  const assumptions = generated.assumptions;
  const childrenCount = parsePayloadNumber(findPayloadTableValue(assumptions, [/number of children/i]));
  const childCurrentAge = parsePayloadNumber(findPayloadTableValue(assumptions, [/children.*current age/i, /child.*current age/i]));
  const collegeStartAge = parsePayloadNumber(findPayloadTableValue(assumptions, [/college start age/i]));
  const collegeDurationYears = parsePayloadNumber(findPayloadTableValue(assumptions, [/college duration/i]));
  const inflationRate = parsePayloadPercent(findPayloadTableValue(assumptions, [/inflation/i]));
  const atHomeAnnual = parsePayloadNumber(findPayloadTableValue(assumptions, [/at.home.*college support/i, /living at home/i]));
  const awayAnnual = parsePayloadNumber(findPayloadTableValue(assumptions, [/away.*from.*home.*college support/i, /away from home/i]));
  const carSupport = parsePayloadNumber(findPayloadTableValue(assumptions, [/optional car support/i, /car support/i]));

  if (childrenCount === null && atHomeAnnual === null && awayAnnual === null) {
    return null;
  }

  const normalized = {};
  if (childrenCount !== null) normalized.childrenCount = childrenCount;
  if (childCurrentAge !== null) normalized.childCurrentAge = childCurrentAge;
  if (collegeStartAge !== null) normalized.collegeStartAge = collegeStartAge;
  if (collegeDurationYears !== null) normalized.collegeDurationYears = collegeDurationYears;
  if (inflationRate !== null) normalized.inflationRate = inflationRate;
  if (atHomeAnnual !== null) normalized.atHomeAnnualCostTodayPerChild = atHomeAnnual;
  if (awayAnnual !== null) normalized.awayAnnualCostTodayPerChild = awayAnnual;
  if (carSupport !== null) normalized.carSupportTodayPerChild = carSupport;
  normalized.planningNote = 'Education costs are modelled separately from normal household spending.';

  return normalized;
}

function normalizeDevPanelPayload(payload) {
  const warnings = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload, warnings };
  }

  const generated = payload.generated;
  if (!generated || typeof generated !== 'object' || Array.isArray(generated)) {
    return { payload, warnings };
  }

  const rawGeneratedAssumptions = generated.assumptions;

  if (typeof generated.summary === 'string' && generated.summary.trim() && typeof generated.summaryHtml !== 'string') {
    generated.summaryHtml = `<p>${escapeHtmlText(generated.summary.trim())}</p>`;
    warnings.push('Moved generated.summary into generated.summaryHtml.');
  }

  if ('assumptions' in generated && !hasGeneratedTableShape(generated.assumptions)) {
    if (isPlainPayloadObject(generated.assumptions)) {
      generated.assumptions = {
        columns: ['Assumption', 'Value'],
        rows: Object.entries(generated.assumptions).map(([key, value]) => [
          humanizePayloadKey(key),
          formatGeneratedObjectValue(value)
        ])
      };
      warnings.push('Converted generated.assumptions object into a two-column table.');
    } else if (Array.isArray(generated.assumptions) && generated.assumptions.every(hasLabelValueItemShape)) {
      generated.assumptions = {
        columns: ['Assumption', 'Value'],
        rows: generated.assumptions.map((item, index) => normalizeLabelValueItem(item, index))
      };
      warnings.push('Converted generated.assumptions label/value list into a two-column table.');
    } else if (generated.assumptions == null) {
      delete generated.assumptions;
      warnings.push('Removed empty generated.assumptions.');
    }
  }

  if (looksLikePbsProjectPayload(payload, generated)) {
    const sourceAssumptions = isPlainPayloadObject(rawGeneratedAssumptions) && !hasGeneratedTableShape(rawGeneratedAssumptions)
      ? rawGeneratedAssumptions
      : {};
    const pbsInputSource = {
      annualExpenditure: getFirstPayloadNumber(sourceAssumptions, ['annualExpenditure'])
        ?? getFirstPayloadNumber(generated.metrics, ['annualExpenditure']),
      currentAge: getFirstPayloadNumber(sourceAssumptions, ['currentAge', 'clientAge'])
        ?? getFirstPayloadNumber(generated.metrics, ['currentAge', 'clientAge'])
    };
    const normalizedPbsInputs = normalizePbsInputs(pbsInputSource);

    if (normalizedPbsInputs && !generated.pbsInputs) {
      generated.pbsInputs = normalizedPbsInputs;
      warnings.push('Created generated.pbsInputs from PBS assumptions.');
    }

    if (!isPlainPayloadObject(generated.outputsBucketed)) {
      const repairedOutputsBucketed = buildOutputsBucketedFromProjectPbs(generated, rawGeneratedAssumptions);
      if (repairedOutputsBucketed) {
        generated.outputsBucketed = repairedOutputsBucketed;
        warnings.push('Created generated.outputsBucketed from PBS buckets and metrics.');
      }
    }
  }

  if (!generated.collegeFundingInputs && !generated.collegeFunding) {
    const repairedCollegeFundingInputs = buildCollegeFundingInputsFromLegacyTables(payload, generated);
    if (repairedCollegeFundingInputs) {
      generated.collegeFundingInputs = repairedCollegeFundingInputs;
      warnings.push('Created generated.collegeFundingInputs from college funding tables.');
    }
  }

  repairChartMetadataPayload(generated, warnings);

  const outputsBucketed = generated.outputsBucketed;
  if (!outputsBucketed || typeof outputsBucketed !== 'object' || Array.isArray(outputsBucketed)) {
    return { payload, warnings };
  }

  if (typeof outputsBucketed.currencySymbol !== 'string' || !outputsBucketed.currencySymbol.trim()) {
    outputsBucketed.currencySymbol = '€';
    warnings.push('Filled missing generated.outputsBucketed.currencySymbol with "€".');
  } else {
    const normalizedCurrencySymbol = inferCurrencySymbol(outputsBucketed.currencySymbol);
    if (normalizedCurrencySymbol !== outputsBucketed.currencySymbol) {
      outputsBucketed.currencySymbol = normalizedCurrencySymbol;
      warnings.push(`Normalized generated.outputsBucketed.currencySymbol to "${normalizedCurrencySymbol}".`);
    }
  }

  if (!Array.isArray(outputsBucketed.sections)) {
    outputsBucketed.sections = [];
    warnings.push('Filled missing generated.outputsBucketed.sections with an empty array.');
  }

  if (!Array.isArray(generated.tables)) {
    generated.tables = [];
  }

  const nextSections = [];

  outputsBucketed.sections.forEach((rawSection, sectionIndex) => {
    if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) {
      warnings.push(`Dropped outputsBucketed section at index ${sectionIndex} because it is not a valid object.`);
      return;
    }

    const section = { ...rawSection };
    const fallbackTitle = typeof section.key === 'string' && section.key.trim()
      ? section.key.trim()
      : `Section ${sectionIndex + 1}`;
    const sectionTitle = typeof section.title === 'string' && section.title.trim()
      ? section.title.trim()
      : fallbackTitle;
    section.title = sectionTitle;

    let columns = Array.isArray(section.columns)
      ? section.columns.map((column) => String(column ?? ''))
      : [];
    const sourceRows = Array.isArray(section.rows) ? section.rows : [];

    if (columns.length !== 2) {
      const repairedSection = repairOutputBucketedSectionColumns(section, columns, sourceRows, sectionTitle, warnings);
      if (!repairedSection) {
        const migratedTable = {
          title: sectionTitle,
          columns: columns.length > 0 ? columns : ['Item', 'Value'],
          rows: toGenericTableRows(section.rows)
        };
        generated.tables.push(migratedTable);
        warnings.push(`Moved outputsBucketed section '${sectionTitle}' into generated.tables because outputsBucketed only supports 2-column sections.`);
        return;
      }

      columns = repairedSection.columns;
      section.rows = repairedSection.rows;
    }

    section.columns = columns;

    if (!Array.isArray(section.rows)) {
      section.rows = [];
      warnings.push(`Filled missing rows for outputsBucketed section '${sectionTitle}' with an empty array.`);
    }

    section.rows = section.rows
      .filter((row) => Array.isArray(row) && row.length >= 2)
      .map((row) => {
        const label = String(row[0] ?? '');
        const numericValue = parsePayloadNumber(row[1]);
        if (numericValue === null) {
          warnings.push(`Normalized non-numeric value to 0 in outputsBucketed section '${sectionTitle}'.`);
          return [label, 0];
        }
        return [label, numericValue];
      });

    if (!('subtotalValue' in section)) {
      section.subtotalValue = 0;
      warnings.push(`Filled missing subtotalValue = 0 for outputsBucketed section '${sectionTitle}'.`);
    } else if (typeof section.subtotalValue !== 'number' || !Number.isFinite(section.subtotalValue)) {
      const parsedSubtotal = parsePayloadNumber(section.subtotalValue);
      if (parsedSubtotal === null) {
        section.subtotalValue = 0;
        warnings.push(`Normalized invalid subtotalValue to 0 for outputsBucketed section '${sectionTitle}'.`);
      } else {
        section.subtotalValue = parsedSubtotal;
        warnings.push(`Parsed subtotalValue for outputsBucketed section '${sectionTitle}' as a number.`);
      }
    }

    nextSections.push(section);
  });

  outputsBucketed.sections = nextSections;

  return {
    payload,
    warnings
  };
}

const AUTO_SFT_SPAN_PATTERN = /<span\b[^>]*\bdata-auto=(["'])sft\1[^>]*>[\s\S]*?<\/span>/gi;
const AUTO_PERSONAL_CAP_SPAN_PATTERN = /<span\b[^>]*\bdata-auto=(["'])personal-cap\1[^>]*>[\s\S]*?<\/span>/gi;
const AUTO_READINESS_SPAN_PATTERN = /<span\b[^>]*\bdata-auto=(["'])readiness\1[^>]*>[\s\S]*?<\/span>/gi;

function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function removeAutoSftSummarySpan(summaryHtml) {
  return String(summaryHtml ?? '')
    .replace(AUTO_SFT_SPAN_PATTERN, '')
    .replace(AUTO_PERSONAL_CAP_SPAN_PATTERN, '')
    .replace(AUTO_READINESS_SPAN_PATTERN, '')
    .replace(/\s+<\/p>/gi, '</p>')
    .trim();
}

function injectAutoSummarySentence(summaryHtml, sentence, autoKey) {
  const cleaned = String(summaryHtml ?? '').trim();
  if (!sentence) {
    return cleaned;
  }

  const safeAutoKey = String(autoKey ?? '').trim() || 'note';
  const autoSpan = `<span data-auto=\"${escapeHtmlText(safeAutoKey)}\">${escapeHtmlText(sentence)}</span>`;

  if (!cleaned) {
    return `<p>${autoSpan}</p>`;
  }

  const firstParagraphCloseMatch = /<\/p>/i.exec(cleaned);
  if (!firstParagraphCloseMatch || typeof firstParagraphCloseMatch.index !== 'number') {
    return `${cleaned}<p>${autoSpan}</p>`;
  }

  const closeTagIndex = firstParagraphCloseMatch.index;
  return `${cleaned.slice(0, closeTagIndex)} ${autoSpan}${cleaned.slice(closeTagIndex)}`;
}

function injectAutoPensionSummarySentences(summaryHtml, {
  readinessSentence = '',
  sftSentence = '',
  personalCapSentence = ''
} = {}) {
  let next = removeAutoSftSummarySpan(summaryHtml);
  next = injectAutoSummarySentence(next, readinessSentence, 'readiness');
  next = injectAutoSummarySentence(next, sftSentence, 'sft');
  next = injectAutoSummarySentence(next, personalCapSentence, 'personal-cap');
  return next;
}

window.__injectAutoPensionSummarySentences = injectAutoPensionSummarySentences;

function isPersonalBalanceSheetModule(module) {
  const generated = module?.generated;
  if (generated?.pbsInputs) {
    return true;
  }

  const sections = Array.isArray(generated?.outputsBucketed?.sections)
    ? generated.outputsBucketed.sections
    : [];
  const sectionTokens = new Set(
    sections.map((section) => String(section?.key || section?.title || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ''))
  );
  const hasPbsBucketShape = ['lifestyle', 'liquidity', 'longevity', 'legacy']
    .every((token) => sectionTokens.has(token));
  if (hasPbsBucketShape) {
    return true;
  }

  const title = typeof module?.title === 'string' ? module.title.toLowerCase() : '';
  return title.includes('personal balance sheet');
}

function isPublishPinEnabled() {
  return Boolean(ui.publishPinToggle?.checked);
}

function isFirstOpenPublishedAccess(access = appState.publishedAccess) {
  return Number(access?.version) >= 4;
}

function isLegacyPinPublishedAccess(access = appState.publishedAccess) {
  return Boolean(access && Number(access.version) < 4 && access.pin);
}

function syncPublishPinControls(access = appState.publishedAccess) {
  const legacyMode = isLegacyPinPublishedAccess(access);
  const enabled = legacyMode && isPublishPinEnabled();
  const pinToggleRow = ui.publishPinToggle?.closest('.publish-toggle-row');
  const inlinePinEmailRow = ui.publishIncludePinEmailToggle?.closest('.publish-toggle-row');

  if (pinToggleRow) {
    pinToggleRow.classList.toggle('is-hidden', !legacyMode);
    pinToggleRow.setAttribute('aria-hidden', legacyMode ? 'false' : 'true');
  }

  if (inlinePinEmailRow) {
    inlinePinEmailRow.classList.toggle('is-hidden', !legacyMode);
    inlinePinEmailRow.setAttribute('aria-hidden', legacyMode ? 'false' : 'true');
  }

  if (ui.publishPinGroup) {
    ui.publishPinGroup.classList.toggle('is-hidden', !enabled);
    ui.publishPinGroup.setAttribute('aria-hidden', enabled ? 'false' : 'true');
  }

  if (ui.publishPinInput) {
    ui.publishPinInput.disabled = !enabled;
  }

  if (!legacyMode) {
    if (ui.publishPinToggle) {
      ui.publishPinToggle.checked = false;
    }
    if (ui.publishIncludePinEmailToggle) {
      ui.publishIncludePinEmailToggle.checked = false;
      ui.publishIncludePinEmailToggle.disabled = true;
    }
    if (ui.publishPinInput) {
      ui.publishPinInput.value = '';
    }
    return;
  }

  if (!enabled && ui.publishPinInput) {
    ui.publishPinInput.value = '';
  }

  if (ui.publishIncludePinEmailToggle) {
    ui.publishIncludePinEmailToggle.disabled = !access?.pin;
  }
}

function normalizePublishSessionId(rawValue) {
  const value = String(rawValue ?? '').trim();
  if (!value) {
    throw new Error('Publish response was missing a published session id.');
  }
  return value;
}

async function copyToClipboard(value) {
  const text = String(value ?? '');
  if (!text) {
    return false;
  }

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

function setPublishError(message) {
  if (!ui.publishError) {
    return;
  }

  ui.publishError.textContent = String(message || '');
  ui.publishError.classList.toggle('is-visible', Boolean(message));
}

function getUrlHashParam(hashValue, key) {
  const raw = String(hashValue ?? '').replace(/^#/, '');
  if (!raw) {
    return '';
  }

  const params = new URLSearchParams(raw);
  return params.get(key)?.trim() || '';
}

function getLocationPublishedId() {
  const params = new URLSearchParams(window.location.search);
  return params.get('pub')?.trim() || '';
}

function getLocationAdvisorSecret() {
  return getUrlHashParam(window.location.hash, 'ak');
}

function getLinkHashParam(link, key) {
  if (typeof link !== 'string' || !link) {
    return '';
  }

  try {
    const parsed = new URL(link);
    return getUrlHashParam(parsed.hash, key);
  } catch (_error) {
    return '';
  }
}

function buildClientSessionLink(publishedId, clientSecretB64u) {
  const url = new URL('./session.html', window.location.href);
  url.searchParams.set('pub', publishedId);
  url.searchParams.set('view', 'overview');
  url.hash = new URLSearchParams({ ck: clientSecretB64u }).toString();
  return url.toString();
}

function buildAdvisorSessionLink(publishedId, advisorSecretB64u) {
  const url = new URL('./index.html', window.location.href);
  url.searchParams.set('pub', publishedId);
  url.searchParams.set('view', 'overview');
  url.hash = new URLSearchParams({ ak: advisorSecretB64u }).toString();
  return url.toString();
}

function formatPublishedExpiry(expiresAt) {
  if (!expiresAt) {
    return 'Not published yet';
  }

  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    return String(expiresAt);
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(parsed);
}

function inferExpiryDays(expiresAt) {
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    return 30;
  }

  const diffDays = Math.max(1, Math.round((parsed.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  if (diffDays <= 10) {
    return 7;
  }
  if (diffDays >= 60) {
    return 90;
  }
  return 30;
}

function getPublishedClientLink(access) {
  return access?.clientLink || access?.link || '';
}

function getPublishedAdvisorLink(access) {
  return access?.advisorLink || '';
}

function getLocationViewMode() {
  const params = new URLSearchParams(window.location.search);
  return params.get('view')?.trim().toLowerCase() || '';
}

function getPublishMode() {
  return ui.publishModeEmailInput?.checked ? 'email' : 'share';
}

function setPublishMode(mode) {
  const normalizedMode = mode === 'email' ? 'email' : 'share';
  if (ui.publishModeShareInput) {
    ui.publishModeShareInput.checked = normalizedMode === 'share';
  }
  if (ui.publishModeEmailInput) {
    ui.publishModeEmailInput.checked = normalizedMode === 'email';
  }
  syncPublishModeControls();
}

function syncPublishModeControls() {
  const mode = getPublishMode();
  const isShareMode = mode === 'share';

  if (ui.publishEmailField) {
    ui.publishEmailField.classList.toggle('is-hidden', isShareMode && !appState.publishedAccess?.clientEmail);
    ui.publishEmailField.setAttribute('aria-hidden', isShareMode && !appState.publishedAccess?.clientEmail ? 'true' : 'false');
  }
  if (ui.publishClientEmailInput) {
    ui.publishClientEmailInput.required = mode === 'email';
    ui.publishClientEmailInput.disabled = isShareMode && !appState.publishedAccess?.clientEmail;
  }
  if (ui.publishClientPinInfo) {
    ui.publishClientPinInfo.textContent = isShareMode && !appState.publishedAccess
      ? 'Anyone with the published link can open a read-only view until it expires or is revoked.'
      : getPublishedClientPinInfoText(appState.publishedAccess);
  }
  updatePublishActionState();
}

function formatPublishedClientPinState(access) {
  if (access?.linkAccessMode === 'direct') {
    return 'Direct read-only link';
  }

  if (!isFirstOpenPublishedAccess(access)) {
    return access?.pin ? 'Advisor-managed PIN' : 'Not configured';
  }

  if (access?.clientPinState === 'active') {
    return 'Created by the client';
  }

  return 'Client will create it on first open';
}

function getPublishedClientPinInfoText(access = appState.publishedAccess) {
  if (!access) {
    return 'The client will create their own 6-digit PIN the first time they open the secure link. The advisor never sees or stores that PIN.';
  }

  if (access?.linkAccessMode === 'direct') {
    return 'Anyone with the published link can open a read-only view until it expires or is revoked.';
  }

  if (!isFirstOpenPublishedAccess(access)) {
    return 'Legacy client PIN controls are shown for this older published session.';
  }

  if (access?.clientPinState === 'active') {
    return 'The client has already created their own 6-digit PIN. If they forget it, use Reset Client Access to issue a fresh client link without losing their published modules.';
  }

  return 'The client will create their own 6-digit PIN the first time they open the secure link. The advisor never sees or stores that PIN.';
}

function getPublishClientEmailFromInput(options = {}) {
  const { required = false } = options;
  const normalized = String(ui.publishClientEmailInput?.value || '').trim().toLowerCase();
  if (!normalized) {
    if (required) {
      throw new Error('Enter the client email address first.');
    }
    return '';
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Enter a valid client email address.');
  }

  return normalized;
}

function getPublishExpiryDaysFromInput() {
  const value = Number(ui.publishExpirySelect?.value || 30);
  return [7, 30, 90].includes(value) ? value : 30;
}

function isPublishPinIncludedInEmail() {
  return Boolean(ui.publishIncludePinEmailToggle?.checked);
}

function formatPublishedEmailStatus(access) {
  if (!access) {
    return 'No final email has been sent yet.';
  }

  if (access.lastEmailSentAt) {
    const destination = access.clientEmail ? ` to ${access.clientEmail}` : '';
    return `Final email sent${destination} on ${formatPublishedExpiry(access.lastEmailSentAt)}.`;
  }

  if (access.clientEmail) {
    return `Ready to email ${access.clientEmail}.`;
  }

  return 'No final email has been sent yet.';
}

function updatePublishActionState(access = appState.publishedAccess) {
  const mode = getPublishMode();
  const hasEmail = Boolean(String(ui.publishClientEmailInput?.value || '').trim());

  if (ui.publishGenerateButton && !ui.publishGenerateButton.disabled) {
    ui.publishGenerateButton.textContent = mode === 'share' ? 'Publish Share Link' : 'Publish & Email Client';
  }

  if (ui.publishSendEmailButton) {
    const supported = Boolean(access && Number(access.version) >= 3);
    ui.publishSendEmailButton.disabled = !supported || !hasEmail;
    ui.publishSendEmailButton.textContent = access?.emailSendCount > 0 ? 'Resend Final Email' : 'Send Final Email';
  }

  if (ui.publishUpdateExpiryButton) {
    ui.publishUpdateExpiryButton.disabled = !access || Number(access.version) < 3;
  }

  if (ui.publishResetClientAccessButton) {
    ui.publishResetClientAccessButton.disabled = !access || !isFirstOpenPublishedAccess(access) || access.status !== 'active';
  }
}

function buildPublishedEmailCopy(access) {
  const clientName = appState.session?.clientName?.trim() || 'there';
  const clientLink = getPublishedClientLink(access);
  if (!clientLink) {
    return '';
  }

  const lines = [
    `Hi ${clientName},`,
    '',
    'Thanks again for taking the call today.',
    'You can revisit your Planeir session here:',
    clientLink,
    '',
    `This secure link expires on ${formatPublishedExpiry(access?.expiresAt)}.`
  ];

  if (isFirstOpenPublishedAccess(access)) {
    lines.push('The first time you open this secure link, you will be asked to create your own 6-digit PIN.');
  } else if (access?.pin) {
    if (isPublishPinIncludedInEmail()) {
      lines.push(`Use this 6-digit PIN to open it: ${access.pin}`);
    } else {
      lines.push('I will share the 6-digit access code separately.');
    }
  }

  lines.push(
    '',
    'Best,',
    'Gerry'
  );

  return lines.join('\n');
}

function hasPublishedLocalRecoveryOption() {
  return hasStoredSession();
}

function setPublishedRecoveryLocalAvailable(available) {
  if (!publishedRecoveryLocalButton) {
    return;
  }

  publishedRecoveryLocalButton.disabled = !available;
  publishedRecoveryLocalButton.classList.toggle('is-hidden', !available);
}

function confirmInlinePinDelivery(access, contextLabel) {
  if (isFirstOpenPublishedAccess(access) || !access?.pin || !isPublishPinIncludedInEmail()) {
    return true;
  }

  return window.confirm(`${contextLabel}\n\nThis will place the secure link and the client PIN in the same message. Only continue if you intend to deliver both together.`);
}

function resetPublishResult(options = {}) {
  const { clearAccess = true, clearInputs = true } = options;
  if (clearAccess) {
    appState.publishedAccess = null;
  }

  if (ui.publishResult) {
    ui.publishResult.classList.add('is-hidden');
  }
  if (ui.publishPinWrap) {
    ui.publishPinWrap.classList.add('is-hidden');
  }
  if (ui.publishClientPinStateRow) {
    ui.publishClientPinStateRow.classList.remove('is-hidden');
  }
  if (ui.publishCopyPinButton) {
    ui.publishCopyPinButton.classList.add('is-hidden');
  }
  if (ui.publishPinValue) {
    ui.publishPinValue.textContent = '------';
  }
  if (ui.publishClientPinStateValue) {
    ui.publishClientPinStateValue.textContent = 'Client will create it on first open';
  }
  if (ui.publishLinkValue) {
    ui.publishLinkValue.value = '';
  }
  if (ui.publishAdvisorLinkValue) {
    ui.publishAdvisorLinkValue.value = '';
  }
  if (ui.publishExpiryValue) {
    ui.publishExpiryValue.textContent = 'Not published yet';
  }
  if (ui.publishEmailStatus) {
    ui.publishEmailStatus.textContent = 'No final email has been sent yet.';
  }
  if (ui.publishClientPinInfo) {
    ui.publishClientPinInfo.textContent = getPublishedClientPinInfoText(null);
  }

  if (clearInputs && ui.publishClientEmailInput) {
    ui.publishClientEmailInput.value = '';
  }
  if (clearInputs && ui.publishExpirySelect) {
    ui.publishExpirySelect.value = '30';
  }
  if (clearInputs && ui.publishPinInput) {
    ui.publishPinInput.value = '';
  }
  if (clearInputs && ui.publishPinToggle) {
    ui.publishPinToggle.checked = false;
  }
  if (clearInputs && ui.publishIncludePinEmailToggle) {
    ui.publishIncludePinEmailToggle.checked = false;
    ui.publishIncludePinEmailToggle.disabled = true;
  }
  syncPublishPinControls(clearAccess ? null : appState.publishedAccess);
  syncPublishModeControls();
  updatePublishActionState(clearAccess ? null : appState.publishedAccess);
}

function setPublishModalOpen(open) {
  if (!ui.publishModal) {
    return;
  }

  ui.publishModal.classList.toggle('is-hidden', !open);
  ui.publishModal.setAttribute('aria-hidden', open ? 'false' : 'true');
}

async function playPublishSuccessTakeover() {
  setPublishModalOpen(false);
  await publishSuccessTakeover.play({
    titleText: 'Congratulations',
    bodyText: 'Thanks for using Planeir, your future self will thank you!',
    restoreFocusIfContainedIn: ui.publishModal,
    restoreFocusTo: ui.publishSessionButton
  });
}

async function fetchPublishedAdvisorBundle(publishedId, advisorSecretB64u) {
  const capability = await buildPublishedCapabilityToken(advisorSecretB64u, 'advisor');
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/advisor`, {
    headers: {
      'X-Published-Capability': capability
    }
  }, {
    authPrompt: 'Sign in to reopen this published session.'
  });

  if (response.status === 404) {
    throw new Error('This advisor link is unavailable or incomplete.');
  }

  if (response.status === 410) {
    throw new Error('This advisor link has expired or has been revoked.');
  }

  if (!response.ok) {
    throw new Error(`Unable to reopen published session (${response.status}).`);
  }

  return response.json();
}

async function maybeLoadPublishedSessionFromLocation() {
  const publishedId = getLocationPublishedId();
  if (!publishedId) {
    return null;
  }

  const advisorSecretB64u = getLocationAdvisorSecret();
  if (!advisorSecretB64u) {
    return {
      error: 'This advisor link is incomplete.'
    };
  }

  const bundle = await fetchPublishedAdvisorBundle(publishedId, advisorSecretB64u);
  const decrypted = await decryptPublishedSessionV2ForAdvisor(advisorSecretB64u, bundle);
  const importedSession = importPublishedSession(decrypted.plaintext);
  void recordPublishedUnlock(publishedId, advisorSecretB64u, 'advisor', 'advisor-reopen');
  return {
    session: importedSession,
    access: {
      version: Number(bundle?.v) || 2,
      publishedId,
      clientLink: buildClientSessionLink(publishedId, decrypted.clientSecretB64u),
      advisorLink: buildAdvisorSessionLink(publishedId, advisorSecretB64u),
      pin: decrypted.clientPin || '',
      clientPinState: bundle?.meta?.clientPinState || decrypted.clientPinState || null,
      clientAccessRevision: Number(bundle?.meta?.clientAccessRevision || decrypted.clientAccessRevision || 0),
      clientPinInitializedAt: bundle?.meta?.clientPinInitializedAt || null,
      expiresAt: bundle.expiresAt,
      expiryDays: inferExpiryDays(bundle.expiresAt),
      clientEmail: bundle?.meta?.clientEmail || '',
      emailSendCount: Number(bundle?.meta?.emailSendCount || 0),
      lastEmailSentAt: bundle?.meta?.lastEmailSentAt || null,
      status: bundle?.status || 'active'
    }
  };
}

function setPublishedRecoveryVisible(visible) {
  if (!publishedRecoveryLayer) {
    return;
  }

  publishedRecoveryLayer.classList.toggle('is-hidden', !visible);
  publishedRecoveryLayer.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function choosePublishedRecoveryAction(message) {
  if (!publishedRecoveryLayer || !publishedRecoveryMessage || !publishedRecoveryRetryButton || !publishedRecoveryFreshButton) {
    return Promise.resolve('fresh');
  }

  publishedRecoveryMessage.textContent = String(message || 'Could not reopen the published session.');
  setPublishedRecoveryLocalAvailable(hasPublishedLocalRecoveryOption());
  setPublishedRecoveryVisible(true);

  return new Promise((resolve) => {
    const cleanup = () => {
      publishedRecoveryRetryButton.removeEventListener('click', handleRetry);
      publishedRecoveryLocalButton?.removeEventListener('click', handleLocal);
      publishedRecoveryFreshButton.removeEventListener('click', handleFresh);
      setPublishedRecoveryVisible(false);
    };

    const handleRetry = () => {
      cleanup();
      resolve('retry');
    };
    const handleLocal = () => {
      cleanup();
      resolve('local');
    };
    const handleFresh = () => {
      cleanup();
      resolve('fresh');
    };

    publishedRecoveryRetryButton.addEventListener('click', handleRetry, { once: true });
    if (publishedRecoveryLocalButton && !publishedRecoveryLocalButton.disabled) {
      publishedRecoveryLocalButton.addEventListener('click', handleLocal, { once: true });
    }
    publishedRecoveryFreshButton.addEventListener('click', handleFresh, { once: true });
    publishedRecoveryRetryButton.focus();
  });
}

async function resolvePublishedStartupRecovery(message) {
  let recoveryMessage = String(message || 'Could not reopen the published session.');

  while (true) {
    const action = await choosePublishedRecoveryAction(recoveryMessage);
    if (action === 'local') {
      return {
        session: loadSession(),
        access: null,
        notice: 'Opened local draft instead.'
      };
    }

    if (action === 'fresh') {
      return {
        session: newSession('Client'),
        access: null,
        notice: 'Started a new session instead.'
      };
    }

    try {
      const publishedBootstrap = await maybeLoadPublishedSessionFromLocation();
      if (publishedBootstrap?.session) {
        return {
          session: publishedBootstrap.session,
          access: publishedBootstrap.access,
          notice: 'Opened published snapshot.'
        };
      }

      recoveryMessage = publishedBootstrap?.error || 'Could not reopen the published session.';
    } catch (error) {
      recoveryMessage = error?.message || 'Could not reopen the published session.';
    }
  }
}

async function publishCurrentSession() {
  const clientPlaintext = exportPublishedSession(appState.session);
  const advisorPlaintext = exportSession(appState.session);
  const mode = getPublishMode();
  const isShareMode = mode === 'share';
  const clientEmail = isShareMode ? '' : getPublishClientEmailFromInput({ required: true });
  const expiresInDays = getPublishExpiryDaysFromInput();
  const encryptedPayload = await (isShareMode ? encryptPublishedSessionV3 : encryptPublishedSessionV4)({
    clientSessionJson: clientPlaintext,
    advisorSessionJson: advisorPlaintext,
    clientName: appState.session?.clientName || 'Client',
    clientEmail,
    expiresInDays
  });
  encryptedPayload.requestBody.recovery = {
    clientSecretB64u: encryptedPayload.clientSecretB64u,
    advisorSecretB64u: encryptedPayload.advisorSecretB64u
  };

  if (isShareMode) {
    encryptedPayload.requestBody.publishTarget = 'detached-share';
    encryptedPayload.requestBody.linkAccessMode = 'direct';
  } else if (appState.pipelineContext?.clientId) {
    encryptedPayload.requestBody.clientId = appState.pipelineContext.clientId;
  }

  if (!isShareMode && appState.pipelineContext?.leadId) {
    encryptedPayload.requestBody.sourceLeadId = appState.pipelineContext.leadId;
  }
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/published-sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(encryptedPayload.requestBody)
  }, {
    includeCsrf: true,
    authPrompt: 'Sign in to publish secure client sessions.'
  });

  if (!response.ok) {
    throw new Error(`Publish failed (${response.status}).`);
  }

  const payload = await response.json();
  const publishedId = normalizePublishSessionId(payload?.publishedId);
  const clientLink = buildClientSessionLink(publishedId, encryptedPayload.clientSecretB64u);
  const advisorLink = buildAdvisorSessionLink(publishedId, encryptedPayload.advisorSecretB64u);

  return {
    version: isShareMode ? 3 : 4,
    publishedId,
    clientId: payload?.clientId || (!isShareMode ? appState.pipelineContext?.clientId : null) || null,
    sourceLeadId: payload?.sourceLeadId || (!isShareMode ? appState.pipelineContext?.leadId : null) || null,
    pin: '',
    clientLink,
    advisorLink,
    expiresAt: payload?.expiresAt || '',
    expiryDays: expiresInDays,
    clientEmail: payload?.clientEmail || clientEmail,
    publishTarget: isShareMode ? 'detached-share' : 'client-email',
    linkAccessMode: isShareMode ? 'direct' : 'client-first-pin',
    clientPinState: isShareMode ? null : (payload?.clientPinState || encryptedPayload.clientPinState || 'pending'),
    clientAccessRevision: Number(payload?.clientAccessRevision || encryptedPayload.clientAccessRevision || 1),
    clientPinInitializedAt: null,
    emailSendCount: Number(payload?.emailSendCount || 0),
    lastEmailSentAt: payload?.lastEmailSentAt || null,
    status: payload?.status || 'active'
  };
}

async function queuePublishedAdvisorNotification(access) {
  if (!WORKER_BASE_URL || !access || Number(access.version) < 3) {
    return;
  }

  const publishedId = String(access.publishedId || '').trim();
  const advisorLink = getPublishedAdvisorLink(access);
  const advisorSecretB64u = getLinkHashParam(advisorLink, 'ak');
  if (!publishedId || !advisorSecretB64u || !advisorLink) {
    throw new Error('Advisor link is unavailable for advisor notification.');
  }

  const capability = await buildPublishedCapabilityToken(advisorSecretB64u, 'advisor');
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/send-advisor-notification`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Published-Capability': capability
    },
    body: JSON.stringify({
      advisorLink,
      clientLink: getPublishedClientLink(access)
    }),
    keepalive: true
  }, {
    includeCsrf: true,
    authPrompt: 'Sign in to publish secure client sessions.'
  });

  if (!response.ok) {
    throw new Error(`Advisor notification request failed (${response.status}).`);
  }
}

async function revokePublishedSession(access) {
  if (!access) {
    throw new Error('No published access to revoke.');
  }

  if (access.publishedId) {
    const publishedId = String(access.publishedId || '').trim();
    const advisorSecretB64u = getLinkHashParam(access.advisorLink, 'ak');
    if (!publishedId || !advisorSecretB64u) {
      throw new Error('Advisor link is unavailable for revoke.');
    }

    const capability = await buildPublishedCapabilityToken(advisorSecretB64u, 'advisor');
    const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Published-Capability': capability
      }
    }, {
      includeCsrf: true,
      authPrompt: 'Sign in to revoke this published client session.'
    });

    if (!response.ok) {
      throw new Error(`Failed to revoke (${response.status}).`);
    }

    return;
  }

  const sessionId = String(access.sessionId || '').trim();
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/revoke/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  }, {
    includeCsrf: true,
    authPrompt: 'Sign in to revoke this published client session.'
  });

  if (!response.ok) {
    throw new Error(`Failed to revoke (${response.status}).`);
  }
}

function applyRuntimeChrome() {
  if (runtimeConfig.readOnly) {
    document.body.classList.add('read-only-session');
    if (ui.clientNameInput) {
      ui.clientNameInput.readOnly = true;
      ui.clientNameInput.setAttribute('aria-readonly', 'true');
    }
    [ui.newCallButton, ui.openClientAccessButton, ui.newModuleButton, ui.resetButton].forEach((element) => {
      if (!element) {
        return;
      }
      element.classList.add('is-hidden');
      element.setAttribute('aria-hidden', 'true');
    });
  } else {
    document.body.classList.remove('read-only-session');
  }

  if (!runtimeConfig.allowPublish && ui.publishSessionButton) {
    ui.publishSessionButton.classList.add('is-hidden');
  }

  if (!runtimeConfig.allowPublish && ui.publishModal) {
    ui.publishModal.classList.add('is-hidden');
    ui.publishModal.setAttribute('aria-hidden', 'true');
  }

  if (!runtimeConfig.allowDevPanel && ui.devPanel) {
    setDevPanelOpen(false);
    ui.devPanel.classList.add('is-hidden');
    ui.devPanel.setAttribute('aria-hidden', 'true');
  }

  if (runtimeConfig.readOnly && ui.sessionStatus) {
    ui.sessionStatus.textContent = 'Read only';
    ui.sessionStatus.classList.remove('is-dirty');
  }

  syncMobileActionState();
  syncMobileFocusedNavState();
  if (!isMobileLayoutActive()) {
    closeMobileModuleSheet({ restoreFocus: false });
    closeMobileOverflowSheet({ restoreFocus: false });
  }
}

function renderPublishedAccess(access) {
  if (!access) {
    return;
  }

  const isV4 = isFirstOpenPublishedAccess(access);
  const isDirectLink = access.linkAccessMode === 'direct';
  const showLegacyPin = isLegacyPinPublishedAccess(access);

  if (ui.publishResult) {
    ui.publishResult.classList.remove('is-hidden');
  }

  if (ui.publishPinToggle) {
    ui.publishPinToggle.checked = showLegacyPin;
  }
  syncPublishPinControls(access);
  if (ui.publishClientEmailInput) {
    ui.publishClientEmailInput.value = access.clientEmail || '';
  }
  if (ui.publishExpirySelect) {
    ui.publishExpirySelect.value = String(access.expiryDays || inferExpiryDays(access.expiresAt));
  }
  if (ui.publishPinInput) {
    ui.publishPinInput.value = access.pin || '';
  }

  if (ui.publishPinValue) {
    ui.publishPinValue.textContent = access.pin || '------';
  }
  if (ui.publishPinWrap) {
    ui.publishPinWrap.classList.toggle('is-hidden', !showLegacyPin);
  }
  if (ui.publishCopyPinButton) {
    ui.publishCopyPinButton.classList.toggle('is-hidden', !showLegacyPin);
  }
  if (ui.publishIncludePinEmailToggle) {
    ui.publishIncludePinEmailToggle.disabled = !showLegacyPin;
    if (!showLegacyPin) {
      ui.publishIncludePinEmailToggle.checked = false;
    }
  }
  if (ui.publishClientPinStateRow) {
    ui.publishClientPinStateRow.classList.toggle('is-hidden', !(isV4 || isDirectLink));
  }
  if (ui.publishClientPinStateValue) {
    ui.publishClientPinStateValue.textContent = formatPublishedClientPinState(access);
  }
  if (ui.publishClientPinInfo) {
    ui.publishClientPinInfo.textContent = getPublishedClientPinInfoText(access);
  }

  if (ui.publishLinkValue) {
    ui.publishLinkValue.value = getPublishedClientLink(access);
  }

  if (ui.publishAdvisorLinkValue) {
    ui.publishAdvisorLinkValue.value = getPublishedAdvisorLink(access);
  }

  if (ui.publishExpiryValue) {
    ui.publishExpiryValue.textContent = formatPublishedExpiry(access.expiresAt);
  }
  if (ui.publishEmailStatus) {
    ui.publishEmailStatus.textContent = formatPublishedEmailStatus(access);
  }

  setPublishMode(isDirectLink ? 'share' : 'email');
  updatePublishActionState(access);
}

async function handlePublishGenerate() {
  if (runtimeConfig.readOnly || !runtimeConfig.allowPublish) {
    return;
  }

  setPublishError('');
  const shouldAutoSendEmail = getPublishMode() === 'email';

  if (ui.publishGenerateButton) {
    ui.publishGenerateButton.disabled = true;
    ui.publishGenerateButton.textContent = shouldAutoSendEmail ? 'Publishing & Emailing...' : 'Publishing...';
  }

  try {
    const access = await publishCurrentSession();
    appState.publishedAccess = access;
    renderPublishedAccess(access);
    if (access.linkAccessMode !== 'direct') {
      void queuePublishedAdvisorNotification(access).catch((error) => {
        console.error('Advisor publish notification request failed', {
          publishedId: access?.publishedId || '',
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }

    if (shouldAutoSendEmail && access.clientEmail) {
      try {
        const payload = await sendPublishedSessionEmail(access);
        appState.publishedAccess = mergePublishedEmailDelivery(access, payload);
        renderPublishedAccess(appState.publishedAccess);
        await playPublishSuccessTakeover();
      } catch (error) {
        setPublishError(`Secure links published, but the client email could not be sent. ${error?.message || 'Use Send Final Email to try again.'}`);
        showToast('Secure links published, but email was not sent.', 'error');
      }
      return;
    }

    showToast('Share link published.');
  } catch (error) {
    setPublishError(error?.message || 'Failed to publish this session.');
  } finally {
    if (ui.publishGenerateButton) {
      ui.publishGenerateButton.disabled = false;
    }
    updatePublishActionState();
  }
}

async function handleCopyPublishedPin() {
  if (!appState.publishedAccess?.pin) {
    return;
  }

  try {
    await copyToClipboard(appState.publishedAccess.pin);
    showToast('PIN copied.');
  } catch (_error) {
    showToast('Could not copy PIN.', 'error');
  }
}

async function handleCopyPublishedLink() {
  const clientLink = getPublishedClientLink(appState.publishedAccess);
  if (!clientLink) {
    return;
  }

  try {
    await copyToClipboard(clientLink);
    showToast('Client link copied.');
  } catch (_error) {
    showToast('Could not copy client link.', 'error');
  }
}

async function handleCopyPublishedAdvisorLink() {
  const advisorLink = getPublishedAdvisorLink(appState.publishedAccess);
  if (!advisorLink) {
    return;
  }

  try {
    await copyToClipboard(advisorLink);
    showToast('Advisor link copied.');
  } catch (_error) {
    showToast('Could not copy advisor link.', 'error');
  }
}

async function handleCopyPublishedEmailCopy() {
  if (!confirmInlinePinDelivery(appState.publishedAccess, 'Copy email copy with the client PIN included?')) {
    return;
  }

  const emailCopy = buildPublishedEmailCopy(appState.publishedAccess);
  if (!emailCopy) {
    return;
  }

  try {
    await copyToClipboard(emailCopy);
    showToast('Email copy copied.');
  } catch (_error) {
    showToast('Could not copy email copy.', 'error');
  }
}

async function sendPublishedSessionEmail(access) {
  if (!access || Number(access.version) < 3) {
    throw new Error('Email sending is only available for newly published sessions.');
  }

  const publishedId = String(access.publishedId || '').trim();
  const advisorSecretB64u = getLinkHashParam(access.advisorLink, 'ak');
  if (!publishedId || !advisorSecretB64u) {
    throw new Error('Advisor link is unavailable for email sending.');
  }

  const clientEmail = getPublishClientEmailFromInput({ required: true });
  if (!confirmInlinePinDelivery(access, 'Send the final email with the client PIN included?')) {
    throw new Error('Email sending cancelled.');
  }
  const capability = await buildPublishedCapabilityToken(advisorSecretB64u, 'advisor');
  const includePinInEmail = !isFirstOpenPublishedAccess(access) && isPublishPinIncludedInEmail();
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/send-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Published-Capability': capability
    },
    body: JSON.stringify({
      clientEmail,
      clientName: appState.session?.clientName || 'Client',
      clientLink: getPublishedClientLink(access),
      pin: includePinInEmail ? (access.pin || '') : '',
      includePinInEmail,
      acknowledgeInlinePinRisk: includePinInEmail && Boolean(access.pin)
    })
  }, {
    includeCsrf: true,
    authPrompt: 'Sign in to send the final client email.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Failed to send final email (${response.status}).`);
  }

  return response.json();
}

function mergePublishedEmailDelivery(access, payload) {
  if (!access) {
    return null;
  }

  return {
    ...access,
    clientEmail: payload?.clientEmail || getPublishClientEmailFromInput(),
    lastEmailSentAt: payload?.lastEmailSentAt || access.lastEmailSentAt,
    emailSendCount: Number(payload?.emailSendCount || access.emailSendCount || 0)
  };
}

async function updatePublishedSessionExpiry(access) {
  if (!access || Number(access.version) < 3) {
    throw new Error('Expiry updates are only available for newly published sessions.');
  }

  const publishedId = String(access.publishedId || '').trim();
  const advisorSecretB64u = getLinkHashParam(access.advisorLink, 'ak');
  if (!publishedId || !advisorSecretB64u) {
    throw new Error('Advisor link is unavailable for expiry changes.');
  }

  const capability = await buildPublishedCapabilityToken(advisorSecretB64u, 'advisor');
  const expiresInDays = getPublishExpiryDaysFromInput();
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/extend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Published-Capability': capability
    },
    body: JSON.stringify({
      expiresInDays
    })
  }, {
    includeCsrf: true,
    authPrompt: 'Sign in to update this published session.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Failed to update expiry (${response.status}).`);
  }

  return response.json();
}

async function resetPublishedClientAccess(access) {
  if (!access || !isFirstOpenPublishedAccess(access)) {
    throw new Error('Client access reset is only available for v4 published sessions.');
  }

  const publishedId = String(access.publishedId || '').trim();
  const advisorSecretB64u = getLinkHashParam(access.advisorLink, 'ak');
  if (!publishedId || !advisorSecretB64u) {
    throw new Error('Advisor link is unavailable for client access reset.');
  }

  const currentBundle = await fetchPublishedAdvisorBundle(publishedId, advisorSecretB64u);
  const decrypted = await decryptPublishedSessionV2ForAdvisor(advisorSecretB64u, currentBundle);
  const sourceSession = importPublishedSession(decrypted.plaintext);
  const clientPlaintext = exportPublishedSession(sourceSession);
  const advisorPlaintext = exportSession(sourceSession);
  const currentRevision = Number(
    currentBundle?.meta?.clientAccessRevision
    || decrypted.clientAccessRevision
    || access.clientAccessRevision
    || 1
  );
  const rotated = await rotatePublishedClientAccessV4({
    clientSessionJson: clientPlaintext,
    advisorSessionJson: advisorPlaintext,
    advisorSecretB64u,
    currentRevision
  });
  const capability = await buildPublishedCapabilityToken(advisorSecretB64u, 'advisor');
  const response = await fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/published-sessions/${encodeURIComponent(publishedId)}/client-access/reset`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Published-Capability': capability
    },
    body: JSON.stringify({
      expectedRevision: currentRevision,
      clientSecretB64u: rotated.clientSecretB64u,
      clientAuthHashB64u: rotated.clientAuthHashB64u,
      clientBundle: rotated.clientBundle,
      advisorBundle: rotated.advisorBundle
    })
  }, {
    includeCsrf: true,
    authPrompt: 'Sign in to reset this client link.'
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Failed to reset client access (${response.status}).`);
  }

  const payload = await response.json();
  return {
    ...access,
    version: 4,
    clientLink: buildClientSessionLink(publishedId, rotated.clientSecretB64u),
    advisorLink: buildAdvisorSessionLink(publishedId, advisorSecretB64u),
    pin: '',
    clientPinState: payload?.clientPinState || rotated.clientPinState || 'pending',
    clientAccessRevision: Number(payload?.clientAccessRevision || rotated.clientAccessRevision || (currentRevision + 1)),
    clientPinInitializedAt: null,
    clientEmail: payload?.clientEmail || access.clientEmail || '',
    emailSendCount: Number(payload?.emailSendCount || 0),
    lastEmailSentAt: payload?.lastEmailSentAt || null,
    status: payload?.status || access.status || 'active'
  };
}

async function handleSendPublishedEmail() {
  if (!appState.publishedAccess) {
    return;
  }

  setPublishError('');
  if (ui.publishSendEmailButton) {
    ui.publishSendEmailButton.disabled = true;
  }

  try {
    const payload = await sendPublishedSessionEmail(appState.publishedAccess);
    appState.publishedAccess = mergePublishedEmailDelivery(appState.publishedAccess, payload);
    renderPublishedAccess(appState.publishedAccess);
    showToast('Final email sent.');
  } catch (error) {
    setPublishError(error?.message || 'Could not send the final email.');
  } finally {
    updatePublishActionState();
  }
}

async function handleUpdatePublishedExpiry() {
  if (!appState.publishedAccess) {
    return;
  }

  setPublishError('');
  if (ui.publishUpdateExpiryButton) {
    ui.publishUpdateExpiryButton.disabled = true;
  }

  try {
    const payload = await updatePublishedSessionExpiry(appState.publishedAccess);
    appState.publishedAccess = {
      ...appState.publishedAccess,
      expiresAt: payload.expiresAt || appState.publishedAccess.expiresAt,
      expiryDays: getPublishExpiryDaysFromInput(),
      status: payload.status || appState.publishedAccess.status
    };
    renderPublishedAccess(appState.publishedAccess);
    showToast('Expiry updated.');
  } catch (error) {
    setPublishError(error?.message || 'Could not update the expiry.');
  } finally {
    updatePublishActionState();
  }
}

async function handleResetPublishedClientAccess() {
  if (!appState.publishedAccess || !isFirstOpenPublishedAccess(appState.publishedAccess)) {
    return;
  }

  const confirmed = window.confirm('Issue a fresh client link and reset the client PIN setup?\n\nThe advisor link will stay the same and the published modules will be preserved, but the current client link will stop working.');
  if (!confirmed) {
    return;
  }

  setPublishError('');
  if (ui.publishResetClientAccessButton) {
    ui.publishResetClientAccessButton.disabled = true;
  }

  try {
    const updatedAccess = await resetPublishedClientAccess(appState.publishedAccess);
    appState.publishedAccess = updatedAccess;
    renderPublishedAccess(updatedAccess);
    showToast('Client access reset. Send the new client link.');
  } catch (error) {
    setPublishError(error?.message || 'Could not reset the client link.');
  } finally {
    updatePublishActionState();
  }
}

async function handleRevokePublishedAccess() {
  if (!appState.publishedAccess) {
    return;
  }

  const confirmed = window.confirm('Revoke this client link now?');
  if (!confirmed) {
    return;
  }

  try {
    await revokePublishedSession(appState.publishedAccess);
    showToast('Client access revoked.');
    resetPublishResult();
  } catch (error) {
    setPublishError(error?.message || 'Revoke failed.');
  }
}

async function replaceSession(nextSession, options = {}) {
  const { markClean = true } = options;

  destroySortable();
  destroyAllCharts();
  clearUndoActionState();
  clearCompareScrollSyncCleanup();

  appState.transitionLock = false;
  appState.session = nextSession;
  appState.compare = null;
  appState.overviewSelection = [];
  ui.swipeStage.classList.remove('is-compare');
  appState.pensionShowMaxByModuleId = new Map();
  appState.pensionScenarioByModuleId = new Map();
  appState.netRetirementScenarioByModuleId = new Map();
  clearAllAssumptionsEditorState();
  appState.lastValidProjectionByModuleId = new Map();

  ensureActiveModule(appState.session);
  saveSessionNow();

  if (markClean) {
    markSessionClean();
  }

  renderGreeting(ui, appState.session.clientName);

  if (appState.session.modules.length > 0) {
    appState.mode = 'focused';
    await renderFocused({ useSwipe: false, revealMode: true });
  } else {
    appState.mode = 'greeting';
    setMode(ui, 'greeting');
    updateUiChrome();
  }

  cleanupDetachedCharts();
}

function validateTablePayload(table, label) {
  if (!table || typeof table !== 'object') {
    throw new Error(`${label} must be an object with columns and rows.`);
  }

  if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) {
    throw new Error(`${label} must include columns[] and rows[].`);
  }

  const columns = table.columns.map((column) => String(column ?? ''));
  const rows = table.rows.map((row) => Array.isArray(row)
    ? row.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : String(value ?? '')))
    : []);

  return {
    columns,
    rows
  };
}

function normalizePbsPayloadToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function validateOutputsBucketedSectionsPayload(sectionsPayload, label) {
  if (!Array.isArray(sectionsPayload)) {
    throw new Error(`${label} must be an array.`);
  }

  return sectionsPayload.map((section, sectionIndex) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new Error(`${label}[${sectionIndex}] must be an object.`);
    }

    if (typeof section.title !== 'string' || !section.title.trim()) {
      throw new Error(`${label}[${sectionIndex}].title must be a non-empty string.`);
    }

    if (!Array.isArray(section.columns) || section.columns.length !== 2) {
      throw new Error(`${label}[${sectionIndex}].columns: outputsBucketed sections only support 2 columns. For multi-column tables, use generated.tables[].`);
    }

    const columns = section.columns.map((column, columnIndex) => {
      if (typeof column !== 'string') {
        throw new Error(`${label}[${sectionIndex}].columns[${columnIndex}] must be a string.`);
      }
      return column;
    });

    if (!Array.isArray(section.rows)) {
      throw new Error(`${label}[${sectionIndex}].rows must be an array.`);
    }

    const rows = section.rows.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== 2) {
        throw new Error(`${label}[${sectionIndex}].rows[${rowIndex}] must be [string, number].`);
      }

      if (typeof row[0] !== 'string') {
        throw new Error(`${label}[${sectionIndex}].rows[${rowIndex}][0] must be a string.`);
      }

      if (typeof row[1] !== 'number' || !Number.isFinite(row[1])) {
        throw new Error(`${label}[${sectionIndex}].rows[${rowIndex}][1] must be a finite number.`);
      }

      return [row[0], row[1]];
    });

    const key = typeof section.key === 'string' && section.key.trim()
      ? section.key.trim().toLowerCase()
      : `section_${sectionIndex + 1}`;
    const title = section.title.trim();
    const keyToken = normalizePbsPayloadToken(key);
    const titleToken = normalizePbsPayloadToken(title);
    const isSummary = keyToken === 'summary'
      || titleToken === 'summary'
      || keyToken.endsWith('summary')
      || titleToken.endsWith('summary');
    const hasSubtotal = 'subtotalValue' in section;

    if (!isSummary && !hasSubtotal) {
      throw new Error(`${label}[${sectionIndex}].subtotalValue is required; dev panel now auto-fills missing subtotalValue = 0.`);
    }

    let subtotalValue = null;
    if (hasSubtotal) {
      if (typeof section.subtotalValue !== 'number' || !Number.isFinite(section.subtotalValue)) {
        throw new Error(`${label}[${sectionIndex}].subtotalValue must be a finite number.`);
      }
      subtotalValue = section.subtotalValue;
    }

    if ('notes' in section && typeof section.notes !== 'string') {
      throw new Error(`${label}[${sectionIndex}].notes must be a string when provided.`);
    }

    return {
      key,
      title,
      columns,
      rows,
      subtotalLabel: typeof section.subtotalLabel === 'string' && section.subtotalLabel.trim()
        ? section.subtotalLabel
        : 'Subtotal',
      subtotalValue,
      notes: typeof section.notes === 'string' ? section.notes : ''
    };
  });
}

function validatePbsMovementEndpointPayload(endpoint, label, { includeAction = false } = {}) {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    throw new Error(`${label} must be an object.`);
  }

  if (typeof endpoint.sectionKey !== 'string' || !endpoint.sectionKey.trim()) {
    throw new Error(`${label}.sectionKey must be a non-empty string.`);
  }

  if (typeof endpoint.amount !== 'number' || !Number.isFinite(endpoint.amount)) {
    throw new Error(`${label}.amount must be a finite number.`);
  }

  const normalized = {
    sectionKey: endpoint.sectionKey.trim().toLowerCase(),
    rowLabel: typeof endpoint.rowLabel === 'string' ? endpoint.rowLabel.trim() : '',
    amount: endpoint.amount
  };

  if (includeAction) {
    const action = normalizePbsMovementAction(endpoint.action) || 'increase';
    normalized.action = action;
  }

  return normalized;
}

function normalizePbsMovementAction(action) {
  const token = String(action ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (!token) {
    return '';
  }

  const aliases = {
    add: 'add',
    added: 'add',
    contribute: 'add',
    contributed: 'add',
    contribution: 'add',
    fund: 'add',
    funded: 'add',
    redirect: 'add',
    redirected: 'add',
    reinvest: 'add',
    reinvested: 'add',
    transfer: 'add',
    transferred: 'add',
    transferin: 'add',
    increase: 'increase',
    increased: 'increase',
    reduce: 'reduce',
    reduced: 'reduce',
    decrease: 'reduce',
    decreased: 'reduce',
    lower: 'reduce',
    lowered: 'reduce',
    paydown: 'reduce',
    payoff: 'reduce',
    repay: 'reduce',
    repaid: 'reduce',
    repayment: 'reduce',
    clear: 'reduce',
    cleared: 'reduce',
    settle: 'reduce',
    settled: 'reduce',
    remove: 'remove',
    removed: 'remove',
    sell: 'remove',
    sold: 'remove',
    dispose: 'remove',
    disposed: 'remove',
    disposal: 'remove'
  };

  return aliases[token] || '';
}

function validatePbsScenarioMovementsPayload(movements, label) {
  if (movements === undefined) {
    return [];
  }

  if (!Array.isArray(movements)) {
    throw new Error(`${label} must be an array when provided.`);
  }

  return movements.map((movement, movementIndex) => {
    if (!movement || typeof movement !== 'object' || Array.isArray(movement)) {
      throw new Error(`${label}[${movementIndex}] must be an object.`);
    }

    const from = validatePbsMovementEndpointPayload(movement.from, `${label}[${movementIndex}].from`);

    if (!Array.isArray(movement.to) || movement.to.length === 0) {
      throw new Error(`${label}[${movementIndex}].to must be a non-empty array.`);
    }

    const to = movement.to.map((endpoint, endpointIndex) => (
      validatePbsMovementEndpointPayload(endpoint, `${label}[${movementIndex}].to[${endpointIndex}]`, {
        includeAction: true
      })
    ));

    return {
      label: typeof movement.label === 'string' && movement.label.trim()
        ? movement.label.trim()
        : `Movement ${movementIndex + 1}`,
      from,
      to
    };
  });
}

function validateOutputsBucketedScenariosPayload(scenarios, label) {
  if (scenarios === undefined) {
    return [];
  }

  if (!Array.isArray(scenarios)) {
    throw new Error(`${label} must be an array when provided.`);
  }

  return scenarios.map((scenario, scenarioIndex) => {
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
      throw new Error(`${label}[${scenarioIndex}] must be an object.`);
    }

    return {
      id: typeof scenario.id === 'string' && scenario.id.trim()
        ? scenario.id.trim()
        : `scenario-${scenarioIndex + 1}`,
      title: typeof scenario.title === 'string' && scenario.title.trim()
        ? scenario.title.trim()
        : `Alternative ${scenarioIndex + 1}`,
      summaryHtml: typeof scenario.summaryHtml === 'string' ? scenario.summaryHtml : '',
      sections: validateOutputsBucketedSectionsPayload(
        scenario.sections,
        `${label}[${scenarioIndex}].sections`
      ),
      movements: validatePbsScenarioMovementsPayload(
        scenario.movements,
        `${label}[${scenarioIndex}].movements`
      )
    };
  });
}

function validateOutputsBucketedPayload(outputsBucketed, label = 'generated.outputsBucketed') {
  if (!outputsBucketed || typeof outputsBucketed !== 'object' || Array.isArray(outputsBucketed)) {
    throw new Error(`${label} must be an object with sections[].`);
  }

  const sections = validateOutputsBucketedSectionsPayload(outputsBucketed.sections, `${label}.sections`);
  const scenarios = validateOutputsBucketedScenariosPayload(outputsBucketed.scenarios, `${label}.scenarios`);

  const normalized = {
    currencySymbol: typeof outputsBucketed.currencySymbol === 'string' && outputsBucketed.currencySymbol.trim()
      ? outputsBucketed.currencySymbol
      : '€',
    sections
  };

  if (scenarios.length > 0) {
    normalized.scenarios = scenarios;
  }

  return normalized;
}

function validateGeneratedTablesPayload(tables, label = 'generated.tables') {
  if (!Array.isArray(tables)) {
    throw new Error(`${label} must be an array of table objects.`);
  }

  return tables.map((table, tableIndex) => {
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      throw new Error(`${label}[${tableIndex}] must be an object.`);
    }

    const validated = validateTablePayload(table, `${label}[${tableIndex}]`);
    return {
      title: typeof table.title === 'string' && table.title.trim()
        ? table.title.trim()
        : `Table ${tableIndex + 1}`,
      columns: validated.columns,
      rows: validated.rows
    };
  });
}

function normalizePayloadTone(value) {
  const tone = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    : '';
  return tone || '';
}

function validateInsightItemsPayload(items, label, fallbackPrefix = 'insight') {
  if (typeof items === 'undefined') {
    return [];
  }

  if (!Array.isArray(items)) {
    throw new Error(`${label} must be an array when provided.`);
  }

  return items.map((item, itemIndex) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label}[${itemIndex}] must be an object.`);
    }

    if ('label' in item && typeof item.label !== 'string') {
      throw new Error(`${label}[${itemIndex}].label must be a string when provided.`);
    }

    if ('title' in item && typeof item.title !== 'string') {
      throw new Error(`${label}[${itemIndex}].title must be a string when provided.`);
    }

    if ('value' in item && typeof item.value !== 'string' && typeof item.value !== 'number') {
      throw new Error(`${label}[${itemIndex}].value must be a string or number when provided.`);
    }

    if ('detail' in item && typeof item.detail !== 'string') {
      throw new Error(`${label}[${itemIndex}].detail must be a string when provided.`);
    }

    if ('body' in item && typeof item.body !== 'string') {
      throw new Error(`${label}[${itemIndex}].body must be a string when provided.`);
    }

    const normalized = {
      id: typeof item.id === 'string' && item.id.trim()
        ? item.id.trim()
        : `${fallbackPrefix}-${itemIndex + 1}`,
      label: typeof item.label === 'string' && item.label.trim()
        ? item.label.trim()
        : (typeof item.title === 'string' && item.title.trim()
          ? item.title.trim()
          : `Insight ${itemIndex + 1}`)
    };

    if (typeof item.value === 'number' && Number.isFinite(item.value)) {
      normalized.value = String(item.value);
    } else if (typeof item.value === 'string' && item.value.trim()) {
      normalized.value = item.value.trim();
    }

    const detail = typeof item.detail === 'string' && item.detail.trim()
      ? item.detail.trim()
      : (typeof item.body === 'string' && item.body.trim() ? item.body.trim() : '');
    if (detail) {
      normalized.detail = detail;
    }

    const tone = normalizePayloadTone(item.tone);
    if (tone) {
      normalized.tone = tone;
    }

    if (item.featured === true) {
      normalized.featured = true;
    }

    return normalized;
  });
}

function validateChartDisplayPayload(display, label) {
  if (typeof display === 'undefined') {
    return null;
  }

  if (!display || typeof display !== 'object' || Array.isArray(display)) {
    throw new Error(`${label} must be an object when provided.`);
  }

  const normalized = {};
  const variant = typeof display.variant === 'string'
    ? display.variant.trim().toLowerCase()
    : '';
  if (variant) {
    if (variant !== 'hero' && variant !== 'compact' && variant !== 'wide' && variant !== 'pension-drawdown-composite') {
      throw new Error(`${label}.variant must be "hero", "compact", "wide", or "pension-drawdown-composite" when provided.`);
    }
    normalized.variant = variant;
  }

  const valueFormat = typeof display.valueFormat === 'string'
    ? display.valueFormat.trim().toLowerCase()
    : '';
  if (valueFormat) {
    if (valueFormat !== 'currency' && valueFormat !== 'percent' && valueFormat !== 'number') {
      throw new Error(`${label}.valueFormat must be "currency", "percent", or "number" when provided.`);
    }
    normalized.valueFormat = valueFormat;
  }

  ['xAxisTitle', 'yAxisTitle', 'highlightDataset'].forEach((key) => {
    if (key in display) {
      if (typeof display[key] !== 'string') {
        throw new Error(`${label}.${key} must be a string when provided.`);
      }
      if (display[key].trim()) {
        normalized[key] = display[key].trim();
      }
    }
  });

  if ('showLegend' in display) {
    if (typeof display.showLegend !== 'boolean') {
      throw new Error(`${label}.showLegend must be a boolean when provided.`);
    }
    normalized.showLegend = display.showLegend;
  }

  if ('stacked' in display) {
    if (typeof display.stacked !== 'boolean') {
      throw new Error(`${label}.stacked must be a boolean when provided.`);
    }
    normalized.stacked = display.stacked;
  }

  ['yMin', 'yMax', 'suggestedMin', 'suggestedMax'].forEach((key) => {
    if (key in display) {
      const value = Number(display[key]);
      if (!Number.isFinite(value)) {
        throw new Error(`${label}.${key} must be a finite number when provided.`);
      }
      normalized[key] = value;
    }
  });

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function validateChartAnnotationsPayload(annotations, label) {
  if (typeof annotations === 'undefined') {
    return [];
  }

  if (!Array.isArray(annotations)) {
    throw new Error(`${label} must be an array when provided.`);
  }

  return annotations.map((annotation, annotationIndex) => {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) {
      throw new Error(`${label}[${annotationIndex}] must be an object.`);
    }

    if ('label' in annotation && typeof annotation.label !== 'string') {
      throw new Error(`${label}[${annotationIndex}].label must be a string when provided.`);
    }

    if ('body' in annotation && typeof annotation.body !== 'string') {
      throw new Error(`${label}[${annotationIndex}].body must be a string when provided.`);
    }

    if ('xLabel' in annotation && typeof annotation.xLabel !== 'string') {
      throw new Error(`${label}[${annotationIndex}].xLabel must be a string when provided.`);
    }

    if ('yValue' in annotation && (typeof annotation.yValue !== 'number' || !Number.isFinite(annotation.yValue))) {
      throw new Error(`${label}[${annotationIndex}].yValue must be a finite number when provided.`);
    }

    const normalized = {
      id: typeof annotation.id === 'string' && annotation.id.trim()
        ? annotation.id.trim()
        : `annotation-${annotationIndex + 1}`,
      label: typeof annotation.label === 'string' && annotation.label.trim()
        ? annotation.label.trim()
        : `Annotation ${annotationIndex + 1}`
    };

    if (typeof annotation.body === 'string' && annotation.body.trim()) {
      normalized.body = annotation.body.trim();
    }

    if (typeof annotation.xLabel === 'string' && annotation.xLabel.trim()) {
      normalized.xLabel = annotation.xLabel.trim();
    }

    if (typeof annotation.yValue === 'number' && Number.isFinite(annotation.yValue)) {
      normalized.yValue = annotation.yValue;
    }

    const tone = normalizePayloadTone(annotation.tone);
    if (tone) {
      normalized.tone = tone;
    }

    return normalized;
  });
}

function validateChartsPayload(charts) {
  if (!Array.isArray(charts)) {
    throw new Error('generated.charts must be an array.');
  }

  return charts.map((chart, index) => {
    if (!chart || typeof chart !== 'object') {
      throw new Error(`Chart ${index + 1} must be an object.`);
    }

    if (typeof chart.title !== 'string' || !chart.title.trim()) {
      throw new Error(`Chart ${index + 1} requires a non-empty title.`);
    }

    if (chart.type !== 'line' && chart.type !== 'bar') {
      throw new Error(`Chart ${index + 1} type must be "line" or "bar".`);
    }

    if (!Array.isArray(chart.labels)) {
      throw new Error(`Chart ${index + 1} labels must be an array.`);
    }

    if (!Array.isArray(chart.datasets) || chart.datasets.length === 0) {
      throw new Error(`Chart ${index + 1} datasets must be a non-empty array.`);
    }

    const normalizedChart = {
      id: typeof chart.id === 'string' && chart.id.trim() ? chart.id : '',
      title: chart.title,
      type: chart.type,
      labels: chart.labels.map((label) => String(label ?? '')),
      datasets: chart.datasets.map((dataset, datasetIndex) => {
        if (!dataset || typeof dataset !== 'object') {
          throw new Error(`Chart ${index + 1}, dataset ${datasetIndex + 1} must be an object.`);
        }

        if (!Array.isArray(dataset.data)) {
          throw new Error(`Chart ${index + 1}, dataset ${datasetIndex + 1} must include data[].`);
        }

        const normalizedDataset = {
          label: typeof dataset.label === 'string' ? dataset.label : `Series ${datasetIndex + 1}`,
          data: dataset.data.map((value) => {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
              throw new Error(`Chart ${index + 1} contains non-numeric data.`);
            }
            return value;
          })
        };

        if ('type' in dataset) {
          if (dataset.type !== 'line' && dataset.type !== 'bar') {
            throw new Error(`Chart ${index + 1}, dataset ${datasetIndex + 1}.type must be "line" or "bar" when provided.`);
          }
          normalizedDataset.type = dataset.type;
        }
        if ('stack' in dataset) {
          if (typeof dataset.stack !== 'string') {
            throw new Error(`Chart ${index + 1}, dataset ${datasetIndex + 1}.stack must be a string when provided.`);
          }
          if (dataset.stack.trim()) {
            normalizedDataset.stack = dataset.stack.trim();
          }
        }

        [
          'backgroundColor',
          'borderColor',
          'pointBackgroundColor',
          'pointBorderColor'
        ].forEach((key) => {
          if (key in dataset) {
            if (typeof dataset[key] !== 'string') {
              throw new Error(`Chart ${index + 1}, dataset ${datasetIndex + 1}.${key} must be a string when provided.`);
            }
            if (dataset[key].trim()) {
              normalizedDataset[key] = dataset[key].trim();
            }
          }
        });

        return normalizedDataset;
      })
    };

    if ('subtitle' in chart) {
      if (typeof chart.subtitle !== 'string') {
        throw new Error(`Chart ${index + 1} subtitle must be a string when provided.`);
      }
      if (chart.subtitle.trim()) {
        normalizedChart.subtitle = chart.subtitle.trim();
      }
    }

    const display = validateChartDisplayPayload(chart.display, `Chart ${index + 1}.display`);
    if (display) {
      normalizedChart.display = display;
    }

    const annotations = validateChartAnnotationsPayload(chart.annotations, `Chart ${index + 1}.annotations`);
    if (annotations.length > 0) {
      normalizedChart.annotations = annotations;
    }

    const insights = validateInsightItemsPayload(chart.insights, `Chart ${index + 1}.insights`, 'chart-insight');
    if (insights.length > 0) {
      normalizedChart.insights = insights;
    }

    return normalizedChart;
  });
}

function cloneEducationSpecValue(value, depth = 0) {
  if (depth > 24) {
    return null;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => cloneEducationSpecValue(entry, depth + 1))
      .filter((entry) => typeof entry !== 'undefined');
  }

  if (value && typeof value === 'object') {
    const clone = {};
    Object.entries(value).forEach(([key, childValue]) => {
      const normalized = cloneEducationSpecValue(childValue, depth + 1);
      if (typeof normalized !== 'undefined') {
        clone[key] = normalized;
      }
    });
    return clone;
  }

  return undefined;
}

function validateEducationPayload(education) {
  if (education === null) {
    return null;
  }

  if (!education || typeof education !== 'object' || Array.isArray(education)) {
    throw new Error('generated.education must be an object.');
  }

  const normalized = {
    topic: typeof education.topic === 'string' ? education.topic : '',
    sections: [],
    visuals: [],
    references: []
  };

  if ('audience' in education) {
    if (typeof education.audience !== 'string') {
      throw new Error('generated.education.audience must be a string when provided.');
    }
    if (education.audience.trim()) {
      normalized.audience = education.audience.trim();
    }
  }

  if ('sections' in education) {
    if (!Array.isArray(education.sections)) {
      throw new Error('generated.education.sections must be an array when provided.');
    }

    normalized.sections = education.sections.map((section, sectionIndex) => {
      if (!section || typeof section !== 'object' || Array.isArray(section)) {
        throw new Error(`generated.education.sections[${sectionIndex}] must be an object.`);
      }

      const bullets = Array.isArray(section.bullets)
        ? section.bullets.map((bullet, bulletIndex) => {
          if (typeof bullet !== 'string') {
            throw new Error(`generated.education.sections[${sectionIndex}].bullets[${bulletIndex}] must be a string.`);
          }
          return bullet;
        })
        : [];

      if ('bodyHtml' in section && typeof section.bodyHtml !== 'string') {
        throw new Error(`generated.education.sections[${sectionIndex}].bodyHtml must be a string when provided.`);
      }

      if ('whyItMatters' in section && typeof section.whyItMatters !== 'string') {
        throw new Error(`generated.education.sections[${sectionIndex}].whyItMatters must be a string when provided.`);
      }

      if ('defaultOpen' in section && typeof section.defaultOpen !== 'boolean') {
        throw new Error(`generated.education.sections[${sectionIndex}].defaultOpen must be a boolean when provided.`);
      }

      return {
        id: typeof section.id === 'string' && section.id.trim()
          ? section.id.trim()
          : `section-${sectionIndex + 1}`,
        title: typeof section.title === 'string' && section.title.trim()
          ? section.title.trim()
          : `Section ${sectionIndex + 1}`,
        bodyHtml: typeof section.bodyHtml === 'string' ? section.bodyHtml : '',
        bullets,
        ...(typeof section.whyItMatters === 'string' && section.whyItMatters.trim()
          ? { whyItMatters: section.whyItMatters.trim() }
          : {}),
        ...(typeof section.defaultOpen === 'boolean'
          ? { defaultOpen: section.defaultOpen }
          : {})
      };
    });
  }

  if ('metrics' in education) {
    normalized.metrics = validateInsightItemsPayload(education.metrics, 'generated.education.metrics', 'education-metric');
  }

  if ('steps' in education) {
    if (!Array.isArray(education.steps)) {
      throw new Error('generated.education.steps must be an array when provided.');
    }

    normalized.steps = education.steps.map((step, stepIndex) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        throw new Error(`generated.education.steps[${stepIndex}] must be an object.`);
      }

      ['title', 'bodyHtml', 'kicker', 'focus'].forEach((key) => {
        if (key in step && typeof step[key] !== 'string') {
          throw new Error(`generated.education.steps[${stepIndex}].${key} must be a string when provided.`);
        }
      });

      const bullets = Array.isArray(step.bullets)
        ? step.bullets.map((bullet, bulletIndex) => {
          if (typeof bullet !== 'string') {
            throw new Error(`generated.education.steps[${stepIndex}].bullets[${bulletIndex}] must be a string.`);
          }
          return bullet;
        })
        : [];

      return {
        id: typeof step.id === 'string' && step.id.trim()
          ? step.id.trim()
          : `step-${stepIndex + 1}`,
        title: typeof step.title === 'string' && step.title.trim()
          ? step.title.trim()
          : `Step ${stepIndex + 1}`,
        bodyHtml: typeof step.bodyHtml === 'string' ? step.bodyHtml : '',
        bullets,
        ...(typeof step.kicker === 'string' && step.kicker.trim()
          ? { kicker: step.kicker.trim() }
          : {}),
        ...(typeof step.focus === 'string' && step.focus.trim()
          ? { focus: step.focus.trim() }
          : {})
      };
    });
  }

  if ('visuals' in education) {
    if (!Array.isArray(education.visuals)) {
      throw new Error('generated.education.visuals must be an array when provided.');
    }

    normalized.visuals = education.visuals.map((visual, visualIndex) => {
      if (!visual || typeof visual !== 'object' || Array.isArray(visual)) {
        throw new Error(`generated.education.visuals[${visualIndex}] must be an object.`);
      }

      const type = String(visual.type || '').trim().toLowerCase();
      const title = typeof visual.title === 'string' ? visual.title : '';
      const subtitle = typeof visual.subtitle === 'string' ? visual.subtitle : '';

      if (type === 'svg') {
        if (!visual.svgSpec || typeof visual.svgSpec !== 'object' || Array.isArray(visual.svgSpec)) {
          throw new Error(`generated.education.visuals[${visualIndex}].svgSpec must be an object for type \"svg\".`);
        }

        return {
          type: 'svg',
          title,
          subtitle,
          svgSpec: cloneEducationSpecValue(visual.svgSpec) || {}
        };
      }

      if (type === 'chart') {
        if (!visual.chart || typeof visual.chart !== 'object' || Array.isArray(visual.chart)) {
          throw new Error(`generated.education.visuals[${visualIndex}].chart must be an object for type \"chart\".`);
        }

        const chart = validateChartsPayload([visual.chart])[0];
        return {
          type: 'chart',
          title,
          subtitle,
          chart
        };
      }

      throw new Error(`generated.education.visuals[${visualIndex}].type must be \"svg\" or \"chart\".`);
    });
  }

  if ('references' in education) {
    if (!Array.isArray(education.references)) {
      throw new Error('generated.education.references must be an array when provided.');
    }

    normalized.references = education.references.map((reference, referenceIndex) => {
      if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
        throw new Error(`generated.education.references[${referenceIndex}] must be an object.`);
      }

      if ('label' in reference && typeof reference.label !== 'string') {
        throw new Error(`generated.education.references[${referenceIndex}].label must be a string when provided.`);
      }

      if ('url' in reference && typeof reference.url !== 'string') {
        throw new Error(`generated.education.references[${referenceIndex}].url must be a string when provided.`);
      }

      if ('kind' in reference && typeof reference.kind !== 'string') {
        throw new Error(`generated.education.references[${referenceIndex}].kind must be a string when provided.`);
      }

      if ('note' in reference && typeof reference.note !== 'string') {
        throw new Error(`generated.education.references[${referenceIndex}].note must be a string when provided.`);
      }

      return {
        label: typeof reference.label === 'string' && reference.label.trim()
          ? reference.label.trim()
          : `Reference ${referenceIndex + 1}`,
        url: typeof reference.url === 'string' ? reference.url.trim() : '',
        kind: typeof reference.kind === 'string' ? reference.kind.trim() : '',
        note: typeof reference.note === 'string' ? reference.note : ''
      };
    });
  }

  return normalized;
}

function validatePensionInputsPayload(pensionInputs) {
  return normalizePensionInputs(pensionInputs);
}

function validateCollegeFundingInputsPayload(collegeFundingInputs) {
  return normalizeCollegeFundingInputs(collegeFundingInputs);
}

function validateNetRetirementInputsPayload(netRetirementInputs) {
  return normalizeNetRetirementInputs(netRetirementInputs);
}

function validateMortgageInputsPayload(mortgageInputs) {
  return normalizeMortgageInputs(mortgageInputs, { defaultLoanKind: 'mortgage' });
}

function validateLoanInputsPayload(loanInputs) {
  return normalizeMortgageInputs(loanInputs, { defaultLoanKind: 'loan' });
}

function validatePbsInputsPayload(pbsInputs) {
  return normalizePbsInputs(pbsInputs);
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload must be a JSON object.');
  }

  const normalized = {};

  if ('moduleId' in payload) {
    if (typeof payload.moduleId !== 'string' || !payload.moduleId.trim()) {
      throw new Error('moduleId must be a non-empty string when provided.');
    }

    normalized.moduleId = payload.moduleId;
  }

  if ('title' in payload) {
    if (typeof payload.title !== 'string') {
      throw new Error('title must be a string when provided.');
    }

    normalized.title = payload.title;
  }

  if ('generated' in payload) {
    if (!payload.generated || typeof payload.generated !== 'object' || Array.isArray(payload.generated)) {
      throw new Error('generated must be an object when provided.');
    }

    const generatedPatch = {};

    if ('summaryHtml' in payload.generated) {
      if (typeof payload.generated.summaryHtml !== 'string') {
        throw new Error('generated.summaryHtml must be a string.');
      }
      generatedPatch.summaryHtml = payload.generated.summaryHtml;
    }

    if ('assumptions' in payload.generated) {
      generatedPatch.assumptions = validateTablePayload(payload.generated.assumptions, 'generated.assumptions');
    }

    if ('outputs' in payload.generated) {
      generatedPatch.outputs = validateTablePayload(payload.generated.outputs, 'generated.outputs');
    }

    if ('outputsBucketed' in payload.generated) {
      generatedPatch.outputsBucketed = validateOutputsBucketedPayload(payload.generated.outputsBucketed);
    }

    if ('tables' in payload.generated) {
      generatedPatch.tables = validateGeneratedTablesPayload(payload.generated.tables);
    }

    if ('pbsInputs' in payload.generated) {
      generatedPatch.pbsInputs = validatePbsInputsPayload(payload.generated.pbsInputs);
    }

    if ('personalBalanceSheetInputs' in payload.generated && !('pbsInputs' in payload.generated)) {
      generatedPatch.pbsInputs = validatePbsInputsPayload(payload.generated.personalBalanceSheetInputs);
    }

    if ('charts' in payload.generated) {
      generatedPatch.charts = validateChartsPayload(payload.generated.charts);
    }

    if ('pensionInputs' in payload.generated) {
      generatedPatch.pensionInputs = validatePensionInputsPayload(payload.generated.pensionInputs);
    }

    if ('collegeFundingInputs' in payload.generated) {
      generatedPatch.collegeFundingInputs = validateCollegeFundingInputsPayload(payload.generated.collegeFundingInputs);
    }

    if ('collegeFunding' in payload.generated && !('collegeFundingInputs' in payload.generated)) {
      generatedPatch.collegeFundingInputs = validateCollegeFundingInputsPayload(payload.generated.collegeFunding);
    }

    if ('netRetirementInputs' in payload.generated) {
      generatedPatch.netRetirementInputs = validateNetRetirementInputsPayload(payload.generated.netRetirementInputs);
    }

    if ('netCashflowInputs' in payload.generated && !('netRetirementInputs' in payload.generated)) {
      generatedPatch.netRetirementInputs = validateNetRetirementInputsPayload(payload.generated.netCashflowInputs);
    }

    if ('mortgageInputs' in payload.generated) {
      generatedPatch.mortgageInputs = validateMortgageInputsPayload(payload.generated.mortgageInputs);
    }

    if ('loanInputs' in payload.generated) {
      generatedPatch.loanInputs = validateLoanInputsPayload(payload.generated.loanInputs);
    }

    if ('education' in payload.generated) {
      generatedPatch.education = validateEducationPayload(payload.generated.education);
    }

    if ('report' in payload.generated) {
      generatedPatch.report = validateReportPayload(payload.generated.report);
    }

    normalized.generated = generatedPatch;
  }

  if (!('title' in normalized) && !('generated' in normalized)) {
    throw new Error('Payload must include at least one of: title, generated.');
  }

  return normalized;
}

function hydrateChartsForActivePane() {
  const activeModule = getModuleById(appState.session, appState.session.activeModuleId);
  const activePane = ui.swipeStage.querySelector('.swipe-pane.active');

  if (!activeModule || !activePane) {
    cleanupDetachedCharts();
    return;
  }

  const chartModule = getChartHydrationModule(activeModule);
  renderChartsForPane(activePane, chartModule, {
    clientName: appState.session.clientName || 'Client',
    moduleTitle: activeModule.title?.trim() || 'Untitled Module',
    paneKey: 'focused-active'
  });
}

function summarizeHydrationSnapshot(snapshot) {
  const paneRect = snapshot?.paneRect
    ? {
      width: Number(snapshot.paneRect.width.toFixed(2)),
      height: Number(snapshot.paneRect.height.toFixed(2))
    }
    : null;

  return {
    zoomAnimating: Boolean(snapshot?.zoomAnimating),
    paneConnected: Boolean(snapshot?.pane?.isConnected),
    paneVisible: Boolean(snapshot?.paneVisible),
    paneOpacityVisible: Boolean(snapshot?.paneOpacityVisible),
    paneRect,
    paneOpacity: snapshot?.paneOpacity ?? null,
    paneTransform: snapshot?.paneTransform ?? null,
    stageTransform: snapshot?.stageTransform ?? null,
    focusTransform: snapshot?.focusTransform ?? null
  };
}

function getActivePaneHydrationSnapshot() {
  const zoomAnimating = getIsZoomAnimating();
  const pane = ui.swipeStage?.querySelector('.swipe-pane.active') || null;

  if (!pane) {
    return {
      zoomAnimating,
      pane,
      paneRect: null,
      paneVisible: false,
      paneOpacityVisible: false,
      paneOpacity: null,
      paneTransform: null,
      stageTransform: null,
      focusTransform: null,
      isStable: false
    };
  }

  const paneStyle = window.getComputedStyle(pane);
  const stageStyle = ui.swipeStage ? window.getComputedStyle(ui.swipeStage) : null;
  const focusStyle = ui.focusLayer ? window.getComputedStyle(ui.focusLayer) : null;
  const paneRect = pane.getBoundingClientRect();
  const paneVisible = pane.isConnected
    && pane.offsetWidth > 0
    && pane.offsetHeight > 0
    && paneRect.width > 0
    && paneRect.height > 0;
  const opacityNumber = Number.parseFloat(paneStyle.opacity);
  const paneOpacityVisible = paneStyle.opacity !== '0'
    && (!Number.isFinite(opacityNumber) || opacityNumber > 0);
  const paneTransform = paneStyle.transform || 'none';
  const stageTransform = stageStyle?.transform || 'none';
  const focusTransform = focusStyle?.transform || 'none';
  const isStable = !zoomAnimating
    && paneVisible
    && paneOpacityVisible
    && paneTransform === 'none'
    && stageTransform === 'none'
    && focusTransform === 'none';

  return {
    zoomAnimating,
    pane,
    paneRect,
    paneVisible,
    paneOpacityVisible,
    paneOpacity: paneStyle.opacity,
    paneTransform,
    stageTransform,
    focusTransform,
    isStable
  };
}

async function hydrateChartsWhenStable({ reason = 'unknown' } = {}) {
  const runId = ++appState.chartHydrationRunId;
  const maxFrames = 60;

  await nextFrame();
  await nextFrame();

  for (let attempt = 1; attempt <= maxFrames; attempt += 1) {
    if (runId !== appState.chartHydrationRunId) {
      return false;
    }

    const snapshot = getActivePaneHydrationSnapshot();

    if (attempt === 1) {
      console.info('[CallCanvas][Charts] hydration wait start', {
        reason,
        ...summarizeHydrationSnapshot(snapshot)
      });
    }

    if (snapshot.isStable) {
      hydrateChartsForActivePane();
      console.info('[CallCanvas][Charts] hydration wait complete', {
        reason,
        attempts: attempt,
        ...summarizeHydrationSnapshot(snapshot)
      });
      return true;
    }

    await nextFrame();
  }

  if (runId !== appState.chartHydrationRunId) {
    return false;
  }

  const finalSnapshot = getActivePaneHydrationSnapshot();
  console.warn('[CallCanvas][Charts] hydration wait capped; hydrating anyway', {
    reason,
    attempts: maxFrames,
    ...summarizeHydrationSnapshot(finalSnapshot)
  });
  hydrateChartsForActivePane();
  return false;
}

function getPensionScenarioCasesForModule(module) {
  if (!module?.generated?.pensionInputs) {
    return [];
  }

  try {
    return getPensionScenarioCases(module.generated.pensionInputs);
  } catch (_error) {
    return [];
  }
}

function getDefaultPensionScenarioForModule(module) {
  if (!module?.generated?.pensionInputs) {
    return '';
  }

  try {
    return getDefaultPensionScenarioId(module.generated.pensionInputs);
  } catch (_error) {
    return '';
  }
}

function getPensionScenarioForModule(moduleId) {
  if (typeof moduleId !== 'string' || !moduleId) {
    return '';
  }

  const module = getModuleById(appState.session, moduleId);
  const cases = getPensionScenarioCasesForModule(module);
  if (cases.length === 0) {
    appState.pensionScenarioByModuleId.delete(moduleId);
    return '';
  }

  const selectedId = appState.pensionScenarioByModuleId.get(moduleId);
  if (cases.some((pensionCase) => pensionCase.id === selectedId)) {
    return selectedId;
  }

  const defaultId = getDefaultPensionScenarioForModule(module) || cases[0].id;
  appState.pensionScenarioByModuleId.delete(moduleId);
  return defaultId;
}

async function setPensionScenarioForModule(moduleId, scenarioId) {
  if (typeof moduleId !== 'string' || !moduleId) {
    return;
  }

  const module = getModuleById(appState.session, moduleId);
  const cases = getPensionScenarioCasesForModule(module);
  if (cases.length <= 1) {
    appState.pensionScenarioByModuleId.delete(moduleId);
    return;
  }

  const nextCase = cases.find((pensionCase) => pensionCase.id === scenarioId);
  if (!nextCase) {
    return;
  }

  const currentId = getPensionScenarioForModule(moduleId);
  if (currentId === nextCase.id) {
    return;
  }

  appState.pensionScenarioByModuleId.set(moduleId, nextCase.id);

  if (appState.mode === 'focused' && appState.session.activeModuleId === moduleId) {
    patchFocusedModuleGeneratedContent(moduleId, {
      patchSummary: true,
      patchAssumptions: true,
      patchOutputs: true,
      updateCharts: true,
      replaceCharts: false
    });
  } else if (appState.mode === 'overview') {
    refreshOverview({ enableSortable: !runtimeConfig.readOnly });
  } else if (appState.mode === 'compare') {
    await renderCompareView();
  }
}

function getNetRetirementScenarioCasesForModule(module) {
  if (!module?.generated?.netRetirementInputs) {
    return [];
  }

  try {
    return getNetRetirementScenarioCases(module.generated.netRetirementInputs);
  } catch (_error) {
    return [];
  }
}

function getDefaultNetRetirementScenarioForModule(module) {
  if (!module?.generated?.netRetirementInputs) {
    return '';
  }

  try {
    return getDefaultNetRetirementScenarioId(module.generated.netRetirementInputs);
  } catch (_error) {
    return '';
  }
}

function getNetRetirementScenarioForModule(moduleId) {
  if (typeof moduleId !== 'string' || !moduleId) {
    return '';
  }

  const module = getModuleById(appState.session, moduleId);
  const cases = getNetRetirementScenarioCasesForModule(module);
  if (cases.length === 0) {
    appState.netRetirementScenarioByModuleId.delete(moduleId);
    return '';
  }

  const selectedId = appState.netRetirementScenarioByModuleId.get(moduleId);
  if (cases.some((netCase) => netCase.id === selectedId)) {
    return selectedId;
  }

  const defaultId = getDefaultNetRetirementScenarioForModule(module) || cases[0].id;
  appState.netRetirementScenarioByModuleId.delete(moduleId);
  return defaultId;
}

async function setNetRetirementScenarioForModule(moduleId, scenarioId) {
  if (typeof moduleId !== 'string' || !moduleId) {
    return;
  }

  const module = getModuleById(appState.session, moduleId);
  const cases = getNetRetirementScenarioCasesForModule(module);
  if (cases.length <= 1) {
    appState.netRetirementScenarioByModuleId.delete(moduleId);
    return;
  }

  const nextCase = cases.find((netCase) => netCase.id === scenarioId);
  if (!nextCase) {
    return;
  }

  const currentId = getNetRetirementScenarioForModule(moduleId);
  if (currentId === nextCase.id) {
    return;
  }

  appState.netRetirementScenarioByModuleId.set(moduleId, nextCase.id);

  if (appState.mode === 'focused' && appState.session.activeModuleId === moduleId) {
    patchFocusedModuleGeneratedContent(moduleId, {
      patchSummary: true,
      patchAssumptions: true,
      patchOutputs: true,
      updateCharts: true,
      replaceCharts: true
    });
  } else if (appState.mode === 'overview') {
    refreshOverview({ enableSortable: !runtimeConfig.readOnly });
  } else if (appState.mode === 'compare') {
    await renderCompareView();
  }
}

function getPensionShowMaxForModule(moduleId) {
  if (typeof moduleId !== 'string' || !moduleId) {
    return false;
  }

  const module = getModuleById(appState.session, moduleId);
  if (!module?.generated?.pensionInputs) {
    return false;
  }

  return appState.pensionShowMaxByModuleId.get(moduleId) ?? false;
}

function setPensionShowMaxForModule(moduleId, value) {
  if (runtimeConfig.readOnly || !runtimeConfig.showPensionToggle) {
    return;
  }

  if (typeof moduleId !== 'string' || !moduleId) {
    return;
  }

  const module = getModuleById(appState.session, moduleId);
  if (!module?.generated?.pensionInputs) {
    appState.pensionShowMaxByModuleId.delete(moduleId);
    return;
  }

  const nextValue = Boolean(value);
  const currentValue = appState.pensionShowMaxByModuleId.get(moduleId) ?? false;
  if (currentValue === nextValue) {
    return;
  }
  appState.pensionShowMaxByModuleId.set(moduleId, nextValue);

  if (appState.mode === 'focused' && appState.session.activeModuleId === moduleId) {
    const pensionInputs = module.generated.pensionInputs;
    const isAffordableMode = pensionInputs?.incomeMode === 'affordable' && pensionInputs?.minDrawdownMode !== true;

    if (isAffordableMode) {
      void renderFocused({ useSwipe: false, revealMode: false });
      return;
    }

    if (typeof window.__setPensionShowMaxForModule === 'function') {
      window.__setPensionShowMaxForModule(moduleId, nextValue);
    }
  }
}

function updateModule(moduleId, patch) {
  if (runtimeConfig.readOnly) {
    return;
  }

  const module = getModuleById(appState.session, moduleId);
  if (!module) {
    return;
  }

  ensureGenerated(module);
  Object.assign(module, patch);
  module.updatedAt = nowIso();
  scheduleSessionSave();

  if (appState.mode === 'overview') {
    refreshOverview({ enableSortable: true });
  }
}

function toggleAssumptionsEditMode(moduleId) {
  const state = getAssumptionsEditorState(moduleId);
  const nextEditing = !Boolean(state.isEditing);
  state.isEditing = nextEditing;
  state.phase = 'idle';
  state.errors = {};
  state.draftValues = {};
  clearAssumptionsEditorTimers(state);
  refreshInlineAssumptionsCard(moduleId);
}

function cancelAssumptionsInlineDraft(moduleId) {
  const state = getAssumptionsEditorState(moduleId);
  state.phase = 'idle';
  state.errors = {};
  state.draftValues = {};
  clearAssumptionsEditorTimers(state);
  refreshInlineAssumptionsCard(moduleId);
}

function setAssumptionDraftValue(moduleId, field, value) {
  if (!field) {
    return;
  }

  const state = getAssumptionsEditorState(moduleId);
  state.draftValues = {
    ...(state.draftValues || {}),
    [field]: value
  };
  clearAssumptionsFieldErrors(state, [field]);
}

async function commitInlineAssumption({
  moduleId,
  calculator,
  field = null,
  value,
  modeOverride = null
}) {
  if (runtimeConfig.readOnly || !moduleId || !calculator) {
    return;
  }

  const module = getModuleById(appState.session, moduleId);
  if (!module) {
    return;
  }

  ensureGenerated(module);
  const state = getAssumptionsEditorState(moduleId);
  if (field && typeof value !== 'undefined') {
    state.draftValues = {
      ...(state.draftValues || {}),
      [field]: value
    };
  }

  clearAssumptionsFieldErrors(state, [field, 'fixedPaymentMode', 'fixedPaymentAmount'].filter(Boolean));
  setAssumptionsEditorPhase(moduleId, 'updating');

  let result;
  if (calculator === 'pension') {
    const rawValue = hasOwnPropertyValue(state.draftValues, field) ? state.draftValues[field] : value;
    result = commitPensionAssumptionField({
      module,
      state,
      field,
      rawValue
    });
  } else if (calculator === 'netRetirement') {
    const rawValue = hasOwnPropertyValue(state.draftValues, field) ? state.draftValues[field] : value;
    result = commitNetRetirementAssumptionField({
      module,
      state,
      field,
      rawValue
    });
  } else if (calculator === 'mortgage') {
    const rawValue = field && hasOwnPropertyValue(state.draftValues, field) ? state.draftValues[field] : value;
    result = commitMortgageAssumptionField({
      module,
      state,
      field,
      rawValue,
      modeOverride
    });
  } else {
    return;
  }

  if (!result?.ok) {
    const errorField = result?.field || (calculator === 'mortgage'
      ? 'currentBalance'
      : (calculator === 'netRetirement' ? 'presentValueRate' : 'growthRate'));
    setAssumptionsFieldError(state, errorField, result?.message || 'Could not update assumptions.');
    setAssumptionsEditorPhase(moduleId, 'idle');
    return;
  }

  if (modeOverride === 'fixed' || modeOverride === 'calculated') {
    clearAssumptionsDraftFields(state, ['fixedPaymentMode']);
  }

  state.errors = {};
  module.updatedAt = nowIso();
  setAssumptionsEditorPhase(moduleId, 'updated');

  patchFocusedModuleGeneratedContent(moduleId, {
    patchSummary: true,
    patchAssumptions: true,
    patchOutputs: true,
    updateCharts: true
  });

  if (appState.mode === 'overview') {
    refreshOverview({ enableSortable: true });
  }

  markSessionDirty();
  saveSessionNow();
}

function handleAssumptionsEditorPatch(action) {
  if (!action || typeof action !== 'object') {
    return;
  }

  const {
    type,
    moduleId,
    calculator,
    field,
    value,
    mode
  } = action;

  if (runtimeConfig.readOnly || !moduleId) {
    return;
  }

  switch (type) {
    case 'toggle-edit-mode':
      toggleAssumptionsEditMode(moduleId);
      return;
    case 'cancel-edit':
      cancelAssumptionsInlineDraft(moduleId);
      return;
    case 'draft-change':
      if (!field) {
        return;
      }
      setAssumptionDraftValue(moduleId, field, value);
      return;
    case 'set-payment-mode': {
      const normalizedMode = mode === 'fixed' ? 'fixed' : 'calculated';
      setAssumptionDraftValue(moduleId, 'fixedPaymentMode', normalizedMode);
      void commitInlineAssumption({
        moduleId,
        calculator,
        field: 'fixedPaymentMode',
        modeOverride: normalizedMode
      });
      return;
    }
    case 'commit-field':
      if (!field || !calculator) {
        return;
      }
      void commitInlineAssumption({
        moduleId,
        calculator,
        field,
        value
      });
      return;
    default:
      return;
  }
}

function updateUiChrome() {
  const activeIndex = getActiveIndex();
  updateControls(ui, {
    mode: appState.mode,
    moduleCount: appState.session.modules.length,
    hasPrevious: activeIndex > 0,
    hasNext: hasNextModule(),
    readOnly: runtimeConfig.readOnly
  });

  document.body.classList.toggle('compare-mode', appState.mode === 'compare');
  document.body.classList.toggle('focus-mode', appState.mode === 'focused');
  document.body.classList.toggle('non-greeting-mode', appState.mode !== 'greeting');
  document.body.classList.toggle('overview-has-selection', appState.mode === 'overview' && appState.overviewSelection.length > 0);
  setOverviewMultiSelectArmed(appState.overviewMultiSelectArmed);
  renderGreeting(ui, appState.session.clientName);
  syncMobileActionState();
  syncMobileFocusedNavState();

  if (appState.mode === 'focused' && typeof window.__callcanvasReflowCharts === 'function') {
    window.requestAnimationFrame(() => {
      if (appState.mode === 'focused') {
        window.__callcanvasReflowCharts();
      }
    });
  }
}

function getFocusedPaneForModule(module, {
  readOnly = runtimeConfig.readOnly,
  showPensionToggle = runtimeConfig.showPensionToggle,
  cardId = 'focusCard'
} = {}) {
  const moduleNumber = Math.max(1, appState.session.order.indexOf(module.id) + 1);
  const moduleCount = Math.max(0, appState.session.order.length);

  ensureGenerated(module);
  const assumptionsEditorStatus = getAssumptionsEditorRenderStatus(module.id);

  return buildFocusedPane({
    module,
    moduleNumber,
    moduleCount,
    onTitleInput: (moduleId, value) => updateModule(moduleId, { title: value }),
    onNotesInput: (moduleId, value) => updateModule(moduleId, { notes: value }),
    onPatchInputs: (patch) => handleAssumptionsEditorPatch(patch),
    assumptionsEditorStatus,
    readOnly,
    showPensionToggle,
    cardId
  });
}

function getComparePairModules() {
  if (!appState.compare) {
    return null;
  }

  const left = getModuleById(appState.session, appState.compare.leftId);
  const right = getModuleById(appState.session, appState.compare.rightId);
  if (!left || !right) {
    return null;
  }

  return [left, right];
}

function bindCompareScrollSync(leftScrollable, rightScrollable) {
  if (!leftScrollable || !rightScrollable) {
    return () => {};
  }

  let syncLock = false;
  let syncRafId = 0;
  let pending = null;

  const syncNow = (source, target) => {
    if (!appState.compare?.syncScroll || syncLock) {
      return;
    }

    syncLock = true;
    target.scrollTop = source.scrollTop;
    target.scrollLeft = source.scrollLeft;
    syncLock = false;
  };

  const scheduleSync = (source, target) => {
    pending = { source, target };
    if (syncRafId) {
      return;
    }
    syncRafId = window.requestAnimationFrame(() => {
      syncRafId = 0;
      if (!pending) {
        return;
      }
      const next = pending;
      pending = null;
      syncNow(next.source, next.target);
    });
  };

  const onLeftScroll = () => scheduleSync(leftScrollable, rightScrollable);
  const onRightScroll = () => scheduleSync(rightScrollable, leftScrollable);

  leftScrollable.addEventListener('scroll', onLeftScroll, { passive: true });
  rightScrollable.addEventListener('scroll', onRightScroll, { passive: true });

  if (appState.compare?.syncScroll) {
    rightScrollable.scrollTop = leftScrollable.scrollTop;
    rightScrollable.scrollLeft = leftScrollable.scrollLeft;
  }

  return () => {
    if (syncRafId) {
      window.cancelAnimationFrame(syncRafId);
      syncRafId = 0;
    }
    leftScrollable.removeEventListener('scroll', onLeftScroll);
    rightScrollable.removeEventListener('scroll', onRightScroll);
  };
}

async function renderCompareView() {
  const pair = getComparePairModules();
  if (!pair) {
    await exitCompareView({ preserveSelection: true });
    return false;
  }

  const [leftModule, rightModule] = pair;
  destroySortable();
  destroyAllCharts();
  clearCompareScrollSyncCleanup();
  setDevPanelOpen(false);

  const root = document.createElement('section');
  root.className = 'compare-root';
  root.dataset.compareRoot = 'true';

  const controls = document.createElement('header');
  controls.className = 'compare-controls';

  const leftTitle = leftModule.title?.trim() || 'Untitled Module';
  const rightTitle = rightModule.title?.trim() || 'Untitled Module';

  const compareLabel = document.createElement('div');
  compareLabel.className = 'compare-label';
  compareLabel.textContent = 'Compare (2)';
  controls.appendChild(compareLabel);

  const buttons = document.createElement('div');
  buttons.className = 'compare-control-buttons';

  const exitButton = document.createElement('button');
  exitButton.type = 'button';
  exitButton.className = 'ui-button compare-control-btn';
  exitButton.textContent = 'Exit';
  exitButton.addEventListener('click', async () => {
    await exitCompareView({ preserveSelection: true });
  });

  const swapButton = document.createElement('button');
  swapButton.type = 'button';
  swapButton.className = 'ui-button compare-control-btn';
  swapButton.textContent = '⇄';
  swapButton.title = 'Swap sides';
  swapButton.setAttribute('aria-label', 'Swap sides');
  swapButton.addEventListener('click', async () => {
    if (!appState.compare) {
      return;
    }
    const previousLeftId = appState.compare.leftId;
    appState.compare.leftId = appState.compare.rightId;
    appState.compare.rightId = previousLeftId;
    await renderCompareView();
  });

  const syncButton = document.createElement('button');
  syncButton.type = 'button';
  syncButton.className = 'ui-button compare-control-btn';
  syncButton.textContent = `Sync scroll: ${appState.compare?.syncScroll === false ? 'Off' : 'On'}`;
  syncButton.addEventListener('click', async () => {
    if (!appState.compare) {
      return;
    }
    appState.compare.syncScroll = appState.compare.syncScroll === false;
    await renderCompareView();
  });
  buttons.appendChild(syncButton);
  buttons.appendChild(swapButton);
  buttons.appendChild(exitButton);

  controls.appendChild(buttons);
  root.appendChild(controls);

  const panes = document.createElement('div');
  panes.className = 'compare-panes';

  const buildComparePane = (module, sideKey) => {
    const paneShell = document.createElement('article');
    paneShell.className = `compare-pane compare-pane-${sideKey}`;
    paneShell.dataset.comparePane = sideKey;

    const paneContent = getFocusedPaneForModule(module, {
      readOnly: true,
      showPensionToggle: false,
      cardId: ''
    });
    paneShell.appendChild(paneContent);

    return paneShell;
  };

  const leftPane = buildComparePane(leftModule, 'left');
  const rightPane = buildComparePane(rightModule, 'right');
  panes.appendChild(leftPane);
  panes.appendChild(rightPane);
  root.appendChild(panes);

  ui.swipeStage.innerHTML = '';
  ui.swipeStage.classList.add('is-compare');
  ui.swipeStage.appendChild(root);

  const leftScrollable = leftPane.querySelector('.focused-module-card');
  const rightScrollable = rightPane.querySelector('.focused-module-card');
  appState.compareScrollCleanup = bindCompareScrollSync(leftScrollable, rightScrollable);

  appState.mode = 'compare';
  setMode(ui, 'focused');
  updateUiChrome();

  renderChartsForPane(leftPane, getChartHydrationModule(leftModule), {
    clientName: appState.session.clientName || 'Client',
    moduleTitle: leftTitle,
    paneKey: 'compare-left'
  });
  renderChartsForPane(rightPane, getChartHydrationModule(rightModule), {
    clientName: appState.session.clientName || 'Client',
    moduleTitle: rightTitle,
    paneKey: 'compare-right'
  });

  return true;
}

async function exitCompareView({ preserveSelection = true } = {}) {
  clearCompareScrollSyncCleanup();
  destroyAllCharts();
  appState.compare = null;
  ui.swipeStage.classList.remove('is-compare');

  if (!preserveSelection) {
    clearSelection();
  }

  if (!hasModules()) {
    appState.mode = 'greeting';
    ui.swipeStage.innerHTML = '';
    setMode(ui, 'greeting');
    updateUiChrome();
    return;
  }

  appState.mode = 'overview';
  setMode(ui, 'overview');
  refreshOverview({ enableSortable: true });
  updateUiChrome();
}

async function renderFocused({
  useSwipe = true,
  direction = 'forward',
  revealMode = true,
  deferCharts = false
} = {}) {
  clearCompareScrollSyncCleanup();
  appState.compare = null;
  ui.swipeStage.classList.remove('is-compare');
  ensureActiveModule(appState.session);

  if (!hasModules()) {
    appState.mode = 'greeting';
    ui.swipeStage.innerHTML = '';
    destroyAllCharts();
    setMode(ui, 'greeting');
    updateUiChrome();
    return;
  }

  const activeModule = getModuleById(appState.session, appState.session.activeModuleId);
  if (!activeModule) {
    return;
  }

  const pane = getFocusedPaneForModule(activeModule);

  if (useSwipe) {
    await swipeToPane(ui.swipeStage, pane, direction);
  } else {
    mountInitialPane(ui.swipeStage, pane);
  }

  if (revealMode) {
    appState.mode = 'focused';
    setMode(ui, 'focused');
    updateUiChrome();
  }

  if (!deferCharts) {
    const reason = useSwipe ? 'swipe-to-pane' : (revealMode ? 'renderFocused-visible' : 'renderFocused');
    await hydrateChartsWhenStable({ reason });
  }
}

function getOverviewScrollPosition() {
  return {
    top: ui.overviewViewport?.scrollTop || 0,
    left: ui.overviewViewport?.scrollLeft || 0
  };
}

function restoreOverviewScrollPosition(position) {
  if (!ui.overviewViewport || !position) {
    return;
  }

  ui.overviewViewport.scrollTop = Number(position.top) || 0;
  ui.overviewViewport.scrollLeft = Number(position.left) || 0;
}

async function runCompareFromSelection() {
  const pair = getSelectedPair();
  if (!pair) {
    showToast('Select exactly 2 modules to compare.', 'error');
    return;
  }

  appState.compare = {
    leftId: pair[0],
    rightId: pair[1],
    syncScroll: true
  };
  await renderCompareView();
}

function restoreSessionModeAfterDeletion() {
  if (!hasModules()) {
    appState.mode = 'greeting';
    ui.swipeStage.innerHTML = '';
    destroyAllCharts();
    clearCompareScrollSyncCleanup();
    setMode(ui, 'greeting');
    updateUiChrome();
    return;
  }

  appState.mode = 'overview';
  appState.compare = null;
  clearCompareScrollSyncCleanup();
  ui.swipeStage.classList.remove('is-compare');
  setMode(ui, 'overview');
  refreshOverview({ enableSortable: true });
  updateUiChrome();
}

function showBulkDeleteConfirmModal(count) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'delete-confirm-backdrop';

    const card = document.createElement('div');
    card.className = 'delete-confirm-card';

    const title = document.createElement('h3');
    title.className = 'delete-confirm-title';
    title.textContent = `Delete ${count} modules?`;

    const actions = document.createElement('div');
    actions.className = 'delete-confirm-actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'ui-button delete-confirm-btn';
    cancelButton.textContent = 'Cancel';

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'ui-button delete-confirm-btn is-destructive';
    confirmButton.textContent = 'Delete';

    const cleanup = () => {
      window.removeEventListener('keydown', onKeyDown);
      backdrop.remove();
    };

    const onResolve = (result) => {
      cleanup();
      resolve(result);
    };

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onResolve(false);
      }
    };

    cancelButton.addEventListener('click', () => onResolve(false));
    confirmButton.addEventListener('click', () => onResolve(true));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        onResolve(false);
      }
    });
    window.addEventListener('keydown', onKeyDown);

    actions.appendChild(cancelButton);
    actions.appendChild(confirmButton);
    card.appendChild(title);
    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
  });
}

async function deleteSelectedModulesWithUndo() {
  const selectedIds = pruneOverviewSelection();
  if (selectedIds.length === 0) {
    return;
  }

  if (selectedIds.length >= 5) {
    const confirmed = await showBulkDeleteConfirmModal(selectedIds.length);
    if (!confirmed) {
      return;
    }
  }

  const selectedSet = new Set(selectedIds);
  const orderBefore = [...appState.session.order];
  const activeBeforeDelete = appState.session.activeModuleId;
  const snapshot = buildDeleteUndoSnapshot(selectedIds, orderBefore, activeBeforeDelete);
  const earliestDeletedIndex = orderBefore.findIndex((moduleId) => selectedSet.has(moduleId));

  appState.session.modules = appState.session.modules.filter((module) => !selectedSet.has(module.id));
  appState.session.order = appState.session.order.filter((moduleId) => !selectedSet.has(moduleId));

  const activeDeleted = selectedSet.has(appState.session.activeModuleId);
  if (appState.session.order.length === 0) {
    appState.session.activeModuleId = null;
  } else if (activeDeleted) {
    let fallbackId = null;
    for (let index = earliestDeletedIndex - 1; index >= 0; index -= 1) {
      const candidate = orderBefore[index];
      if (!selectedSet.has(candidate) && appState.session.order.includes(candidate)) {
        fallbackId = candidate;
        break;
      }
    }

    appState.session.activeModuleId = fallbackId || appState.session.order[0];
  } else {
    ensureActiveModule(appState.session);
  }

  clearSelection();
  restoreSessionModeAfterDeletion();
  markSessionDirty();
  saveSessionNow();

  startDeleteUndoSnackbar({
    deletedCount: selectedIds.length,
    snapshot
  });
}

function deselectAllInOverview() {
  const selectedIds = pruneOverviewSelection();
  if (selectedIds.length === 0) {
    return;
  }

  clearSelection();
  refreshOverview({ enableSortable: true });
}

function keepLastTwoSelected() {
  const selectedIds = pruneOverviewSelection();
  if (selectedIds.length <= 2) {
    return;
  }

  keepMostRecentTwoSelected();
  refreshOverview({ enableSortable: true });
}

async function handleOverviewSelectionAction(action) {
  if (appState.mode !== 'overview') {
    return;
  }

  switch (action) {
    case 'deselect-all':
      deselectAllInOverview();
      return;
    case 'delete-selected':
      if (runtimeConfig.readOnly) {
        return;
      }
      await deleteSelectedModulesWithUndo();
      return;
    case 'compare-selected':
      await runCompareFromSelection();
      return;
    case 'keep-last-two':
      keepLastTwoSelected();
      return;
    default:
      return;
  }
}

function refreshOverview({ enableSortable = appState.mode === 'overview' } = {}) {
  pruneOverviewSelection();
  const modules = getModulesInOrder();
  const scrollPosition = getOverviewScrollPosition();

  const width = ui.overviewViewport.clientWidth;
  const height = ui.overviewViewport.clientHeight;
  const layout = computeBestOverviewLayout(modules.length, width, height, {
    maxCols: 6,
    gap: width < 900 ? 14 : 18,
    outerPadding: width < 900 ? 22 : 36
  });

  renderOverview({
    ui,
    modules,
    activeModuleId: appState.session.activeModuleId,
    layout,
    viewportWidth: width,
    viewportHeight: height,
    selectedModuleIds: appState.overviewSelection,
    onCardClick: async (moduleId, cardEl, event) => {
      const multiSelect = isMultiSelectModifier(event);
      if (multiSelect) {
        event.preventDefault();
        toggleSelected(moduleId);
        refreshOverview({ enableSortable: true });
        return;
      }
      await zoomIntoModuleFromOverview(moduleId, cardEl);
    },
    onSelectionAction: async (action) => {
      await handleOverviewSelectionAction(action);
    }
  });
  document.body.classList.toggle('overview-has-selection', appState.mode === 'overview' && appState.overviewSelection.length > 0);
  restoreOverviewScrollPosition(scrollPosition);

  if (enableSortable) {
    initSortable();
  }
}

function destroySortable() {
  if (appState.sortable) {
    appState.sortable.destroy();
    appState.sortable = null;
  }
}

function initSortable() {
  destroySortable();

  if (runtimeConfig.readOnly) {
    return;
  }

  if (typeof window.Sortable === 'undefined') {
    return;
  }

  if (appState.session.modules.length < 2 || appState.mode !== 'overview' || appState.overviewSelection.length > 0) {
    return;
  }

  appState.sortable = window.Sortable.create(ui.overviewGrid, {
    animation: 180,
    ghostClass: 'overview-drag-ghost',
    chosenClass: 'overview-drag-chosen',
    dragClass: 'overview-drag-dragging',
    onEnd: () => {
      const nextOrder = [...ui.overviewGrid.querySelectorAll('.overview-card')]
        .map((card) => card.dataset.moduleId)
        .filter(Boolean);

      if (nextOrder.length === appState.session.order.length) {
        appState.session.order = nextOrder;
        ensureActiveModule(appState.session);
        scheduleSessionSave();
      }

      refreshOverview({ enableSortable: true });
    }
  });
}

async function zoomIntoModuleFromOverview(moduleId, sourceCardEl) {
  if (
    appState.transitionLock ||
    appState.mode !== 'overview' ||
    !moduleId ||
    !sourceCardEl ||
    getIsZoomAnimating()
  ) {
    return;
  }

  const targetModule = getModuleById(appState.session, moduleId);
  if (!targetModule) {
    return;
  }

  appState.transitionLock = true;
  destroySortable();
  appState.session.activeModuleId = moduleId;

  const completed = await zoomToModuleFromOverview(moduleId, sourceCardEl, {
    overviewLayer: ui.overviewLayer,
    focusLayer: ui.focusLayer,
    animLayer: ui.animLayer,
    prepareFocusTarget: async () => {
      await renderFocused({ useSwipe: false, revealMode: false, deferCharts: true });
      ensureLayerVisibleForMeasure(ui.focusLayer);
      ui.focusLayer.style.visibility = 'hidden';
      ui.focusLayer.style.opacity = '0';
      await nextFrame();
      return getFocusedCardElement(ui);
    }
  });

  if (completed) {
    appState.mode = 'focused';
    setMode(ui, 'focused');
    updateUiChrome();
    await hydrateChartsWhenStable({ reason: 'zoom-into-completed' });
    scheduleSessionSave();
  }

  appState.transitionLock = false;
}

async function zoomOutToOverviewMode() {
  if (appState.transitionLock || appState.mode === 'overview' || appState.mode === 'compare' || !hasModules() || getIsZoomAnimating()) {
    return;
  }

  appState.transitionLock = true;
  destroySortable();

  const moduleId = appState.session.activeModuleId;

  const completed = await zoomOutToOverview({
    moduleId,
    overviewLayer: ui.overviewLayer,
    focusLayer: ui.focusLayer,
    animLayer: ui.animLayer,
    getFocusSource: () => getFocusedCardElement(ui),
    prepareOverviewTarget: async (activeModuleId) => {
      ensureLayerVisibleForMeasure(ui.overviewLayer);
      refreshOverview({ enableSortable: false });
      await nextFrame();
      return getOverviewCardElement(ui, activeModuleId)
        || ui.overviewGrid.querySelector('.overview-card');
    }
  });

  if (completed) {
    destroyAllCharts();
    appState.mode = 'overview';
    setMode(ui, 'overview');
    updateUiChrome();
    initSortable();
  }

  appState.transitionLock = false;
}

async function toggleOverview() {
  if (!hasModules() || appState.transitionLock || getIsZoomAnimating()) {
    return;
  }

  if (appState.mode === 'compare') {
    await exitCompareView({ preserveSelection: true });
    return;
  }

  if (appState.mode === 'overview') {
    const sourceCardEl = getOverviewCardElement(ui, appState.session.activeModuleId)
      || ui.overviewGrid.querySelector('.overview-card');
    await zoomIntoModuleFromOverview(appState.session.activeModuleId, sourceCardEl);
    return;
  }

  await zoomOutToOverviewMode();
}

async function createNewModule() {
  if (runtimeConfig.readOnly || appState.transitionLock || getIsZoomAnimating()) {
    return null;
  }

  const module = createBlankModule();
  appState.session.modules.push(module);
  appState.session.order.push(module.id);
  appState.session.activeModuleId = module.id;

  scheduleSessionSave();

  if (appState.mode === 'overview') {
    refreshOverview({ enableSortable: false });
    await nextFrame();
    const sourceCardEl = getOverviewCardElement(ui, module.id)
      || ui.overviewGrid.querySelector(`.overview-card[data-module-id="${module.id}"]`);
    await zoomIntoModuleFromOverview(module.id, sourceCardEl);
    return module.id;
  }

  appState.mode = 'focused';
  setMode(ui, 'focused');

  await renderFocused({
    useSwipe: true,
    direction: 'forward',
    revealMode: true
  });

  return module.id;
}

function mergeGeneratedPatch(module, generatedPatch) {
  ensureGenerated(module);

  if ('summaryHtml' in generatedPatch) {
    module.generated.summaryHtml = generatedPatch.summaryHtml;
  }

  if ('assumptions' in generatedPatch) {
    module.generated.assumptions = generatedPatch.assumptions;
  }

  if ('outputs' in generatedPatch) {
    module.generated.outputs = generatedPatch.outputs;
  }

  if ('pensionInputs' in generatedPatch) {
    module.generated.pensionInputs = generatedPatch.pensionInputs;
    if (generatedPatch.pensionInputs) {
      module.generated.mortgageInputs = null;
      module.generated.loanInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.education = null;
      module.generated.report = null;
    }
  }

  if ('collegeFundingInputs' in generatedPatch) {
    module.generated.collegeFundingInputs = generatedPatch.collegeFundingInputs;
    if (generatedPatch.collegeFundingInputs) {
      module.generated.pensionInputs = null;
      module.generated.mortgageInputs = null;
      module.generated.loanInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.education = null;
      module.generated.report = null;
    }
  }

  if ('netRetirementInputs' in generatedPatch) {
    module.generated.netRetirementInputs = generatedPatch.netRetirementInputs;
    if (generatedPatch.netRetirementInputs) {
      module.generated.pensionInputs = null;
      module.generated.mortgageInputs = null;
      module.generated.loanInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.education = null;
      module.generated.report = null;
    }
  }

  if ('mortgageInputs' in generatedPatch) {
    module.generated.mortgageInputs = generatedPatch.mortgageInputs;
    if (generatedPatch.mortgageInputs) {
      module.generated.pensionInputs = null;
      module.generated.loanInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.education = null;
      module.generated.report = null;
    }
  }

  if ('loanInputs' in generatedPatch) {
    module.generated.loanInputs = generatedPatch.loanInputs;
    if (generatedPatch.loanInputs) {
      module.generated.pensionInputs = null;
      module.generated.mortgageInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.education = null;
      module.generated.report = null;
    }
  }

  if ('education' in generatedPatch) {
    module.generated.education = generatedPatch.education;
    if (generatedPatch.education) {
      module.generated.pensionInputs = null;
      module.generated.mortgageInputs = null;
      module.generated.loanInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.report = null;
    }
  }

  if ('report' in generatedPatch) {
    module.generated.report = generatedPatch.report;
    if (generatedPatch.report) {
      module.generated.pensionInputs = null;
      module.generated.mortgageInputs = null;
      module.generated.loanInputs = null;
      module.generated.collegeFundingInputs = null;
      module.generated.netRetirementInputs = null;
      module.generated.education = null;
    }
  }

  if ('outputsBucketed' in generatedPatch) {
    module.generated.outputsBucketed = generatedPatch.outputsBucketed;

    if (isPersonalBalanceSheetModule(module)) {
      module.generated.outputs = {
        columns: [],
        rows: []
      };
    }
  }

  if ('tables' in generatedPatch) {
    module.generated.tables = generatedPatch.tables;
  }

  if ('pbsInputs' in generatedPatch) {
    module.generated.pbsInputs = generatedPatch.pbsInputs;
  }

  if ('charts' in generatedPatch) {
    module.generated.charts = generatedPatch.charts.map((chart, index) => ({
      ...chart,
      id: chart.id || makeChartId(module.id, chart.title, index)
    }));
  }
}

function cloneSessionValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function applyNormalizedPayloadToModule(module, normalizedPayload, { resetEditorState = true } = {}) {
  if ('title' in normalizedPayload) {
    module.title = normalizedPayload.title;
  }

  if (normalizedPayload.generated) {
    mergeGeneratedPatch(module, normalizedPayload.generated);

    const hasPensionInputsPatch = 'pensionInputs' in normalizedPayload.generated;
    const hasCollegeFundingInputsPatch = 'collegeFundingInputs' in normalizedPayload.generated;
    const hasNetRetirementInputsPatch = 'netRetirementInputs' in normalizedPayload.generated;
    const hasMortgageInputsPatch = 'mortgageInputs' in normalizedPayload.generated;
    const hasLoanInputsPatch = 'loanInputs' in normalizedPayload.generated;

    if (hasLoanInputsPatch && module.generated.loanInputs) {
      applyMortgageProjectionToModule(module, { updateSummary: true });
      if (resetEditorState) {
        resetAssumptionsEditorState(module.id);
      }
    } else if (hasMortgageInputsPatch && module.generated.mortgageInputs) {
      applyMortgageProjectionToModule(module, { updateSummary: true });
      if (resetEditorState) {
        resetAssumptionsEditorState(module.id);
      }
    } else if (hasPensionInputsPatch && module.generated.pensionInputs) {
      applyPensionProjectionToModule(module, { updateSummary: true });
      if (resetEditorState) {
        resetAssumptionsEditorState(module.id);
      }
    } else if (hasNetRetirementInputsPatch && module.generated.netRetirementInputs) {
      applyNetRetirementProjectionToModule(module);
      if (resetEditorState) {
        resetAssumptionsEditorState(module.id);
      }
    } else if (hasCollegeFundingInputsPatch && module.generated.collegeFundingInputs) {
      applyCollegeFundingProjectionToModule(module);
    }
  }
}

function preflightGeneratedPayload(normalizedPayload) {
  const scratchModule = createBlankModule();
  applyNormalizedPayloadToModule(scratchModule, normalizedPayload, { resetEditorState: false });
}

async function rerenderAfterPayloadRollback(previousMode) {
  ensureActiveModule(appState.session);

  if (!hasModules()) {
    appState.mode = 'greeting';
    await renderFocused({ useSwipe: false, revealMode: true });
    return;
  }

  if (previousMode === 'overview') {
    appState.mode = 'overview';
    setMode(ui, 'overview');
    refreshOverview({ enableSortable: true });
    updateUiChrome();
    return;
  }

  appState.mode = 'focused';
  setMode(ui, 'focused');
  await renderFocused({ useSwipe: false, revealMode: true });
}

async function applyModuleUpdateInternal(payload, options = {}) {
  if (runtimeConfig.readOnly) {
    throw new Error('This session is read only.');
  }

  const normalizedPayload = normalizePayload(payload);
  preflightGeneratedPayload(normalizedPayload);

  const previousSession = cloneSessionValue(appState.session);
  const previousMode = appState.mode;
  let targetModuleId = options.targetModuleId || normalizedPayload.moduleId || appState.session.activeModuleId;

  try {
    if (options.createNewModule) {
      if (appState.transitionLock || getIsZoomAnimating()) {
        throw new Error('Unable to create a new module while a transition is active.');
      }

      destroySortable();
      const module = createBlankModule();
      appState.session.modules.push(module);
      appState.session.order.push(module.id);
      appState.session.activeModuleId = module.id;
      targetModuleId = module.id;
    }

    if (!targetModuleId) {
      throw new Error('No active module found. Create a module first, or provide moduleId.');
    }

    const module = getModuleById(appState.session, targetModuleId);
    if (!module) {
      throw new Error(`Module not found: ${targetModuleId}`);
    }

    applyNormalizedPayloadToModule(module, normalizedPayload);

    module.updatedAt = nowIso();

    if (options.createNewModule) {
      appState.mode = 'focused';
      await renderFocused({ useSwipe: false, revealMode: true });
    } else if (appState.mode === 'focused') {
      await renderFocused({ useSwipe: false, revealMode: true });
    } else if (appState.mode === 'overview') {
      refreshOverview({ enableSortable: true });
    }

    markSessionDirty();
    saveSessionNow();

    const activeModule = getModuleById(appState.session, appState.session.activeModuleId);
    if (activeModule?.generated) {
      const hasOutputsBucketed = Boolean(
        activeModule.generated.outputsBucketed
        && typeof activeModule.generated.outputsBucketed === 'object'
        && !Array.isArray(activeModule.generated.outputsBucketed)
      );
      const hasOutputs = Boolean(
        activeModule.generated.outputs
        && Array.isArray(activeModule.generated.outputs.columns)
        && Array.isArray(activeModule.generated.outputs.rows)
      );

      console.info('[CallCanvas] applyModuleUpdate generated state', {
        moduleId: activeModule.id,
        hasOutputsBucketed,
        hasOutputs
      });
    }

    return {
      ok: true,
      moduleId: module.id
    };
  } catch (error) {
    appState.session = previousSession;
    await rerenderAfterPayloadRollback(previousMode);
    throw error;
  }
}

async function applyPayloadFromEditor({ createNewModuleFirst }) {
  if (!ui.devPayloadInput) {
    return;
  }

  let parsed;
  try {
    const normalizedInput = normalizeEditorJsonInput(ui.devPayloadInput.value || '{}');
    ui.devPayloadInput.value = normalizedInput;
    parsed = JSON.parse(normalizedInput || '{}');
  } catch (_error) {
    renderDevPayloadWarnings([], { errorMessage: 'Invalid JSON (check quotes)' });
    showToast('Invalid JSON (check quotes)', 'error');
    return;
  }

  const { payload: repairedPayload, warnings } = normalizeDevPanelPayload(parsed);
  renderDevPayloadWarnings(warnings);
  if (warnings.length > 0) {
    console.warn('[CallCanvas][DevPayload] auto-repairs applied', warnings);
  }

  try {
    await applyModuleUpdateInternal(repairedPayload, { createNewModule: createNewModuleFirst });
    renderDevPayloadWarnings(warnings);
    showToast(warnings.length > 0
      ? `Payload applied with ${warnings.length} auto-repair${warnings.length === 1 ? '' : 's'}.`
      : 'Payload applied successfully.');
  } catch (error) {
    renderDevPayloadWarnings(warnings, {
      errorMessage: error.message || 'Failed to apply payload.'
    });
    showToast(error.message || 'Failed to apply payload.', 'error');
  }
}

async function focusPreviousModule() {
  if (appState.transitionLock || appState.mode !== 'focused' || getIsZoomAnimating()) {
    return;
  }

  const activeIndex = getActiveIndex();
  if (activeIndex <= 0) {
    return;
  }

  appState.session.activeModuleId = appState.session.order[activeIndex - 1];
  scheduleSessionSave();

  await renderFocused({
    useSwipe: true,
    direction: 'backward',
    revealMode: true
  });
}

async function focusModuleById(moduleId) {
  if (appState.transitionLock || appState.mode !== 'focused' || getIsZoomAnimating() || !moduleId) {
    return;
  }

  const targetIndex = appState.session.order.indexOf(moduleId);
  const activeIndex = getActiveIndex();
  if (targetIndex < 0 || targetIndex === activeIndex) {
    return;
  }

  appState.session.activeModuleId = moduleId;
  scheduleSessionSave();

  await renderFocused({
    useSwipe: true,
    direction: targetIndex > activeIndex ? 'forward' : 'backward',
    revealMode: true
  });
}

async function focusNextModule() {
  if (appState.transitionLock || appState.mode !== 'focused' || getIsZoomAnimating()) {
    return;
  }

  const activeIndex = getActiveIndex();
  if (activeIndex < 0 || activeIndex >= appState.session.order.length - 1) {
    return;
  }

  appState.session.activeModuleId = appState.session.order[activeIndex + 1];
  scheduleSessionSave();

  await renderFocused({
    useSwipe: true,
    direction: 'forward',
    revealMode: true
  });
}

async function focusNextModuleOrCreate() {
  if (runtimeConfig.readOnly) {
    await focusNextModule();
    return;
  }

  if (appState.mode !== 'focused') {
    await createNewModule();
    return;
  }

  if (hasNextModule()) {
    await focusNextModule();
    return;
  }

  await createNewModule();
}

async function handleMobileModuleSelect(moduleId) {
  closeMobileModuleSheet({ restoreFocus: false });
  await focusModuleById(moduleId);
}

async function handleNewCall() {
  if (runtimeConfig.readOnly) {
    return;
  }

  const confirmed = window.confirm('Start a new call? Unsaved changes will be lost.');
  if (!confirmed) {
    return;
  }

  const fresh = newSession('Client');
  await replaceSession(fresh, { markClean: true });
  showToast('New call started.');
}

async function openClientAccessManager(options = {}) {
  const { closeOverflow = false, closePublish = false } = options;
  await ensureAdvisorAuthenticated('Sign in to open the Client Pipeline.');

  if (closeOverflow) {
    closeMobileOverflowSheet({ restoreFocus: false });
  }
  if (closePublish) {
    setPublishModalOpen(false);
  }

  window.location.href = new URL('./clients.html', window.location.href).toString();
}

async function openPublishedLinksManager(options = {}) {
  const { closePublish = false } = options;
  await ensureAdvisorAuthenticated('Sign in to open Published Links.');

  if (closePublish) {
    setPublishModalOpen(false);
  }

  window.location.href = new URL('./access.html', window.location.href).toString();
}

function bindEvents() {
  bindAdvisorAuthEvents();

  if (ui.clientNameInput && !runtimeConfig.readOnly) {
    ui.clientNameInput.addEventListener('input', (event) => {
      appState.session.clientName = normalizeClientName(event.target.value);
      renderGreeting(ui, appState.session.clientName);
      scheduleSessionSave();
    });
  }

  if (!runtimeConfig.readOnly && ui.newCallButton) {
    ui.newCallButton.addEventListener('click', async () => {
      await handleNewCall();
    });
  }

  if (!runtimeConfig.readOnly && runtimeConfig.allowPublish && ui.publishSessionButton) {
    ui.publishSessionButton.addEventListener('click', async () => {
      await ensureAdvisorAuthenticated('Sign in to publish secure client sessions and manage final emails.');
      setPublishError('');
      if (appState.publishedAccess) {
        renderPublishedAccess(appState.publishedAccess);
      } else {
        resetPublishResult({ clearAccess: false });
        applyClientPipelineContextToSession();
        setPublishMode(appState.pipelineContext?.clientId || appState.pipelineContext?.leadId ? 'email' : 'share');
      }
      setPublishModalOpen(true);
    });
  }

  if (ui.publishCloseButton) {
    ui.publishCloseButton.addEventListener('click', () => {
      setPublishModalOpen(false);
    });
  }

  if (ui.publishModal) {
    ui.publishModal.addEventListener('click', (event) => {
      if (event.target === ui.publishModal) {
        setPublishModalOpen(false);
      }
    });
  }

  if (ui.publishGenerateButton) {
    ui.publishGenerateButton.addEventListener('click', async () => {
      await handlePublishGenerate();
    });
  }

  [ui.publishModeShareInput, ui.publishModeEmailInput].forEach((input) => {
    if (!input) {
      return;
    }
    input.addEventListener('change', () => {
      syncPublishModeControls();
    });
  });

  if (ui.publishPinToggle) {
    ui.publishPinToggle.addEventListener('change', () => {
      syncPublishPinControls(appState.publishedAccess);
    });
  }

  if (ui.publishCopyPinButton) {
    ui.publishCopyPinButton.addEventListener('click', async () => {
      await handleCopyPublishedPin();
    });
  }

  if (ui.publishCopyLinkButton) {
    ui.publishCopyLinkButton.addEventListener('click', async () => {
      await handleCopyPublishedLink();
    });
  }

  if (ui.publishCopyAdvisorLinkButton) {
    ui.publishCopyAdvisorLinkButton.addEventListener('click', async () => {
      await handleCopyPublishedAdvisorLink();
    });
  }

  if (ui.publishCopyEmailButton) {
    ui.publishCopyEmailButton.addEventListener('click', async () => {
      await handleCopyPublishedEmailCopy();
    });
  }

  if (ui.publishSendEmailButton) {
    ui.publishSendEmailButton.addEventListener('click', async () => {
      await handleSendPublishedEmail();
    });
  }

  if (ui.publishUpdateExpiryButton) {
    ui.publishUpdateExpiryButton.addEventListener('click', async () => {
      await handleUpdatePublishedExpiry();
    });
  }

  if (ui.publishResetClientAccessButton) {
    ui.publishResetClientAccessButton.addEventListener('click', async () => {
      await handleResetPublishedClientAccess();
    });
  }

  if (ui.publishRevokeButton) {
    ui.publishRevokeButton.addEventListener('click', async () => {
      await handleRevokePublishedAccess();
    });
  }

  if (ui.publishClientEmailInput) {
    ui.publishClientEmailInput.addEventListener('input', () => {
      if (!appState.publishedAccess) {
        updatePublishActionState();
        return;
      }
      appState.publishedAccess.clientEmail = String(ui.publishClientEmailInput.value || '').trim().toLowerCase();
      if (ui.publishEmailStatus) {
        ui.publishEmailStatus.textContent = formatPublishedEmailStatus(appState.publishedAccess);
      }
      updatePublishActionState();
    });
  }

  if (!runtimeConfig.readOnly && ui.openClientAccessButton) {
    ui.openClientAccessButton.addEventListener('click', async () => {
      await openClientAccessManager();
    });
  }

  if (ui.publishOpenClientAccessButton) {
    ui.publishOpenClientAccessButton.addEventListener('click', async () => {
      await openPublishedLinksManager({ closePublish: true });
    });
  }

  if (!runtimeConfig.readOnly && ui.newModuleButton) {
    ui.newModuleButton.addEventListener('click', async () => {
      await createNewModule();
    });
  }

  if (ui.nextArrowButton) {
    ui.nextArrowButton.addEventListener('click', async () => {
      await focusNextModuleOrCreate();
    });
  }

  if (ui.prevArrowButton) {
    ui.prevArrowButton.addEventListener('click', async () => {
      await focusPreviousModule();
    });
  }

  if (ui.zoomButton) {
    ui.zoomButton.addEventListener('click', async () => {
      await toggleOverview();
    });
  }

  if (!runtimeConfig.readOnly && ui.resetButton) {
    ui.resetButton.addEventListener('click', () => {
      destroyAllCharts();
      stateManager.reset();
      window.location.reload();
    });
  }

  if (ui.mobileActionNewCallButton) {
    ui.mobileActionNewCallButton.addEventListener('click', () => {
      triggerDesktopAction(ui.newCallButton);
    });
  }

  if (ui.mobileActionNewModuleButton) {
    ui.mobileActionNewModuleButton.addEventListener('click', () => {
      triggerDesktopAction(ui.newModuleButton);
    });
  }

  if (ui.mobileActionZoomButton) {
    ui.mobileActionZoomButton.addEventListener('click', () => {
      triggerDesktopAction(ui.zoomButton);
    });
  }

  if (ui.mobileFocusModulesButton) {
    ui.mobileFocusModulesButton.addEventListener('click', () => {
      toggleMobileModuleSheet(ui.mobileFocusModulesButton);
    });
  }

  if (ui.mobileFocusPrevButton) {
    ui.mobileFocusPrevButton.addEventListener('click', async () => {
      await focusPreviousModule();
    });
  }

  if (ui.mobileFocusNextButton) {
    ui.mobileFocusNextButton.addEventListener('click', async () => {
      await focusNextModule();
    });
  }

  if (ui.mobileOverflowPublishButton) {
    ui.mobileOverflowPublishButton.addEventListener('click', () => {
      triggerDesktopAction(ui.publishSessionButton, { closeOverflow: true });
    });
  }

  if (ui.mobileOverflowNewModuleButton) {
    ui.mobileOverflowNewModuleButton.addEventListener('click', () => {
      triggerDesktopAction(ui.newModuleButton, { closeOverflow: true });
    });
  }

  if (ui.mobileOverflowClientAccessButton) {
    ui.mobileOverflowClientAccessButton.addEventListener('click', async () => {
      await openClientAccessManager({ closeOverflow: true });
    });
  }

  if (ui.mobileOverflowResetButton) {
    ui.mobileOverflowResetButton.addEventListener('click', () => {
      triggerDesktopAction(ui.resetButton, { closeOverflow: true });
    });
  }

  [ui.mobileHeaderMoreButton, ui.mobileActionMoreButton].forEach((button) => {
    if (!button) {
      return;
    }
    button.addEventListener('click', () => {
      toggleMobileOverflowSheet(button);
    });
  });

  if (ui.mobileOverflowBackdrop) {
    ui.mobileOverflowBackdrop.addEventListener('click', () => {
      closeMobileOverflowSheet();
    });
  }

  if (ui.mobileModuleCloseButton) {
    ui.mobileModuleCloseButton.addEventListener('click', () => {
      closeMobileModuleSheet();
    });
  }

  if (ui.mobileModuleBackdrop) {
    ui.mobileModuleBackdrop.addEventListener('click', () => {
      closeMobileModuleSheet();
    });
  }

  if (ui.mobileModulePanel) {
    ui.mobileModulePanel.addEventListener('touchstart', handleMobileModuleTouchStart, { passive: true });
    ui.mobileModulePanel.addEventListener('touchmove', handleMobileModuleTouchMove, { passive: true });
    ui.mobileModulePanel.addEventListener('touchend', handleMobileModuleTouchEnd, { passive: true });
    ui.mobileModulePanel.addEventListener('touchcancel', handleMobileModuleTouchEnd, { passive: true });
  }

  if (ui.mobileOverflowPanel) {
    ui.mobileOverflowPanel.addEventListener('touchstart', handleMobileOverflowTouchStart, { passive: true });
    ui.mobileOverflowPanel.addEventListener('touchmove', handleMobileOverflowTouchMove, { passive: true });
    ui.mobileOverflowPanel.addEventListener('touchend', handleMobileOverflowTouchEnd, { passive: true });
    ui.mobileOverflowPanel.addEventListener('touchcancel', handleMobileOverflowTouchEnd, { passive: true });
  }

  if (runtimeConfig.allowDevPanel && ui.devLoadExampleBtn) {
    ui.devLoadExampleBtn.addEventListener('click', () => {
      loadSelectedExampleIntoEditor();
    });
  }

  if (runtimeConfig.allowDevPanel && ui.devClearBtn) {
    ui.devClearBtn.addEventListener('click', () => {
      if (ui.devPayloadInput) {
        ui.devPayloadInput.value = '';
      }
      renderDevPayloadWarnings([]);
    });
  }

  if (runtimeConfig.allowDevPanel && ui.devApplyBtn) {
    ui.devApplyBtn.addEventListener('click', async () => {
      await applyPayloadFromEditor({ createNewModuleFirst: false });
    });
  }

  if (runtimeConfig.allowDevPanel && ui.devCreateApplyBtn) {
    ui.devCreateApplyBtn.addEventListener('click', async () => {
      await applyPayloadFromEditor({ createNewModuleFirst: true });
    });
  }

  if (runtimeConfig.allowDevPanel && ui.devCloseBtn) {
    ui.devCloseBtn.addEventListener('click', () => {
      setDevPanelOpen(false);
    });
  }

  window.addEventListener('resize', () => {
    cleanupDetachedCharts();
    if (appState.mode === 'overview') {
      refreshOverview({ enableSortable: true });
    }
    if (!isMobileLayoutActive()) {
      closeMobileModuleSheet({ restoreFocus: false });
      closeMobileOverflowSheet({ restoreFocus: false });
    }
    syncMobileActionState();
    syncMobileFocusedNavState();
  });

  window.addEventListener('callcanvas:pbs-scenario-charts-updated', async () => {
    await hydrateChartsWhenStable({ reason: 'pbs-scenario-change' });
  });

  if (ui.swipeStage) {
    ui.swipeStage.addEventListener('click', (event) => {
      handleTableCellHighlightClick(event);
    });
  }

  window.addEventListener('keydown', async (event) => {
    setOverviewMultiSelectArmed(isMultiSelectModifier(event));

    const target = event.target;
    const typing = target instanceof HTMLElement && (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    );

    const key = event.key;
    const lower = key.toLowerCase();
    const hasDeleteConfirmOpen = Boolean(document.querySelector('.delete-confirm-backdrop'));

    if (key === 'Escape' && isMobileModuleSheetOpen()) {
      event.preventDefault();
      closeMobileModuleSheet();
      return;
    }

    if (key === 'Escape' && isMobileOverflowOpen()) {
      event.preventDefault();
      closeMobileOverflowSheet();
      return;
    }

    if (hasDeleteConfirmOpen) {
      if (key === 'Escape') {
        event.preventDefault();
      }
      return;
    }

    if (!typing && runtimeConfig.allowDevPanel && appState.mode !== 'compare' && lower === 'd') {
      event.preventDefault();
      setDevPanelOpen(!appState.devPanelOpen);
      return;
    }

    if (typing && key !== 'Escape') {
      return;
    }

    if (lower === 'n') {
      if (appState.mode === 'compare') {
        return;
      }
      if (runtimeConfig.readOnly) {
        return;
      }
      event.preventDefault();
      await createNewModule();
      return;
    }

    if (lower === 'o') {
      event.preventDefault();
      await toggleOverview();
      return;
    }

    if (key === 'ArrowRight') {
      if (appState.mode === 'compare') {
        return;
      }
      event.preventDefault();
      if (appState.mode === 'focused') {
        await focusNextModuleOrCreate();
      } else {
        if (!runtimeConfig.readOnly) {
          await createNewModule();
        }
      }
      return;
    }

    if (key === 'ArrowLeft') {
      if (appState.mode === 'compare') {
        return;
      }
      event.preventDefault();
      await focusPreviousModule();
      return;
    }

    if (key === 'Escape' && ui.publishModal && !ui.publishModal.classList.contains('is-hidden')) {
      event.preventDefault();
      setPublishModalOpen(false);
      return;
    }

    if (runtimeConfig.allowDevPanel && key === 'Escape' && appState.devPanelOpen) {
      event.preventDefault();
      setDevPanelOpen(false);
      return;
    }

    if (key === 'Escape' && appState.mode === 'compare') {
      event.preventDefault();
      await exitCompareView({ preserveSelection: true });
      return;
    }

    if (key === 'Escape' && appState.mode === 'focused' && !typing) {
      const cleared = clearModuleTableHighlights(appState.session.activeModuleId);
      if (cleared) {
        event.preventDefault();
        return;
      }
    }

    if (key === 'Enter' && appState.mode === 'overview') {
      if (getSelectedPair()) {
        event.preventDefault();
        await runCompareFromSelection();
      }
      return;
    }

    if (key === 'Escape' && appState.mode === 'overview') {
      if (appState.overviewSelection.length > 0) {
        event.preventDefault();
        deselectAllInOverview();
      }
    }
  });

  window.addEventListener('keyup', (event) => {
    setOverviewMultiSelectArmed(isMultiSelectModifier(event));
  });

  window.addEventListener('blur', () => {
    setOverviewMultiSelectArmed(false);
  });

  syncMobileActionState();

  window.addEventListener('beforeunload', () => {
    saveSessionNow();
  });
}

function applyRuntimeOptions(options = {}) {
  runtimeConfig.readOnly = Boolean(options.readOnly);
  runtimeConfig.allowDevPanel = !runtimeConfig.readOnly && options.allowDevPanel !== false;
  runtimeConfig.allowPublish = !runtimeConfig.readOnly && options.allowPublish !== false;
  runtimeConfig.showPensionToggle = !runtimeConfig.readOnly && options.showPensionToggle !== false;
  runtimeConfig.persistLocalSession = !runtimeConfig.readOnly && options.persistLocalSession !== false;
}

let initPromise = null;

export async function initApp(options = {}) {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    applyRuntimeOptions(options);
    const workerMissing = !WORKER_BASE_URL;
    let startupPublishedAccess = null;
    let startupNotice = '';
    appState.pipelineContext = getClientPipelineContextFromLocation();
    const startFreshFromPipeline = appState.pipelineContext
      && new URLSearchParams(window.location.search).get('fresh') === '1';

    if (!runtimeConfig.readOnly && runtimeConfig.allowPublish && workerMissing) {
      runtimeConfig.allowPublish = false;
    }

    bindAdvisorAuthEvents();
    updateAdvisorAuthChrome();

    if (!runtimeConfig.readOnly && !workerMissing) {
      try {
        await syncAdvisorAuthState();
      } catch (_error) {
        updateAdvisorAuthChrome();
      }

      if (options.requireAdvisorAuthOnStart === true) {
        await ensureAdvisorAuthenticated(options.advisorAuthStartMessage || 'Sign in to open the advisor workspace.');
        if (options.returnHomeAfterAdvisorAuthOnStart === true) {
          window.location.replace(new URL('../', window.location.href).toString());
          return;
        }
      }
    }

    document.body?.classList.remove('advisor-gate-pending');

    if ('initialSession' in options && options.initialSession != null) {
      appState.session = importSession(options.initialSession);
      appState.publishedAccess = null;
    } else {
      appState.publishedAccess = null;

      if (!runtimeConfig.readOnly && !workerMissing) {
        try {
          const publishedBootstrap = await maybeLoadPublishedSessionFromLocation();
          if (publishedBootstrap?.session) {
            appState.session = publishedBootstrap.session;
            startupPublishedAccess = publishedBootstrap.access;
            startupNotice = 'Opened published snapshot.';
          } else {
            if (publishedBootstrap?.error) {
              const recovery = await resolvePublishedStartupRecovery(publishedBootstrap.error);
              startupNotice = recovery.notice;
              appState.session = recovery.session;
              startupPublishedAccess = recovery.access;
            } else {
              appState.session = startFreshFromPipeline
                ? newSession(appState.pipelineContext?.clientName || 'Client')
                : loadSession();
            }
          }
        } catch (error) {
          const recovery = await resolvePublishedStartupRecovery(error?.message || 'Could not reopen published session.');
          startupNotice = recovery.notice;
          appState.session = recovery.session;
          startupPublishedAccess = recovery.access;
        }
      } else {
        appState.session = startFreshFromPipeline
          ? newSession(appState.pipelineContext?.clientName || 'Client')
          : loadSession();
      }
    }

    applyClientPipelineContextToSession();
    ensureActiveModule(appState.session);
    appState.publishedAccess = startupPublishedAccess;
    const startInOverview = hasModules() && (
      options.startInOverview === true
      || getLocationViewMode() === 'overview'
      || Boolean(startupPublishedAccess)
    );
    appState.mode = hasModules() ? (startInOverview ? 'overview' : 'focused') : 'greeting';

    applyRuntimeChrome();
    resetPublishResult({ clearAccess: false });
    applyClientPipelineContextToSession();
    bindEvents();
    if (appState.publishedAccess) {
      renderPublishedAccess(appState.publishedAccess);
    }

    if (runtimeConfig.allowDevPanel) {
      populateDevExamples();
      loadSelectedExampleIntoEditor();
      runDevEducationSvgAssertions();
    } else {
      renderDevPayloadWarnings([]);
    }

    renderGreeting(ui, appState.session.clientName);
    syncPublishPinControls();
    if (!runtimeConfig.readOnly && workerMissing) {
      showToast('Publishing is disabled: worker URL is not configured for this environment.', 'error');
    }
    if (startupNotice) {
      showToast(startupNotice, startupPublishedAccess ? 'success' : 'error');
    }
    if (runtimeConfig.readOnly && ui.sessionStatus) {
      ui.sessionStatus.textContent = 'Read only';
      ui.sessionStatus.classList.remove('is-dirty');
    } else {
      updateSessionStatus(ui, stateManager.isDirty());
    }

    window.applyModuleUpdate = async (payload) => {
      if (runtimeConfig.readOnly) {
        throw new Error('This session is read only.');
      }

      const { payload: repairedPayload, warnings } = normalizeDevPanelPayload(payload);
      if (warnings.length > 0) {
        console.warn('[CallCanvas][applyModuleUpdate] auto-repairs applied', warnings);
      }
      return applyModuleUpdateInternal(repairedPayload, {});
    };
    window.__setPensionShowMax = (moduleId, value) => {
      setPensionShowMaxForModule(moduleId, value);
    };
    window.__getPensionShowMaxForModule = (moduleId) => getPensionShowMaxForModule(moduleId);
    window.__setPensionScenario = (moduleId, scenarioId) => {
      void setPensionScenarioForModule(moduleId, scenarioId);
    };
    window.__getPensionScenarioForModule = (moduleId) => getPensionScenarioForModule(moduleId);
    window.__setNetRetirementScenario = (moduleId, scenarioId) => {
      void setNetRetirementScenarioForModule(moduleId, scenarioId);
    };
    window.__getNetRetirementScenarioForModule = (moduleId) => getNetRetirementScenarioForModule(moduleId);
    window.__runMortgageMathTests = () => runMortgageMathTests();
    window.__runPensionMathTests = () => runPensionMathTests();
    window.__runCollegeFundingMathTests = () => runCollegeFundingMathTests();
    window.__runNetRetirementMathTests = () => runNetRetirementMathTests();

    if (appState.mode === 'focused') {
      await renderFocused({ useSwipe: false, revealMode: true });
    } else if (appState.mode === 'overview') {
      setMode(ui, 'overview');
      refreshOverview({ enableSortable: !runtimeConfig.readOnly });
      updateUiChrome();
    } else {
      setMode(ui, 'greeting');
      updateUiChrome();
    }
  })();

  return initPromise;
}

if (window.__CALL_CANVAS_AUTO_INIT__ !== false) {
  void initApp();
}
