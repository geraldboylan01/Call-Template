import { createSuccessTakeover } from './success_takeover.js';

const WORKER_BASE_URL = (() => {
  const override = typeof window.__WORKER_BASE_URL === 'string'
    ? window.__WORKER_BASE_URL.trim()
    : '';

  if (override) {
    return override.replace(/\/+$/, '');
  }

  if (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') {
    return 'http://127.0.0.1:8787';
  }

  return '';
})();

const navToggle = document.getElementById('mobileNavToggle');
const siteNav = document.getElementById('siteNav');
const siteHeader = document.querySelector('.site-header');
const leadForm = document.getElementById('leadForm');
const leadFormStatus = document.getElementById('leadFormStatus');
const leadSubmitButton = document.getElementById('leadSubmitButton');
const leadSuccessOverlay = document.getElementById('leadSuccessOverlay');
const leadSuccessGhost = document.getElementById('leadSuccessGhost');
const leadSuccessTarget = document.getElementById('leadSuccessTarget');
const leadSuccessTitle = document.querySelector('#leadSuccessCopy .lead-success-title');
const leadSuccessBody = document.querySelector('#leadSuccessCopy .lead-success-body');
const leadSuccessOrigin = document.querySelector('.site-brand-logo-wrap');
const advisorAppLinks = [...document.querySelectorAll('[data-advisor-app-link]')];
const advisorGateNotice = document.getElementById('advisorGateNotice');
const leadSuccessLockTargets = [
  siteHeader,
  document.querySelector('main'),
  document.querySelector('.site-footer'),
  document.querySelector('.mobile-cta-bar')
].filter(Boolean);

const LEAD_SUCCESS_MESSAGE = 'Thanks — your request has been received. Gerry will be in touch shortly.';
const LEAD_SUCCESS_HOLD_MS = 10000;

const leadSuccessTakeover = createSuccessTakeover({
  overlay: leadSuccessOverlay,
  origin: leadSuccessOrigin,
  ghost: leadSuccessGhost,
  target: leadSuccessTarget,
  title: leadSuccessTitle,
  body: leadSuccessBody,
  motionQuery: window.matchMedia('(prefers-reduced-motion: reduce)'),
  holdMs: LEAD_SUCCESS_HOLD_MS,
  lockTargets: leadSuccessLockTargets
});

const leadFields = {
  fullName: document.getElementById('leadFullName'),
  email: document.getElementById('leadEmail'),
  phone: document.getElementById('leadPhone'),
  stage: document.getElementById('leadStage'),
  callOutcome: document.getElementById('leadCallOutcome'),
  reason: document.getElementById('leadReason'),
  understandsRecordedCall: document.getElementById('leadUnderstandsRecordedCall'),
  understandsEducationalOnly: document.getElementById('leadUnderstandsEducationalOnly'),
  understandsEducationalContent: document.getElementById('leadUnderstandsEducationalContent')
};

function setAdvisorAppLinksVisible(visible) {
  advisorAppLinks.forEach((link) => {
    link.hidden = !visible;
    link.classList.toggle('is-hidden', !visible);
    link.setAttribute('aria-hidden', visible ? 'false' : 'true');
  });
}

async function syncAdvisorAppLinkVisibility() {
  if (advisorAppLinks.length === 0) {
    return;
  }

  setAdvisorAppLinksVisible(false);
  if (!WORKER_BASE_URL) {
    return;
  }

  try {
    const response = await fetch(`${WORKER_BASE_URL}/api/auth/session`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include'
    });
    if (!response.ok) {
      return;
    }

    const payload = await response.json().catch(() => null);
    setAdvisorAppLinksVisible(payload?.authEnabled === true && payload?.authenticated === true);
  } catch (_error) {
    setAdvisorAppLinksVisible(false);
  }
}

function showAdvisorGateNoticeIfNeeded() {
  if (!advisorGateNotice) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('app') !== 'advisor-required') {
    return;
  }

  advisorGateNotice.hidden = false;
  advisorGateNotice.classList.remove('is-hidden');

  window.requestAnimationFrame(() => {
    scrollToHash('#request-call', { behavior: 'auto' });
    advisorGateNotice.focus({ preventScroll: true });
  });
}

function setNavOpen(open) {
  if (!navToggle || !siteNav) {
    return;
  }

  navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  siteNav.classList.toggle('is-open', open);
  document.body.classList.toggle('nav-open', open);
}

