import { computeGridPosition, applyOverviewLayout } from './layout.js';

function formatLocalTime(isoString) {
  try {
    return new Date(isoString).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (_error) {
    return '';
  }
}

function htmlToPlainText(html) {
  if (!html || typeof html !== 'string') {
    return '';
  }

  const temp = document.createElement('template');
  temp.innerHTML = html;
  return (temp.content.textContent || '').replace(/\s+/g, ' ').trim();
}

function sanitizeSummaryHtml(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') {
    return '';
  }

  const template = document.createElement('template');
  template.innerHTML = rawHtml;

  template.content
    .querySelectorAll('script, style, iframe, object, embed, link, meta, form, button, input, textarea')
    .forEach((element) => element.remove());

  template.content.querySelectorAll('*').forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      const attrName = attribute.name.toLowerCase();
      const attrValue = attribute.value;

      if (attrName.startsWith('on')) {
        element.removeAttribute(attribute.name);
        return;
      }

      if ((attrName === 'href' || attrName === 'src') && /^\s*javascript:/i.test(attrValue)) {
        element.removeAttribute(attribute.name);
      }
    });
  });

  return template.innerHTML;
}

function makeOverviewSnippet(module) {
  const notes = module.notes || '';
  if (notes.trim()) {
    const cleanNotes = notes.replace(/\s+/g, ' ').trim();
    return cleanNotes.length > 120 ? `${cleanNotes.slice(0, 117)}...` : cleanNotes;
  }

  const summary = htmlToPlainText(module.generated?.summaryHtml || '');
  if (summary) {
    return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
  }

  return 'No notes yet.';
}

function isPensionModule(module) {
  return Boolean(module?.generated?.pensionInputs);
}

function isMortgageModule(module) {
  return Boolean(module?.generated?.mortgageInputs);
}

function formatNumberForInput(value, maxDecimals = 4) {
  if (!Number.isFinite(value)) {
    return '';
  }

  const fixed = Number(value).toFixed(maxDecimals);
  return fixed.replace(/\.?0+$/, '');
}

function formatRateForInput(value) {
  if (!Number.isFinite(value)) {
    return '';
  }

  return `${formatNumberForInput(value * 100, 4)}%`;
}

