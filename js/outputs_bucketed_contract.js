/**
 * The payload contract for `generated.outputsBucketed`, including the PBS
 * scenario array and its movement metadata.
 *
 * This is the app's front door: a payload it rejects renders as nothing, and a
 * payload it accepts is what the client sees. It lives apart from `app.js` so
 * the contract can be exercised without a browser -- `app.js` reaches for
 * `window` at import time, so a rule that only exists in there is a rule that
 * cannot be tested.
 *
 * Rejection is deliberate here. `js/state.js` holds the tolerant twin used when
 * an already published session is imported: reject on the way in, tolerate on
 * the way back out.
 */

import { MAX_PBS_SCENARIO_ALTERNATIVES } from './scenario_cap.js';

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

export function validateOutputsBucketedScenariosPayload(scenarios, label) {
  if (scenarios === undefined) {
    return [];
  }

  if (!Array.isArray(scenarios)) {
    throw new Error(`${label} must be an array when provided.`);
  }

  // `Current position` is injected by the renderer rather than sent, so the
  // number in this message counts alternatives, which is what the payload
  // actually contains.
  if (scenarios.length > MAX_PBS_SCENARIO_ALTERNATIVES) {
    throw new Error(
      `${label} supports at most ${MAX_PBS_SCENARIO_ALTERNATIVES} alternatives; received ${scenarios.length}.`
    );
  }

  const usedIds = new Set();

  return scenarios.map((scenario, scenarioIndex) => {
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
      throw new Error(`${label}[${scenarioIndex}] must be an object.`);
    }

    // A repeated id breaks case selection, which finds a case by id: the
    // second alternative becomes unreachable and clicking it shows the first.
    const id = typeof scenario.id === 'string' && scenario.id.trim()
      ? scenario.id.trim()
      : `scenario-${scenarioIndex + 1}`;
    if (usedIds.has(id)) {
      throw new Error(`${label}[${scenarioIndex}].id must be unique.`);
    }
    usedIds.add(id);

    return {
      id,
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

export function validateOutputsBucketedPayload(outputsBucketed, label = 'generated.outputsBucketed') {
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