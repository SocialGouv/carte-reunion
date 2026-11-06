/**
 * Rejoue une transcription hors serveur, cycle par cycle, avec un ou plusieurs modèles,
 * et accepte automatiquement toutes les propositions rattachables. Sert à choisir LLM_MODEL
 * et à régler la consigne.
 *
 *   node --env-file=.env scripts/compare-models.ts samples/reunion-exemple.txt scaleway/gpt-oss-120b …
 *
 * Option : CHUNKS_PER_CYCLE (défaut 2, soit un cycle toutes les ~50 s de parole).
 */
import { readFile } from 'node:fs/promises';
import { contextBefore, propose } from '../src/llm.ts';
import { acceptProposal, addProposals, addSegment, ApiError, createSession } from '../src/session.ts';
import type { MapNode, Session } from '../src/types.ts';

const [file, ...models] = process.argv.slice(2);
if (!file || !models.length) {
  console.error('usage : compare-models.ts <transcription.txt> <modèle> [modèle…]');
  process.exit(1);
}
const perCycle = Number(process.env.CHUNKS_PER_CYCLE ?? 2);

const raw = await readFile(file, 'utf8');
const title = raw.match(/^#\s*(.+)$/m)?.[1] ?? 'Réunion';
const chunks = raw
  .replace(/^#.*$/m, '')
  .split(/\n\s*\n/)
  .map((c) => c.replace(/\s+/g, ' ').trim())
  .filter(Boolean);

function tree(s: Session): string {
  const out: string[] = [];
  const walk = (n: MapNode, d: number) => {
    out.push(`${'  '.repeat(d)}${n.type.padEnd(11)} ${n.text}`);
    s.nodes.filter((c) => c.parent === n.id).forEach((c) => walk(c, d + 1));
  };
  walk(s.nodes[0], 0);
  return out.join('\n');
}

for (const model of models) {
  const s = createSession(title);
  const t0 = Date.now();
  let calls = 0;
  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let proposed = 0;
  let unattached = 0;
  let errors = 0;
  const durations: number[] = [];
  const base = Date.now() - chunks.length * 25_000;

  for (let i = 0; i < chunks.length; i += perCycle) {
    const from = s.transcript.length;
    chunks.slice(i, i + perCycle).forEach((c, j) => {
      const start = new Date(base + (i + j) * 25_000);
      addSegment(s, c, start, new Date(start.getTime() + 25_000));
    });
    const delta = s.transcript.slice(from);
    const tc = Date.now();
    try {
      const { proposals, call } = await propose(s, delta, contextBefore(s, from), model);
      calls++;
      durations.push(Date.now() - tc);
      cost += call.cost ?? 0;
      tokensIn += call.inputTokens;
      tokensOut += call.outputTokens;
      const added = addProposals(s, proposals, calls);
      proposed += added.length;
      // Accepte tout ce qui est rattachable, parents d'abord.
      for (const p of added) {
        if (!s.proposals.includes(p)) continue;
        try {
          acceptProposal(s, p.id);
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          unattached++;
          s.proposals = s.proposals.filter((x) => x !== p);
        }
      }
    } catch (e) {
      errors++;
      console.error(`  [${model}] cycle ${calls + 1} : ${(e as Error).message.slice(0, 300)}`);
    }
  }

  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  console.log(`\n===== ${model}`);
  console.log(
    `${calls} cycles, ${errors} erreurs, ${proposed} propositions, ${unattached} non rattachables, ` +
      `${avg} ms par appel (max ${Math.max(0, ...durations)}), ${tokensIn}+${tokensOut} tokens, ${cost.toFixed(4)} €, ` +
      `${Math.round((Date.now() - t0) / 1000)} s au total`,
  );
  console.log(tree(s));
}
