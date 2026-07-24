/*
 * Call Analytics dashboard (M1 Overview).
 *
 * Advisor-gated, read-only. It talks ONLY to the Worker backend-for-frontend
 * (/api/advisor/analytics/*), which holds the least-privilege learning-signals
 * `read` key server-side; the browser never sees that key nor reaches the
 * telemetry service directly. Every number shown is a derived aggregate or a
 * categorical count — no PII, no transcripts, no raw payloads.
 */

function getMetaContent(name) {
  const element = document.querySelector(`meta[name="${name}"]`);
  return element?.getAttribute('content')?.trim() || '';
}

const WORKER_BASE_URL = (() => {
  const override = getMetaContent('call-canvas-worker-base-url');
  return override ? override.replace(/\/+$/, '') : '';
})();

const ui = {
  authStatus: document.getElementById('advisorAuthStatus'),
  logoutBtn: document.getElementById('advisorLogoutBtn'),
  authLayer: document.getElementById('advisorAuthLayer'),
  authPassword: document.getElementById('advisorAuthPasswordInput'),
  authLoginBtn: document.getElementById('advisorAuthLoginBtn'),
  authError: document.getElementById('advisorAuthError'),
  shell: document.getElementById('analyticsShell'),
  errorBanner: document.getElementById('errorBanner'),
  freshness: document.getElementById('freshness'),
  refreshBtn: document.getElementById('refreshBtn'),
  rangeButtons: Array.from(document.querySelectorAll('.range-btn')),
  healthDial: document.getElementById('healthDial'),
  kpiStarted: document.getElementById('kpiStarted'),
  kpiGrowth: document.getElementById('kpiGrowth'),
  kpiConnect: document.getElementById('kpiConnect'),
  kpiConnectCap: document.getElementById('kpiConnectCap'),
  kpiClean: document.getElementById('kpiClean'),
  kpiDrop: document.getElementById('kpiDrop'),
  kpiDropCap: document.getElementById('kpiDropCap'),
  kpiDuration: document.getElementById('kpiDuration'),
  kpiSubjects: document.getElementById('kpiSubjects'),
  subjectCaveat: document.getElementById('subjectCaveat'),
  alertStack: document.getElementById('alertStack'),
  trendCanvas: document.getElementById('trendChart'),
  outcomeCanvas: document.getElementById('outcomeChart')
};

const advisorAuthState = {
  enabled: false,
  authenticated: false,
  csrfToken: '',
  expiresAt: null
};

const state = {
  rangeDays: 30,
  loading: false,
  requestId: 0
};

const charts = { trend: null, outcome: null };

const CHART_TEXT = '#a9b5bd';
const CHART_GRID = 'rgba(190, 202, 207, 0.10)';
const PALETTE = {
  blue: '#6aa7c8',
  green: '#66b89e',
  amber: '#d4a64f',
  red: '#c96f62',
  muted: '#9aa9b8'
};

const ALERT_LABELS = {
  completion_rate_below_threshold: 'Completion rate below target',
  connection_success_below_threshold: 'Connection success below target',
  drop_rate_above_threshold: 'Technical drop rate above target',
  cost_per_session_drift: 'Cost per session drifting up',
  reconciliation_divergence: 'Telemetry reconciliation divergence'
};

/* ---------------------------------------------------------------- auth ---- */

function buildAdvisorRequestInit(init = {}, options = {}) {
  const headers = new Headers(init.headers || {});
  if (options.includeCsrf && advisorAuthState.csrfToken) {
    headers.set('X-Advisor-CSRF', advisorAuthState.csrfToken);
  }
  return { ...init, headers, credentials: 'include' };
}

function setAuthVisible(visible) {
  ui.authLayer?.classList.toggle('is-hidden', !visible);
  ui.authLayer?.setAttribute('aria-hidden', visible ? 'false' : 'true');
  if (visible) {
    window.setTimeout(() => ui.authPassword?.focus(), 40);
  }
}

function setAuthError(message) {
  if (ui.authError) ui.authError.textContent = String(message || '');
}

function updateAuthChrome() {
  if (ui.authStatus) {
    ui.authStatus.textContent = !advisorAuthState.enabled
      ? 'Advisor auth disabled'
      : advisorAuthState.authenticated
        ? 'Advisor signed in'
        : 'Advisor sign-in required';
  }
  ui.logoutBtn?.classList.toggle('is-hidden', !(advisorAuthState.enabled && advisorAuthState.authenticated));
  document.body.classList.toggle('is-auth-locked', advisorAuthState.enabled && !advisorAuthState.authenticated);
}

