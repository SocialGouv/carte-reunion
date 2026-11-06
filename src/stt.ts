import { config } from './config.ts';
import { notifyNewWords } from './cycle.ts';
import { transcribe } from './litellm.ts';
import { addSegment, wordCount } from './session.ts';
import { changed } from './store.ts';
import type { Session } from './types.ts';

/**
 * Phrases que Whisper invente sur du silence ou de la musique en français
 * (héritées des sous-titres de son corpus d'entraînement).
 */
const HALLUCINATIONS: RegExp[] = [
  /sous-titr(?:es|age|é)[^\n]{0,60}?(?:amara\.org|radio-canada|st['’]? ?\d+)[.!?]?/gi,
  /sous-titres? (?:réalisés? )?par [^.!?\n]*[.!?]?/gi,
  /merci d['’]avoir regardé (?:cette vidéo)?[^.!?\n]*[.!?]?/gi,
  /abonnez-vous[^.!?\n]*[.!?]?/gi,
  /\[(?:musique|music|rires|applaudissements|silence)\]/gi,
  /♪+/g,
];

function lastWords(text: string, n: number): string {
  return text.split(/\s+/).filter(Boolean).slice(-n).join(' ');
}

/** Retire les hallucinations connues, l'écho de la consigne et les répétitions en boucle. */
export function cleanTranscript(raw: string, prompt: string): string {
  let t = raw;
  for (const re of HALLUCINATIONS) t = t.replace(re, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (prompt && t.replace(/[.…\s]+$/, '') === prompt.replace(/[.…\s]+$/, '')) return '';

  // Whisper boucle parfois sur une même phrase.
  const sentences = t.match(/[^.!?…]+[.!?…]*/g) ?? [];
  const kept: string[] = [];
  for (const s of sentences) {
    const k = s.trim().toLowerCase();
    if (kept.length && kept[kept.length - 1].trim().toLowerCase() === k) continue;
    kept.push(s.trim());
  }
  t = kept.join(' ').trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

/** Les tranches d'une séance sont transcrites l'une après l'autre : la consigne dépend de la précédente. */
const chains = new Map<string, Promise<void>>();

export function enqueueChunk(s: Session, audio: Blob, filename: string, durationS: number, receivedAt: Date): void {
  const prev = chains.get(s.id) ?? Promise.resolve();
  const next = prev
    .then(() => processChunk(s, audio, filename, durationS, receivedAt))
    .catch((e) => console.error('tranche', s.id, e));
  chains.set(s.id, next);
  void next.finally(() => {
    if (chains.get(s.id) === next) chains.delete(s.id);
  });
}

async function processChunk(s: Session, audio: Blob, filename: string, durationS: number, receivedAt: Date) {
  if (s.status !== 'live') return;
  const previous = s.transcript.at(-1)?.text ?? '';
  const prompt = lastWords(previous, 30);

  let result: Awaited<ReturnType<typeof transcribe>> | undefined;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    try {
      result = await transcribe(audio, filename, prompt);
    } catch (e) {
      console.error(`transcription ${s.id} essai ${attempt + 1}`, (e as Error).message);
    }
  }
  s.stats.chunks++;
  if (!result) {
    s.stats.sttErrors++;
    changed(s);
    return;
  }
  s.stats.audioSeconds += durationS;
  s.stats.costEur.stt += result.cost ?? durationS * config.sttEurPerSecond;

  const text = cleanTranscript(result.text, prompt);
  if (text) {
    addSegment(s, text, new Date(receivedAt.getTime() - durationS * 1000), receivedAt);
    notifyNewWords(s, wordCount(text));
  }
  changed(s);
}

/** Ajoute du texte sans passer par l'audio (rejeu, tests). */
export function addTextSegment(s: Session, text: string, durationS: number): void {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return;
  const end = new Date();
  addSegment(s, t, new Date(end.getTime() - durationS * 1000), end);
  notifyNewWords(s, wordCount(t));
  changed(s);
}
