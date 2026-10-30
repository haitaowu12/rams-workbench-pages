/* Shared engineering canvas controls. No framework or model-authoring dependency. */
(function (root) {
  'use strict';
  const installed = new WeakSet();
  function readingWidth(graphic) {
    const box = graphic.getBoundingClientRect(), view = graphic.viewBox.baseVal;
    return Math.min(box.width, box.height * view.width / view.height);
  }
  function select(canvas, identity) {
    canvas.querySelectorAll('svg [data-select]').forEach(el => {
      const active = el.dataset.select === identity;
      el.classList.toggle('diagram-selected', active);
      el.setAttribute('aria-pressed', String(active));
    });
    canvas.querySelectorAll('[data-edge-from]').forEach(el => {
      el.classList.toggle('diagram-related', [el.dataset.edgeFrom, el.dataset.edgeTo].includes(identity));
    });
  }
  function mount(canvas, source, identity) {
    canvas.innerHTML = source;
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'region');
    canvas.setAttribute('aria-label', 'Engineering diagram; zoom controls above, arrow keys scroll the canvas');
    if (!installed.has(canvas)) {
      canvas.addEventListener('keydown', event => {
        if (['Enter', ' '].includes(event.key) && event.target.matches('svg [data-select]')) {
          event.preventDefault();
          event.target.dispatchEvent(new MouseEvent('click', {bubbles:true}));
        }
      });
      installed.add(canvas);
    }
    select(canvas, identity);
  }
  function scale(canvas, width) {
    const graphic = canvas.querySelector('svg'), natural = graphic.viewBox.baseVal.width;
    const next = Math.max(natural * .25, Math.min(natural * 3, width));
    const old = readingWidth(graphic), oldHeight = old * graphic.viewBox.baseVal.height / natural;
    const centreX = old <= canvas.clientWidth ? .5 : (canvas.scrollLeft + canvas.clientWidth / 2) / old;
    const centreY = oldHeight <= canvas.clientHeight ? oldHeight / (2 * old) : (canvas.scrollTop + canvas.clientHeight / 2) / old;
    graphic.style.width = `${next}px`;
    canvas.scrollLeft = centreX * next - canvas.clientWidth / 2;
    canvas.scrollTop = centreY * next - canvas.clientHeight / 2;
    return `${Math.round(next / natural * 100)}%`;
  }
  function fit(canvas) { canvas.querySelector('svg').style.width = ''; return 'Fit'; }
  function toolbar() {
    return '<span class="diagram-tools" role="group" aria-label="Diagram view"><button type="button" data-diagram-zoom="0.8" aria-label="Zoom out">−</button><output data-diagram-zoom aria-live="polite">Fit</output><button type="button" data-diagram-zoom="1.25" aria-label="Zoom in">+</button><button type="button" data-diagram-size>Actual size</button><button type="button" data-download-diagram>Download SVG</button><button type="button" data-download-diagram-source>Source JSON</button></span>';
  }
  function source(svgText) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const metadata = doc.querySelector('metadata#unified-engineering-source');
    if (!metadata) throw new Error('The diagram has no unified engineering source');
    return JSON.parse(metadata.textContent);
  }
  root.UnifiedEngineeringView = Object.freeze({version:'1.0.0', readingWidth, select, mount, scale, fit, toolbar, source});
})(typeof window === 'undefined' ? globalThis : window);
