window.__CALL_CANVAS_AUTO_INIT__ = false;

function getMetaContent(name) {
  const element = document.querySelector(`meta[name="${name}"]`);
  return element?.getAttribute('content')?.trim() || '';
}

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

function getHashParams() {
  return new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
}

function hasAdvisorEntryIntent() {
  const params = new URLSearchParams(window.location.search);
  const hashParams = getHashParams();
  return params.has('advisor')
    || params.has('login')
    || (params.has('pub') && hashParams.has('ak'));
}

function shouldReturnHomeAfterAdvisorLogin() {
  const params = new URLSearchParams(window.location.search);
  return params.get('return') === 'home';
}

function redirectToRequestForm() {
  const target = new URL('../', window.location.href);
  target.searchParams.set('app', 'advisor-required');
  target.hash = 'request-call';
  window.location.replace(target.toString());
}

async function fetchAdvisorSession() {
  if (!WORKER_BASE_URL) {
    return null;
  }

  const response = await fetch(`${WORKER_BASE_URL}/api/auth/session`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'include'
  });
  if (!response.ok) {
    throw new Error(`Unable to check advisor session (${response.status}).`);
  }

  return response.json();
}

async function startAdvisorApp(options = {}) {
  const { initApp } = await import('./app.js');
  await initApp(options);
}

async function boot() {
  const advisorIntent = hasAdvisorEntryIntent();
  const returnHomeAfterLogin = shouldReturnHomeAfterAdvisorLogin();

  if (!WORKER_BASE_URL) {
    if (!advisorIntent) {
      redirectToRequestForm();
      return;
    }

    document.body?.classList.remove('advisor-gate-pending');
    await startAdvisorApp();
    return;
  }

  let session = null;
  try {
    session = await fetchAdvisorSession();
  } catch (_error) {
    if (!advisorIntent) {
      redirectToRequestForm();
      return;
    }
  }

  if (session?.authEnabled === true && session.authenticated === true) {
    if (returnHomeAfterLogin) {
      window.location.replace(new URL('../', window.location.href).toString());
      return;
    }

    document.body?.classList.remove('advisor-gate-pending');
    await startAdvisorApp();
    return;
  }

  if (advisorIntent) {
    await startAdvisorApp({
      requireAdvisorAuthOnStart: true,
      advisorAuthStartMessage: 'Sign in to open the advisor workspace.',
      returnHomeAfterAdvisorAuthOnStart: returnHomeAfterLogin
    });
    return;
  }

  redirectToRequestForm();
}

void boot();