function parseIsoDateToMonthDate(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
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

function deriveRemainingTermYears(mortgageInputs) {
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
  const inclusiveMonths = deltaMonths + 1;
  if (!Number.isInteger(inclusiveMonths) || inclusiveMonths <= 0) {
    return null;
  }

  return inclusiveMonths / 12;
}

function getEditorStatusText(status) {
  if (status?.phase === 'updating') {
    return 'Updating...';
  }

  if (status?.phase === 'updated') {
    return 'Updated';
  }

  return '';
}

function getEditorStatusClass(status) {
  if (status?.phase === 'updating') {
    return 'is-updating';
  }

  if (status?.phase === 'updated') {
    return 'is-updated';
  }

  return 'is-idle';
}

function buildAssumptionField({
  module,
  calculator,
  fieldKey,
  label,
  placeholder,
  value,
  error,
  onPatchInputs,
  readOnly = false,
  inputMode = 'text'
}) {
  const field = document.createElement('div');
  field.className = 'assumptions-editor-field';

  const labelEl = document.createElement('label');
  labelEl.className = 'assumptions-editor-label';
  labelEl.textContent = label;
  labelEl.setAttribute('for', `${calculator}-${module.id}-${fieldKey}`);

  const input = document.createElement('input');
  input.type = 'text';
  input.id = `${calculator}-${module.id}-${fieldKey}`;
  input.className = 'assumptions-editor-input';
  input.inputMode = inputMode;
  input.placeholder = placeholder;
  input.value = String(value ?? '');
  input.dataset.assumptionField = fieldKey;
  input.dataset.assumptionCalculator = calculator;
  input.readOnly = readOnly;
  input.disabled = readOnly;
  input.classList.toggle('is-invalid', Boolean(error));
  input.setAttribute('aria-invalid', error ? 'true' : 'false');

  if (!readOnly && typeof onPatchInputs === 'function') {
    input.addEventListener('input', (event) => {
      onPatchInputs({
        moduleId: module.id,
        calculator,
        field: fieldKey,
        value: event.target.value
      });
    });
  }

  const errorEl = document.createElement('div');
  errorEl.className = 'assumptions-editor-error';
  errorEl.dataset.assumptionErrorFor = fieldKey;
  errorEl.textContent = error ? String(error) : '';

  field.appendChild(labelEl);
  field.appendChild(input);
  field.appendChild(errorEl);

  return {
    field,
    input,
    errorEl
  };
}

function buildEditorGroup(title) {
  const section = document.createElement('section');
  section.className = 'assumptions-editor-group';

  const heading = document.createElement('h4');
  heading.className = 'assumptions-editor-subheading';
  heading.textContent = title;
  section.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'assumptions-editor-grid';
  section.appendChild(grid);

  return {
    section,
    grid
  };
}

function buildAssumptionsEditorCard({ module, status }) {
  const card = document.createElement('section');
  card.className = 'generated-card assumptions-editor-card';
  card.dataset.assumptionEditor = module.id;

  const header = document.createElement('div');
  header.className = 'assumptions-editor-header';

  const heading = document.createElement('h3');
  heading.className = 'generated-card-title';
  heading.textContent = 'Edit assumptions';

  const statusEl = document.createElement('span');
  statusEl.className = `assumptions-editor-status ${getEditorStatusClass(status)}`;
  statusEl.dataset.assumptionStatus = 'true';
  statusEl.textContent = getEditorStatusText(status);

  header.appendChild(heading);
  header.appendChild(statusEl);

  const helper = document.createElement('p');
  helper.className = 'assumptions-editor-helper';
  helper.textContent = 'Type to update projections instantly. Values are saved in this session.';

  card.appendChild(header);
  card.appendChild(helper);

  return card;
}

export function renderPensionAssumptionsEditor({
  module,
  onPatchInputs,
  status = {},
  readOnly = false
}) {
  const pensionInputs = module?.generated?.pensionInputs;
  if (!pensionInputs) {
    return null;
  }

  const draftValues = status?.draftValues && typeof status.draftValues === 'object' ? status.draftValues : {};
  const errors = status?.errors && typeof status.errors === 'object' ? status.errors : {};
  const card = buildAssumptionsEditorCard({ module, status });

  const returnsGroup = buildEditorGroup('Returns & inflation');
  returnsGroup.grid.appendChild(buildAssumptionField({
    module,
    calculator: 'pension',
    fieldKey: 'growthRate',
    label: 'Growth rate',
    placeholder: '5% or 0.05',
    value: draftValues.growthRate ?? formatRateForInput(pensionInputs.growthRate),
    error: errors.growthRate,
    onPatchInputs,
    readOnly,
    inputMode: 'decimal'
  }).field);
  returnsGroup.grid.appendChild(buildAssumptionField({
    module,
    calculator: 'pension',
    fieldKey: 'wageGrowthRate',
    label: 'Wage growth rate',
    placeholder: '3% or 0.03',
    value: draftValues.wageGrowthRate ?? formatRateForInput(pensionInputs.wageGrowthRate),
    error: errors.wageGrowthRate,
    onPatchInputs,
    readOnly,
    inputMode: 'decimal'
  }).field);
  returnsGroup.grid.appendChild(buildAssumptionField({
    module,
    calculator: 'pension',
    fieldKey: 'inflationRate',
    label: 'Inflation rate',
    placeholder: '2% or 0.02',
    value: draftValues.inflationRate ?? formatRateForInput(pensionInputs.inflationRate),
    error: errors.inflationRate,
    onPatchInputs,
    readOnly,
    inputMode: 'decimal'
  }).field);

  const retirementGroup = buildEditorGroup('Retirement');
  retirementGroup.grid.appendChild(buildAssumptionField({
    module,
    calculator: 'pension',
    fieldKey: 'retirementAge',
    label: 'Retirement age',
    placeholder: '67',
    value: draftValues.retirementAge ?? formatNumberForInput(pensionInputs.retirementAge, 0),
    error: errors.retirementAge,
    onPatchInputs,
    readOnly,
    inputMode: 'numeric'
  }).field);

  if (Object.prototype.hasOwnProperty.call(pensionInputs, 'horizonEndAge')) {
    retirementGroup.grid.appendChild(buildAssumptionField({
      module,
      calculator: 'pension',
      fieldKey: 'horizonEndAge',
      label: 'Horizon end age',
      placeholder: '90',
      value: draftValues.horizonEndAge ?? formatNumberForInput(pensionInputs.horizonEndAge, 0),
      error: errors.horizonEndAge,
      onPatchInputs,
      readOnly,
      inputMode: 'numeric'
    }).field);
  }

  const contributionsGroup = buildEditorGroup('Contributions');
  contributionsGroup.grid.appendChild(buildAssumptionField({
    module,
    calculator: 'pension',
    fieldKey: 'personalPct',
    label: 'Personal contribution rate',
    placeholder: '8% or 0.08',
    value: draftValues.personalPct ?? formatRateForInput(pensionInputs.personalPct),
    error: errors.personalPct,
    onPatchInputs,
    readOnly,
    inputMode: 'decimal'
  }).field);
  contributionsGroup.grid.appendChild(buildAssumptionField({
    module,
    calculator: 'pension',
    fieldKey: 'employerPct',
    label: 'Employer contribution rate',
    placeholder: '6% or 0.06',
    value: draftValues.employerPct ?? formatRateForInput(pensionInputs.employerPct),
    error: errors.employerPct,
    onPatchInputs,
    readOnly,
    inputMode: 'decimal'
  }).field);

  card.appendChild(returnsGroup.section);
  card.appendChild(retirementGroup.section);
  card.appendChild(contributionsGroup.section);

  return card;
}

export function renderMortgageAssumptionsEditor({
  module,
  onPatchInputs,
  status = {},
  readOnly = false
}) {
  const mortgageInputs = module?.generated?.mortgageInputs;
  if (!mortgageInputs) {
    return null;
  }

  const draftValues = status?.draftValues && typeof status.draftValues === 'object' ? status.draftValues : {};
  const errors = status?.errors && typeof status.errors === 'object' ? status.errors : {};
  const card = buildAssumptionsEditorCard({ module, status });
  const inferredTermYears = deriveRemainingTermYears(mortgageInputs);
  const defaultPaymentMode = Number.isFinite(mortgageInputs.fixedPaymentAmount) && mortgageInputs.fixedPaymentAmount > 0
    ? 'fixed'
    : 'calculated';
  const paymentMode = draftValues.fixedPaymentMode === 'fixed' || draftValues.fixedPaymentMode === 'calculated'
    ? draftValues.fixedPaymentMode
    : defaultPaymentMode;
  const usingFixedPayment = paymentMode === 'fixed';

  const loanGroup = buildEditorGroup('Loan & rate');
  loanGroup.grid.appendChild(buildAssumptionField({
    module,
    calculator: 'mortgage',
    fieldKey: 'currentBalance',
    label: 'Current balance',
    placeholder: '€300,000 or 300000',
    value: draftValues.currentBalance ?? formatNumberForInput(mortgageInputs.currentBalance, 2),
    error: errors.currentBalance,
    onPatchInputs,
    readOnly,
    inputMode: 'decimal'
  }).field);
  loanGroup.grid.appendChild(buildAssumptionField({
    module,
    calculator: 'mortgage',
    fieldKey: 'annualInterestRate',
    label: 'Annual interest rate',
    placeholder: '4.25% or 0.0425',
    value: draftValues.annualInterestRate ?? formatRateForInput(mortgageInputs.annualInterestRate),
    error: errors.annualInterestRate,
    onPatchInputs,
    readOnly,
    inputMode: 'decimal'
  }).field);

  const termGroup = buildEditorGroup('Term');
  termGroup.grid.appendChild(buildAssumptionField({
    module,
    calculator: 'mortgage',
    fieldKey: 'remainingTermYears',
    label: 'Remaining term (years)',
    placeholder: '25',
    value: draftValues.remainingTermYears ?? formatNumberForInput(inferredTermYears, 2),
    error: errors.remainingTermYears,
    onPatchInputs,
    readOnly,
    inputMode: 'decimal'
  }).field);

  const overpaymentGroup = buildEditorGroup('Overpayments');
  overpaymentGroup.grid.appendChild(buildAssumptionField({
    module,
    calculator: 'mortgage',
    fieldKey: 'oneOffOverpayment',
    label: 'One-off overpayment',
    placeholder: '10000',
    value: draftValues.oneOffOverpayment ?? formatNumberForInput(mortgageInputs.oneOffOverpayment, 2),
    error: errors.oneOffOverpayment,
    onPatchInputs,
    readOnly,
    inputMode: 'decimal'
  }).field);
  overpaymentGroup.grid.appendChild(buildAssumptionField({
    module,
    calculator: 'mortgage',
    fieldKey: 'annualOverpayment',
    label: 'Annual overpayment',
    placeholder: '3000',
    value: draftValues.annualOverpayment ?? formatNumberForInput(mortgageInputs.annualOverpayment, 2),
    error: errors.annualOverpayment,
    onPatchInputs,
    readOnly,
    inputMode: 'decimal'
  }).field);

  const monthlyPaymentGroup = buildEditorGroup('Monthly payment');
  const modeField = document.createElement('div');
  modeField.className = 'assumptions-editor-field assumptions-editor-payment-mode';

  const modeLabel = document.createElement('label');
  modeLabel.className = 'assumptions-editor-label';
  modeLabel.textContent = 'Payment mode';
  modeField.appendChild(modeLabel);

  const radioRow = document.createElement('div');
  radioRow.className = 'assumptions-editor-radio-row';
  radioRow.dataset.assumptionField = 'fixedPaymentMode';

  const radioName = `mortgage-payment-mode-${module.id}`;

  const calculatedLabel = document.createElement('label');
  calculatedLabel.className = 'assumptions-editor-radio-label';
  const calculatedInput = document.createElement('input');
  calculatedInput.type = 'radio';
  calculatedInput.name = radioName;
  calculatedInput.value = 'calculated';
  calculatedInput.checked = paymentMode === 'calculated';
  calculatedInput.disabled = readOnly;
  calculatedInput.readOnly = readOnly;
  calculatedLabel.appendChild(calculatedInput);
  calculatedLabel.append(' Monthly payment: Calculated');

  const fixedLabel = document.createElement('label');
  fixedLabel.className = 'assumptions-editor-radio-label';
  const fixedInput = document.createElement('input');
  fixedInput.type = 'radio';
  fixedInput.name = radioName;
  fixedInput.value = 'fixed';
  fixedInput.checked = paymentMode === 'fixed';
  fixedInput.disabled = readOnly;
  fixedInput.readOnly = readOnly;
  fixedLabel.appendChild(fixedInput);
  fixedLabel.append(' Monthly payment: Fixed');

  const syncFixedModeState = () => {
    const currentMode = fixedInput.checked ? 'fixed' : 'calculated';
    const fixedPaymentInput = modeField.querySelector('[data-assumption-field="fixedPaymentAmount"]');
    if (fixedPaymentInput) {
      fixedPaymentInput.disabled = readOnly || currentMode !== 'fixed';
      fixedPaymentInput.classList.toggle('is-disabled', currentMode !== 'fixed');
    }
  };

  if (!readOnly && typeof onPatchInputs === 'function') {
    [calculatedInput, fixedInput].forEach((radio) => {
      radio.addEventListener('change', () => {
        syncFixedModeState();
        onPatchInputs({
          moduleId: module.id,
          calculator: 'mortgage',
          field: 'fixedPaymentMode',
          value: fixedInput.checked ? 'fixed' : 'calculated'
        });
      });
    });
  }

  radioRow.appendChild(calculatedLabel);
  radioRow.appendChild(fixedLabel);
  modeField.appendChild(radioRow);

  const modeError = document.createElement('div');
  modeError.className = 'assumptions-editor-error';
  modeError.dataset.assumptionErrorFor = 'fixedPaymentMode';
  modeError.textContent = errors.fixedPaymentMode ? String(errors.fixedPaymentMode) : '';
  modeField.appendChild(modeError);

  const fixedPaymentField = buildAssumptionField({
    module,
    calculator: 'mortgage',
    fieldKey: 'fixedPaymentAmount',
    label: 'Fixed monthly payment',
    placeholder: '1500',
    value: draftValues.fixedPaymentAmount ?? formatNumberForInput(mortgageInputs.fixedPaymentAmount, 2),
    error: errors.fixedPaymentAmount,
    onPatchInputs,
    readOnly: readOnly || !usingFixedPayment,
    inputMode: 'decimal'
  });
  fixedPaymentField.field.classList.add('assumptions-editor-fixed-payment');
  fixedPaymentField.field.classList.toggle('is-disabled', !usingFixedPayment);

  modeField.appendChild(fixedPaymentField.field);
  monthlyPaymentGroup.grid.appendChild(modeField);
  syncFixedModeState();

  card.appendChild(loanGroup.section);
  card.appendChild(termGroup.section);
  card.appendChild(overpaymentGroup.section);
  card.appendChild(monthlyPaymentGroup.section);

  return card;
}

function showLayer(layer) {
  if (!layer) {
    return;
  }

  layer.classList.remove('is-hidden');
  layer.setAttribute('aria-hidden', 'false');
}

function hideLayer(layer) {
  if (!layer) {
    return;
  }

  layer.classList.add('is-hidden');
  layer.setAttribute('aria-hidden', 'true');
}

function buildTableCard(cardTitle, tableData) {
  const card = document.createElement('section');
  card.className = 'generated-card generated-table-card';

  const heading = document.createElement('h3');
  heading.className = 'generated-card-title';
  heading.textContent = cardTitle;

  card.appendChild(heading);

  const columns = Array.isArray(tableData?.columns) ? tableData.columns : [];
  const rows = Array.isArray(tableData?.rows) ? tableData.rows : [];

  if (columns.length === 0 || rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = `No ${cardTitle.toLowerCase()} provided.`;
    card.appendChild(empty);
    return card;
  }

  const wrap = document.createElement('div');
  wrap.className = 'generated-table-wrap';

  const table = document.createElement('table');
  table.className = 'generated-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  columns.forEach((column) => {
    const th = document.createElement('th');
    th.textContent = String(column ?? '');
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    const safeRow = Array.isArray(row) ? row : [];

    columns.forEach((_column, index) => {
      const td = document.createElement('td');
      td.textContent = String(safeRow[index] ?? '');
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);

  return card;
}

function formatBucketedAmount(value) {
  if (!Number.isFinite(value)) {
    return '';
  }

  if (Number.isInteger(value)) {
    return value.toLocaleString();
  }

  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function hasOutputsBucketed(outputsBucketed) {
  return Boolean(
    outputsBucketed &&
    typeof outputsBucketed === 'object' &&
    !Array.isArray(outputsBucketed) &&
    Array.isArray(outputsBucketed.sections) &&
    outputsBucketed.sections.length > 0
  );
}

function isOutputsBucketedPresent(outputsBucketed) {
  return Boolean(
    outputsBucketed &&
    typeof outputsBucketed === 'object' &&
    !Array.isArray(outputsBucketed)
  );
}

function normalizeSectionToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function findOutputsBucketedSection(sections, targetKey) {
  const targetToken = normalizeSectionToken(targetKey);
  return sections.find((section) => (
    normalizeSectionToken(section?.key) === targetToken
    || normalizeSectionToken(section?.title) === targetToken
  )) || null;
}

function sanitizeSectionRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .filter((row) => Array.isArray(row) && row.length >= 2)
    .map((row) => [String(row[0] ?? ''), Number(row[1])])
    .filter((row) => Number.isFinite(row[1]));
}

function buildOutputsBucketedMiniTablesContent(outputsBucketed) {
  const wrap = document.createElement('div');
  wrap.className = 'pbs-bucket-tables';

  const currencySymbol = typeof outputsBucketed.currencySymbol === 'string' && outputsBucketed.currencySymbol.trim()
    ? outputsBucketed.currencySymbol
    : '€';

  outputsBucketed.sections.forEach((section, sectionIndex) => {
    const sectionWrap = document.createElement('article');
    sectionWrap.className = 'pbs-bucket-section';

    const columns = Array.isArray(section.columns) && section.columns.length === 2
      ? section.columns
      : ['Asset', `Amount (${currencySymbol})`];
    const rows = sanitizeSectionRows(section.rows);
    const key = typeof section.key === 'string' ? section.key.toLowerCase() : '';
    const title = typeof section.title === 'string' && section.title.trim()
      ? section.title
      : `Section ${sectionIndex + 1}`;
    const subtotalLabel = typeof section.subtotalLabel === 'string' && section.subtotalLabel.trim()
      ? section.subtotalLabel
      : 'Subtotal';
    const hasSubtotal = Number.isFinite(Number(section.subtotalValue));
    const isSummary = key === 'summary' || title.trim().toLowerCase() === 'summary';

    const table = document.createElement('table');
    table.className = 'generated-table pbs-bucket-table';

    const thead = document.createElement('thead');

    const titleRow = document.createElement('tr');
    titleRow.className = 'pbs-bucket-title-row';
    const titleCell = document.createElement('th');
    titleCell.colSpan = 2;
    titleCell.textContent = title;
    titleRow.appendChild(titleCell);
    thead.appendChild(titleRow);

    const headerRow = document.createElement('tr');
    columns.forEach((column, columnIndex) => {
      const th = document.createElement('th');
      th.textContent = String(column ?? '');
      if (columnIndex === 1) {
        th.classList.add('pbs-amount-col');
      }
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      const label = row[0];
      const amount = row[1];

      const labelCell = document.createElement('td');
      labelCell.textContent = label;
      tr.appendChild(labelCell);

      const amountCell = document.createElement('td');
      amountCell.className = 'pbs-amount-col';
      amountCell.textContent = formatBucketedAmount(amount);
      tr.appendChild(amountCell);

      if (isSummary && normalizeSectionToken(label) === 'networth') {
        tr.classList.add('pbs-net-worth-row');
      }

      tbody.appendChild(tr);
    });

    if (hasSubtotal) {
      const subtotalRow = document.createElement('tr');
      subtotalRow.className = 'pbs-subtotal-row';

      const subtotalLabelCell = document.createElement('td');
      subtotalLabelCell.textContent = subtotalLabel;
      subtotalRow.appendChild(subtotalLabelCell);

      const subtotalValueCell = document.createElement('td');
      subtotalValueCell.className = 'pbs-amount-col';
      subtotalValueCell.textContent = formatBucketedAmount(Number(section.subtotalValue));
      subtotalRow.appendChild(subtotalValueCell);

      tbody.appendChild(subtotalRow);
    }

    table.appendChild(tbody);
    sectionWrap.appendChild(table);

    if (typeof section.notes === 'string' && section.notes.trim()) {
      const note = document.createElement('p');
      note.className = 'pbs-bucket-note';
      note.textContent = section.notes;
      sectionWrap.appendChild(note);
    }

    wrap.appendChild(sectionWrap);
  });

  return wrap;
}

function buildOutputsBucketedDetailCard(section, {
  defaultTitle,
  defaultColumns,
  highlightNetWorth = false
} = {}) {
  const card = document.createElement('section');
  card.className = 'pbs-stacked-card';

  const title = typeof section.title === 'string' && section.title.trim()
    ? section.title
    : defaultTitle;
  const columns = Array.isArray(section.columns) && section.columns.length === 2
    ? section.columns
    : defaultColumns;
  const rows = sanitizeSectionRows(section.rows);
  const subtotalLabel = typeof section.subtotalLabel === 'string' && section.subtotalLabel.trim()
    ? section.subtotalLabel
    : 'Subtotal';
  const hasSubtotal = Number.isFinite(Number(section.subtotalValue));

  const heading = document.createElement('h4');
  heading.className = 'generated-card-title pbs-stacked-title';
  heading.textContent = title;
  card.appendChild(heading);

  const table = document.createElement('table');
  table.className = 'generated-table pbs-bucket-table pbs-detail-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  columns.forEach((column, index) => {
    const th = document.createElement('th');
    th.textContent = String(column ?? '');
    if (index === 1) {
      th.classList.add('pbs-amount-col');
    }
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    const label = row[0];

    const labelCell = document.createElement('td');
    labelCell.textContent = label;
    tr.appendChild(labelCell);

    const amountCell = document.createElement('td');
    amountCell.className = 'pbs-amount-col';
    amountCell.textContent = formatBucketedAmount(row[1]);
    tr.appendChild(amountCell);

    if (highlightNetWorth && normalizeSectionToken(label) === 'networth') {
      tr.classList.add('pbs-net-worth-row');
    }

    tbody.appendChild(tr);
  });

  if (hasSubtotal) {
    const subtotalRow = document.createElement('tr');
    subtotalRow.className = 'pbs-subtotal-row';

    const subtotalLabelCell = document.createElement('td');
    subtotalLabelCell.textContent = subtotalLabel;
    subtotalRow.appendChild(subtotalLabelCell);

    const subtotalValueCell = document.createElement('td');
    subtotalValueCell.className = 'pbs-amount-col';
    subtotalValueCell.textContent = formatBucketedAmount(Number(section.subtotalValue));
    subtotalRow.appendChild(subtotalValueCell);

    tbody.appendChild(subtotalRow);
  }

  table.appendChild(tbody);
  card.appendChild(table);

  return card;
}

