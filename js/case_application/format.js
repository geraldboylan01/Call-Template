/**
 * Reading and writing the figures people type into an application.
 *
 * People write money the way they say it: "35k", "€35,000", "1.2m". A form
 * that rejects those makes the person do arithmetic to get past it, so the
 * parser accepts them and the page shows back what it understood.
 */

const MONEY_MAX = 1_000_000_000;

const moneyFormatter = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
  minimumFractionDigits: 0
});

/**
 * Parse a typed money amount. Returns a number, null for an empty entry, or
 * NaN when the text is not a figure the page can read.
 */
export function parseMoney(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input >= 0 && input <= MONEY_MAX ? roundCents(input) : Number.NaN;
  }
  const text = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/euros?|eur/g, '')
    .replace(/[€\s,]/g, '');
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(text);
  if (!match) return Number.NaN;
  let value = Number.parseFloat(match[1]);
  if (match[2] === 'k') value *= 1_000;
  if (match[2] === 'm') value *= 1_000_000;
  if (!Number.isFinite(value) || value > MONEY_MAX) return Number.NaN;
  return roundCents(value);
}

/**
 * Parse a percentage or rate. "4.2", "4.2%" and "4,2" all mean 4.2.
 */
export function parsePercent(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : Number.NaN;
  }
  const text = String(input ?? '').trim().replace(/%/g, '').replace(/\s/g, '');
  if (!text) return null;
  const normalized = /^\d+,\d{1,3}$/.test(text) ? text.replace(',', '.') : text;
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return Number.NaN;
  return Number.parseFloat(normalized);
}

/** Parse a whole number such as an age or a count of years. */
export function parseWhole(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? Math.round(input) : Number.NaN;
  }
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (!/^\d+(?:\.\d+)?$/.test(text)) return Number.NaN;
  return Math.round(Number.parseFloat(text));
}

/** Parse a number of years, allowing halves: "22.5". */
export function parseYears(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : Number.NaN;
  }
  const text = String(input ?? '').trim().replace(',', '.');
  if (!text) return null;
  if (!/^\d+(?:\.\d+)?$/.test(text)) return Number.NaN;
  return Math.round(Number.parseFloat(text) * 10) / 10;
}

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

export function formatMoney(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return moneyFormatter.format(Math.round(value));
}

export function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const rounded = Math.round(value * 100) / 100;
  return `${rounded}%`;
}

export function formatYears(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return value === 1 ? '1 year' : `${value} years`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/** "2027-03" becomes "March 2027". */
export function formatMonth(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
  if (!match) return '';
  const month = Number(match[2]);
  if (month < 1 || month > 12) return '';
  return `${MONTH_NAMES[month - 1]} ${match[1]}`;
}

/**
 * Round money for a published case, so a figure cannot be matched to a
 * statement. Large amounts move in bigger steps than small ones. Monthly
 * amounts move in steps of €50. Nothing above zero rounds down to zero,
 * because "€0 a month" says something the person never said.
 */
export function roundPublicMoney(value, { monthly = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  let step;
  if (monthly) step = 50;
  else if (value >= 100_000) step = 5_000;
  else if (value >= 10_000) step = 1_000;
  else step = 100;
  const rounded = Math.round(value / step) * step;
  return value > 0 && rounded === 0 ? step : rounded;
}
