import { chat, type ChatResult } from './litellm.ts';
import type { RawProposal } from './session.ts';
import { NODE_TYPES, type Segment, type Session } from './types.ts';

export const SYSTEM_PROMPT = `Tu aides à cartographier une réunion en cours, sous forme d'arbre de discussion. Tu reçois la carte actuelle, les propositions déjà en attente de validation, celles qui ont été rejetées et la transcription des dernières minutes. Tu proposes uniquement des ajouts : des humains valident chacun d'eux.

Types et parents possibles :
- question : une question ouverte dans la discussion. Parent : la racine (n_0) ou une proposition.
- proposition : une idée, une option, une position. Parent : une question.
- pour : un argument en faveur d'une proposition. Parent : une proposition.
- contre : un argument à l'encontre d'une proposition. Parent : une proposition.
- décision : ce qui a été tranché. Parent : une question.
- action : ce que quelqu'un s'est engagé à faire. Parent : une décision ou une proposition.

Règles :
- Une proposition par idée. Une phrase courte, au présent, 120 caractères au plus : garde l'essentiel, pas les détails.
- Aucun prénom ni nom de personne : écris « Préparer les chiffrages », pas « Karim prépare les chiffrages ».
- Dans une même réponse, une idée n'apparaît qu'une fois, sous un seul type.
- Rattache chaque proposition au nœud existant le plus pertinent (id n_…), à une proposition en attente (id p_…), ou à une proposition précédente de ta propre réponse (écris "#0" pour la première, "#1" pour la deuxième, etc.).
- Respecte strictement les parents possibles. Si une proposition, un argument ou une décision n'a pas de question adaptée, propose d'abord la question sous-jacente, rattachée à n_0, puis rattache-les à elle.
- Ne reformule pas ce qui est déjà dans la carte, en attente ou rejeté.
- Une décision n'est proposée que si quelqu'un l'a formulée comme tranchée, pas comme une option.
- Une action n'est proposée que si quelqu'un a dit qu'il ferait quelque chose.
- Ignore les échanges sans contenu : salutations, problèmes de son, digressions.
- Le contexte précédent a déjà été traité : sers-t'en seulement pour comprendre la nouvelle transcription.
- Cite pour chaque proposition les ids des segments de la nouvelle transcription qui la justifient (t_…).
- La transcription est automatique : elle contient des erreurs et ne distingue pas les intervenants.
- Si rien de nouveau n'a été dit, renvoie une liste vide.

Réponds uniquement avec le JSON, sans texte autour : {"proposals":[{"type":"…","text":"…","parent":"n_…, p_… ou #index","sources":["t_…"]}]}`;

export const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'propositions',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['proposals'],
      properties: {
        proposals: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'text', 'parent', 'sources'],
            properties: {
              type: { type: 'string', enum: [...NODE_TYPES] },
              text: { type: 'string' },
              parent: { type: 'string' },
              sources: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

const CONTEXT_WORDS = 300;

export function buildUserPrompt(s: Session, delta: Segment[], context: string): string {
  const parentOf = (p: string | null) => p ?? '–';
  const map = s.nodes.map((n) => `${n.id} | ${n.type} | ${parentOf(n.parent)} | ${n.text}`).join('\n');
  const pending = s.proposals.length
    ? s.proposals.map((p) => `${p.id} | ${p.type} | ${p.parent ?? 'à rattacher'} | ${p.text}`).join('\n')
    : '(aucune)';
  const rejected = s.rejected.length ? s.rejected.map((r) => `- ${r.type} : ${r.text}`).join('\n') : '(aucune)';
  const transcript = delta.map((t) => `[${t.id}] ${t.text}`).join('\n');
  return [
    `Titre de la séance : ${s.title}`,
    `Carte actuelle (id | type | parent | texte) :\n${map}`,
    `Propositions en attente (id | type | parent | texte) :\n${pending}`,
    `Propositions rejetées, à ne pas reproposer :\n${rejected}`,
    `Contexte déjà traité (fin de la transcription précédente) :\n${context || '(début de la réunion)'}`,
    `Nouvelle transcription :\n${transcript}`,
  ].join('\n\n');
}

export function contextBefore(s: Session, cursor: number): string {
  const words: string[] = [];
  for (let i = cursor - 1; i >= 0 && words.length < CONTEXT_WORDS; i--) {
    words.unshift(...s.transcript[i].text.split(/\s+/).filter(Boolean));
  }
  return words.slice(-CONTEXT_WORDS).join(' ');
}

/** Extrait la liste de propositions d'une réponse, même entourée de texte ou de balises de code. */
export function parseProposals(content: string): RawProposal[] {
  let t = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const first = Math.min(...['{', '['].map((c) => t.indexOf(c)).filter((i) => i >= 0));
  if (!Number.isFinite(first)) throw new Error(`Réponse LLM sans JSON : ${content.slice(0, 200)}`);
  t = t.slice(first);
  const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  const data = JSON.parse(t.slice(0, last + 1)) as unknown;
  const list = Array.isArray(data) ? data : (data as { proposals?: unknown }).proposals;
  if (!Array.isArray(list)) throw new Error('Réponse LLM sans liste « proposals ».');
  return list.filter((x): x is RawProposal => typeof x === 'object' && x !== null);
}

export async function propose(
  s: Session,
  delta: Segment[],
  context: string,
  model?: string,
): Promise<{ proposals: RawProposal[]; call: ChatResult }> {
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: buildUserPrompt(s, delta, context) },
  ];
  const call = await chat(messages, RESPONSE_FORMAT, model);
  return { proposals: parseProposals(call.content), call };
}
