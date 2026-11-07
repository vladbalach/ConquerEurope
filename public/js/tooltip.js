// Custom tooltips. Any element with a `title` shows it at once in a styled box, instead of the browser's
// slow, plain native tooltip. On first hover the title moves to `data-tip`, so the native one never appears;
// code can keep setting `title` as usual. Text may contain line breaks (\n).
const GAP = 8;          // px between the element and the tooltip
const EDGE = 6;         // px kept free at the window edges

let tip = null;
let target = null;
let timer = 0;

function textOf(el) {
  if (el.hasAttribute('title')) {
    el.dataset.tip = el.getAttribute('title');
    el.removeAttribute('title');
  }
  return el.dataset.tip || '';
}

// Above the element, centred; below it when there is no room above. Always inside the window.
function place() {
  const r = target.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  let y = r.top - h - GAP;
  if (y < EDGE) y = r.bottom + GAP;
  x = Math.max(EDGE, Math.min(window.innerWidth - w - EDGE, x));
  y = Math.max(EDGE, Math.min(window.innerHeight - h - EDGE, y));
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function show(el) {
  const text = textOf(el);
  if (!text) { hide(); return; }
  target = el;
  tip.textContent = text;
  tip.hidden = false;
  place();
  clearInterval(timer);
  timer = setInterval(watch, 150);
}

function hide() {
  target = null;
  if (tip) tip.hidden = true;
  clearInterval(timer);
}

// The HUD rebuilds and relabels elements while the mouse rests on them.
function watch() {
  if (!target || !target.isConnected || target.closest('[hidden]')) { hide(); return; }
  const text = textOf(target);
  if (!text) { hide(); return; }
  if (text !== tip.textContent) tip.textContent = text;
  place();
}

export function initTooltips() {
  if (tip) return;
  tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);

  document.addEventListener('pointerover', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[title], [data-tip]') : null;
    if (el === target) return;
    if (el) show(el);
    else hide();
  });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) hide(); });   // left the window
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
}
