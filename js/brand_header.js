// Keep existing canvas/content offsets aligned when the larger brand wraps controls.
const header = document.querySelector('.topbar');
if (header) {
  const update = () => {
    const height = Math.ceil(header.getBoundingClientRect().height);
    if (height > 0) document.documentElement.style.setProperty(
      '--topbar-height', `${height}px`
    );
  };
  update();
  if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(header);
  else window.addEventListener('resize', update, { passive: true });
}
