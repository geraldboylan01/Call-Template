function getMetaContent(name) {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() || '';
}

const WORKER_BASE_URL = (() => {
  const override = getMetaContent('call-canvas-worker-base-url');
  return override ? override.replace(/\/+$/, '') : '';
})();

const PROVISIONING_MESSAGE = 'Catalogue authoring is not yet provisioned. Deploy Worker migration 0016_create_module_catalogue_drafts.sql.';

const ui = {
  authStatus: document.getElementById('advisorAuthStatus'),
  logoutBtn: document.getElementById('advisorLogoutBtn'),
  authLayer: document.getElementById('advisorAuthLayer'),
  authPassword: document.getElementById('advisorAuthPasswordInput'),
  authLoginBtn: document.getElementById('advisorAuthLoginBtn'),
  authError: document.getElementById('advisorAuthError'),
  catalogueStatus: document.getElementById('catalogueStatus'),
  provisioningNotice: document.getElementById('provisioningNotice'),
  refresh: document.getElementById('refreshCatalogueBtn'),
  moduleList: document.getElementById('moduleList'),
  moduleCount: document.getElementById('moduleCount'),
  implementationFilter: document.getElementById('implementationFilter'),
  routingFilter: document.getElementById('routingFilter'),
  availabilityFilter: document.getElementById('availabilityFilter'),
  readinessFilter: document.getElementById('readinessFilter'),
  search: document.getElementById('moduleSearchInput'),
  authoringTitle: document.getElementById('authoringTitle'),
  draftSelect: document.getElementById('draftSelect'),
  draftKind: document.getElementById('draftKindBadge'),
  draftRevision: document.getElementById('draftRevisionBadge'),
  draftStatus: document.getElementById('draftStatusBadge'),
  generationBrief: document.getElementById('generationBrief'),
  draftPayload: document.getElementById('draftPayload'),
  previewProfile: document.getElementById('previewProfile'),
  validationOutput: document.getElementById('validationOutput'),
  previewOutput: document.getElementById('previewOutput'),
  auditOutput: document.getElementById('auditOutput'),
  exportOutput: document.getElementById('exportOutput'),
  toastHost: document.getElementById('toastHost')
};

const state = {
  authEnabled: false,
  authenticated: false,
  csrfToken: '',
  modules: [],
  drafts: [],
  selectedModuleId: '',
  activeDraft: null,
  exportArtifact: null,
  provisioned: true
};

function requestInit(init = {}, { csrf = false } = {}) {
  const headers = new Headers(init.headers || {});
  if (csrf && state.csrfToken) headers.set('X-Advisor-CSRF', state.csrfToken);
  return { ...init, headers, credentials: 'include', cache: 'no-store' };
}

function setAuthLayer(visible) {
  ui.authLayer.classList.toggle('is-hidden', !visible);
  ui.authLayer.setAttribute('aria-hidden', visible ? 'false' : 'true');
  if (visible) window.setTimeout(() => ui.authPassword.focus(), 40);
}

function updateAuthChrome() {
  ui.authStatus.textContent = !state.authEnabled
    ? 'Advisor auth disabled'
    : state.authenticated
      ? 'Advisor signed in'
      : 'Advisor sign-in required';
  ui.logoutBtn.classList.toggle('is-hidden', !(state.authEnabled && state.authenticated));
  document.body.classList.toggle('is-auth-locked', state.authEnabled && !state.authenticated);
}

function setProvisioned(provisioned, message = '') {
  state.provisioned = provisioned;
  ui.provisioningNotice.textContent = provisioned ? '' : (message || PROVISIONING_MESSAGE);
  ui.provisioningNotice.classList.toggle('is-hidden', provisioned);
  document.querySelectorAll('.draft-action').forEach((element) => {
    element.disabled = !provisioned;
  });
}

function toast(message) {
  const item = document.createElement('div');
  item.className = 'toast';
  item.textContent = message;
  ui.toastHost.append(item);
  window.setTimeout(() => item.remove(), 3200);
}

