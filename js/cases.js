/**
 * Topic filters on the case gallery. The page works without this script:
 * every case is listed, and the filters only narrow the list.
 */

const buttons = [...document.querySelectorAll('.case-filter')];
const cards = [...document.querySelectorAll('#caseGrid .case-card')];
const empty = document.getElementById('caseFilterEmpty');

function show(topic) {
  buttons.forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.topic === topic ? 'true' : 'false');
  });
  let visible = 0;
  cards.forEach((card) => {
    const topics = (card.dataset.topics || '').split(' ');
    const match = !topic || topics.includes(topic);
    card.hidden = !match;
    if (match) visible += 1;
  });
  if (empty) empty.hidden = visible > 0;
}

buttons.forEach((button) => {
  button.addEventListener('click', () => {
    const topic = button.dataset.topic || '';
    show(topic);
    const url = new URL(window.location.href);
    if (topic) url.searchParams.set('topic', topic);
    else url.searchParams.delete('topic');
    window.history.replaceState(null, '', url);
  });
});

const requested = new URLSearchParams(window.location.search).get('topic') || '';
if (requested && buttons.some((button) => button.dataset.topic === requested)) {
  show(requested);
}