function getPreferredScrollBehavior() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function getHeaderOffsetValue() {
  if (!siteHeader) {
    return 0;
  }

  const headerHeight = Math.ceil(siteHeader.getBoundingClientRect().height);
  const visualGap = window.innerWidth >= 900 ? 18 : 14;
  return headerHeight + visualGap;
}

function updateHeaderOffset() {
  const headerOffset = getHeaderOffsetValue();
  if (headerOffset <= 0) {
    return;
  }

  document.documentElement.style.setProperty('--header-offset', `${headerOffset}px`);
}

function getHashTarget(hash) {
  const id = decodeURIComponent(String(hash || '').replace(/^#/, '').trim());
  if (!id) {
    return null;
  }

  return document.getElementById(id);
}

function scrollToHash(hash, { behavior = getPreferredScrollBehavior() } = {}) {
  const target = getHashTarget(hash);
  if (!target) {
    return false;
  }

  updateHeaderOffset();
  const top = target.getBoundingClientRect().top + window.scrollY - getHeaderOffsetValue();
  window.scrollTo({
    top: Math.max(0, top),
    behavior
  });
  return true;
}

function bindHashNavigation() {
  document.querySelectorAll('a[href]').forEach((link) => {
    const destination = new URL(link.href, window.location.href);
    const isSamePageHashLink = destination.origin === window.location.origin
      && destination.pathname === window.location.pathname
      && destination.hash;

    if (!isSamePageHashLink || !getHashTarget(destination.hash)) {
      return;
    }

    link.addEventListener('click', (event) => {
      event.preventDefault();
      setNavOpen(false);

      window.requestAnimationFrame(() => {
        scrollToHash(destination.hash);

        if (window.location.hash === destination.hash) {
          history.replaceState(null, '', destination.hash);
          return;
        }

        history.pushState(null, '', destination.hash);
      });
    });
  });
}

function bindNavigation() {
  updateHeaderOffset();
  bindHashNavigation();

  if (siteHeader && 'ResizeObserver' in window) {
    const observer = new ResizeObserver(() => {
      updateHeaderOffset();
    });
    observer.observe(siteHeader);
  }

  if (navToggle && siteNav) {
    navToggle.addEventListener('click', () => {
      const isOpen = navToggle.getAttribute('aria-expanded') === 'true';
      setNavOpen(!isOpen);
    });

    siteNav.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        setNavOpen(false);
      });
    });
  }

  window.addEventListener('resize', () => {
    updateHeaderOffset();
    if (window.innerWidth >= 900) {
      setNavOpen(false);
    }
  });

  window.addEventListener('load', () => {
    updateHeaderOffset();

    if (window.location.hash) {
      window.requestAnimationFrame(() => {
        scrollToHash(window.location.hash, { behavior: 'auto' });
      });
    }
  });

  window.addEventListener('hashchange', () => {
    scrollToHash(window.location.hash, { behavior: 'auto' });
  });

  window.addEventListener('popstate', () => {
    if (!window.location.hash) {
      return;
    }

    scrollToHash(window.location.hash, { behavior: 'auto' });
  });
}

function initRevealAnimations() {
  const revealNodes = [...document.querySelectorAll('[data-reveal]')];
  if (revealNodes.length === 0) {
    return;
  }

  revealNodes.forEach((node) => {
    const delay = Number(node.getAttribute('data-reveal-delay'));
    if (Number.isFinite(delay) && delay > 0) {
      node.style.transitionDelay = `${delay}ms`;
    }
  });

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    revealNodes.forEach((node) => node.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) {
        return;
      }

      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, {
    threshold: 0.15,
    rootMargin: '0px 0px -8% 0px'
  });

  revealNodes.forEach((node) => observer.observe(node));
}

function setFieldValidity(field, isValid) {
  if (!field) {
    return;
  }

  field.setAttribute('aria-invalid', isValid ? 'false' : 'true');
  const consentCheck = field.closest('.consent-check');
  if (consentCheck) {
    consentCheck.classList.toggle('is-invalid', !isValid);
  }
}

function setFormStatus(kind, message) {
  if (!leadFormStatus) {
    return;
  }

  leadFormStatus.textContent = String(message || '');
  leadFormStatus.classList.toggle('is-success', kind === 'success');
  leadFormStatus.classList.toggle('is-error', kind === 'error');
}