async function syncAuthState() {
  if (!WORKER_BASE_URL) throw new Error('Worker URL is not configured for this environment.');
  const response = await fetch(`${WORKER_BASE_URL}/api/auth/session`, buildAdvisorRequestInit({
    method: 'GET',
    cache: 'no-store'
  }));
  if (!response.ok) throw new Error(`Unable to check advisor session (${response.status}).`);
  const payload = await response.json();
  advisorAuthState.enabled = payload?.authEnabled === true;
  advisorAuthState.authenticated = payload?.authenticated === true;
  advisorAuthState.csrfToken = advisorAuthState.authenticated ? String(payload?.csrfToken || '') : '';
  advisorAuthState.expiresAt = advisorAuthState.authenticated ? String(payload?.expiresAt || '') : null;
  updateAuthChrome();
}

async function handleLogin() {
  const password = String(ui.authPassword?.value || '');
  if (!password.trim()) {
    setAuthError('Enter the advisor password.');
    return;
  }
  if (ui.authLoginBtn) {
    ui.authLoginBtn.disabled = true;
    ui.authLoginBtn.textContent = 'Signing In…';
  }
  setAuthError('');
  try {
    const response = await fetch(`${WORKER_BASE_URL}/api/auth/login`, buildAdvisorRequestInit({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    }));
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || `Sign-in failed (${response.status}).`);

    advisorAuthState.enabled = payload?.authEnabled === true;
    advisorAuthState.authenticated = payload?.authenticated === true;
    advisorAuthState.csrfToken = String(payload?.csrfToken || '');
    advisorAuthState.expiresAt = String(payload?.expiresAt || '');
    updateAuthChrome();
    if (ui.authPassword) ui.authPassword.value = '';
    setAuthVisible(false);
    await loadDashboard();
  } catch (error) {
    setAuthError(error?.message || 'Could not sign in.');
  } finally {
    if (ui.authLoginBtn) {
      ui.authLoginBtn.disabled = false;
      ui.authLoginBtn.textContent = 'Sign In';
    }
  }
}

async function handleLogout() {
  try {
    await fetch(`${WORKER_BASE_URL}/api/auth/logout`, buildAdvisorRequestInit({ method: 'POST' }, { includeCsrf: true }));
  } catch (_error) {
    /* best effort */
  }
  advisorAuthState.authenticated = false;
  advisorAuthState.csrfToken = '';
  updateAuthChrome();
  window.location.replace(new URL('../', window.location.href).toString());
}

// Fetches an advisor-gated endpoint; on an auth failure it re-opens the login
// dialog rather than showing a broken dashboard.
async function fetchWithAdvisorAuth(url) {
  const response = await fetch(url, buildAdvisorRequestInit({ method: 'GET', cache: 'no-store' }));
  if ((response.status === 401 || response.status === 403) && advisorAuthState.enabled) {
    advisorAuthState.authenticated = false;
    advisorAuthState.csrfToken = '';
    updateAuthChrome();
    setAuthVisible(true);
    throw new Error('Sign in to view analytics.');
  }
  return response;
}

/* ------------------------------------------------------------ formatting -- */

function formatInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-IE') : '--';
}

