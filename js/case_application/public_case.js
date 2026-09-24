/**
 * FROM AN APPLICATION TO A PUBLISHED CASE.
 *
 * The draft Gerry copies into content/cases/<slug>.json. Only rounded figures
 * survive: no name, no email, no lender, and none of the person's own words.
 * The question is left for Gerry to write, because free text is where a person
 * is most likely to identify themselves without meaning to.
 */

import { TOPICS } from './schema.js';
import { applicationToSections } from './writeup.js';

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

function childrenPhrase(app) {
  if (app?.household?.children === 'no') return 'no children';
  if (app?.household?.children !== 'yes') return '';
  const count = Array.isArray(app.children) ? app.children.length : 0;
  if (count === 0) return 'children';
  const word = NUMBER_WORDS[count] || String(count);
  return `${word} ${count === 1 ? 'child' : 'children'}`;
}

function joinWithAnd(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * A working title in the style of a good forum thread: who, then what.
 * "34 and 35, two children: retirement and the mortgage".
 */
export function suggestCaseTitle(app) {
  const ages = [app?.household?.age, app?.household?.partner === 'yes' ? app?.household?.partnerAge : null]
    .filter((age) => typeof age === 'number');
  const who = [ages.join(' and '), childrenPhrase(app)].filter(Boolean).join(', ');
  const chosen = Array.isArray(app?.topics) ? app.topics : [];
  const what = joinWithAnd(TOPICS.filter((topic) => chosen.includes(topic.id) && topic.short).map((topic) => topic.short));
  if (who && what) return `${who}: ${what}`;
  return who || (what ? what.charAt(0).toUpperCase() + what.slice(1) : 'A Planeir case');
}

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '') || 'case';
}

/**
 * The content/cases JSON for a published video. `youtubeId`, `duration`,
 * `summary`, `question` and `covers` are left for Gerry to fill in.
 *
 * A situation line is a string, or `{ label, lines }` for one pension, loan or
 * child, so the case page can show each as its own small list.
 */
export function toPublicCase(app, { publishedDate = '' } = {}) {
  const title = suggestCaseTitle(app);
  const situation = applicationToSections(app, { publicMode: true })
    .map((section) => ({
      heading: section.title,
      lines: section.lines.map((line) => (
        Array.isArray(line.items)
          ? { label: line.label, lines: line.items.map((item) => `${item.label}: ${item.value}`) }
          : `${line.label}: ${line.value}`
      ))
    }))
    .filter((section) => section.lines.length > 0);
  return {
    slug: slugify(title),
    title,
    publishedDate,
    youtubeId: '',
    duration: '',
    topics: Array.isArray(app?.topics) ? [...app.topics] : [],
    summary: '',
    situation,
    question: '',
    covers: []
  };
}