function buildOutputsBucketedMatrixContent(outputsBucketed) {
  const sections = outputsBucketed.sections;
  const assetSectionKeys = ['lifestyle', 'liquidity', 'longevity', 'legacy'];
  const assetSections = assetSectionKeys.map((key) => findOutputsBucketedSection(sections, key));

  if (assetSections.some((section) => !section)) {
    return null;
  }

  const outputStack = document.createElement('div');
  outputStack.className = 'pbs-outputs-stack';

  const matrixPanel = document.createElement('section');
  matrixPanel.className = 'pbs-matrix-panel';

  const matrixWrap = document.createElement('div');
  matrixWrap.className = 'pbs-matrix-wrap';

  const matrixTable = document.createElement('table');
  matrixTable.className = 'generated-table pbs-matrix';

  const rowsByBucket = assetSections.map((section) => sanitizeSectionRows(section.rows));
  const rowCount = Math.max(0, ...rowsByBucket.map((rows) => rows.length));

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.className = 'pbs-matrix-head';
  assetSections.forEach((section, index) => {
    const th = document.createElement('th');
    th.textContent = typeof section.title === 'string' && section.title.trim()
      ? section.title
      : assetSectionKeys[index].charAt(0).toUpperCase() + assetSectionKeys[index].slice(1);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  matrixTable.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const tr = document.createElement('tr');

    rowsByBucket.forEach((bucketRows) => {
      const cell = document.createElement('td');
      cell.className = 'pbs-cell';

      const item = bucketRows[rowIndex];
      if (item) {
        const name = document.createElement('div');
        name.className = 'pbs-cell-name';
        name.textContent = item[0];

        const amount = document.createElement('div');
        amount.className = 'pbs-cell-amt';
        amount.textContent = formatBucketedAmount(item[1]);

        cell.appendChild(name);
        cell.appendChild(amount);
      } else {
        cell.classList.add('pbs-cell-empty');
      }

      tr.appendChild(cell);
    });

    tbody.appendChild(tr);
  }
  matrixTable.appendChild(tbody);

  const tfoot = document.createElement('tfoot');
  const subtotalRow = document.createElement('tr');
  subtotalRow.className = 'pbs-subtotal-row';
  assetSections.forEach((section) => {
    const subtotalCell = document.createElement('td');
    const subtotalLabel = document.createElement('div');
    subtotalLabel.className = 'pbs-subtotal-label';
    subtotalLabel.textContent = typeof section.subtotalLabel === 'string' && section.subtotalLabel.trim()
      ? section.subtotalLabel
      : 'Subtotal';

    const subtotalAmount = document.createElement('div');
    subtotalAmount.className = 'pbs-cell-amt pbs-subtotal-amt';
    subtotalAmount.textContent = formatBucketedAmount(Number(section.subtotalValue));

    subtotalCell.appendChild(subtotalLabel);
    subtotalCell.appendChild(subtotalAmount);
    subtotalRow.appendChild(subtotalCell);
  });
  tfoot.appendChild(subtotalRow);
  matrixTable.appendChild(tfoot);

  matrixWrap.appendChild(matrixTable);
  matrixPanel.appendChild(matrixWrap);
  outputStack.appendChild(matrixPanel);

  const currencySymbol = typeof outputsBucketed.currencySymbol === 'string' && outputsBucketed.currencySymbol.trim()
    ? outputsBucketed.currencySymbol
    : '€';

  const liabilitiesSection = findOutputsBucketedSection(sections, 'liabilities');
  if (liabilitiesSection) {
    outputStack.appendChild(buildOutputsBucketedDetailCard(liabilitiesSection, {
      defaultTitle: 'Liabilities',
      defaultColumns: ['Liability', `Amount (${currencySymbol})`]
    }));
  }

  const summarySection = findOutputsBucketedSection(sections, 'summary');
  if (summarySection) {
    outputStack.appendChild(buildOutputsBucketedDetailCard(summarySection, {
      defaultTitle: 'Summary',
      defaultColumns: ['Metric', `Amount (${currencySymbol})`],
      highlightNetWorth: true
    }));
  }

  return outputStack;
}

function buildOutputsBucketedCard(outputsBucketed) {
  const card = document.createElement('section');
  card.className = 'generated-card generated-table-card generated-outputs-bucketed-card';

  const heading = document.createElement('h3');
  heading.className = 'generated-card-title';
  heading.textContent = 'Outputs';
  card.appendChild(heading);

  if (!hasOutputsBucketed(outputsBucketed)) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'No outputs provided.';
    card.appendChild(empty);
    return card;
  }

  const matrixContent = buildOutputsBucketedMatrixContent(outputsBucketed);
  if (matrixContent) {
    card.appendChild(matrixContent);
    return card;
  }

  card.appendChild(buildOutputsBucketedMiniTablesContent(outputsBucketed));
  return card;
}

