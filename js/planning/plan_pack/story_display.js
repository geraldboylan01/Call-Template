/** Native modules sometimes round a displayed result before rendering it. */
export const shownMoneyValue = shown => typeof shown === 'number' ? shown : Number(String(shown).replace(/[^0-9.-]/g, ''));

/** Person-facing story displays; calculation values retain their precision. */
export function storyDisplay(value, unit) {
  if (['EUR', 'EUR/year', 'EUR/month'].includes(unit)) return new Intl.NumberFormat('en-IE', {
    style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(Math.abs(value) < 0.005 ? 0 : value);
  if (unit === 'date') return new Intl.DateTimeFormat('en-IE', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
  }).format(new Date(value + 'T00:00:00Z'));
  if (unit === 'ratio') return new Intl.NumberFormat('en-IE', { style: 'percent', maximumFractionDigits: 2 }).format(value);
  if (unit === 'list') return value.length ? value.map(row => typeof row === 'string' ? row : row.label ?? row.title ?? row.text ?? row.message ?? row.id).join(', ') : 'None';
  if (unit === 'year' || unit === 'text') return String(value);
  return new Intl.NumberFormat('en-IE', { maximumFractionDigits: 2 }).format(value);
}