async function api(pathname, init = {}, options = {}) {
  const response = await fetch(`${WORKER_BASE_URL}${pathname}`, requestInit(init, options));
  const payload = await response.json().catch(() => ({}));
  if (payload?.code === 'catalogue_authoring_not_provisioned') {
    setProvisioned(false, payload.message);
  }
  if ((response.status === 401 || response.status === 403) && state.authEnabled) {
    state.authenticated = false;
    state.csrfToken = '';
    updateAuthChrome();
    setAuthLayer(true);
  }
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.error || `Request failed (${response.status}).`);
    error.code = payload?.code || '';
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function syncAuth() {
  if (!WORKER_BASE_URL) throw new Error('Worker URL is not configured for this environment.');
  const response = await fetch(`${WORKER_BASE_URL}/api/auth/session`, requestInit({ method: 'GET' }));
  if (!response.ok) throw new Error(`Unable to check advisor session (${response.status}).`);
  const payload = await response.json();
  state.authEnabled = payload?.authEnabled === true;
  state.authenticated = payload?.authenticated === true;
  state.csrfToken = state.authenticated ? String(payload?.csrfToken || '') : '';
  updateAuthChrome();
  setAuthLayer(state.authEnabled && !state.authenticated);
  return !state.authEnabled || state.authenticated;
}

async function login() {
  const password = ui.authPassword.value;
  if (!password.trim()) {
    ui.authError.textContent = 'Enter the advisor password.';
    return;
  }
  ui.authLoginBtn.disabled = true;
  ui.authError.textContent = '';
  try {
    const response = await fetch(`${WORKER_BASE_URL}/api/auth/login`, requestInit({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    }));
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `Sign-in failed (${response.status}).`);
    state.authEnabled = payload?.authEnabled === true;
    state.authenticated = payload?.authenticated === true;
    state.csrfToken = String(payload?.csrfToken || '');
    ui.authPassword.value = '';
    updateAuthChrome();
    setAuthLayer(false);
    await loadAll();
  } catch (error) {
    ui.authError.textContent = error?.message || 'Could not sign in.';
  } finally {
    ui.authLoginBtn.disabled = false;
  }
}

async function logout() {
  try {
    await fetch(`${WORKER_BASE_URL}/api/auth/logout`, requestInit({ method: 'POST' }, { csrf: true }));
  } catch (_error) {
    // Best effort; local state still closes.
  }
  state.authenticated = false;
  state.csrfToken = '';
  updateAuthChrome();
  setAuthLayer(true);
}

function runtimeManifest(entry) {
  const manifest = structuredClone(entry);
  delete manifest.availabilityAxes;
  delete manifest.implementationAxes;
  delete manifest.routingAxes;
  delete manifest.readinessAxes;
  return manifest;
}

function selectedModule() {
  return state.modules.find((entry) => entry.moduleId === state.selectedModuleId) || null;
}

