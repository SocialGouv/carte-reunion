export const NODE_TYPES = ['question', 'proposition', 'pour', 'contre', 'décision', 'action'] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export type AnyNodeType = NodeType | 'racine';

/** Parents possibles pour chaque type (spec §6). */
export const ALLOWED_PARENTS: Record<NodeType, readonly AnyNodeType[]> = {
  question: ['racine', 'proposition'],
  proposition: ['question'],
  pour: ['proposition'],
  contre: ['proposition'],
  décision: ['question'],
  action: ['décision', 'proposition'],
};

export const MAX_TEXT = 140;

export interface MapNode {
  id: string;
  type: AnyNodeType;
  text: string;
  /** null pour la racine uniquement */
  parent: string | null;
  speaker: string | null;
  sources: string[];
  createdAt: string;
  /** Texte proposé par le LLM, pour mesurer les acceptations sans retouche. */
  proposedText?: string;
  /** Vrai dès que le texte d'un nœud issu du LLM a été retouché. */
  edited?: boolean;
}

export interface Link {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface Proposal {
  id: string;
  type: NodeType;
  text: string;
  /** Nœud (n_…) ou proposition en file (p_…). null : à rattacher par un humain. */
  parent: string | null;
  sources: string[];
  createdAt: string;
  cycle: number;
  /** Secondes entre le début du dernier segment cité et l'arrivée dans la file. */
  latencyS: number | null;
}

export interface Segment {
  id: string;
  seq: number;
  start: string;
  end: string;
  text: string;
  speaker: string | null;
}

export interface Stats {
  audioSeconds: number;
  chunks: number;
  sttErrors: number;
  llmCycles: number;
  llmErrors: number;
  proposalsCreated: number;
  accepted: number;
  /** Propositions acceptées dont le texte a ensuite été retouché. */
  acceptedEdited: number;
  rejected: number;
  latencies: number[];
  costEur: { stt: number; llm: number };
  tokens: { input: number; output: number };
  /** Identifiant anonyme de navigateur → rôle, pour le critère « chaque participant a agi ». */
  actors: Record<string, 'host' | 'guest'>;
}

export interface Session {
  id: string;
  title: string;
  status: 'live' | 'closed';
  createdAt: string;
  lastActivityAt: string;
  nodes: MapNode[];
  links: Link[];
  proposals: Proposal[];
  transcript: Segment[];
  /** Derniers rejets, donnés au LLM pour qu'il ne les repropose pas. */
  rejected: { type: NodeType; text: string }[];
  stats: Stats;
  /** Compteurs d'identifiants. */
  seq: { node: number; proposal: number; segment: number; link: number };
  /** Index du dernier segment traité par le LLM (exclu du prochain delta). */
  llmCursor: number;
  keys: { host: string; guest: string };
}

export type Role = 'host' | 'guest';