function formatPct(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? '—'
    : `${(Number(value) * 100).toFixed(1)}%`;
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const totalSeconds = Math.round(n / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function utcDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

function rangeParams() {
  const to = utcDate(0);
  const from = utcDate(-(state.rangeDays - 1));
  return { from, to };
}

function eachDate(from, to) {
  const dates = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/* -------------------------------------------------------------- render ---- */

function setHealth(overview) {
  const rates = overview?.rates || {};
  const started = overview?.totals?.started || 0;
  const dial = ui.healthDial;
  if (!dial) return;

  if (started === 0 || rates.connection_success === null || rates.clean_completion === null) {
    dial.textContent = '—';
    dial.style.setProperty('--pct', '0');
    dial.style.setProperty('--dial', PALETTE.muted);
    return;
  }
  const reliability = rates.technical_drop === null ? 1 : 1 - rates.technical_drop;
  const score = Math.round(
    100 * (0.4 * rates.connection_success + 0.4 * rates.clean_completion + 0.2 * reliability)
  );
  const clamped = Math.max(0, Math.min(100, score));
  dial.textContent = String(clamped);
  dial.style.setProperty('--pct', String(clamped));
  dial.style.setProperty('--dial', clamped >= 80 ? PALETTE.green : clamped >= 60 ? PALETTE.amber : PALETTE.red);
}

function computeGrowth(series, to) {
  if (state.rangeDays < 14) return '';
  const byDate = new Map(series.map((row) => [row.date, row.started]));
  const sumWindow = (endOffset) => {
    let total = 0;
    for (let i = 0; i < 7; i += 1) {
      total += byDate.get(utcDateFrom(to, -(endOffset + i))) || 0;
    }
    return total;
  };
  const last7 = sumWindow(0);
  const prior7 = sumWindow(7);
  if (prior7 === 0) return last7 > 0 ? 'new activity' : '';
  const pct = ((last7 - prior7) / prior7) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(0)}% vs prior 7d`;
}

function utcDateFrom(anchor, offsetDays) {
  const d = new Date(`${anchor}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function renderKpis(overview, timeseries) {
  const totals = overview?.totals || {};
  const rates = overview?.rates || {};
  const engagement = overview?.engagement || {};
  const empty = (totals.started || 0) === 0;

  ui.kpiStarted.textContent = formatInt(totals.started);
  const growth = empty ? '' : computeGrowth(timeseries?.series || [], (overview?.range?.to) || utcDate(0));
  ui.kpiGrowth.innerHTML = growth || '&nbsp;';
  ui.kpiGrowth.className = 'kpi-cap' + (growth.startsWith('+') ? ' up' : growth.startsWith('-') ? ' down' : '');

  ui.kpiConnect.textContent = empty ? '—' : formatPct(rates.connection_success);
  ui.kpiConnectCap.textContent = empty ? 'no calls yet' : `${formatInt(totals.connected)} of ${formatInt(totals.started)} connected`;

  ui.kpiClean.textContent = empty ? '—' : formatPct(rates.clean_completion);
  ui.kpiDrop.textContent = empty ? '—' : formatPct(rates.technical_drop);
  ui.kpiDropCap.textContent = empty ? 'of connected calls' : `${formatInt(totals.dropped_technical)} of ${formatInt(totals.connected)} connected`;

  ui.kpiDuration.textContent = formatDuration(engagement.median_duration_ms);
  ui.kpiSubjects.textContent = formatInt(totals.distinct_subjects);
  if (ui.subjectCaveat) ui.subjectCaveat.hidden = empty;
}

function renderAlerts(alerts) {
  if (!ui.alertStack) return;
  ui.alertStack.innerHTML = '';
  const rows = Array.isArray(alerts) ? alerts : [];
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'alert-empty';
    empty.textContent = 'No alerts — all thresholds met in this range.';
    ui.alertStack.appendChild(empty);
    return;
  }
  for (const alert of rows) {
    const severity = alert.severity === 'critical' ? 'critical' : 'warning';
    const row = document.createElement('div');
    row.className = `alert-row ${severity}`;

    const sev = document.createElement('span');
    sev.className = 'alert-sev';
    sev.textContent = severity;

    const label = document.createElement('span');
    const name = ALERT_LABELS[alert.alert_type] || alert.alert_type;
    const observed = alert.observed_value;
    const threshold = alert.threshold_value;
    label.textContent = Number.isFinite(observed) && Number.isFinite(threshold)
      ? `${name} — observed ${formatMetricValue(alert.alert_type, observed)}, target ${formatMetricValue(alert.alert_type, threshold)}`
      : name;

    const date = document.createElement('span');
    date.className = 'alert-date';
    date.textContent = alert.metric_date || '';

    row.append(sev, label, date);
    ui.alertStack.appendChild(row);
  }
}

function formatMetricValue(alertType, value) {
  if (alertType === 'cost_per_session_drift') return String(Math.round(value));
  // The remaining alert types are all rates.
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function baseChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: CHART_TEXT, boxWidth: 12, font: { size: 11 } } },
      tooltip: { intersect: false, mode: 'index' }
    },
    scales: {
      x: { ticks: { color: CHART_TEXT, maxRotation: 0, autoSkip: true, font: { size: 10 } }, grid: { color: CHART_GRID } },
      y: { beginAtZero: true, ticks: { color: CHART_TEXT, precision: 0, font: { size: 10 } }, grid: { color: CHART_GRID } }
    }
  };
}

function renderTrend(timeseries, range) {
  if (!ui.trendCanvas || typeof window.Chart === 'undefined') return;
  const dates = eachDate(range.from, range.to);
  const byDate = new Map((timeseries?.series || []).map((row) => [row.date, row]));
  const pick = (key) => dates.map((d) => (byDate.get(d)?.[key]) || 0);
  const labels = dates.map((d) => d.slice(5)); // MM-DD

  charts.trend?.destroy();
  charts.trend = new window.Chart(ui.trendCanvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Started', data: pick('started'), borderColor: PALETTE.blue, backgroundColor: 'rgba(106,167,200,0.14)', borderWidth: 2, tension: 0.25, pointRadius: 0, fill: true },
        { label: 'Connected', data: pick('connected'), borderColor: PALETTE.green, borderWidth: 2, tension: 0.25, pointRadius: 0 },
        { label: 'Completed', data: pick('completed'), borderColor: PALETTE.muted, borderWidth: 2, borderDash: [5, 4], tension: 0.25, pointRadius: 0 }
      ]
    },
    options: baseChartOptions()
  });
}