function filteredModules() {
  const search = ui.search.value.trim().toLowerCase();
  return state.modules.filter((entry) => {
    if (ui.implementationFilter.value !== 'all'
      && entry.implementation.status !== ui.implementationFilter.value) return false;
    if (ui.routingFilter.value === 'routable' && !entry.routing.consumerRoutable) return false;
    if (ui.routingFilter.value === 'not_routable' && entry.routing.consumerRoutable) return false;
    if (ui.availabilityFilter.value === 'consumer' && !entry.availabilityAxes.effectiveConsumerVisible) return false;
    if (ui.availabilityFilter.value === 'adviser' && !entry.availability.adviser) return false;
    if (ui.availabilityFilter.value === 'adviser_only'
      && (!entry.availability.adviser || entry.availabilityAxes.effectiveConsumerVisible)) return false;
    if (ui.availabilityFilter.value === 'unavailable'
      && (entry.availability.adviser || entry.availabilityAxes.effectiveConsumerVisible)) return false;
    if (ui.readinessFilter.value !== 'all'
      && entry.consumerReadiness.status !== ui.readinessFilter.value) return false;
    if (search) {
      const haystack = [
        entry.moduleId,
        entry.name,
        entry.purpose,
        ...(entry.routing.goals || []).map((goal) => goal.type),
        ...(entry.routing.adviserGoals || []).map((goal) => goal.type)
      ].join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function badge(text) {
  const element = document.createElement('span');
  element.className = 'module-badge';
  element.textContent = text;
  return element;
}

function renderModules() {
  const modules = filteredModules();
  ui.moduleList.replaceChildren();
  ui.moduleCount.textContent = `${modules.length} of ${state.modules.length} modules`;
  for (const entry of modules) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'module-list-card';
    card.classList.toggle('is-selected', entry.moduleId === state.selectedModuleId);
    card.setAttribute('role', 'listitem');
    const title = document.createElement('h3');
    title.textContent = entry.name;
    const id = document.createElement('p');
    id.textContent = entry.moduleId;
    const goals = document.createElement('p');
    const goalTypes = (entry.routing.goals || []).map((goal) => `${goal.type} (${goal.role})`);
    goals.textContent = `Goals: ${goalTypes.join(', ') || 'none'}`;
    const badges = document.createElement('div');
    badges.className = 'module-badges';
    badges.append(
      badge(entry.implementation.status),
      badge(entry.routing.consumerRoutable ? 'routable' : 'not routable'),
      badge(entry.availability.adviser ? 'adviser' : 'not adviser'),
      badge(entry.availabilityAxes.effectiveConsumerVisible ? 'consumer visible' : 'consumer gated'),
      badge(entry.consumerReadiness.status)
    );
    card.append(title, id, goals, badges);
    card.addEventListener('click', () => {
      state.selectedModuleId = entry.moduleId;
      ui.authoringTitle.textContent = entry.name;
      if (!state.activeDraft) ui.draftPayload.value = JSON.stringify({ manifest: runtimeManifest(entry) }, null, 2);
      renderModules();
    });
    ui.moduleList.append(card);
  }
}

function renderDraftSelect() {
  const current = state.activeDraft?.id || '';
  ui.draftSelect.replaceChildren(new Option('Saved drafts', ''));
  for (const draft of state.drafts) {
    const label = `${draft.moduleId || draft.payload?.goalType || 'proposal'} — ${draft.kind} — r${draft.revision}`;
    ui.draftSelect.append(new Option(label, draft.id));
  }
  ui.draftSelect.value = current;
}

function rememberDraft(draft) {
  state.drafts = [draft, ...state.drafts.filter((entry) => entry.id !== draft.id)];
}

function renderActiveDraft() {
  const draft = state.activeDraft;
  ui.draftKind.textContent = draft ? draft.kind : 'No draft';
  ui.draftRevision.textContent = `Revision ${draft?.revision ?? '—'}`;
  ui.draftStatus.textContent = `Status ${draft?.status || '—'}`;
  if (!draft) return;
  if (draft.moduleId) state.selectedModuleId = draft.moduleId;
  ui.authoringTitle.textContent = draft.moduleId || draft.payload?.goalType || 'Goal proposal';
  ui.draftPayload.value = JSON.stringify(draft.payload, null, 2);
  ui.auditOutput.textContent = JSON.stringify(draft.audit || [], null, 2);
  renderDraftSelect();
  renderModules();
}

async function loadCatalogue() {
  const payload = await api('/api/advisor/modules');
  state.modules = payload.modules || [];
  if (!state.selectedModuleId && state.modules.length) state.selectedModuleId = state.modules[0].moduleId;
  ui.catalogueStatus.textContent = `${payload.count} committed modules from ${payload.runtimeSource}. Authored changes still go through ${payload.authoredSource}.`;
  renderModules();
}

async function loadDrafts() {
  try {
    const payload = await api('/api/advisor/module-drafts');
    setProvisioned(true);
    state.drafts = payload.drafts || [];
    renderDraftSelect();
  } catch (error) {
    if (error.code !== 'catalogue_authoring_not_provisioned') throw error;
    state.drafts = [];
    renderDraftSelect();
  }
}

async function loadAll() {
  ui.catalogueStatus.textContent = 'Loading the committed catalogue.';
  await loadCatalogue();
  await loadDrafts();
}

function editorPayload() {
  let payload;
  try {
    payload = JSON.parse(ui.draftPayload.value);
  } catch (_error) {
    throw new Error('Draft payload must be valid JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Draft payload must be a JSON object.');
  }
  return payload;
}

async function createDraft(kind) {
  const module = selectedModule();
  let moduleId = module?.moduleId || null;
  let payload;
  if (kind === 'manifest_edit') {
    if (!module) throw new Error('Select a committed module first.');
    payload = { manifest: runtimeManifest(module) };
  } else if (kind === 'recognition_variant') {
    if (!module) throw new Error('Select the existing module this variant belongs to.');
    payload = {
      summary: 'Describe the narrower client need and how it maps to the existing module.',
      parentModuleId: module.moduleId,
      recognitionSignals: []
    };
  } else if (kind === 'new_engine') {
    moduleId = 'proposed_engine';
    payload = { summary: 'Describe the proposed deterministic engine.', goalTypes: [], implementationBrief: '' };
  } else {
    moduleId = null;
    payload = { summary: 'Describe the newly recognised client goal.', goalType: 'proposed_goal', consumerActive: false };
  }
  const result = await api('/api/advisor/module-drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, moduleId, payload })
  }, { csrf: true });
  state.activeDraft = result.draft;
  rememberDraft(result.draft);
  state.exportArtifact = null;
  renderActiveDraft();
  toast('Draft created.');
}

async function openDraft(id) {
  if (!id) return;
  const result = await api(`/api/advisor/module-drafts/${encodeURIComponent(id)}`);
  state.activeDraft = result.draft;
  state.exportArtifact = null;
  renderActiveDraft();
}

async function saveDraft() {
  if (!state.activeDraft) throw new Error('Create or select a draft first.');
  const result = await api(`/api/advisor/module-drafts/${encodeURIComponent(state.activeDraft.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: state.activeDraft.revision, payload: editorPayload() })
  }, { csrf: true });
  state.activeDraft = result.draft;
  state.exportArtifact = null;
  rememberDraft(result.draft);
  renderActiveDraft();
  toast('Draft saved. Validate this revision before export.');
}

async function generateDraft() {
  if (!state.activeDraft) throw new Error('Create or select a draft first.');
  const brief = ui.generationBrief.value.trim();
  if (!brief) throw new Error('Add an AI drafting brief first.');
  const result = await api(`/api/advisor/module-drafts/${encodeURIComponent(state.activeDraft.id)}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: state.activeDraft.revision, brief })
  }, { csrf: true });
  state.activeDraft = result.draft;
  state.exportArtifact = null;
  rememberDraft(result.draft);
  renderActiveDraft();
  toast('AI draft generated for review. Nothing was published.');
}

