/**
 * Which social welfare rate applies on a date, and whether the catalogue is
 * sound. The rates themselves are data in `social_welfare_ie.js`.
 */

import { SOCIAL_WELFARE_SERIES } from './social_welfare_ie.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SERIES_ID = /^ie\.social_welfare(\.[a-z][a-z0-9_]*)+$/;
const STATUSES = ['in_force', 'announced'];
const WEEKS_IN_YEAR = 52;

const BY_ID = new Map(SOCIAL_WELFARE_SERIES.map((series) => [series.id, series]));

export function socialWelfareSeries(id) {
  const series = BY_ID.get(id);
  if (!series) {
    throw new Error(`No social welfare rate has the id ${JSON.stringify(id)}.`);
  }
  return series;
}

/**
 * The rate in force on a date: the last row on or before it.
 *
 * `latest` is true when the row is the last one recorded, so a date after it
 * holds the last rate known rather than one recorded for that date. A date
 * before the first row throws, because no rate is recorded for it.
 */
export function socialWelfareRateOn(id, dateIso) {
  if (!ISO_DATE.test(dateIso ?? '')) {
    throw new Error(`dateIso must be a YYYY-MM-DD date; received ${JSON.stringify(dateIso)}.`);
  }
  const series = socialWelfareSeries(id);
  const row = [...series.rates].reverse().find((candidate) => candidate.effectiveFrom <= dateIso);
  if (!row) {
    throw new Error(`${id} has no rate recorded on or before ${dateIso}.`);
  }
  return Object.freeze({
    id,
    weeklyEur: row.weeklyEur,
    effectiveFrom: row.effectiveFrom,
    status: row.status,
    announcedBy: row.announcedBy ?? null,
    sources: row.sources,
    latest: row === series.rates[series.rates.length - 1]
  });
}

/** What a weekly rate comes to over 52 weeks, to the cent. A comparison, not a forecast. */
export function socialWelfareAnnualEur(weeklyEur) {
  return Number((weeklyEur * WEEKS_IN_YEAR).toFixed(2));
}

/** Problems with one series, as strings. An empty list means it is sound. */
export function socialWelfareSeriesProblems(series) {
  const problems = [];
  const add = (message) => problems.push(`${series?.id ?? 'series'}: ${message}`);
  if (typeof series?.id !== 'string' || !SERIES_ID.test(series.id)) add('id must look like ie.social_welfare.<scheme>.<band>.');
  if (typeof series?.label !== 'string' || series.label.trim() === '') add('needs a plain label.');
  if (typeof series?.scheme !== 'string' || series.scheme.trim() === '') add('needs the scheme name.');
  if (!Array.isArray(series?.rates) || series.rates.length === 0) {
    add('needs at least one rate.');
    return problems;
  }
  series.rates.forEach((row, index) => {
    const where = `rate ${index}`;
    if (!ISO_DATE.test(row.effectiveFrom ?? '')) add(`${where}.effectiveFrom must be a date.`);
    if (index > 0 && row.effectiveFrom <= series.rates[index - 1].effectiveFrom) add(`${where} must start after the one before it.`);
    if (typeof row.weeklyEur !== 'number' || !(row.weeklyEur > 0)) add(`${where}.weeklyEur must be a positive number.`);
    if (!STATUSES.includes(row.status)) add(`${where}.status must be ${STATUSES.join(' or ')}.`);
    if (!ISO_DATE.test(row.verifiedOn ?? '')) add(`${where}.verifiedOn must be a date.`);
    if (row.status === 'announced' && (typeof row.announcedBy !== 'string' || !ISO_DATE.test(row.announcedOn ?? ''))) {
      add(`${where} is announced, so it needs announcedBy and announcedOn.`);
    }
    if (!Array.isArray(row.sources) || row.sources.length === 0) {
      add(`${where} needs a source.`);
    } else {
      row.sources.forEach((source) => {
        if (!source.title || !/^https:\/\/www\.gov\.ie\/|^https:\/\/www\.citizensinformation\.ie\//.test(source.url ?? '')) {
          add(`${where} has a source that is not a gov.ie or Citizens Information page.`);
        }
        if (/[?&]utm_/.test(source.url ?? '')) add(`${where} has a source url with tracking parameters.`);
      });
    }
  });
  return problems;
}
