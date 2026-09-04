const surface = document.getElementById('surface');
const textSize = document.getElementById('text-size');
const frame = document.getElementById('surface-frame');
let loadId = 0;

async function load() {
  const id = ++loadId;
  const url = new URL(`../${surface.value}`, location.href);
  const html = await fetch(url, { cache: 'no-store' }).then(response => response.text());
  if (id !== loadId) return;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, iframe, meta[http-equiv], base').forEach(node => node.remove());
  doc.querySelectorAll('[onload], [onclick], [onsubmit]').forEach(node => {
    node.removeAttribute('onload'); node.removeAttribute('onclick'); node.removeAttribute('onsubmit');
  });
  // This is only inert QA markup, never a bypass of the live app's authentication.
  doc.body.classList.remove('is-auth-locked', 'advisor-gate-pending');
  const base = doc.createElement('base'); base.href = url.href; doc.head.prepend(base);
  doc.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
    const css = new URL(link.getAttribute('href'), url);
    css.searchParams.set('brand-preview', String(id));
    link.href = css.href;
  });
  frame.onload = () => {
    const view = frame.contentWindow;
    const root = frame.contentDocument;
    root.addEventListener('click', event => event.preventDefault());
    root.addEventListener('submit', event => event.preventDefault());
    if (textSize.value === '200') {
      const fonts = [...root.querySelectorAll('body, body *')].map(node => [node, parseFloat(view.getComputedStyle(node).fontSize)]);
      fonts.forEach(([node, size]) => node.style.setProperty('font-size', `${size * 2}px`, 'important'));
    }
    const header = root.querySelector('.topbar, .site-header, .plan-header');
    const update = () => {
      if (header?.matches('.topbar, .site-header')) root.documentElement.style.setProperty(
        header.matches('.topbar') ? '--topbar-height' : '--header-offset',
        `${Math.ceil(header.getBoundingClientRect().height) + (header.matches('.site-header') ? (view.innerWidth >= 900 ? 18 : 14) : 0)}px`
      );
      const width = root.documentElement.clientWidth;
      const rect = node => node?.getBoundingClientRect().toJSON();
      document.getElementById('measurements').textContent = JSON.stringify({
        surface: surface.value, text: textSize.value, viewport: width,
        header: rect(header), image: rect(header?.querySelector('img')),
        content: [...root.querySelectorAll('.main-viewport,.access-manager-main,.analytics-main,.module-catalogue-shell')]
          .map(node => ({ className: node.className, rect: rect(node), scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflowY: view.getComputedStyle(node).overflowY })),
        overflow: [...header?.querySelectorAll('a,button,input,select') ?? []]
          .filter(node => {
            const box = node.getBoundingClientRect();
            return box.width > 0 && (box.left < -1 || box.right > width + 1);
          }).map(node => ({ label: node.textContent.trim() || node.getAttribute('aria-label'), rect: rect(node) })),
      }, null, 2);
    };
    update();
    if (header) new view.ResizeObserver(update).observe(header);
  };
  frame.srcdoc = `<!doctype html>${doc.documentElement.outerHTML}`;
}
surface.addEventListener('change', load);
textSize.addEventListener('change', load);
void load();
