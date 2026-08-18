/**
 * One vocabulary for "the module did not produce a result".
 *
 * The deterministic layer used to report every such outcome as a single opaque
 * `module_run_failed`, which the Worker then re-read as "the client still owes
 * us information". A module that crashes on a complete profile is not a client
 * who has not answered yet, and telling them apart is the difference between a
 * useful recovery and asking for a fact the client already gave.
 *
 * Two audiences, kept deliberately apart:
 *   - `code` plus `detail` are for us. `detail` is an engine message and may
 *     name fields, contracts and internal invariants, so it stays server-side.
 *   - `clientFailureMessage(code)` is for the client. It says what happened in
 *     plain terms and never carries a field name, a contract or a stack.
 */

export const MODULE_FAILURE_CODES = Object.freeze({
  /** Generated engine input broke the module's own schema or invariants. */
  INPUT_INVALID: 'module_input_invalid',
  /** Input was accepted; the engine threw while calculating. */
  EXECUTION_FAILED: 'module_execution_failed',
  /** The module was selected but its readiness never reached a runnable state. */
  READINESS_NOT_MET: 'readiness_not_met',
  /** A known state the deterministic layer deliberately declines to calculate. */
  UNSUPPORTED_STATE: 'unsupported_state',
  /** Nothing above matched; treat as a defect and read `detail`. */
  UNKNOWN: 'unknown_module_failure'
});

export const MODULE_FAILURE_CODE_VALUES = Object.freeze(Object.values(MODULE_FAILURE_CODES));

/** A failure that already knows which phase it came from. */
export class ModuleFailureError extends Error {
  constructor(code, moduleId, detail, cause = undefined) {
    super(detail);
    this.name = 'ModuleFailureError';
    this.code = MODULE_FAILURE_CODE_VALUES.includes(code) ? code : MODULE_FAILURE_CODES.UNKNOWN;
    this.moduleId = moduleId || null;
    this.detail = detail;
    if (typeof cause !== 'undefined') this.cause = cause;
  }
}

export function isModuleFailureCode(value) {
  return typeof value === 'string' && MODULE_FAILURE_CODE_VALUES.includes(value);
}

/**
 * Read the code a failure already carries. Anything unlabelled is `UNKNOWN`
 * rather than a guess: message sniffing is how a classifier silently starts
 * lying when an engine reworks its wording.
 */
export function classifyModuleFailure(error) {
  if (error instanceof ModuleFailureError) return error.code;
  if (isModuleFailureCode(error?.code)) return error.code;
  return MODULE_FAILURE_CODES.UNKNOWN;
}

/** The internal diagnostic. Never hand this to a client. */
export function moduleFailureDetail(error) {
  if (typeof error?.detail === 'string' && error.detail) return error.detail;
  if (typeof error?.message === 'string' && error.message) return error.message;
  return String(error);
}

const CLIENT_MESSAGES = Object.freeze({
  [MODULE_FAILURE_CODES.INPUT_INVALID]:
    'One of the figures behind that analysis does not add up yet, so it did not run. Nothing has been lost — we can go back over that part.',
  [MODULE_FAILURE_CODES.EXECUTION_FAILED]:
    'That analysis could not be completed just now. Everything you have told me is saved and we can come back to it.',
  [MODULE_FAILURE_CODES.READINESS_NOT_MET]:
    'That analysis is still waiting on something, so it has not run yet.',
  [MODULE_FAILURE_CODES.UNSUPPORTED_STATE]:
    'That analysis is not something I can work out automatically in this situation, so it needs a proper adviser review.',
  [MODULE_FAILURE_CODES.UNKNOWN]:
    'That analysis did not complete. Everything you have told me is saved and we can come back to it.'
});

/**
 * Client-safe wording for a failure code. Deliberately free of field names,
 * contract text and stack detail: the client hears what it means for them,
 * and the engine message stays in the server-side record.
 */
export function clientFailureMessage(code) {
  return CLIENT_MESSAGES[code] || CLIENT_MESSAGES[MODULE_FAILURE_CODES.UNKNOWN];
}

/**
 * Pick the failure that should drive the spoken recovery when several modules
 * failed at once. Order is "most diagnosable first": a broken input contract is
 * a real defect worth surfacing ahead of a module that merely was not ready.
 */
const CODE_PRIORITY = Object.freeze([
  MODULE_FAILURE_CODES.INPUT_INVALID,
  MODULE_FAILURE_CODES.EXECUTION_FAILED,
  MODULE_FAILURE_CODES.UNSUPPORTED_STATE,
  MODULE_FAILURE_CODES.UNKNOWN,
  MODULE_FAILURE_CODES.READINESS_NOT_MET
]);

export function primaryModuleFailure(failures) {
  const candidates = (Array.isArray(failures) ? failures : []).filter((item) => isModuleFailureCode(item?.code));
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (left, right) => CODE_PRIORITY.indexOf(left.code) - CODE_PRIORITY.indexOf(right.code)
  )[0];
}

/** True when at least one failure is a defect rather than an open question. */
export function hasBlockingModuleFailure(failures) {
  return (Array.isArray(failures) ? failures : []).some((item) => (
    isModuleFailureCode(item?.code) && item.code !== MODULE_FAILURE_CODES.READINESS_NOT_MET
  ));
}
