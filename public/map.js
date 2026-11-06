// Rendu SVG de la carte : mise en page dagre de gauche à droite, déplacement et zoom de la vue.
/* global dagre */

const NS = 'http://www.w3.org/2000/svg';
const NODE_W = 210;
const ROOT_W = 210;
const PAD_X = 12;
const LINE_H = 18;
const FONT = '14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const ROOT_FONT = '600 15px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const LABELS = {
  racine: 'Séance',
  question: 'Question',
  proposition: 'Proposition',
  pour: 'Pour',
  contre: 'Contre',
  décision: 'Décision',
  action: 'Action',
};

const measureCtx = document.createElement('canvas').getContext('2d');

function wrap(text, font, width) {
  measureCtx.font = font;
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (measureCtx.measureText(candidate).width <= width || !line) line = candidate;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function svgEl(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
}

/**
 * @param {SVGSVGElement} svg
 * @param {{ onSelect: (id: string|null) => void, onHover: (id: string|null, ev?: PointerEvent) => void }} handlers
 */
export function createMap(svg, handlers) {
  const viewport = svgEl('g', { class: 'viewport' }, svg);
  let t = { x: 20, y: 20, k: 1 };
  let follow = true;
  let bounds = { width: 0, height: 0 };
  let known = null;

  const apply = () => viewport.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`);

  function fit() {
    const r = svg.getBoundingClientRect();
    if (!bounds.width || !r.width) return;
    // En dessous de 0,5 le texte devient illisible : on préfère laisser déborder et faire défiler.
    const k = Math.min(1, (r.width - 40) / bounds.width, (r.height - 40) / bounds.height);
    t = { k: Math.max(k, 0.5), x: 0, y: 0 };
    t.x = Math.max(20, (r.width - bounds.width * t.k) / 2);
    t.y = Math.max(20, (r.height - bounds.height * t.k) / 2);
    apply();
  }

  function zoomAt(factor, px, py) {
    const k = Math.min(2.5, Math.max(0.15, t.k * factor));
    t.x = px - ((px - t.x) * k) / t.k;
    t.y = py - ((py - t.y) * k) / t.k;
    t.k = k;
    follow = false;
    apply();
  }

  // Déplacement de la vue et sélection au clic.
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y, moved: false, target: e.target };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    follow = false;
    svg.classList.add('is-panning');
    t.x = drag.tx + dx;
    t.y = drag.ty + dy;
    apply();
  });
  svg.addEventListener('pointerup', () => {
    if (drag && !drag.moved) {
      const g = drag.target.closest?.('[data-id]');
      handlers.onSelect(g ? g.dataset.id : null);
    }
    drag = null;
    svg.classList.remove('is-panning');
  });
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );
  new ResizeObserver(() => follow && fit()).observe(svg);

  function render(state, { selected, highlight }) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 12, ranksep: 44, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));

    const nodes = [...state.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const boxes = new Map();
    for (const n of nodes) {
      const isRoot = n.type === 'racine';
      const w = isRoot ? ROOT_W : NODE_W;
      const lines = wrap(n.text, isRoot ? ROOT_FONT : FONT, w - 2 * PAD_X);
      const h = 30 + lines.length * LINE_H + 10;
      boxes.set(n.id, { w, h, lines });
      g.setNode(n.id, { width: w, height: h });
    }
    for (const n of nodes) if (n.parent && boxes.has(n.parent)) g.setEdge(n.parent, n.id);
    dagre.layout(g);
    const gg = g.graph();
    bounds = { width: gg.width ?? 0, height: gg.height ?? 0 };

    const fresh = known ? new Set(nodes.filter((n) => !known.has(n.id)).map((n) => n.id)) : new Set();
    known = new Set(nodes.map((n) => n.id));

    viewport.replaceChildren();
    const edges = svgEl('g', { class: 'edges' }, viewport);
    for (const n of nodes) {
      if (!n.parent || !boxes.has(n.parent)) continue;
      const a = g.node(n.parent);
      const b = g.node(n.id);
      const x1 = a.x + a.width / 2;
      const x2 = b.x - b.width / 2;
      const dx = Math.max(24, (x2 - x1) / 2);
      svgEl(
        'path',
        { d: `M${x1},${a.y} C${x1 + dx},${a.y} ${x2 - dx},${b.y} ${x2},${b.y}`, class: `edge t-${n.type}` },
        edges,
      );
    }

    for (const n of nodes) {
      const p = g.node(n.id);
      const { w, h, lines } = boxes.get(n.id);
      const cls = ['node', `t-${n.type}`];
      if (n.id === selected) cls.push('is-selected');
      if (n.id === highlight) cls.push('is-highlight');
      if (fresh.has(n.id)) cls.push('is-new');
      const grp = svgEl(
        'g',
        { class: cls.join(' '), 'data-id': n.id, transform: `translate(${p.x - w / 2},${p.y - h / 2})`, tabindex: '0' },
        viewport,
      );
      svgEl('rect', { width: w, height: h, rx: 8 }, grp);
      svgEl('rect', { class: 'stripe', width: 5, height: h, rx: 2 }, grp);
      const label = svgEl('text', { class: 'type', x: PAD_X, y: 19 }, grp);
      label.textContent = LABELS[n.type] + (n.sources?.length ? ' ·' : '');
      if (n.sources?.length) {
        const src = svgEl('tspan', { class: 'src' }, label);
        src.textContent = ` ${n.sources.length} extrait${n.sources.length > 1 ? 's' : ''}`;
      }
      const body = svgEl('text', { class: n.type === 'racine' ? 'text root' : 'text', x: PAD_X, y: 40 }, grp);
      lines.forEach((l, i) => {
        const ts = svgEl('tspan', { x: PAD_X, dy: i ? LINE_H : 0 }, body);
        ts.textContent = l;
      });
      grp.addEventListener('pointerenter', (e) => handlers.onHover(n.id, e));
      grp.addEventListener('pointermove', (e) => handlers.onHover(n.id, e));
      grp.addEventListener('pointerleave', () => handlers.onHover(null));
      grp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handlers.onSelect(n.id);
        }
      });
    }

    if (follow) fit();
    else apply();
  }

  return {
    render,
    fit() {
      follow = true;
      fit();
    },
    zoom(factor) {
      const r = svg.getBoundingClientRect();
      zoomAt(factor, r.width / 2, r.height / 2);
    },
  };
}
