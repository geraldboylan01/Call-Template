import { bookingElement as el, loadBookingStyles } from './education_booking_ui.js';

const STARTER = {
  schemaVersion: 1, participatingOwnerIds: ['primary'], assetReviewComplete: false, consumerConfirmedAt: null,
  adviser: { id: 'gerry', name: 'Gerry Boylan', serviceFitConfirmed: null, minimumPfumCents: null },
  assets: [],
  readiness: { introductionRequested: null, willingToMeet: null, meeting: { kind: 'adviser', status: 'none' }, decisionWithinSixMonths: null, specificDecisionConfirmed: null, contactVerified: null, profileReviewedAt: null },
  consent: { granted: false, purpose: 'adviser_introduction', sharedDataCategories: [], recipientId: null, policyVersion: null, capturedAt: null, withdrawnAt: null }
};
const money = (cents) => cents === null || cents === undefined ? 'Unassessed' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);

export function createQualificationAdmin(root, { request, toast = () => {} }) {
  loadBookingStyles();
  root.classList.add('education-booking');
  let leadId = '', assessment = null, sequence = 0;
  let rankingLoaded = false, rankingLoading = false;
  const rankingDetails = el('details', 'education-booking-terms');
  rankingDetails.append(el('summary', '', 'Internal introduction ranking'));
  rankingDetails.append(el('p', '', 'Eligible introductions appear in Priority order, then readiness score, then oldest request. Available assets are shown separately. This is an internal pilot queue; no billing or distribution occurs here.'));
  const rankingRefresh = el('button', 'education-booking-link', 'Refresh introduction ranking'); rankingRefresh.type = 'button';
  const rankingStatus = el('p'); rankingStatus.setAttribute('role', 'status');
  const rankingError = el('p'); rankingError.setAttribute('role', 'alert');
  const rankingScroll = el('div'); rankingScroll.style.overflowX = 'auto';
  const rankingTable = el('table', 'education-booking-table');
  rankingTable.append(el('caption', '', 'Eligible adviser introductions'));
  const rankingHead = el('thead'), rankingHeadRow = el('tr');
  for (const title of ['Name', 'Available pFUM', 'Readiness', 'Tier', 'Test fee', 'Requested']) {
    const cell = el('th', '', title); cell.scope = 'col'; rankingHeadRow.append(cell);
  }
  rankingHead.append(rankingHeadRow);
  const rankingBody = el('tbody'); rankingTable.append(rankingHead, rankingBody); rankingScroll.append(rankingTable);
  rankingScroll.hidden = true;
  rankingDetails.append(rankingRefresh, rankingStatus, rankingError, rankingScroll);
  root.append(rankingDetails);
  function queueDate(value, includeTime = false) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not recorded' : new Intl.DateTimeFormat('en-IE', {
      timeZone: 'Europe/Dublin', day: 'numeric', month: 'short', year: 'numeric',
      ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {})
    }).format(date);
  }
  async function refreshRanking() {
    if (rankingLoading) return;
    rankingLoading = true; rankingRefresh.disabled = true; rankingError.textContent = '';
    try {
      const payload = await request('/api/advisor/qualification/ranking');
      const ranked = Array.isArray(payload.ranked) ? payload.ranked : [];
      rankingBody.replaceChildren();
      for (const entry of ranked) {
        const row = el('tr');
        for (const value of [
          `${entry.rank}. ${entry.fullName || `Lead ${entry.leadId}`}`,
          money(entry.pfumCents), `${entry.readinessScore}/100`,
          entry.classification === 'priority' ? 'Priority' : 'Standard',
          entry.quote ? money(entry.quote.feeCents) : 'Unassessed', queueDate(entry.requestedAt)
        ]) row.append(el('td', '', value));
        rankingBody.append(row);
      }
      const counts = payload.counts || {};
      rankingStatus.textContent = `${counts.assessed ?? 0} assessed · ${counts.eligible ?? ranked.length} eligible · ${counts.needsReview ?? 0} need review. Evaluated ${queueDate(payload.evaluatedAt, true)} (Europe/Dublin).${ranked.length ? '' : ' No eligible introductions are currently in the queue.'}`;
      rankingScroll.hidden = ranked.length === 0; rankingLoaded = true;
    } catch (failure) { rankingError.textContent = `Could not refresh introduction ranking: ${failure.message}`; }
    finally { rankingLoading = false; rankingRefresh.disabled = false; }
  }
  rankingRefresh.addEventListener('click', () => { void refreshRanking(); });
  rankingDetails.addEventListener('toggle', () => { if (rankingDetails.open && !rankingLoaded) void refreshRanking(); });
  const details = el('details');
  details.append(el('summary', '', 'Internal adviser introduction qualification'));
  details.append(el('p', '', 'Pilot assessment only. Available assets determine the price band; readiness determines Standard or Priority. The walkthrough is not an adviser meeting. No automatic billing or distribution is enabled.'));
  details.append(el('p', '', 'Record consumer-confirmed facts and the adviser’s eligibility checks. Amounts in this editor use euro cents. Do not mark education-call consent as consent to an adviser introduction. Unknown facts stay null; a consumer confirmation is not independent verification.'));
  const guide = el('details', 'education-booking-terms');
  guide.append(el('summary', '', 'Asset ledger example — replace every value with confirmed evidence'));
  const example = el('pre'); example.style.whiteSpace = 'pre-wrap';
  example.textContent = JSON.stringify({ holdingId: 'replace-with-distinct-holding-id', sourceRefs: [{ collection: 'manual', id: 'replace-with-record-id' }], label: 'Savings', type: 'cash', ownerIds: ['primary'], currency: 'EUR', identityConfirmed: false, valueCents: null, valueConfirmed: false, ownershipShareBps: null, ownershipConfirmed: false, availableAmountCents: null, availabilityConfirmed: false, availableWithin12Months: null, eligibilityConfirmed: false, manageableByAdviser: null, alreadyManagedByRecipient: null, deductions: [], evidence: [] }, null, 2);
  guide.append(el('p', '', 'Add one row per distinct economic holding. Confirm identity after checking duplicate records and holdings. A full ownership share is 10000 basis points. Deductions require distinct deductionId values, a kind, amountCents and confirmed:true; the same reserve must never be deducted twice.'), example);
  details.append(guide);
  const summary = el('p'); summary.setAttribute('role', 'status');
  const error = el('p'); error.setAttribute('role', 'alert');
  const form = el('form');
  const label = el('label', 'education-booking-field');
  label.append(el('span', '', 'Confirmed assessment ledger (JSON)'));
  const editor = el('textarea'); editor.rows = 15; editor.spellcheck = false; editor.required = true; editor.setAttribute('aria-label', 'Confirmed qualification assessment JSON');
  label.append(editor);
  const save = el('button', 'education-booking-button', 'Save a new assessment version'); save.type = 'submit';
  form.append(label, save);
  const resultDetails = el('details', 'education-booking-terms');
  resultDetails.append(el('summary', '', 'Calculation reasons and asset positions'));
  const result = el('pre'); result.style.whiteSpace = 'pre-wrap'; resultDetails.append(result);
  const outcomes = el('div');
  const outcomeForm = el('form', 'education-booking-admin-row');
  const outcomeSelect = el('select'); outcomeSelect.setAttribute('aria-label', 'Introduction outcome');
  for (const [value, text] of [['contacted', 'Contacted'], ['meeting_held', 'Adviser meeting held'], ['client_won', 'Client won'], ['funds_transferred', 'Funds transferred'], ['closed_lost', 'Closed without a client']]) {
    const option = el('option', '', text); option.value = value; outcomeSelect.append(option);
  }
  const amount = el('input'); amount.type = 'number'; amount.min = '0'; amount.step = '0.01'; amount.placeholder = 'Transferred amount in euros'; amount.setAttribute('aria-label', 'Funds transferred in euros'); amount.hidden = true;
  const record = el('button', 'education-booking-button', 'Record observed outcome'); record.type = 'submit';
  outcomeForm.append(outcomeSelect, amount, record);
  details.append(summary, error, form, resultDetails, outcomes, outcomeForm); root.append(details);

  function render(payload) {
    assessment = payload.assessment;
    editor.value = JSON.stringify(assessment?.input || STARTER, null, 2);
    save.disabled = !leadId; record.disabled = !assessment;
    if (assessment) {
      const calculated = assessment.result;
      summary.textContent = `${money(calculated.pfumCents)} pFUM · ${calculated.readinessScore}/100 readiness · ${calculated.qualificationStatus || 'needs_review'} · ${calculated.classification} · ${calculated.quote ? `${money(calculated.quote.feeCents)} test introduction fee` : 'No final introduction price'}. Sharing eligible: ${calculated.distributionEligible ? 'yes' : 'no'}.`;
      result.textContent = JSON.stringify(calculated, null, 2);
    } else {
      summary.textContent = leadId ? 'No assessment yet. Start with confirmed evidence; incomplete information must remain unassessed.' : 'Select a client lead to record an internal assessment.';
      result.textContent = '';
    }
    outcomes.replaceChildren(el('h3', '', 'Observed outcomes'));
    for (const event of payload.outcomes || []) outcomes.append(el('p', '', `${event.event || event.type} · ${event.occurredAt}${event.amountCents !== null && event.amountCents !== undefined ? ` · ${money(event.amountCents)}` : ''}`));
  }
  async function refresh(nextLeadId) {
    if (nextLeadId !== undefined) leadId = String(nextLeadId || '');
    const ticket = ++sequence;
    error.textContent = ''; save.disabled = true; record.disabled = true;
    if (!leadId) { render({ assessment: null }); return; }
    try {
      const payload = await request(`/api/advisor/leads/${encodeURIComponent(leadId)}/qualification`);
      if (ticket === sequence) render(payload);
    } catch (failure) { if (ticket === sequence) { error.textContent = failure.message; render({ assessment: null }); } }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!leadId || !form.reportValidity()) return;
    save.disabled = true; error.textContent = '';
    try {
      const input = JSON.parse(editor.value);
      await request(`/api/advisor/leads/${encodeURIComponent(leadId)}/qualification`, { method: 'POST', body: { assessmentId: `qualification_${crypto.randomUUID()}`, assessment: input } });
      toast('New internal qualification version saved.'); await refresh();
      if (rankingLoaded) await refreshRanking();
    } catch (failure) { error.textContent = failure.message; }
    finally { save.disabled = !leadId; }
  });
  outcomeSelect.addEventListener('change', () => { amount.hidden = outcomeSelect.value !== 'funds_transferred'; amount.required = !amount.hidden; });
  outcomeForm.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!leadId || !assessment || !outcomeForm.reportValidity()) return;
    record.disabled = true; error.textContent = '';
    try {
      await request(`/api/advisor/leads/${encodeURIComponent(leadId)}/qualification/outcomes`, { method: 'POST', body: {
        eventId: `outcome_${crypto.randomUUID()}`, assessmentId: assessment.id, event: outcomeSelect.value,
        occurredAt: new Date().toISOString(), ...(outcomeSelect.value === 'funds_transferred' ? { amountCents: Math.round(Number(amount.value) * 100) } : {})
      } });
      toast('Observed outcome recorded.'); await refresh();
    } catch (failure) { error.textContent = failure.message; }
    finally { record.disabled = !assessment; }
  });
  render({ assessment: null });
  return { refresh, refreshRanking };
}
