/**
 * A figure's value as a person reads it. Plain string work, with no locale
 * library, so the register reads the same in Node, the Worker and a browser.
 */

function withCommas(integerText) {
  return integerText.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function euroText(value) {
  const sign = value < 0 ? '-' : '';
  const [whole, cents] = Math.abs(value).toFixed(2).split('.');
  return `${sign}€${withCommas(whole)}${cents === '00' ? '' : `.${cents}`}`;
}

function percentText(value) {
  const text = (value * 100).toFixed(4).replace(/\.?0+$/, '');
  return `${text}%`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function dateText(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** The value as shown, for a unit. */
export function formatFigureValue(value, unit) {
  switch (unit) {
    case 'rate':
      return percentText(value);
    case 'rate_a_year':
      return `${percentText(value)} a year`;
    case 'eur':
      return euroText(value);
    case 'eur_a_week':
      return `${euroText(value)} a week`;
    case 'eur_a_month':
      return `${euroText(value)} a month`;
    case 'eur_a_year':
      return `${euroText(value)} a year`;
    case 'age':
      return `age ${value}`;
    case 'years':
      return `${value} ${value === 1 ? 'year' : 'years'}`;
    case 'months':
      return `${value} ${value === 1 ? 'month' : 'months'}`;
    case 'multiple':
      return `${value} times`;
    case 'year':
      return String(value);
    case 'count':
      return String(value);
    case 'date':
      return dateText(value);
    case 'text':
      return String(value);
    default:
      throw new Error(`Unknown figure unit ${JSON.stringify(unit)}.`);
  }
}