function getFriendlyLeadSubmitError(error) {
  const message = typeof error?.message === 'string'
    ? error.message.trim()
    : '';

  if (!message) {
    return 'Could not submit your request right now. Please try again shortly.';
  }

  if (
    error instanceof TypeError
    || /failed to fetch|networkerror|load failed|network request failed/i.test(message)
  ) {
    return 'We could not send your request right now. Please try again in a moment.';
  }

  if (/not configured/i.test(message)) {
    return 'Request booking is not available right now. Please try again shortly.';
  }

  return message;
}

function normalizeLeadPayload() {
  return {
    fullName: String(leadFields.fullName?.value || '').trim(),
    email: String(leadFields.email?.value || '').trim(),
    phone: String(leadFields.phone?.value || '').trim(),
    stage: String(leadFields.stage?.value || '').trim(),
    callOutcome: String(leadFields.callOutcome?.value || '').trim(),
    reason: String(leadFields.reason?.value || '').trim(),
    understandsRecordedCall: Boolean(leadFields.understandsRecordedCall?.checked),
    understandsEducationalOnly: Boolean(leadFields.understandsEducationalOnly?.checked),
    understandsEducationalContent: Boolean(leadFields.understandsEducationalContent?.checked)
  };
}

function validateLeadPayload(payload) {
  const errors = [];

  if (!payload.fullName) {
    errors.push({
      field: leadFields.fullName,
      message: 'Enter your full name.'
    });
  }

  if (!payload.email) {
    errors.push({
      field: leadFields.email,
      message: 'Enter your email address.'
    });
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    errors.push({
      field: leadFields.email,
      message: 'Enter a valid email address.'
    });
  }

  if (!payload.reason) {
    errors.push({
      field: leadFields.reason,
      message: 'Add some context about the question, concern, or decision you want to talk through.'
    });
  } else if (payload.reason.length < 10) {
    errors.push({
      field: leadFields.reason,
      message: 'Add a little more context so Gerry can understand the situation and whether the call is a good fit.'
    });
  }

  if (!payload.understandsRecordedCall) {
    errors.push({
      field: leadFields.understandsRecordedCall,
      message: 'Confirm that you understand this is a free recorded call.'
    });
  }

  if (!payload.understandsEducationalOnly) {
    errors.push({
      field: leadFields.understandsEducationalOnly,
      message: 'Confirm that you understand Planeir uses your scenario for financial education only, not regulated financial advice or product recommendations.'
    });
  }

  if (!payload.understandsEducationalContent) {
    errors.push({
      field: leadFields.understandsEducationalContent,
      message: 'Confirm that you understand the recording may be used as educational content online.'
    });
  }

  return errors;
}

async function submitLead(payload) {
  if (!WORKER_BASE_URL) {
    throw new Error('Lead capture is not configured for this environment.');
  }

  const response = await fetch(`${WORKER_BASE_URL}/api/leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  let data = null;
  try {
    data = await response.json();
  } catch (_error) {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error || 'Could not submit your request right now. Please try again shortly.');
  }

  return data;
}

function resetFieldValidity() {
  Object.values(leadFields).forEach((field) => {
    setFieldValidity(field, true);
  });
}

function bindLeadForm() {
  if (!leadForm) {
    return;
  }

  leadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    resetFieldValidity();
    setFormStatus('', '');

    const payload = normalizeLeadPayload();
    const errors = validateLeadPayload(payload);

    if (errors.length > 0) {
      errors.forEach((entry) => {
        setFieldValidity(entry.field, false);
      });
      setFormStatus('error', errors[0].message);
      errors[0].field?.focus();
      return;
    }

    if (leadSubmitButton) {
      leadSubmitButton.disabled = true;
      leadSubmitButton.textContent = 'Sending...';
    }
    leadForm.setAttribute('aria-busy', 'true');

    try {
      await submitLead(payload);
      leadForm.reset();
      resetFieldValidity();
      setFormStatus('success', LEAD_SUCCESS_MESSAGE);
      await leadSuccessTakeover.play({
        titleText: 'Congratulations',
        bodyText: 'You have taken the first step towards understanding your options more clearly.',
        restoreFocusIfContainedIn: leadForm,
        restoreFocusTo: leadFormStatus
      });
    } catch (error) {
      setFormStatus('error', getFriendlyLeadSubmitError(error));
    } finally {
      if (leadSubmitButton) {
        leadSubmitButton.disabled = false;
        leadSubmitButton.textContent = 'Request a free call';
      }
      leadForm.removeAttribute('aria-busy');
    }
  });
}

bindNavigation();
showAdvisorGateNoticeIfNeeded();
void syncAdvisorAppLinkVisibility();
initRevealAnimations();
bindLeadForm();