function buildSummaryCard(summaryHtml) {
  const card = document.createElement('section');
  card.className = 'generated-card generated-summary-card';

  const heading = document.createElement('h3');
  heading.className = 'generated-card-title';
  heading.textContent = 'Summary';

  card.appendChild(heading);

  const content = document.createElement('div');
  content.className = 'generated-summary-content';

  const safeHtml = sanitizeSummaryHtml(summaryHtml || '');

  if (!safeHtml) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'No generated summary yet.';
    content.appendChild(empty);
  } else {
    content.innerHTML = safeHtml;
  }

  card.appendChild(content);

  return card;
}

function buildChartsCard(module, charts, { showPensionToggle = true, readOnly = false } = {}) {
  const card = document.createElement('section');
  card.className = 'generated-card generated-charts-card';

  const heading = document.createElement('h3');
  heading.className = 'generated-card-title';
  heading.textContent = 'Charts';

  card.appendChild(heading);

  if (showPensionToggle && isPensionModule(module)) {
    const showMax = typeof window.__getPensionShowMaxForModule === 'function'
      ? Boolean(window.__getPensionShowMaxForModule(module.id))
      : false;

    const toggle = document.createElement('label');
    toggle.className = 'pension-toggle';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'pension-toggle-input';
    checkbox.checked = showMax;

    const switchTrack = document.createElement('span');
    switchTrack.className = 'pension-toggle-switch';
    switchTrack.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'pension-toggle-text';
    text.textContent = 'Show max personal contributions';

    if (!readOnly) {
      checkbox.addEventListener('change', (event) => {
        if (typeof window.__setPensionShowMax === 'function') {
          window.__setPensionShowMax(module.id, Boolean(event.target.checked));
        }
      });
    } else {
      checkbox.disabled = true;
      toggle.style.opacity = '0.75';
    }

    toggle.appendChild(checkbox);
    toggle.appendChild(switchTrack);
    toggle.appendChild(text);
    card.appendChild(toggle);
  }

  const list = document.createElement('div');
  list.className = 'generated-charts-list';

  if (!Array.isArray(charts) || charts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'generated-empty';
    empty.textContent = 'No charts generated yet.';
    list.appendChild(empty);
  } else {
    charts.forEach((chart, index) => {
      const chartBlock = document.createElement('article');
      chartBlock.className = 'generated-chart-block';
      chartBlock.dataset.chartIndex = String(index);

      const chartTop = document.createElement('div');
      chartTop.className = 'generated-chart-top';

      const title = document.createElement('h4');
      title.className = 'generated-chart-title';
      title.textContent = chart.title || `Chart ${index + 1}`;

      const downloadButton = document.createElement('button');
      downloadButton.type = 'button';
      downloadButton.className = 'chart-download-btn';
      downloadButton.textContent = 'CSV';
      downloadButton.title = 'Download CSV';
      downloadButton.setAttribute('aria-label', `Download CSV for ${title.textContent}`);
      downloadButton.setAttribute('data-chart-download', 'true');

      chartTop.appendChild(title);
      chartTop.appendChild(downloadButton);

      const canvasWrap = document.createElement('div');
      canvasWrap.className = 'generated-chart-canvas-wrap';

      const canvas = document.createElement('canvas');
      canvas.className = 'generated-chart-canvas';
      canvas.height = 220;

      canvasWrap.appendChild(canvas);
      chartBlock.appendChild(chartTop);
      chartBlock.appendChild(canvasWrap);

      list.appendChild(chartBlock);
    });
  }

  card.appendChild(list);

  return card;
}

