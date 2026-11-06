import { publicState } from './session.ts';
import type { AnyNodeType, MapNode, Session } from './types.ts';

const LABELS: Record<AnyNodeType, string> = {
  racine: 'Séance',
  question: 'Question',
  proposition: 'Proposition',
  pour: 'Pour',
  contre: 'Contre',
  décision: 'Décision',
  action: 'Action',
};

const tz = 'Europe/Paris';
const fmtDate = (iso: string) => new Intl.DateTimeFormat('fr-FR', { timeZone: tz, dateStyle: 'long' }).format(new Date(iso));
const fmtTime = (iso: string) => new Intl.DateTimeFormat('fr-FR', { timeZone: tz, timeStyle: 'short' }).format(new Date(iso));

function childrenOf(s: Session, id: string): MapNode[] {
  return s.nodes.filter((n) => n.parent === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function toMarkdown(s: Session): string {
  const lines: string[] = [];
  lines.push(`# ${s.title}`, '');
  lines.push(
    `Séance du ${fmtDate(s.createdAt)}, de ${fmtTime(s.createdAt)} à ${fmtTime(s.lastActivityAt)} (heure de Paris)` +
      (s.status === 'live' ? ', export pendant la séance.' : '.'),
    '',
  );

  lines.push('## Carte', '');
  const walk = (n: MapNode, depth: number) => {
    lines.push(`${'  '.repeat(depth)}- **${LABELS[n.type]}** : ${n.text}`);
    for (const c of childrenOf(s, n.id)) walk(c, depth + 1);
  };
  const top = childrenOf(s, 'n_0');
  if (top.length) top.forEach((n) => walk(n, 0));
  else lines.push('Carte vide.');
  lines.push('');

  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  const listOf = (type: AnyNodeType, title: string) => {
    const items = s.nodes.filter((n) => n.type === type);
    if (!items.length) return;
    lines.push(`## ${title}`, '');
    for (const n of items) {
      const parent = n.parent ? byId.get(n.parent) : undefined;
      lines.push(`- ${n.text}` + (parent && parent.type !== 'racine' ? ` (${LABELS[parent.type].toLowerCase()} : ${parent.text})` : ''));
    }
    lines.push('');
  };
  listOf('décision', 'Décisions');
  listOf('action', 'Actions');

  const st = publicState(s).stats;
  lines.push(
    '---',
    '',
    `Carte produite avec carte-reunion. ${st.proposalsCreated} proposition(s) du LLM, ${st.accepted} acceptée(s) dont ${st.acceptedUnchanged} sans retouche du texte, ${st.rejected} rejetée(s).`,
    '',
  );
  return lines.join('\n');
}

export function toJson(s: Session) {
  const { proposals: _p, recent: _r, ...state } = publicState(s);
  return { exportedAt: new Date().toISOString(), ...state };
}