async function validateDraft() {
  if (!state.activeDraft) throw new Error('Create or select a draft first.');
  const result = await api(`/api/advisor/module-drafts/${encodeURIComponent(state.activeDraft.id)}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: state.activeDraft.revision })
  }, { csrf: true });
  state.activeDraft = result.draft;
  rememberDraft(result.draft);
  ui.validationOutput.textContent = JSON.stringify(result.validation, null, 2);
  ui.validationOutput.classList.remove('is-hidden');
  renderActiveDraft();
  toast(`Validation: ${result.validation.status}.`);
}

async function previewRouting() {
  if (!state.activeDraft) throw new Error('Create or select a draft first.');
  let profile;
  try {
    profile = JSON.parse(ui.previewProfile.value);
  } catch (_error) {
    throw new Error('Preview profile must be valid JSON.');
  }
  const result = await api(`/api/advisor/module-drafts/${encodeURIComponent(state.activeDraft.id)}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile })
  }, { csrf: true });
  ui.previewOutput.textContent = JSON.stringify(result, null, 2);
  ui.previewOutput.classList.remove('is-hidden');
  ui.auditOutput.classList.add('is-hidden');
  toast(result.previewUnavailableReason || 'Committed and candidate routing compared.');
}

async function exportPatch() {
  if (!state.activeDraft) throw new Error('Create or select a draft first.');
  const result = await api(`/api/advisor/module-drafts/${encodeURIComponent(state.activeDraft.id)}/export-patch`, {
    method: 'POST'
  }, { csrf: true });
  state.exportArtifact = result;
  state.activeDraft = result.draft;
  rememberDraft(result.draft);
  ui.exportOutput.textContent = JSON.stringify({
    targetPath: result.targetPath,
    manifestJsonBlock: result.manifestJsonBlock,
    authoredProseChanges: result.authoredProseChanges,
    applyPatch: result.applyPatch,
    contractsPatch: result.contractsPatch,
    implementationBrief: result.implementationBrief,
    requiredVerificationCommands: result.requiredVerificationCommands
  }, null, 2);
  renderActiveDraft();
  toast('Review patch exported. Repository files were not changed.');
}

