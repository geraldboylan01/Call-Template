/**
 * Consumer analysis → published client-session bundle.
 *
 * WHY THIS IS A MAPPING AND NOT A RENDERER
 *
 * The viewer the client needs already exists. `app/session.html` carries the
 * same `#overviewGrid` / `.overview-zoom-wrap` shell as the advisor workspace,
 * loads Chart.js, and renders through `js/session_viewer.js` →
 * `importPublishedSession` → `js/render.js`. That is the zoomed-out map of
 * modules with a drill-in per module, read-only.
 *
 * And the data already exists. `createModuleRunResult`
 * (js/planning/adapters/common.js) returns `assumptions`, `outputs`, `tables`
 * and `charts` on every module run, in exactly the shapes `normalizeTable`,
 * `normalizeGeneratedTables` and `normalizeCharts` consume — the planning
 * adapters were written to feed this renderer. A liquidity chart comes out as
 * `{ id, title, type: 'bar', labels, datasets }` and needs no translation at
 * all. The consumer results view simply never routed there, and
 * `views.js` was dropping `tables` and `charts` on the floor.
 *
 * So this file builds a SESSION-SHAPED object and hands it to the existing
 * `exportPublishedSession` / `exportSession`. Reusing those is the point: it is
 * what guarantees the bundle stays byte-compatible with the viewer as the
 * session schema moves, instead of this module drifting into a second, subtly
 * different definition of a module.
 *
 * NOTHING HERE ENCRYPTS OR PUBLISHES. Encryption is `encryptPublishedSessionV4`
 * in js/crypto_session.js and runs in the browser, so the Worker never sees the
 * client's plaintext analysis. This module is pure and has no I/O, which is why
 * it can be asserted on offline.
 */

import { consumerLanguageForModule } from '../planning/module_offers.js';
import { getResultItems } from './views.js';

/** The client link stays open for this long unless it is revoked sooner. */
export const PUBLISHED_ANALYSIS_EXPIRY_DAYS = 90;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

/**
 * Everything reaching `summaryHtml` is escaped.
 *
 * The summary is deterministic server-generated copy, not authored markup, and
 * the viewer renders `summaryHtml` as HTML. Escaping here means a stray angle
 * bracket in a module summary can never become markup in the client's viewer.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resultOf(item) {
  const nested = asObject(item?.result);
  return nested && !item?.outputs ? { ...item, ...nested } : item;
}

function moduleIdOf(item) {
  return String(firstDefined(item?.moduleId, item?.id, item?.module?.id, '') || '');
}

/** Client-facing description only. An internal module id is never a title. */
function titleFor(moduleId) {
  const description = consumerLanguageForModule(moduleId)?.shortDescription;
  return String(description || 'Your analysis');
}

function summaryTextOf(result) {
  return String(firstDefined(
    result?.summary,
    result?.resultSummary,
    result?.headline,
    result?.description,
    ''
  ) || '').trim();
}

function warningTextsOf(result) {
  return (Array.isArray(result?.warnings) ? result.warnings : [])
    .map((warning) => (typeof warning === 'string'
      ? warning
      : String(firstDefined(warning?.message, warning?.text, warning?.reason, '') || '')))
    .map((text) => text.trim())
    .filter(Boolean);
}

/**
 * `normalizeGenerated` has no slot for warnings, so a module's caveats would be
 * silently dropped from the published copy. Fold them into the summary instead —
 * an assumption the client cannot see is worse than a slightly longer summary.
 */
function summaryHtmlFor(result) {
  const parts = [];
  const summary = summaryTextOf(result);
  if (summary) parts.push(`<p>${escapeHtml(summary)}</p>`);
  const warnings = warningTextsOf(result);
  if (warnings.length > 0) {
    parts.push(`<ul>${warnings.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`);
  }
  return parts.join('');
}

function tableOf(value) {
  const table = asObject(value);
  if (!table) return { columns: [], rows: [] };
  return {
    columns: Array.isArray(table.columns) ? table.columns : [],
    rows: Array.isArray(table.rows) ? table.rows : []
  };
}

/**
 * One completed module run as a session module.
 *
 * `assumptions`, `outputs`, `tables` and `charts` pass straight through: the
 * adapters already emit the shapes the session normalisers consume. Everything
 * else in `generated` is filled by `createEmptyGenerated()` downstream.
 */
function toSessionModule(item, timestamp) {
  const result = resultOf(item);
  const moduleId = moduleIdOf(item);
  const calculatedAt = String(firstDefined(result?.calculatedAt, result?.completedAt, timestamp));
  return {
    id: moduleId,
    createdAt: calculatedAt,
    updatedAt: calculatedAt,
    title: titleFor(moduleId),
    generated: {
      summaryHtml: summaryHtmlFor(result),
      assumptions: tableOf(result?.assumptions),
      outputs: tableOf(result?.outputs),
      tables: Array.isArray(result?.tables) ? result.tables : [],
      charts: Array.isArray(result?.charts) ? result.charts : []
    }
  };
}

/**
 * Build the session object for a completed consumer analysis.
 *
 * `order` is the module set the client actually confirmed, so the overview grid
 * opens in the order the meeting agreed rather than whatever order the engines
 * happened to finish in. Anything confirmed but absent from the results is
 * dropped — the grid must not offer a module with nothing behind it.
 *
 * `sessionId` is deliberately a caller argument rather than something derived
 * from the consumer session: the consumer's own id is credential-bearing and
 * must not travel inside a published bundle. Omitting it lets the session layer
 * mint one, which needs `window.crypto` — so pass one to keep this deterministic
 * and offline-testable.
 *
 * @param {object} analysis The consumer analysis payload as the browser holds it.
 * @param {{clientName?: string, order?: string[], nowIso?: string, sessionId?: string}} [options]
 */
export function buildPublishedAnalysisSession(analysis, options = {}) {
  const timestamp = String(options.nowIso || new Date().toISOString());
  const items = getResultItems(analysis);
  const modulesById = new Map();
  for (const item of items) {
    const sessionModule = toSessionModule(item, timestamp);
    // A module id is unique within an analysis; if a payload repeats one, the
    // later run is the current one.
    if (sessionModule.id) modulesById.set(sessionModule.id, sessionModule);
  }

  const confirmed = (Array.isArray(options.order) ? options.order : [])
    .map((moduleId) => String(moduleId || ''))
    .filter((moduleId) => modulesById.has(moduleId));
  const ordered = [...new Set([...confirmed, ...modulesById.keys()])];

  return {
    ...(options.sessionId ? { sessionId: String(options.sessionId) } : {}),
    clientName: String(options.clientName || 'Client'),
    createdAt: timestamp,
    updatedAt: timestamp,
    modules: ordered.map((moduleId) => modulesById.get(moduleId)),
    order: ordered,
    activeModuleId: ordered[0] || null
  };
}

/** Whether there is anything worth publishing yet. */
export function publishedAnalysisHasModules(analysis) {
  return buildPublishedAnalysisSession(analysis).modules.length > 0;
}
