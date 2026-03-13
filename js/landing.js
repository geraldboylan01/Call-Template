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
const leadSuccessMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const leadSuccessOrigin = document.querySelector('.site-brand-logo-wrap');
const leadSuccessLockTargets = [
  siteHeader,
  document.querySelector('main'),
  document.querySelector('.site-footer'),
  document.querySelector('.mobile-cta-bar')
].filter(Boolean);

const LEAD_SUCCESS_MESSAGE = 'Thanks — your request has been received. Gerry will be in touch shortly.';
const LEAD_SUCCESS_CLASSES = ['is-measuring', 'is-active', 'is-entering', 'is-settling', 'is-showing-copy', 'is-exiting', 'is-reduced-motion'];
const LEAD_SUCCESS_WORDMARK_RATIO = 1330 / 384;

let leadSuccessRunId = 0;

const leadFields = {
  fullName: document.getElementById('leadFullName'),
  email: document.getElementById('leadEmail'),
  phone: document.getElementById('leadPhone'),
  stage: document.getElementById('leadStage'),
  callOutcome: document.getElementById('leadCallOutcome'),
  reason: document.getElementById('leadReason'),
  understandsRecordedCall: document.getElementById('leadUnderstandsRecordedCall'),
  understandsEducationalContent: document.getElementById('leadUnderstandsEducationalContent')
};

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

function waitForNextFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function setLeadSuccessInteractionLock(isLocked) {
  document.body.classList.toggle('is-lead-success-active', isLocked);

  leadSuccessLockTargets.forEach((node) => {
    if ('inert' in node) {
      node.inert = isLocked;
    }
  });
}

function resetLeadSuccessOverlayState() {
  if (!leadSuccessOverlay) {
    return;
  }

  leadSuccessOverlay.classList.remove(...LEAD_SUCCESS_CLASSES);
  leadSuccessOverlay.setAttribute('aria-hidden', 'true');
  leadSuccessOverlay.style.removeProperty('--lead-success-origin-left');
  leadSuccessOverlay.style.removeProperty('--lead-success-origin-top');
  leadSuccessOverlay.style.removeProperty('--lead-success-origin-width');
  leadSuccessOverlay.style.removeProperty('--lead-success-origin-height');
  leadSuccessOverlay.style.removeProperty('--lead-success-dx');
  leadSuccessOverlay.style.removeProperty('--lead-success-dy');
  leadSuccessOverlay.style.removeProperty('--lead-success-sx');
  leadSuccessOverlay.style.removeProperty('--lead-success-sy');
  setLeadSuccessInteractionLock(false);
}

function getLeadSuccessOriginFallbackRect() {
  const width = Math.min(164, window.innerWidth * 0.42);
  const height = width / LEAD_SUCCESS_WORDMARK_RATIO;

  return {
    left: 24,
    top: 20,
    width,
    height
  };
}

function getLeadSuccessTargetFallbackRect() {
  const width = Math.min(window.innerWidth * 0.82, 780);
  const height = width / LEAD_SUCCESS_WORDMARK_RATIO;

  return {
    left: (window.innerWidth - width) / 2,
    top: Math.max(42, (window.innerHeight - height) / 2 - 48),
    width,
    height
  };
}

function getValidRect(element, fallbackRect) {
  if (!element) {
    return fallbackRect;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return fallbackRect;
  }

  return rect;
}

function configureLeadSuccessGhostRect(originRect, targetRect) {
  if (!leadSuccessOverlay) {
    return;
  }

  leadSuccessOverlay.style.setProperty('--lead-success-origin-left', `${originRect.left}px`);
  leadSuccessOverlay.style.setProperty('--lead-success-origin-top', `${originRect.top}px`);
  leadSuccessOverlay.style.setProperty('--lead-success-origin-width', `${originRect.width}px`);
  leadSuccessOverlay.style.setProperty('--lead-success-origin-height', `${originRect.height}px`);
  leadSuccessOverlay.style.setProperty('--lead-success-dx', `${targetRect.left - originRect.left}px`);
  leadSuccessOverlay.style.setProperty('--lead-success-dy', `${targetRect.top - originRect.top}px`);
  leadSuccessOverlay.style.setProperty('--lead-success-sx', `${targetRect.width / originRect.width}`);
  leadSuccessOverlay.style.setProperty('--lead-success-sy', `${targetRect.height / originRect.height}`);
}

async function playLeadSuccessTakeover() {
  if (!leadSuccessOverlay || !leadSuccessGhost || !leadSuccessTarget) {
    return;
  }

  const runId = ++leadSuccessRunId;
  const shouldRestoreFocus = Boolean(leadForm?.contains(document.activeElement));
  const prefersReducedMotion = leadSuccessMotionQuery.matches;

  resetLeadSuccessOverlayState();
  leadSuccessOverlay.classList.toggle('is-reduced-motion', prefersReducedMotion);
  leadSuccessOverlay.classList.add('is-measuring');
  leadSuccessOverlay.setAttribute('aria-hidden', 'false');

  await waitForNextFrame();

  if (runId !== leadSuccessRunId) {
    return;
  }

  const originRect = getValidRect(leadSuccessOrigin, getLeadSuccessOriginFallbackRect());
  const targetRect = getValidRect(leadSuccessTarget, getLeadSuccessTargetFallbackRect());
  configureLeadSuccessGhostRect(originRect, targetRect);

  leadSuccessOverlay.classList.remove('is-measuring');
  setLeadSuccessInteractionLock(true);
  leadSuccessOverlay.classList.add('is-active');

  await waitForNextFrame();

  if (runId !== leadSuccessRunId) {
    return;
  }

  if (prefersReducedMotion) {
    leadSuccessOverlay.classList.add('is-settling');
    await delay(220);
  } else {
    leadSuccessOverlay.classList.add('is-entering');
    await delay(980);
    if (runId !== leadSuccessRunId) {
      return;
    }
    leadSuccessOverlay.classList.add('is-settling');
    await delay(560);
  }

  if (runId !== leadSuccessRunId) {
    return;
  }

  leadSuccessOverlay.classList.add('is-showing-copy');
  await delay(prefersReducedMotion ? 900 : 760);

  if (runId !== leadSuccessRunId) {
    return;
  }

  leadSuccessOverlay.classList.add('is-exiting');
  await delay(prefersReducedMotion ? 260 : 420);

  if (runId !== leadSuccessRunId) {
    return;
  }

  resetLeadSuccessOverlayState();

  if (shouldRestoreFocus && leadFormStatus) {
    leadFormStatus.focus({ preventScroll: true });
  }
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
      await playLeadSuccessTakeover();
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
initRevealAnimations();
bindLeadForm();