async function copyText(value, label) {
  if (!value) throw new Error(`${label} is not available yet.`);
  await navigator.clipboard.writeText(value);
  toast(`${label} copied.`);
}

function downloadPatch() {
  const value = state.exportArtifact?.downloadablePatch;
  if (!value) throw new Error('Export a review patch first.');
  const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${state.activeDraft?.moduleId || state.activeDraft?.payload?.goalType || 'module-catalogue'}.patch`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Patch downloaded.');
}

function showAudit() {
  if (!state.activeDraft) throw new Error('Create or select a draft first.');
  ui.auditOutput.textContent = JSON.stringify(state.activeDraft.audit || [], null, 2);
  ui.auditOutput.classList.toggle('is-hidden');
  ui.previewOutput.classList.add('is-hidden');
}

function run(action) {
  return async () => {
    try {
      await action();
    } catch (error) {
      ui.catalogueStatus.textContent = error?.message || 'The catalogue action failed.';
      toast(error?.message || 'The catalogue action failed.');
    }
  };
}

for (const control of [
  ui.implementationFilter,
  ui.routingFilter,
  ui.availabilityFilter,
  ui.readinessFilter,
  ui.search
]) {
  control.addEventListener(control === ui.search ? 'input' : 'change', renderModules);
}

ui.authLoginBtn.addEventListener('click', login);
ui.authPassword.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') login();
});
ui.logoutBtn.addEventListener('click', logout);
ui.refresh.addEventListener('click', run(loadAll));
ui.draftSelect.addEventListener('change', () => run(() => openDraft(ui.draftSelect.value))());
document.getElementById('createManifestEditBtn').addEventListener('click', run(() => createDraft('manifest_edit')));
document.getElementById('createGoalProposalBtn').addEventListener('click', run(() => createDraft('new_goal')));
document.getElementById('createRecognitionVariantBtn').addEventListener('click', run(() => createDraft('recognition_variant')));
document.getElementById('createEngineSpecificationBtn').addEventListener('click', run(() => createDraft('new_engine')));
document.getElementById('generateDraftBtn').addEventListener('click', run(generateDraft));
document.getElementById('saveDraftBtn').addEventListener('click', run(saveDraft));
document.getElementById('validateDraftBtn').addEventListener('click', run(validateDraft));
document.getElementById('previewRoutingBtn').addEventListener('click', run(previewRouting));
document.getElementById('compareCommittedBtn').addEventListener('click', run(previewRouting));
document.getElementById('exportPatchBtn').addEventListener('click', run(exportPatch));
document.getElementById('copyManifestBtn').addEventListener('click', run(() => copyText(
  state.exportArtifact?.manifestJsonBlock || JSON.stringify(state.activeDraft?.payload?.manifest || {}, null, 2),
  'Manifest'
)));
document.getElementById('copyPatchBtn').addEventListener('click', run(() => copyText(
  state.exportArtifact?.applyPatch || state.exportArtifact?.contractsPatch,
  'Patch'
)));
document.getElementById('downloadPatchBtn').addEventListener('click', run(downloadPatch));
document.getElementById('copyImplementationBriefBtn').addEventListener('click', run(() => copyText(
  state.exportArtifact?.implementationBrief || state.activeDraft?.payload?.implementationBrief,
  'Implementation brief'
)));
document.getElementById('viewAuditBtn').addEventListener('click', run(showAudit));

async function start() {
  try {
    if (await syncAuth()) await loadAll();
  } catch (error) {
    ui.catalogueStatus.textContent = error?.message || 'Unable to load the module catalogue.';
  }
}

start();
