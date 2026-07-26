// Local-only agent test console.
//
// NOT DEPLOYED. This file and its page are deliberately absent from the
// HTML_FILES allowlist in scripts/build-pages.mjs, so `npm run build` never
// ships them. Point it at a local `wrangler dev` running the consumer-test
// configuration, where CONSUMER_AGENT_TEST_ENABLED is true.
//
// The console RENDERS; it never plans. Every string it shows comes from one of
// the two server projections. It does not compose a question, choose a module,
// or decide anything — doing so would create exactly the shadow planner the
// agent-testing plan forbids.
//
// The left column is the consumer projection and the right column is the tester
// projection. They are never merged: seeing what leaked is the whole point.

const el = (id) => document.getElementById(id);
const state = {
  baseUrl: '',
  csrfToken: '',
  sessionId: null,
  meetingId: null,
  revision: null,
  turns: []
};

function setStatus(message, isError = false) {
  const node = el('status');
  node.textContent = message;
  node.className = isError ? 'status error' : 'status';
}

function setBusy(busy) {
  for (const id of ['new-session', 'refresh', 'export', 'reset', 'send', 'message']) {
    const node = el(id);
    if (!node) continue;
    node.disabled = busy || (id !== 'new-session' && !state.sessionId);
  }
  el('new-session').disabled = busy || !state.csrfToken;
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.csrfToken) headers['X-Advisor-CSRF'] = state.csrfToken;
  const response = await fetch(new URL(path, `${state.baseUrl}/`), {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
  if (!response.ok) {
    const detail = payload?.code || payload?.error || `HTTP ${response.status}`;
    throw new Error(`${method} ${path} failed: ${detail}`);
  }
  return payload;
}

/* ---------------------------------------------------------------- */
/* Rendering — consumer column                                        */
/* ---------------------------------------------------------------- */

function renderTranscript() {
  const root = el('transcript');
  if (state.turns.length === 0) {
    root.replaceChildren(emptyNode('No turns yet.'));
    return;
  }
  root.replaceChildren(...state.turns.map((turn) => {
    const wrapper = document.createElement('div');
    wrapper.className = `turn ${turn.role}`;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = turn.role === 'client' ? 'Client' : 'Planéir';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    // textContent, never innerHTML: transcript text is untrusted content.
    bubble.textContent = turn.text;
    wrapper.append(who, bubble);
    return wrapper;
  }));
  root.scrollTop = root.scrollHeight;
}

/* ---------------------------------------------------------------- */
/* Rendering — tester column                                          */
/* ---------------------------------------------------------------- */

function panel(title, node) {
  const section = document.createElement('div');
  section.className = 'panel';
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.append(heading, node);
  return section;
}

function emptyNode(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

function definitionList(entries) {
  const list = document.createElement('dl');
  list.className = 'kv';
  for (const [key, value] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
    list.append(dt, dd);
  }
  return list;
}

function table(columns, rows, renderRow) {
  if (rows.length === 0) return emptyNode('none');
  const node = document.createElement('table');
  const head = document.createElement('tr');
  for (const column of columns) {
    const th = document.createElement('th');
    th.textContent = column;
    head.append(th);
  }
  node.append(head);
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of renderRow(row)) {
      const td = document.createElement('td');
      if (cell instanceof Node) td.append(cell);
      else td.textContent = cell === null || cell === undefined ? '—' : String(cell);
      tr.append(td);
    }
    node.append(tr);
  }
  return node;
}

function moduleId(value) {
  const code = document.createElement('code');
  code.textContent = value;
  return code;
}