function renderOutcome(overview) {
  if (!ui.outcomeCanvas || typeof window.Chart === 'undefined') return;
  const outcome = overview?.totals?.outcome || { completed: 0, abandoned: 0, failed: 0 };
  const values = [outcome.completed || 0, outcome.abandoned || 0, outcome.failed || 0];
  charts.outcome?.destroy();
  charts.outcome = new window.Chart(ui.outcomeCanvas, {
    type: 'doughnut',
    data: {
      labels: ['Completed', 'Abandoned', 'Failed'],
      datasets: [{
        data: values,
        backgroundColor: [PALETTE.green, PALETTE.amber, PALETTE.red],
        borderColor: 'rgba(10,16,20,0.9)',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: { legend: { position: 'bottom', labels: { color: CHART_TEXT, boxWidth: 12, font: { size: 11 } } } }
    }
  });
}

function setFreshness(range) {
  if (!ui.freshness) return;
  ui.freshness.innerHTML = '';
  const through = document.createElement('span');
  through.textContent = `Data through ${range?.to || rangeParams().to} (UTC)`;
  ui.freshness.appendChild(through);
  if (range?.includes_partial_today) {
    const pill = document.createElement('span');
    pill.className = 'partial';
    pill.textContent = 'Today partial';
    ui.freshness.appendChild(pill);
  }
}

function showError(message) {
  if (!ui.errorBanner) return;
  ui.errorBanner.textContent = message;
  ui.errorBanner.hidden = !message;
}

/* -------------------------------------------------------------- loading --- */

async function loadDashboard() {
  if (!advisorAuthState.enabled && WORKER_BASE_URL === '') return;
  const requestId = ++state.requestId;
  state.loading = true;
  ui.shell?.classList.add('is-loading');
  showError('');

  const { from, to } = rangeParams();
  const q = `?from=${from}&to=${to}`;
  try {
    const [overviewRes, seriesRes, alertsRes] = await Promise.all([
      fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/advisor/analytics/overview${q}`),
      fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/advisor/analytics/timeseries${q}`),
      fetchWithAdvisorAuth(`${WORKER_BASE_URL}/api/advisor/analytics/alerts${q}`)
    ]);
    if (requestId !== state.requestId) return;

    for (const res of [overviewRes, seriesRes, alertsRes]) {
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error || `Analytics request failed (${res.status}).`);
      }
    }
    const overview = await overviewRes.json();
    const timeseries = await seriesRes.json();
    const alertsPayload = await alertsRes.json();
    if (requestId !== state.requestId) return;

    setFreshness(overview.range);
    setHealth(overview);
    renderKpis(overview, timeseries);
    renderAlerts(alertsPayload.alerts);
    renderTrend(timeseries, overview.range || { from, to });
    renderOutcome(overview);
  } catch (error) {
    if (requestId !== state.requestId) return;
    if (advisorAuthState.enabled && !advisorAuthState.authenticated) return; // login dialog is showing
    const message = error instanceof TypeError
      ? 'Could not reach the analytics service. Check your connection and press Refresh.'
      : (error?.message || 'Analytics is temporarily unavailable. Try Refresh.');
    showError(message);
  } finally {
    if (requestId === state.requestId) {
      state.loading = false;
      ui.shell?.classList.remove('is-loading');
    }
  }
}

/* ---------------------------------------------------------------- events -- */

function selectRange(days) {
  state.rangeDays = days;
  for (const button of ui.rangeButtons) {
    const isActive = Number(button.dataset.range) === days;
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  }
  void loadDashboard();
}

function bindEvents() {
  for (const button of ui.rangeButtons) {
    button.addEventListener('click', () => selectRange(Number(button.dataset.range)));
  }
  ui.refreshBtn?.addEventListener('click', () => void loadDashboard());
  ui.authLoginBtn?.addEventListener('click', () => void handleLogin());
  ui.authPassword?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleLogin();
    }
  });
  ui.logoutBtn?.addEventListener('click', () => void handleLogout());
}

async function init() {
  bindEvents();
  try {
    await syncAuthState();
    if (advisorAuthState.enabled && !advisorAuthState.authenticated) {
      setAuthVisible(true);
      return;
    }
    await loadDashboard();
  } catch (error) {
    showError(error?.message || 'Could not start the analytics dashboard.');
  }
}

void init();