function buildGeneratedSection(module, {
  showPensionToggle = true,
  readOnly = false,
  onPatchInputs = null,
  assumptionsEditorStatus = null
} = {}) {
  const generated = module.generated || {
    summaryHtml: '',
    assumptions: { columns: [], rows: [] },
    outputs: { columns: [], rows: [] },
    tables: [],
    outputsBucketed: null,
    charts: []
  };

  const section = document.createElement('section');
  section.className = 'generated-section';

  const heading = document.createElement('h2');
  heading.className = 'generated-section-title';
  heading.textContent = 'Generated Content';

  const grid = document.createElement('div');
  grid.className = 'generated-grid';

  grid.appendChild(buildSummaryCard(generated.summaryHtml));
  if (!readOnly && typeof onPatchInputs === 'function' && isPensionModule(module)) {
    const pensionEditor = renderPensionAssumptionsEditor({
      module,
      onPatchInputs,
      status: assumptionsEditorStatus,
      readOnly
    });
    if (pensionEditor) {
      grid.appendChild(pensionEditor);
    }
  }
  if (!readOnly && typeof onPatchInputs === 'function' && !isPensionModule(module) && isMortgageModule(module)) {
    const mortgageEditor = renderMortgageAssumptionsEditor({
      module,
      onPatchInputs,
      status: assumptionsEditorStatus,
      readOnly
    });
    if (mortgageEditor) {
      grid.appendChild(mortgageEditor);
    }
  }
  grid.appendChild(buildTableCard('Assumptions', generated.assumptions));
  if (isOutputsBucketedPresent(generated.outputsBucketed)) {
    grid.appendChild(buildOutputsBucketedCard(generated.outputsBucketed));
  } else {
    grid.appendChild(buildTableCard('Outputs', generated.outputs));
  }
  if (Array.isArray(generated.tables) && generated.tables.length > 0) {
    generated.tables.forEach((table, tableIndex) => {
      const title = typeof table?.title === 'string' && table.title.trim()
        ? table.title
        : `Table ${tableIndex + 1}`;
      grid.appendChild(buildTableCard(title, table));
    });
  }
  grid.appendChild(buildChartsCard(module, generated.charts, { showPensionToggle, readOnly }));

  section.appendChild(heading);
  section.appendChild(grid);

  return section;
}