function renderDiagnostics(diagnostics, usage) {
  const root = el('diagnostics');
  if (!diagnostics) {
    root.replaceChildren(emptyNode('No session yet.'));
    return;
  }
  const sections = [];

  sections.push(panel('Session', definitionList([
    ['revision', diagnostics.revision],
    ['confirmed revision', diagnostics.confirmedRevision],
    ['stage', diagnostics.stage],
    ['phase', diagnostics.phase],
    ['turns', usage?.turnCount ?? state.turns.filter((t) => t.role === 'client').length],
    ['spend (µ€)', usage?.spendMicroEur ?? '—']
  ])));

  sections.push(panel('Goals', definitionList([
    ['primary', diagnostics.goals.primary],
    ['active', diagnostics.goals.active.join(', ')],
    ['deferred', diagnostics.goals.deferred.join(', ')],
    ['confidence', diagnostics.goals.confidence],
    ['needs priority question', diagnostics.goals.priorityQuestionRequired],
    ['needs decision topic', diagnostics.goals.decisionTopicQuestionRequired]
  ])));

  sections.push(panel('Facts', table(
    ['fact', 'value', 'certainty', 'status'],
    diagnostics.facts,
    (fact) => [
      moduleId(fact.factId),
      typeof fact.value === 'object' ? JSON.stringify(fact.value) : fact.value,
      fact.certainty,
      fact.status
    ]
  )));

  sections.push(panel('Pending question', diagnostics.pendingQuestion
    ? definitionList([
        ['factId', diagnostics.pendingQuestion.factId],
        ['topic', diagnostics.pendingQuestion.topic],
        ['prompt', diagnostics.pendingQuestion.prompt]
      ])
    // The incident: a live meeting with no question is the clarification loop.
    : emptyNode('none — a live meeting with no question is the failure mode to watch for')));

  sections.push(panel('Analyses (internal id · client wording)', table(
    ['slot', 'moduleId', 'client description', 'selection', 'availability'],
    diagnostics.analyses,
    (item) => [item.slot, moduleId(item.moduleId), item.description, item.selectionState, item.availability]
  )));

  sections.push(panel('Still needed', table(
    ['fact', 'for module'],
    diagnostics.stillNeeded,
    (item) => [moduleId(item.factId), item.moduleId ? moduleId(item.moduleId) : '—']
  )));

  sections.push(panel('Opportunities', table(
    ['moduleId', 'state'],
    diagnostics.opportunities,
    (item) => [moduleId(item.moduleId), item.state]
  )));

  sections.push(panel('Capacity', diagnostics.capacity
    ? definitionList([
        ['used', `${diagnostics.capacity.used} / ${diagnostics.capacity.maximumAnalyses}`],
        ['at limit', diagnostics.capacity.atLimit],
        ['overflow', diagnostics.capacity.overflowModuleIds.join(', ')]
      ])
    : emptyNode('none')));

  const offerNode = document.createElement('div');
  if (diagnostics.activeOffer) {
    offerNode.append(definitionList([
      ['moduleId', diagnostics.activeOffer.moduleId],
      ['anchor', diagnostics.activeOffer.anchor],
      ['spoken offer', diagnostics.activeOffer.spokenOffer]
    ]));
    offerNode.append(decisionButtons('offer', ['accepted', 'declined', 'uncertain']));
  } else {
    offerNode.append(emptyNode('no offer on the table'));
  }
  sections.push(panel('Active offer', offerNode));

  const capacityNode = document.createElement('div');
  if (diagnostics.activeCapacityDecision) {
    const decision = diagnostics.activeCapacityDecision;
    capacityNode.append(definitionList([
      ['candidate', decision.candidateModuleId],
      ['spoken', decision.spoken]
    ]));
    capacityNode.append(table(
      ['#', 'moduleId', 'client description'],
      decision.replacementChoices,
      (choice) => [choice.choiceIndex, moduleId(choice.moduleId), choice.description]
    ));
    capacityNode.append(capacityButtons(decision.replacementChoices));
  } else {
    capacityNode.append(emptyNode('no capacity decision'));
  }
  sections.push(panel('Capacity decision', capacityNode));

  sections.push(panel('Planning decisions', definitionList([
    ['accepted', diagnostics.planningDecisions.accepted.join(', ')],
    ['declined', diagnostics.planningDecisions.declined.join(', ')],
    ['deferred', diagnostics.planningDecisions.deferred.join(', ')],
    ['replaced', diagnostics.planningDecisions.replaced.join(', ')],
    ['confirmed', diagnostics.planningDecisions.confirmed.join(', ')]
  ])));

  const confirmNode = document.createElement('div');
  confirmNode.append(definitionList([
    ['ready to confirm', diagnostics.readyToConfirm],
    ['confirmation summary', diagnostics.confirmationSummary],
    ['plan moduleIds', diagnostics.analysisPlan?.moduleIds?.join(', ') ?? '—'],
    ['plan status', diagnostics.analysisPlan?.status ?? '—']
  ]));
  const confirmButton = document.createElement('button');
  confirmButton.className = 'action-mode';
  confirmButton.textContent = 'Confirm and run (action mode)';
  confirmButton.addEventListener('click', () => runAction('Confirm', () => api(
    `/api/agent-tests/sessions/${state.sessionId}/confirm`,
    { method: 'POST', body: { expectedRevision: state.revision } }
  )));
  confirmNode.append(confirmButton);
  sections.push(panel('Confirmation and execution', confirmNode));

  root.replaceChildren(...sections);
}

/* ---------------------------------------------------------------- */
/* Action mode — always badged, never a parity path                   */
/* ---------------------------------------------------------------- */

function actionNote() {
  const note = document.createElement('p');
  note.className = 'note mid';
  note.textContent = 'ACTION MODE — resolves the server-owned decision directly, '
    + 'bypassing the model. Not valid as a voice/text parity test.';
  return note;
}

function decisionButtons(kind, decisions) {
  const wrapper = document.createElement('div');
  wrapper.append(actionNote());
  for (const decision of decisions) {
    const button = document.createElement('button');
    button.className = 'action-mode';
    button.textContent = decision;
    button.addEventListener('click', () => runAction(`Offer: ${decision}`, () => api(
      `/api/agent-tests/sessions/${state.sessionId}/decisions/${kind}`,
      { method: 'POST', body: { decision, expectedRevision: state.revision } }
    )));
    wrapper.append(button);
  }
  return wrapper;
}

