import { Capture, captureSupport } from './capture.js';
import { createMap, LABELS } from './map.js';

const TYPES = ['question', 'proposition', 'pour', 'contre', 'décision', 'action'];
const ALLOWED_PARENTS = {
  question: ['racine', 'proposition'],
  proposition: ['question'],
  pour: ['proposition'],
  contre: ['proposition'],
  décision: ['question'],
  action: ['décision', 'proposition'],
};

const sessionId = location.pathname.split('/').pop();
const key = new URLSearchParams(location.search).get('k') ?? '';
const clientId = (() => {
  try {
    let id = localStorage.getItem('carte-reunion-client');
    if (!id) localStorage.setItem('carte-reunion-client', (id = crypto.randomUUID().replaceAll('-', '')));
    return id;
  } catch {
    return crypto.randomUUID().replaceAll('-', '');
  }
})();

let state = null;
let role = 'guest';
let guestKey = null;
let chunkSeconds = 25;
let selected = null;
let highlight = null;
let capture = null;

const $ = (sel) => document.querySelector(sel);

/** Petit constructeur de DOM : h('button', { class: 'x', onclick }, 'texte', enfant…) */
function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

function toast(msg, kind = 'error') {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}

async function api(method, path, body) {
  const res = await fetch(`/api/sessions/${sessionId}${path}${path.includes('?') ? '&' : '?'}k=${encodeURIComponent(key)}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
  return data;
}

async function act(fn) {
  try {
    await fn();
  } catch (e) {
    toast(e.message);
  }
}

// ---------------------------------------------------------------- règles de la carte

const live = () => state?.status === 'live';
const nodeById = (id) => state.nodes.find((n) => n.id === id);
const proposalById = (id) => state.proposals.find((p) => p.id === id);
const childrenOf = (id) => state.nodes.filter((n) => n.parent === id);

function descendantsOf(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of state.nodes) if (n.parent && out.has(n.parent) && !out.has(n.id)) out.add(n.id), (grew = true);
  }
  return out;
}

const childTypesFor = (parentType) => TYPES.filter((t) => ALLOWED_PARENTS[t].includes(parentType));
const parentsFor = (type, exclude = new Set()) =>
  state.nodes.filter((n) => ALLOWED_PARENTS[type].includes(n.type) && !exclude.has(n.id));

function typesFor(node) {
  const parent = nodeById(node.parent);
  return TYPES.filter(
    (t) => ALLOWED_PARENTS[t].includes(parent?.type) && childrenOf(node.id).every((c) => ALLOWED_PARENTS[c.type].includes(t)),
  );
}

const short = (t, n = 60) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const optionLabel = (n) => (n.type === 'racine' ? `Séance : ${short(n.text)}` : `${LABELS[n.type]} : ${short(n.text)}`);

// ---------------------------------------------------------------- carte

const map = createMap($('#map'), {
  onSelect(id) {
    selected = id;
    renderMap();
    renderPanel(true);
  },
  onHover(id, ev) {
    const tip = $('#tooltip');
    const n = id && nodeById(id);
    const segs = n?.sources.map((s) => state.segments[s]).filter(Boolean) ?? [];
    if (!n || !segs.length || !ev) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren(...segs.map((s) => h('blockquote', {}, s.text)));
    tip.hidden = false;
    const pane = $('#map-pane').getBoundingClientRect();
    const x = Math.min(ev.clientX - pane.left + 16, pane.width - tip.offsetWidth - 8);
    const y = Math.min(ev.clientY - pane.top + 16, pane.height - tip.offsetHeight - 8);
    tip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  },
});

function renderMap() {
  map.render(state, { selected, highlight });
}

// ---------------------------------------------------------------- file des propositions

let queueKey = '';
function renderQueue(force = false) {
  const list = $('#queue');
  // Ne pas reconstruire la file pendant qu'on y choisit un parent.
  if (!force && list.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') {
    list.dataset.stale = '1';
    return;
  }
  const k = JSON.stringify([state.proposals, state.nodes.map((n) => [n.id, n.type, n.text]), state.status]);
  if (!force && k === queueKey) return;
  queueKey = k;
  delete list.dataset.stale;

  $('#queue-count').textContent = state.proposals.length || '';
  const inQueue = new Set(state.proposals.map((p) => p.id));
  // Les plus anciennes d'abord : une nouvelle fournée s'ajoute en bas sans déplacer les cartes.
  const byAge = (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id, 'fr', { numeric: true });
  const roots = state.proposals.filter((p) => !p.parent || !inQueue.has(p.parent)).sort(byAge);

  const build = (p) => {
    const parentText = p.parent ? (nodeById(p.parent)?.text ?? p.parent) : null;
    const ck = JSON.stringify([p, parentText, parentsFor(p.type).map((n) => [n.id, n.text]), live()]);
    let c = cards.get(p.id);
    if (!c || c.k !== ck) {
      c = { k: ck, li: h('li', { class: `proposal t-${p.type}`, 'data-id': p.id }, proposalCard(p)), ol: h('ol') };
      cards.set(p.id, c);
    }
    const kids = state.proposals.filter((q) => q.parent === p.id).sort(byAge).map(build);
    syncChildren(c.ol, kids);
    if (kids.length && c.ol.parentNode !== c.li) c.li.append(c.ol);
    if (!kids.length) c.ol.remove();
    return c.li;
  };
  syncChildren(list, roots.map(build));
  for (const id of cards.keys()) if (!inQueue.has(id)) cards.delete(id);
  $('#queue-empty').hidden = state.proposals.length > 0;
}

/** Cartes déjà construites, réutilisées tant que la proposition ne change pas (un clic en cours n'est pas perdu). */
const cards = new Map();

/** Met les enfants d'un élément dans l'ordre voulu en ne touchant qu'aux éléments déplacés. */
function syncChildren(parent, els) {
  els.forEach((el, i) => {
    if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] ?? null);
  });
  while (parent.children.length > els.length) parent.lastElementChild.remove();
}

function proposalCard(p) {
  const parentNode = p.parent ? nodeById(p.parent) : null;
  const parentProposal = p.parent ? proposalById(p.parent) : null;
  const options = parentsFor(p.type);
  const select = h(
    'select',
    { class: 'parent-select', 'aria-label': 'Rattacher à', disabled: !live() },
    parentProposal ? h('option', { value: '' }, `Sous la proposition au-dessus`) : null,
    !p.parent ? h('option', { value: '' }, 'À rattacher : choisis un parent') : null,
    options.map((n) => h('option', { value: n.id, selected: n.id === parentNode?.id }, optionLabel(n))),
  );
  const segs = p.sources.map((s) => state.segments[s]).filter(Boolean);

  return h(
    'article',
    {
      onpointerenter: () => setHighlight(parentNode?.id ?? null),
      onpointerleave: () => setHighlight(null),
    },
    h('header', {}, h('span', { class: 'badge' }, LABELS[p.type]), !p.parent ? h('span', { class: 'warn' }, 'à rattacher') : null),
    h('p', { class: 'ptext' }, p.text),
    h('label', { class: 'parent' }, h('span', {}, 'Sous'), select),
    segs.length
      ? h('details', { class: 'extract' }, h('summary', {}, `Extrait${segs.length > 1 ? 's' : ''}`), segs.map((s) => h('blockquote', {}, s.text)))
      : null,
    live()
      ? h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              class: 'primary',
              title: parentProposal ? 'Accepte aussi la proposition parente' : undefined,
              onclick: () =>
                act(async () => {
                  const chosen = select.value;
                  await api('POST', `/proposals/${p.id}/accept`, chosen && chosen !== p.parent ? { parent: chosen } : {});
                }),
            },
            'Accepter',
          ),
          h('button', { onclick: () => act(() => api('POST', `/proposals/${p.id}/reject`)) }, 'Rejeter'),
        )
      : null,
  );
}

function setHighlight(id) {
  if (highlight === id) return;
  highlight = id;
  renderMap();
}

$('#node-panel').addEventListener('focusout', () => {
  setTimeout(() => {
    if ($('#node-panel').dataset.stale && !$('#node-panel').contains(document.activeElement)) renderPanel(true);
  });
});

$('#queue').addEventListener('focusout', () => {
  setTimeout(() => {
    if ($('#queue').dataset.stale && !$('#queue').contains(document.activeElement)) renderQueue(true);
  });
});

// ---------------------------------------------------------------- panneau du nœud sélectionné

let panelKey = '';
function renderPanel(force = false) {
  const panel = $('#node-panel');
  const n = selected && nodeById(selected);
  if (!n) {
    panel.hidden = true;
    panelKey = '';
    return;
  }
  const k = JSON.stringify([n, state.status, childrenOf(n.id).map((c) => c.type), state.nodes.length]);
  if (!force && k === panelKey) return;
  // Ne pas écraser une saisie en cours : on redessinera en sortant du panneau.
  if (!force && panel.contains(document.activeElement)) {
    panel.dataset.stale = '1';
    return;
  }
  delete panel.dataset.stale;
  panelKey = k;
  panel.hidden = false;

  const isRoot = n.type === 'racine';
  const ro = !live();
  const text = h('textarea', { rows: 3, maxlength: 140, disabled: ro }, n.text);
  const save = () => {
    const v = text.value.trim();
    if (v && v !== n.text) act(() => api('PATCH', `/nodes/${n.id}`, { text: v }));
  };
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      text.blur();
    }
    if (e.key === 'Escape') {
      text.value = n.text;
      text.blur();
    }
  });
  text.addEventListener('blur', save);

  const typeSelect = h(
    'select',
    { disabled: ro, onchange: (e) => act(() => api('PATCH', `/nodes/${n.id}`, { type: e.target.value })) },
    typesFor(n).map((t) => h('option', { value: t, selected: t === n.type }, LABELS[t])),
  );
  const parentSelect = h(
    'select',
    { disabled: ro, onchange: (e) => act(() => api('PATCH', `/nodes/${n.id}`, { parent: e.target.value })) },
    isRoot ? [] : parentsFor(n.type, descendantsOf(n.id)).map((p) => h('option', { value: p.id, selected: p.id === n.parent }, optionLabel(p))),
  );

  const childTypes = childTypesFor(n.type);
  const childType = h('select', { 'aria-label': 'Type du nouveau nœud' }, childTypes.map((t) => h('option', { value: t }, LABELS[t])));
  const childText = h('input', { type: 'text', maxlength: 140, placeholder: 'Une phrase', 'aria-label': 'Texte du nouveau nœud' });
  const addChild = (e) => {
    e.preventDefault();
    const v = childText.value.trim();
    if (!v) return;
    act(async () => {
      const created = await api('POST', '/nodes', { type: childType.value, text: v, parent: n.id });
      childText.value = '';
      childText.blur();
      selected = created.id;
      if (nodeById(created.id)) {
        renderMap();
        renderPanel(true);
      }
    });
  };

  const segs = n.sources.map((s) => state.segments[s]).filter(Boolean);
  const count = descendantsOf(n.id).size - 1;

  panel.replaceChildren(
    h(
      'header',
      {},
      h('span', { class: `badge t-${n.type}` }, LABELS[n.type]),
      h(
        'button',
        {
          class: 'icon',
          'aria-label': 'Fermer',
          onclick: () => {
            selected = null;
            renderMap();
            renderPanel(true);
          },
        },
        '×',
      ),
    ),
    h('label', {}, h('span', {}, isRoot ? 'Titre de la séance' : 'Texte'), text),
    isRoot ? null : h('div', { class: 'row' }, h('label', {}, h('span', {}, 'Type'), typeSelect), h('label', {}, h('span', {}, 'Sous'), parentSelect)),
    segs.length ? h('details', { class: 'extract', open: true }, h('summary', {}, 'Extraits de la transcription'), segs.map((s) => h('blockquote', {}, s.text))) : null,
    !ro && childTypes.length
      ? h('form', { class: 'add-child', onsubmit: addChild }, h('span', { class: 'label' }, 'Ajouter dessous'), h('div', { class: 'row' }, childType, childText), h('button', { type: 'submit' }, 'Ajouter'))
      : null,
    !ro && !isRoot
      ? h(
          'button',
          {
            class: 'danger',
            onclick: () => {
              if (count && !confirm(`Supprimer ce nœud et ses ${count} descendant(s) ?`)) return;
              act(async () => {
                await api('DELETE', `/nodes/${n.id}`);
                selected = null;
              });
            },
          },
          count ? `Supprimer avec ses ${count} descendant(s)` : 'Supprimer',
        )
      : null,
  );
}

// ---------------------------------------------------------------- en-tête, transcription, indicateurs

function renderHeader() {
  document.title = `${state.title} · Carte de réunion`;
  $('#title').textContent = state.title;
  const st = $('#status');
  st.textContent = state.status === 'live' ? 'En cours' : 'Close';
  st.className = `pill ${state.status}`;
  $('#closed-banner').hidden = state.status === 'live';
  for (const b of document.querySelectorAll('.host-only')) b.hidden = role !== 'host';
  $('#close-btn').hidden = role !== 'host' || state.status !== 'live';
  $('#capture-box').hidden = role !== 'host' || state.status !== 'live';
  if (state.status !== 'live' && capture?.status.running) capture.stop('Séance close.');
  const errs = state.stats.sttErrors;
  $('#stt-errors').textContent = errs ? `${errs} tranche${errs > 1 ? 's' : ''} perdue${errs > 1 ? 's' : ''}` : '';
}

function renderRecent() {
  const box = $('#recent');
  box.replaceChildren(...(state.recent.length ? state.recent.map((r) => h('p', {}, r.text)) : [h('p', { class: 'muted' }, 'Rien pour l’instant.')]));
}

function renderStats() {
  const s = state.stats;
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '–');
  const rows = [
    ['Propositions', s.proposalsCreated],
    ['Acceptées sans retouche', `${s.acceptedUnchanged} (${pct(s.acceptedUnchanged, s.proposalsCreated)})`],
    ['Acceptées, rejetées', `${s.accepted}, ${s.rejected}`],
    ['Délai propos → proposition', s.latency.count ? `${s.latency.avg} s en moyenne, ${s.latency.max} s au plus` : '–'],
    ['Participants ayant agi', s.guestActors],
    ['Audio transcrit', `${Math.round(s.audioSeconds / 60)} min, ${s.chunks} tranche(s), ${s.sttErrors} perdue(s)`],
    ['Cycles LLM', `${s.llmCycles}${s.llmErrors ? `, ${s.llmErrors} en échec` : ''}`],
    ['Coût', `${s.costEurTotal.toFixed(3)} €`],
  ];
  $('#stats').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]));
}

function render() {
  if (selected && !nodeById(selected)) selected = null;
  renderHeader();
  renderMap();
  renderQueue();
  renderPanel();
  renderRecent();
  renderStats();
}

// ---------------------------------------------------------------- animateur

function setupHost() {
  const guestUrl = `${location.origin}/s/${sessionId}?k=${guestKey}`;
  $('#share-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(guestUrl);
      toast('Lien participants copié.', 'ok');
    } catch {
      prompt('Lien à partager avec les participants :', guestUrl);
    }
  });
  $('#close-btn').addEventListener('click', () => {
    if (!confirm('Clore la séance ? La capture s’arrête et la carte est figée.')) return;
    act(() => api('POST', '/close'));
  });

  const unsupported = captureSupport();
  const btn = $('#capture-btn');
  if (unsupported) {
    btn.disabled = true;
    $('#capture-status').textContent = unsupported;
    return;
  }
  btn.addEventListener('click', async () => {
    if (capture?.status.running) {
      capture.stop();
      return;
    }
    capture = new Capture({
      chunkSeconds,
      upload: async (blob, seq, durationMs) => {
        const form = new FormData();
        form.set('file', blob, `tranche-${seq}.webm`);
        form.set('seq', String(seq));
        form.set('durationMs', String(durationMs));
        const res = await fetch(`/api/sessions/${sessionId}/audio?k=${encodeURIComponent(key)}`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },
      onStatus: renderCapture,
      onEnd: (reason) => reason && toast(reason, 'ok'),
    });
    try {
      await capture.start();
    } catch (e) {
      if (e.name !== 'NotAllowedError') toast(e.message);
      capture = null;
      renderCapture({ running: false });
    }
  });
}

function renderCapture(s) {
  const btn = $('#capture-btn');
  btn.textContent = s.running ? 'Arrêter la capture' : 'Capturer';
  btn.classList.toggle('recording', s.running);
  $('#level').style.setProperty('--level', s.running ? Math.min(1, Math.sqrt(s.level ?? 0) * 3).toFixed(2) : 0);
  $('#capture-status').textContent = s.running
    ? `${s.sent} tranche(s) envoyée(s) · ${s.silent} silence(s)${s.failed ? ` · ${s.failed} échec(s) d’envoi` : ''}${s.micOk ? '' : ' · micro non autorisé'}`
    : '';
}

// ---------------------------------------------------------------- démarrage

function connect() {
  const es = new EventSource(`/api/sessions/${sessionId}/events?k=${encodeURIComponent(key)}`);
  es.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    $('#offline').hidden = true;
    render();
  });
  es.addEventListener('error', () => {
    $('#offline').hidden = false;
  });
}

async function init() {
  try {
    const [data, cfg] = await Promise.all([api('GET', ''), fetch('/api/config').then((r) => r.json())]);
    state = data;
    role = data.role;
    guestKey = data.guestKey;
    chunkSeconds = cfg.chunkSeconds;
  } catch (e) {
    document.body.replaceChildren(h('main', { class: 'fatal' }, h('h1', {}, 'Séance inaccessible'), h('p', {}, e.message)));
    return;
  }
  $('#export-md').href = `/api/sessions/${sessionId}/export?format=md&k=${encodeURIComponent(key)}`;
  $('#export-json').href = `/api/sessions/${sessionId}/export?format=json&k=${encodeURIComponent(key)}`;
  $('#zoom-in').addEventListener('click', () => map.zoom(1.25));
  $('#zoom-out').addEventListener('click', () => map.zoom(0.8));
  $('#fit').addEventListener('click', () => map.fit());
  if (role === 'host') setupHost();
  render();
  connect();
}

init();