export function getUiElements() {
  return {
    app: document.getElementById('app'),
    animLayer: document.getElementById('animLayer'),
    toastHost: document.getElementById('toastHost'),
    loadSessionInput: document.getElementById('loadSessionInput'),
    devPanel: document.getElementById('devPanel'),
    devPayloadInput: document.getElementById('devPayloadInput'),
    devExampleSelect: document.getElementById('devExampleSelect'),
    devApplyBtn: document.getElementById('devApplyBtn'),
    devCreateApplyBtn: document.getElementById('devCreateApplyBtn'),
    devLoadExampleBtn: document.getElementById('devLoadExampleBtn'),
    devClearBtn: document.getElementById('devClearBtn'),
    devCloseBtn: document.getElementById('devCloseBtn'),
    clientNameInput: document.getElementById('clientNameInput'),
    greetingHeadline: document.getElementById('greetingHeadline'),
    greetingLayer: document.getElementById('greetingLayer'),
    focusLayer: document.getElementById('focusLayer'),
    overviewLayer: document.getElementById('overviewLayer'),
    swipeStage: document.getElementById('swipeStage'),
    overviewViewport: document.getElementById('overviewViewport'),
    overviewZoomWrap: document.getElementById('overviewZoomWrap'),
    overviewGrid: document.getElementById('overviewGrid'),
    playbookSelect: document.getElementById('playbookSelect'),
    publishSessionButton: document.getElementById('publishSessionBtn'),
    publishModal: document.getElementById('publishModal'),
    publishCloseButton: document.getElementById('publishCloseBtn'),
    publishGenerateButton: document.getElementById('publishGenerateBtn'),
    publishCopyPinButton: document.getElementById('publishCopyPinBtn'),
    publishCopyLinkButton: document.getElementById('publishCopyLinkBtn'),
    publishRevokeButton: document.getElementById('publishRevokeBtn'),
    publishError: document.getElementById('publishError'),
    publishPinInput: document.getElementById('publishPinInput'),
    publishPinHelp: document.getElementById('publishPinHelp'),
    publishPinValue: document.getElementById('publishPinValue'),
    publishLinkValue: document.getElementById('publishLinkValue'),
    publishResult: document.getElementById('publishResult'),
    newCallButton: document.getElementById('newCallBtn'),
    loadSessionButton: document.getElementById('loadSessionBtn'),
    sessionStatus: document.getElementById('sessionStatus'),
    zoomButton: document.getElementById('zoomToggleBtn'),
    newModuleButton: document.getElementById('newModuleBtn'),
    resetButton: document.getElementById('resetBtn'),
    prevArrowButton: document.getElementById('navPrevBtn'),
    nextArrowButton: document.getElementById('navNextBtn')
  };
}