function capacityButtons(choices) {
  const wrapper = document.createElement('div');
  wrapper.append(actionNote());
  for (const choice of choices) {
    const button = document.createElement('button');
    button.className = 'action-mode';
    button.textContent = `replace #${choice.choiceIndex}`;
    button.addEventListener('click', () => runAction(`Capacity: replace #${choice.choiceIndex}`, () => api(
      `/api/agent-tests/sessions/${state.sessionId}/decisions/capacity`,
      {
        method: 'POST',
        body: { decision: 'replace', replaceChoiceIndex: choice.choiceIndex, expectedRevision: state.revision }
      }
    )));
    wrapper.append(button);
  }
  for (const decision of ['defer', 'unclear']) {
    const button = document.createElement('button');
    button.className = 'action-mode';
    button.textContent = decision;
    button.addEventListener('click', () => runAction(`Capacity: ${decision}`, () => api(
      `/api/agent-tests/sessions/${state.sessionId}/decisions/capacity`,
      { method: 'POST', body: { decision, expectedRevision: state.revision } }
    )));
    wrapper.append(button);
  }
  return wrapper;
}

async function runAction(label, call) {
  setBusy(true);
  try {
    const result = await call();
    if (result.consumer?.assistantMessage) {
      state.turns.push({ role: 'assistant', text: result.consumer.assistantMessage });
    }
    if (result.result?.acknowledgement) {
      state.turns.push({ role: 'assistant', text: result.result.acknowledgement });
    }
    if (result.diagnostics) {
      state.revision = result.diagnostics.revision;
      renderDiagnostics(result.diagnostics, null);
    }
    renderTranscript();
    const mode = result.decisionMode ? ` [${result.decisionMode}]` : '';
    setStatus(`${label} — ok${mode}${result.parityValid === false ? ' · not parity-valid' : ''}`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

/* ---------------------------------------------------------------- */
/* Lifecycle                                                          */
/* ---------------------------------------------------------------- */

async function signIn() {
  state.baseUrl = el('base-url').value.trim().replace(/\/+$/, '');
  setStatus('Signing in…');
  try {
    await api('/api/auth/session');
    const login = await api('/api/auth/login', { method: 'POST', body: { password: el('password').value } });
    if (!login?.authenticated) throw new Error('Adviser login was rejected.');
    state.csrfToken = String(login.csrfToken || '');
    setStatus('Signed in. Create a test session.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function newSession() {
  setBusy(true);
  try {
    const created = await api('/api/agent-tests/sessions', { method: 'POST', body: {} });
    state.sessionId = created.sessionId;
    state.meetingId = created.meetingId;
    state.revision = null;
    state.turns = [];
    renderTranscript();
    await refresh();
    setStatus(`Session ${created.sessionId} · max ${created.limits.maxTurns} turns`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function refresh() {
  if (!state.sessionId) return;
  const result = await api(`/api/agent-tests/sessions/${state.sessionId}/state`);
  state.revision = result.diagnostics.revision;
  renderDiagnostics(result.diagnostics, result.usage);
}

async function sendTurn(event) {
  event.preventDefault();
  const message = el('message').value.trim();
  if (!message || !state.sessionId) return;
  setBusy(true);
  state.turns.push({ role: 'client', text: message });
  renderTranscript();
  el('message').value = '';
  try {
    const result = await api(`/api/agent-tests/sessions/${state.sessionId}/turns`, {
      method: 'POST',
      body: { message, expectedRevision: state.revision }
    });
    state.revision = result.consumer.revision;
    state.turns.push({ role: 'assistant', text: result.consumer.assistantMessage });
    renderTranscript();
    renderDiagnostics(result.diagnostics, result.usage);
    const notes = [`revision ${result.consumer.revision}`, `phase ${result.consumer.phase}`];
    if (result.diagnostics.rendererFallback) notes.push('renderer fell back to the server question');
    if (result.diagnostics.plannerErrorCode) notes.push(`planner: ${result.diagnostics.plannerErrorCode}`);
    for (const call of result.diagnostics.toolCalls || []) {
      notes.push(`${call.tool}=${call.decision ?? (call.ok ? 'ok' : call.errorCode)}`);
    }
    setStatus(notes.join(' · '));
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function exportSession() {
  setBusy(true);
  try {
    const result = await api(`/api/agent-tests/sessions/${state.sessionId}/export`);
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `agent-test-${state.sessionId}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    setStatus(`Exported ${result.transcript.length} turns.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function deleteSession() {
  setBusy(true);
  try {
    await api(`/api/agent-tests/sessions/${state.sessionId}`, { method: 'DELETE' });
    setStatus(`Deleted ${state.sessionId}.`);
    state.sessionId = null;
    state.meetingId = null;
    state.turns = [];
    renderTranscript();
    renderDiagnostics(null, null);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

el('sign-in').addEventListener('click', signIn);
el('new-session').addEventListener('click', newSession);
el('refresh').addEventListener('click', () => refresh().catch((error) => setStatus(error.message, true)));
el('export').addEventListener('click', exportSession);
el('reset').addEventListener('click', deleteSession);
el('composer').addEventListener('submit', sendTurn);
el('message').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) el('composer').requestSubmit();
});

renderTranscript();
setBusy(false);
