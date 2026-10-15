const examples = {
  mortgage: {
    label: 'Mortgage', responsive: true,
    caption: 'Compare how extra repayments change the finish date and interest cost.',
    context: 'Actual mortgage module, using fictional figures and stated repayment assumptions.'
  },
  'balance-sheet': {
    label: 'Personal balance sheet', responsive: true,
    caption: 'See how a property sale moves money between assets, cash and debt.',
    context: 'Actual personal balance sheet module, using fictional figures. The sale is an illustrative scenario.'
  },
  'future-cost-fund': {
    label: 'College funding',
    caption: 'Compare four ways to fund €15,000 a year in today’s money for student charges, accommodation and living costs, with inflation included.',
    context: 'A fictional Irish student living away from home, eligible for free tuition. The €15,000 annual budget includes €2,500 student contribution, €8,000 accommodation and utilities, and €4,500 living and study costs. Four years of college start in eight years, with education inflation assumed at 4% a year. Grants, tax relief and student earnings are not deducted. These are sample costs, not a college quote.'
  },
  'household-cash-flow': {
    label: 'Household cash flow',
    caption: 'See how clearing a car loan, adding to pensions or doing both changes one household’s yearly cash flow.',
    context: 'Fictional figures and the app’s estimated 2026 tax. Clearing the car loan uses savings; the upfront payoff must be checked separately. Pension contributions are within the modelled relief limits. This is a one-year comparison.'
  },
  'protection-gap': {
    label: 'Protection gap',
    caption: 'Compare the yearly gap and how long savings last if one income stops.',
    context: 'A separate fictional household. State payments, survivor’s pension, mortgage clearance and lower costs are assumptions, not confirmed entitlements. Savings earn no interest in this comparison.'
  }
};
const version = new URL(import.meta.url).searchParams.get('v');
function asset(name) {
  const url = new URL(`../../assets/examples/${name}`, import.meta.url);
  if (version) url.searchParams.set('v', version);
  return url.href;
}

function mountProductPreview(root) {
  if (!root) return;
  const video = root.querySelector('[data-preview-video]');
  const tabs = [...root.querySelectorAll('[data-preview-module]')];
  const play = root.querySelector('[data-preview-play]');
  const enlarge = root.querySelector('[data-preview-enlarge]');
  const caption = root.querySelector('[data-preview-caption]');
  const panel = root.querySelector('[role="tabpanel"]');
  const dialog = root.querySelector('dialog');
  const enlargedVideo = dialog.querySelector('video');
  const dialogTitle = dialog.querySelector('h2');
  const context = dialog.querySelector('[data-preview-context]');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = matchMedia('(max-width: 700px)');
  let kind = 'mortgage';
  let autoAttempted = false;
  let visible = false;
  let pendingPlay = false;
  let sources = [];

  function setSources(player) {
    player.replaceChildren(...sources.map(({ src, type }) => {
      const source = document.createElement('source');
      source.src = src; source.type = type;
      return source;
    }));
  }

  function updateControls() {
    play.textContent = !video.paused ? 'Pause' : video.ended ? 'Replay' : video.currentTime > 0 ? 'Resume' : 'Play preview';
    play.setAttribute('aria-label', `${play.textContent}: ${examples[kind].label.toLowerCase()} example`);
  }
  async function start({ replay = false } = {}) {
    if (replay || video.ended) video.currentTime = 0;
    try { await video.play(); } catch { updateControls(); }
  }
  function choose(nextKind, { userInitiated = false } = {}) {
    const wasPlaying = !video.paused;
    video.pause();
    kind = nextKind;
    const example = examples[kind];
    const size = mobile.matches ? 'mobile' : 'desktop';
    const stem = `${kind}-preview-${size}`;
    sources = example.responsive
      ? [{ src: asset(`${stem}.mp4`), type: 'video/mp4' }, { src: asset(`${stem}.webm`), type: 'video/webm' }]
      : [{ src: asset(`${kind}.mp4`), type: 'video/mp4' }];
    setSources(video);
    video.poster = asset(example.responsive ? `${stem}-poster.png` : `${kind}-poster.webp`);
    video.width = example.responsive ? (mobile.matches ? 720 : 1440) : 1920;
    video.height = example.responsive && mobile.matches ? 1290 : 1080;
    root.style.setProperty('--preview-aspect', `${video.width} / ${video.height}`);
    video.setAttribute('aria-label', `${example.label} scenario comparison using fictional figures`);
    video.load();
    play.disabled = false;
    caption.textContent = example.caption;
    context.textContent = example.context;
    dialogTitle.textContent = `${example.label} · Fictional figures`;
    enlargedVideo.setAttribute('aria-label', `Enlarged ${example.label.toLowerCase()} example`);
    tabs.forEach(tab => {
      const selected = tab.dataset.previewModule === kind;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      if (selected) panel.setAttribute('aria-labelledby', tab.id);
    });
    updateControls();
    pendingPlay = (userInitiated || wasPlaying) && !motion.matches;
    if (pendingPlay) { autoAttempted = true; if (visible) { pendingPlay = false; start(); } }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => { if (tab.dataset.previewModule !== kind) choose(tab.dataset.previewModule, { userInitiated: true }); });
    tab.addEventListener('keydown', event => {
      const destination = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
      if (destination === null) return;
      event.preventDefault(); tabs[destination].focus();
      if (tabs[destination].dataset.previewModule !== kind) choose(tabs[destination].dataset.previewModule, { userInitiated: true });
    });
  });
  play.addEventListener('click', () => { autoAttempted = true; pendingPlay = false; video.paused ? start() : video.pause(); });
  ['play', 'pause', 'ended', 'loadedmetadata'].forEach(event => video.addEventListener(event, updateControls));
  video.addEventListener('error', () => { play.disabled = true; caption.textContent = 'The example is unavailable. Please try another module.'; });
  enlarge.addEventListener('click', async () => {
    const time = video.currentTime;
    const wasPlaying = !video.paused;
    pendingPlay = false;
    video.pause();
    enlargedVideo.pause(); enlargedVideo.poster = video.poster;
    setSources(enlargedVideo);
    enlargedVideo.onloadedmetadata = () => {
      if (!dialog.open) return;
      enlargedVideo.currentTime = Math.min(time, Math.max(0, enlargedVideo.duration - .04));
      if (wasPlaying) enlargedVideo.play().then(() => { if (!dialog.open) enlargedVideo.pause(); }).catch(() => {});
    };
    enlargedVideo.load(); dialog.showModal();
  });
  dialog.querySelector('[data-preview-close]').addEventListener('click', () => { enlargedVideo.pause(); dialog.close(); });
  dialog.addEventListener('cancel', () => enlargedVideo.pause());
  dialog.addEventListener('close', () => { enlargedVideo.onloadedmetadata = null; enlargedVideo.pause(); enlarge.focus(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pendingPlay ||= !video.paused; video.pause(); enlargedVideo.pause(); }
    else if (pendingPlay && visible && !motion.matches && !dialog.open) { pendingPlay = false; start(); }
  });
  motion.addEventListener('change', () => { if (motion.matches) { pendingPlay = false; video.pause(); } });
  mobile.addEventListener('change', () => choose(kind));
  choose(kind);
  const observer = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting && entries[0].intersectionRatio >= .35;
    if (!visible) { pendingPlay ||= !video.paused; video.pause(); }
    else if (!motion.matches && !document.hidden && !dialog.open && (pendingPlay || !autoAttempted)) {
      autoAttempted = true; pendingPlay = false; start();
    }
  }, { threshold: .35 });
  observer.observe(video);
}

mountProductPreview(document.querySelector('[data-product-preview]'));
