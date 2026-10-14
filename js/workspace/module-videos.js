const section = document.querySelector('.module-videos-section');
const dialog = section?.querySelector('dialog');

if (dialog && typeof dialog.showModal === 'function') {
  const video = dialog.querySelector('video');
  const title = dialog.querySelector('#moduleVideoTitle');
  const context = dialog.querySelector('#moduleVideoContext');
  const error = dialog.querySelector('[data-module-video-error]');
  const fallback = dialog.querySelector('[data-module-video-fallback]');
  let opener;
  const notes = {
    collegeVideoTitle: 'A fictional Irish student living away from home, eligible for free tuition. The €15,000 annual budget includes €2,500 student contribution, €8,000 accommodation and utilities, and €4,500 living and study costs. Four years of college start in eight years. Education inflation is assumed at 4% a year. Grants, tax relief and student earnings are not deducted. These are sample costs, not a college quote.',
    cashFlowVideoTitle: 'Fictional figures and the app’s estimated 2026 tax. Clearing the car loan uses savings; the upfront payoff must be checked separately. Pension contributions are within the modelled relief limits. This is a one-year comparison.',
    protectionVideoTitle: 'A separate fictional household. State payments, survivor’s pension, mortgage clearance and lower costs are assumptions, not confirmed entitlements. Savings earn no interest in this comparison.'
  };

  section.querySelectorAll('[data-module-video]').forEach(link => {
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      opener = link;
      const titleId = link.getAttribute('aria-labelledby');
      title.textContent = link.querySelector('h3').textContent;
      context.textContent = notes[titleId];
      error.hidden = true;
      fallback.href = link.href;
      video.poster = link.querySelector('img').currentSrc || link.querySelector('img').src;
      video.setAttribute('aria-label', `${title.textContent} — silent example using fictional figures`);
      video.src = link.href;
      dialog.showModal();
      video.play().catch(() => { if (dialog.open && video.error) error.hidden = false; });
    });
  });
  video.addEventListener('error', () => { if (dialog.open) error.hidden = false; });
  dialog.querySelector('[data-module-video-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
    opener?.focus({ preventScroll: true });
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) video.pause(); });
}
