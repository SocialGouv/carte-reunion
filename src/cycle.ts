import { config } from './config.ts';
import { contextBefore, propose } from './llm.ts';
import { addProposals, wordCount } from './session.ts';
import { allSessions, changed } from './store.ts';
import type { Session } from './types.ts';

/** Au-delà, un delta trop long (LLM indisponible longtemps) est tronqué à sa fin. */
const MAX_DELTA_WORDS = 2500;

interface CycleState {
  newWords: number;
  lastCycleAt: number;
  running: boolean;
  again: boolean;
}

const states = new Map<string, CycleState>();

function stateOf(id: string): CycleState {
  let st = states.get(id);
  if (!st) states.set(id, (st = { newWords: 0, lastCycleAt: 0, running: false, again: false }));
  return st;
}

export function forgetCycle(id: string): void {
  states.delete(id);
}

export function notifyNewWords(s: Session, n: number): void {
  stateOf(s.id).newWords += n;
  maybeRun(s);
}

function isDue(st: CycleState): boolean {
  if (st.newWords >= config.mapMinNewWords) return true;
  return st.newWords >= config.mapIntervalMinWords && Date.now() - st.lastCycleAt >= config.mapIntervalSeconds * 1000;
}

export function maybeRun(s: Session): void {
  if (s.status !== 'live') return;
  const st = stateOf(s.id);
  if (!isDue(st)) return;
  if (st.running) {
    st.again = true;
    return;
  }
  void run(s, st);
}

/** Toutes les 5 s, déclenche les cycles dont l'intervalle est écoulé. */
export function startCycleTicker(): NodeJS.Timeout {
  return setInterval(() => {
    for (const s of allSessions()) if (states.has(s.id)) maybeRun(s);
  }, 5000);
}

async function run(s: Session, st: CycleState): Promise<void> {
  st.running = true;
  st.again = false;
  st.lastCycleAt = Date.now();
  const pendingWords = st.newWords;
  st.newWords = 0;

  const upto = s.transcript.length;
  let from = s.llmCursor;
  let words = 0;
  for (let i = upto - 1; i >= from; i--) {
    words += wordCount(s.transcript[i].text);
    if (words > MAX_DELTA_WORDS) {
      from = i + 1;
      break;
    }
  }
  const delta = s.transcript.slice(from, upto);
  const cycle = s.stats.llmCycles + 1;
  const t0 = Date.now();
  try {
    if (!delta.length) return;
    const { proposals, call } = await propose(s, delta, contextBefore(s, from));
    s.stats.llmCycles = cycle;
    s.stats.tokens.input += call.inputTokens;
    s.stats.tokens.output += call.outputTokens;
    if (call.cost !== null) s.stats.costEur.llm += call.cost;
    s.llmCursor = upto;
    const added = s.status === 'live' ? addProposals(s, proposals, cycle) : [];
    console.log(
      `${s.id} cycle ${cycle} : ${delta.length} segment(s), ${added.length}/${proposals.length} proposition(s), ${Date.now() - t0} ms`,
    );
  } catch (e) {
    s.stats.llmErrors++;
    // Le curseur n'a pas avancé : le delta repartira au cycle suivant.
    st.newWords += pendingWords;
    console.error(`${s.id} cycle ${cycle} en échec`, (e as Error).message);
  } finally {
    st.running = false;
    changed(s);
    if (st.again) maybeRun(s);
  }
}