export function renderGreeting(ui, clientName) {
  if (ui.greetingHeadline) {
    ui.greetingHeadline.textContent = `Hello ${clientName || 'Client'}!`;
  }

  if (ui.clientNameInput && ui.clientNameInput.value !== (clientName || '')) {
    ui.clientNameInput.value = clientName || '';
  }
}

export function buildFocusedPane({
  module,
  moduleNumber,
  onTitleInput,
  onNotesInput,
  onPatchInputs = null,
  assumptionsEditorStatus = null,
  readOnly = false,
  showPensionToggle = true
}) {
  const pane = document.createElement('div');
  pane.className = 'focused-pane swipe-pane-content';

  const card = document.createElement('article');
  card.id = 'focusCard';
  card.className = 'module-card focused-module-card';
  card.dataset.moduleId = module.id;

  const meta = document.createElement('div');
  meta.className = 'module-meta';
  meta.textContent = `Module ${moduleNumber}`;

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'module-title-input';
  titleInput.placeholder = 'Untitled Module';
  titleInput.value = module.title || '';
  titleInput.autocomplete = 'off';
  titleInput.readOnly = readOnly;

  const notesInput = document.createElement('textarea');
  notesInput.className = 'module-notes-input';
  notesInput.placeholder = 'Type notes for this module...';
  notesInput.value = module.notes || '';
  notesInput.readOnly = readOnly;

  if (!readOnly) {
    titleInput.addEventListener('input', (event) => {
      onTitleInput(module.id, event.target.value);
    });

    notesInput.addEventListener('input', (event) => {
      onNotesInput(module.id, event.target.value);
    });
  }

  card.appendChild(meta);
  card.appendChild(titleInput);
  card.appendChild(notesInput);
  card.appendChild(buildGeneratedSection(module, {
    showPensionToggle,
    readOnly,
    onPatchInputs,
    assumptionsEditorStatus
  }));
  pane.appendChild(card);

  return pane;
}

