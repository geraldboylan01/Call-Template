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
const leadForm = document.getElementById('leadForm');
const leadFormStatus = document.getElementById('leadFormStatus');
const leadSubmitButton = document.getElementById('leadSubmitButton');

const leadFields = {
  fullName: document.getElementById('leadFullName'),
  email: document.getElementById('leadEmail'),
  phone: document.getElementById('leadPhone'),
  stage: document.getElementById('leadStage'),
  reason: document.getElementById('leadReason')
};

function setNavOpen(open) {
  if (!navToggle || !siteNav) {
    return;
  }

  navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  siteNav.classList.toggle('is-open', open);
  document.body.classList.toggle('nav-open', open);
}

function bindNavigation() {
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
    if (window.innerWidth >= 900) {
      setNavOpen(false);
    }
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
}

function setFormStatus(kind, message) {
  if (!leadFormStatus) {
    return;
  }

  leadFormStatus.textContent = String(message || '');
  leadFormStatus.classList.toggle('is-success', kind === 'success');
  leadFormStatus.classList.toggle('is-error', kind === 'error');
}

function normalizeLeadPayload() {
  return {
    fullName: String(leadFields.fullName?.value || '').trim(),
    email: String(leadFields.email?.value || '').trim(),
    phone: String(leadFields.phone?.value || '').trim(),
    stage: String(leadFields.stage?.value || '').trim(),
    reason: String(leadFields.reason?.value || '').trim()
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
      message: 'Add a short note about what you would like help with.'
    });
  } else if (payload.reason.length < 10) {
    errors.push({
      field: leadFields.reason,
      message: 'Add a little more context so we can route your request properly.'
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

    try {
      await submitLead(payload);
      leadForm.reset();
      resetFieldValidity();
      setFormStatus('success', 'Thanks \u2014 your request has been received. We\'ll be in touch shortly.');
    } catch (error) {
      setFormStatus('error', error?.message || 'Could not submit your request right now. Please try again shortly.');
    } finally {
      if (leadSubmitButton) {
        leadSubmitButton.disabled = false;
        leadSubmitButton.textContent = 'Request a call';
      }
    }
  });
}

bindNavigation();
initRevealAnimations();
bindLeadForm();
