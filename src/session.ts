import { randomBytes } from 'node:crypto';
import {
  ALLOWED_PARENTS,
  MAX_TEXT,
  NODE_TYPES,
  type AnyNodeType,
  type MapNode,
  type NodeType,
  type Proposal,
  type Role,
  type Segment,
  type Session,
} from './types.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const ROOT_ID = 'n_0';
const MAX_REJECTED_MEMORY = 30;

const nowIso = () => new Date().toISOString();

export function isNodeType(t: unknown): t is NodeType {
  return typeof t === 'string' && (NODE_TYPES as readonly string[]).includes(t);
}

export function canAttach(child: NodeType, parent: AnyNodeType): boolean {
  return ALLOWED_PARENTS[child].includes(parent);
}

/** Une phrase, espaces normalisés, 140 caractères au plus (coupe au dernier mot). */
export function normalizeText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const t = raw.replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_TEXT) return t;
  const cut = t.slice(0, MAX_TEXT - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, '') + '…';
}

/** Clé de comparaison pour repérer les doublons. */
export function textKey(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function wordCount(t: string): number {
  return t.split(/\s+/).filter(Boolean).length;
}

export function newKey(): string {
  return randomBytes(18).toString('base64url');
}

export function createSession(title: string): Session {
  const t = normalizeText(title);
  if (!t) throw new ApiError(400, 'Le titre est obligatoire.');
  const now = nowIso();
  return {
    id: 's_' + randomBytes(5).toString('hex'),
    title: t,
    status: 'live',
    createdAt: now,
    lastActivityAt: now,
    nodes: [{ id: ROOT_ID, type: 'racine', text: t, parent: null, speaker: null, sources: [], createdAt: now }],
    links: [],
    proposals: [],
    transcript: [],
    rejected: [],
    stats: {
      audioSeconds: 0,
      chunks: 0,
      sttErrors: 0,
      llmCycles: 0,
      llmErrors: 0,
      proposalsCreated: 0,
      accepted: 0,
      acceptedEdited: 0,
      rejected: 0,
      latencies: [],
      costEur: { stt: 0, llm: 0 },
      tokens: { input: 0, output: 0 },
      actors: {},
    },
    seq: { node: 0, proposal: 0, segment: 0, link: 0 },
    llmCursor: 0,
    keys: { host: newKey(), guest: newKey() },
  };
}

export function touch(s: Session): void {
  s.lastActivityAt = nowIso();
}

function assertLive(s: Session): void {
  if (s.status !== 'live') throw new ApiError(409, 'La séance est close.');
}

export function getNode(s: Session, id: string): MapNode | undefined {
  return s.nodes.find((n) => n.id === id);
}

function getProposal(s: Session, id: string): Proposal | undefined {
  return s.proposals.find((p) => p.id === id);
}

/** Type de la cible d'un rattachement : nœud de la carte ou proposition en file. */
function targetType(s: Session, id: string): AnyNodeType | undefined {
  return getNode(s, id)?.type ?? getProposal(s, id)?.type;
}

function descendants(s: Session, id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of s.nodes) {
      if (n.parent && out.has(n.parent) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Remet à « à rattacher » une proposition dont le parent n'existe plus ou ne convient plus. */
function revalidateProposalParent(s: Session, p: Proposal): void {
  if (p.parent === null) return;
  const t = targetType(s, p.parent);
  if (!t || !canAttach(p.type, t)) p.parent = null;
}

export function recordActor(s: Session, clientId: string | undefined, role: Role): void {
  if (!clientId || !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) return;
  // L'animateur garde son rôle même s'il agit depuis le lien participant.
  if (s.stats.actors[clientId] === 'host') return;
  s.stats.actors[clientId] = role;
}

// ---------------------------------------------------------------- transcription

export function addSegment(s: Session, text: string, start: Date, end: Date): Segment {
  const seg: Segment = {
    id: `t_${++s.seq.segment}`,
    seq: s.seq.segment,
    start: start.toISOString(),
    end: end.toISOString(),
    text,
    speaker: null,
  };
  s.transcript.push(seg);
  touch(s);
  return seg;
}

// ---------------------------------------------------------------- propositions du LLM

export interface RawProposal {
  type?: unknown;
  text?: unknown;
  parent?: unknown;
  sources?: unknown;
}

/**
 * Valide et ajoute un lot de propositions. `parent` peut être un id de nœud (n_…),
 * une proposition en file (p_…) ou l'index d'une proposition précédente du même lot.
 * Un parent introuvable ou incompatible donne une proposition « à rattacher ».
 */
export function addProposals(s: Session, raw: RawProposal[], cycle = 0, now = new Date()): Proposal[] {
  const known = new Map<string, string | null>();
  for (const n of s.nodes) known.set(textKey(n.text), n.id);
  for (const p of s.proposals) known.set(textKey(p.text), p.id);
  for (const r of s.rejected) known.set(textKey(r.text), null);

  const segIds = new Map(s.transcript.map((t) => [t.id, t]));
  const batchIds: (string | null)[] = [];
  const added: Proposal[] = [];

  raw.forEach((r, i) => {
    const text = normalizeText(r.text);
    if (!isNodeType(r.type) || !text) {
      batchIds.push(null);
      return;
    }
    const key = textKey(text);
    if (known.has(key)) {
      // Déjà dans la carte, en file ou rejeté : on ne le repropose pas,
      // mais les enfants du lot peuvent s'y rattacher.
      batchIds.push(known.get(key) ?? null);
      return;
    }

    let parent: string | null = null;
    const rp = r.parent;
    const idx =
      typeof rp === 'number' ? rp : typeof rp === 'string' && /^#?\d+$/.test(rp) ? Number(rp.replace('#', '')) : NaN;
    if (Number.isInteger(idx)) {
      if (idx >= 0 && idx < i) parent = batchIds[idx] ?? null;
    } else if (typeof rp === 'string' && (getNode(s, rp) || getProposal(s, rp))) {
      parent = rp;
    }
    if (parent) {
      const t = targetType(s, parent);
      if (!t || !canAttach(r.type, t)) parent = null;
    }

    const sources = Array.isArray(r.sources)
      ? [...new Set(r.sources.filter((x): x is string => typeof x === 'string' && segIds.has(x)))]
      : [];
    const lastStart = sources
      .map((id) => Date.parse(segIds.get(id)!.start))
      .reduce((a, b) => Math.max(a, b), -Infinity);
    const latencyS = Number.isFinite(lastStart) ? Math.round((now.getTime() - lastStart) / 1000) : null;

    const p: Proposal = {
      id: `p_${++s.seq.proposal}`,
      type: r.type,
      text,
      parent,
      sources,
      createdAt: now.toISOString(),
      cycle,
      latencyS,
    };
    s.proposals.push(p);
    added.push(p);
    batchIds.push(p.id);
    known.set(key, p.id);
    s.stats.proposalsCreated++;
    if (latencyS !== null) s.stats.latencies.push(latencyS);
  });

  if (added.length) touch(s);
  return added;
}

// ---------------------------------------------------------------- actions des participants

/**
 * Accepte une proposition. Si son parent est lui-même une proposition en file,
 * toute la chaîne est acceptée. Tout est vérifié avant la moindre écriture.
 */
export function acceptProposal(s: Session, pid: string, parentOverride?: string): MapNode {
  assertLive(s);
  const p = getProposal(s, pid);
  if (!p) throw new ApiError(404, 'Proposition introuvable, elle a peut-être déjà été traitée.');

  const chain: Proposal[] = [p];
  let anchorId: string | null;
  if (parentOverride) {
    if (!getNode(s, parentOverride)) throw new ApiError(400, 'Le parent choisi doit être un nœud de la carte.');
    anchorId = parentOverride;
  } else {
    anchorId = p.parent;
    while (anchorId && anchorId.startsWith('p_')) {
      const up = getProposal(s, anchorId);
      if (!up || chain.includes(up)) {
        anchorId = null;
        break;
      }
      chain.unshift(up);
      anchorId = up.parent;
    }
  }
  if (!anchorId) throw new ApiError(400, 'Choisis où rattacher cette proposition.');
  const anchor = getNode(s, anchorId);
  if (!anchor) throw new ApiError(409, 'Le parent suggéré n’existe plus. Choisis un autre rattachement.');

  let parentType: AnyNodeType = anchor.type;
  for (const c of chain) {
    if (!canAttach(c.type, parentType)) {
      throw new ApiError(409, `Un nœud « ${c.type} » ne peut pas être rattaché à « ${parentType} ».`);
    }
    parentType = c.type;
  }

  let parentId = anchor.id;
  let last!: MapNode;
  for (const c of chain) {
    const node: MapNode = {
      id: `n_${++s.seq.node}`,
      type: c.type,
      text: c.text,
      parent: parentId,
      speaker: null,
      sources: c.sources,
      createdAt: nowIso(),
      proposedText: c.text,
    };
    s.nodes.push(node);
    s.proposals = s.proposals.filter((x) => x.id !== c.id);
    for (const q of s.proposals) if (q.parent === c.id) q.parent = node.id;
    s.stats.accepted++;
    parentId = node.id;
    last = node;
  }
  touch(s);
  return last;
}

export function rejectProposal(s: Session, pid: string): void {
  assertLive(s);
  const p = getProposal(s, pid);
  if (!p) throw new ApiError(404, 'Proposition introuvable, elle a peut-être déjà été traitée.');
  s.proposals = s.proposals.filter((x) => x.id !== pid);
  for (const q of s.proposals) {
    if (q.parent === pid) {
      q.parent = p.parent;
      revalidateProposalParent(s, q);
    }
  }
  s.rejected.push({ type: p.type, text: p.text });
  if (s.rejected.length > MAX_REJECTED_MEMORY) s.rejected.splice(0, s.rejected.length - MAX_REJECTED_MEMORY);
  s.stats.rejected++;
  touch(s);
}

export function createNode(s: Session, body: { type?: unknown; text?: unknown; parent?: unknown }): MapNode {
  assertLive(s);
  if (!isNodeType(body.type)) throw new ApiError(400, 'Type inconnu.');
  const text = normalizeText(body.text);
  if (!text) throw new ApiError(400, 'Le texte est vide.');
  const parent = typeof body.parent === 'string' ? getNode(s, body.parent) : undefined;
  if (!parent) throw new ApiError(400, 'Parent introuvable.');
  if (!canAttach(body.type, parent.type)) {
    throw new ApiError(409, `Un nœud « ${body.type} » ne peut pas être rattaché à « ${parent.type} ».`);
  }
  const node: MapNode = {
    id: `n_${++s.seq.node}`,
    type: body.type,
    text,
    parent: parent.id,
    speaker: null,
    sources: [],
    createdAt: nowIso(),
  };
  s.nodes.push(node);
  touch(s);
  return node;
}

export function patchNode(s: Session, nid: string, body: { text?: unknown; type?: unknown; parent?: unknown }): MapNode {
  assertLive(s);
  const node = getNode(s, nid);
  if (!node) throw new ApiError(404, 'Nœud introuvable.');

  let text: string | undefined;
  if (body.text !== undefined) {
    text = normalizeText(body.text);
    if (!text) throw new ApiError(400, 'Le texte est vide.');
  }

  const isRoot = node.id === ROOT_ID;
  if (isRoot && (body.type !== undefined || body.parent !== undefined)) {
    throw new ApiError(400, 'La racine ne change ni de type ni de parent.');
  }

  let type = node.type;
  if (body.type !== undefined) {
    if (!isNodeType(body.type)) throw new ApiError(400, 'Type inconnu.');
    type = body.type;
  }

  let parentId = node.parent;
  if (body.parent !== undefined) {
    if (typeof body.parent !== 'string' || !getNode(s, body.parent)) throw new ApiError(400, 'Parent introuvable.');
    if (descendants(s, node.id).has(body.parent)) {
      throw new ApiError(409, 'Impossible de rattacher un nœud à lui-même ou à l’un de ses descendants.');
    }
    parentId = body.parent;
  }

  if (!isRoot) {
    const parent = getNode(s, parentId!)!;
    if (!canAttach(type as NodeType, parent.type)) {
      throw new ApiError(409, `Un nœud « ${type} » ne peut pas être rattaché à « ${parent.type} ».`);
    }
    for (const child of s.nodes) {
      if (child.parent === node.id && !canAttach(child.type as NodeType, type)) {
        throw new ApiError(
          409,
          `Ce nœud a un enfant « ${child.type} », incompatible avec le type « ${type} ». Déplace ou supprime d’abord cet enfant.`,
        );
      }
    }
  }

  if (text !== undefined && text !== node.text) {
    if (node.proposedText !== undefined && !node.edited) {
      node.edited = true;
      s.stats.acceptedEdited++;
    }
    node.text = text;
    if (isRoot) s.title = text;
  }
  node.type = type;
  node.parent = parentId;
  for (const p of s.proposals) if (p.parent === node.id) revalidateProposalParent(s, p);
  touch(s);
  return node;
}

export function deleteNode(s: Session, nid: string): void {
  assertLive(s);
  const node = getNode(s, nid);
  if (!node) throw new ApiError(404, 'Nœud introuvable.');
  if (node.id === ROOT_ID) throw new ApiError(400, 'La racine ne peut pas être supprimée.');
  const gone = descendants(s, nid);
  s.nodes = s.nodes.filter((n) => !gone.has(n.id));
  s.links = s.links.filter((l) => !gone.has(l.from) && !gone.has(l.to));
  for (const p of s.proposals) {
    if (p.parent && gone.has(p.parent)) {
      p.parent = node.parent;
      revalidateProposalParent(s, p);
    }
  }
  touch(s);
}

export function closeSession(s: Session): void {
  if (s.status === 'closed') return;
  s.status = 'closed';
  touch(s);
}

// ---------------------------------------------------------------- vue publique

/** Ce qui est diffusé aux navigateurs : ni clés, ni transcription complète. */
export function publicState(s: Session) {
  const cited = new Set<string>();
  for (const n of s.nodes) n.sources.forEach((id) => cited.add(id));
  for (const p of s.proposals) p.sources.forEach((id) => cited.add(id));
  const segments: Record<string, { text: string; start: string; end: string }> = {};
  for (const t of s.transcript) if (cited.has(t.id)) segments[t.id] = { text: t.text, start: t.start, end: t.end };

  const lat = s.stats.latencies;
  const actors = Object.values(s.stats.actors);
  const { latencies: _l, actors: _a, ...counters } = s.stats;
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    nodes: s.nodes,
    links: s.links,
    proposals: s.proposals,
    segments,
    recent: s.transcript.slice(-3).map((t) => ({ id: t.id, text: t.text, end: t.end })),
    stats: {
      ...counters,
      acceptedUnchanged: s.stats.accepted - s.stats.acceptedEdited,
      latency: {
        count: lat.length,
        avg: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
        max: lat.length ? Math.max(...lat) : null,
      },
      costEurTotal: Math.round((s.stats.costEur.stt + s.stats.costEur.llm) * 1000) / 1000,
      guestActors: actors.filter((r) => r === 'guest').length,
    },
  };
}

export type PublicState = ReturnType<typeof publicState>;