export function renderOverview({
  ui,
  modules,
  activeModuleId,
  layout,
  viewportWidth,
  viewportHeight,
  onCardClick
}) {
  ui.overviewGrid.innerHTML = '';

  modules.forEach((module, index) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'module-card overview-card';
    if (module.id === activeModuleId) {
      card.classList.add('is-active');
    }

    card.dataset.moduleId = module.id;

    const label = document.createElement('div');
    label.className = 'overview-meta';
    label.textContent = `#${index + 1} • ${formatLocalTime(module.createdAt)}`;

    const title = document.createElement('h3');
    title.className = 'overview-title';
    title.textContent = module.title?.trim() ? module.title : 'Untitled Module';

    const snippet = document.createElement('p');
    snippet.className = 'overview-snippet';
    snippet.textContent = makeOverviewSnippet(module);

    card.appendChild(label);
    card.appendChild(title);
    card.appendChild(snippet);

    const position = computeGridPosition(index, modules.length, layout.cols);
    card.style.gridColumnStart = String(position.columnStart);
    card.style.gridRowStart = String(position.rowStart);

    card.addEventListener('click', () => onCardClick(module.id, card));

    ui.overviewGrid.appendChild(card);
  });

  applyOverviewLayout(ui.overviewZoomWrap, ui.overviewGrid, layout, viewportWidth, viewportHeight);
}

export function setMode(ui, mode) {
  const greeting = ui.greetingLayer;
  const focus = ui.focusLayer;
  const overview = ui.overviewLayer;

  focus.classList.remove('is-transitioning-in', 'is-transitioning-out');
  overview.classList.remove('is-transitioning-in', 'is-transitioning-out');
  focus.style.opacity = '';
  focus.style.visibility = '';
  focus.style.pointerEvents = '';
  overview.style.opacity = '';
  overview.style.filter = '';
  overview.style.pointerEvents = '';

  focus.classList.remove('layer-active');
  overview.classList.remove('layer-active');

  if (mode === 'greeting') {
    showLayer(greeting);
    hideLayer(focus);
    hideLayer(overview);
    return;
  }

  hideLayer(greeting);

  if (mode === 'overview') {
    hideLayer(focus);
    showLayer(overview);
    overview.classList.add('layer-active');
    return;
  }

  showLayer(focus);
  hideLayer(overview);
  focus.classList.add('layer-active');
}

export function updateControls(ui, {
  mode,
  moduleCount,
  hasPrevious,
  hasNext = false,
  readOnly = false
}) {
  const hasModules = moduleCount > 0;

  if (ui.zoomButton) {
    ui.zoomButton.disabled = !hasModules;
    ui.zoomButton.textContent = mode === 'overview' ? 'Zoom In' : 'Zoom Out';
  }

  if (ui.newModuleButton) {
    ui.newModuleButton.disabled = readOnly;
  }

  if (ui.prevArrowButton) {
    ui.prevArrowButton.classList.toggle('is-hidden', mode !== 'focused');
    ui.prevArrowButton.disabled = !hasPrevious;
  }

  if (ui.nextArrowButton) {
    ui.nextArrowButton.classList.toggle('is-hidden', mode !== 'focused');
    ui.nextArrowButton.disabled = readOnly ? !hasNext : false;
    ui.nextArrowButton.title = readOnly ? 'Next module' : 'New module';
    ui.nextArrowButton.setAttribute('aria-label', readOnly ? 'Next module' : 'New module');
  }
}

export function updateSessionStatus(ui, isDirty) {
  if (!ui.sessionStatus) {
    return;
  }

  ui.sessionStatus.textContent = isDirty ? 'Unsaved changes' : 'Saved locally';
  ui.sessionStatus.classList.toggle('is-dirty', Boolean(isDirty));
}

export function getFocusedCardElement(ui) {
  return ui.swipeStage.querySelector('#focusCard') || ui.swipeStage.querySelector('.focused-module-card');
}

export function getOverviewCardElement(ui, moduleId) {
  return ui.overviewGrid.querySelector(`.overview-card[data-module-id="${moduleId}"]`);
}

export function ensureLayerVisibleForMeasure(layer) {
  layer.classList.remove('is-hidden');
  layer.setAttribute('aria-hidden', 'false');
}
