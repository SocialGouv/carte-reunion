/**
 * Rejoue une transcription texte dans une séance, sans audio, pour tester l'interface et la consigne.
 * Le serveur doit tourner avec DEV_TEXT_INPUT=true.
 *
 *   npm run replay -- samples/reunion-exemple.txt [--base http://localhost:3000] [--every 8]
 *   npm run replay -- samples/reunion-exemple.txt --session s_xxx --key <clé animateur>
 *
 * Chaque paragraphe du fichier est une tranche de 25 s ; --every règle l'intervalle réel entre deux tranches.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', default: `http://localhost:${process.env.PORT ?? 3000}` },
    every: { type: 'string', default: '8' },
    session: { type: 'string' },
    key: { type: 'string' },
  },
});

const file = positionals[0];
if (!file) {
  console.error('usage : replay.ts <transcription.txt> [--base URL] [--every secondes] [--session id --key clé]');
  process.exit(1);
}

const raw = await readFile(file, 'utf8');
const title = raw.match(/^#\s*(.+)$/m)?.[1] ?? 'Rejeu';
const chunks = raw
  .replace(/^#.*$/m, '')
  .split(/\n\s*\n/)
  .map((c) => c.replace(/\s+/g, ' ').trim())
  .filter(Boolean);

let id = values.session;
let key = values.key;
if (!id || !key) {
  const res = await fetch(`${values.base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, token: process.env.CREATE_TOKEN }),
  });
  if (!res.ok) throw new Error(`Création : HTTP ${res.status} ${await res.text()}`);
  const s = (await res.json()) as { id: string; hostKey: string; hostUrl: string; guestUrl: string };
  id = s.id;
  key = s.hostKey;
  console.log(`Animateur    : ${s.hostUrl}\nParticipants : ${s.guestUrl}`);
}

const every = Number(values.every) * 1000;
for (const [i, text] of chunks.entries()) {
  const res = await fetch(`${values.base}/api/sessions/${id}/transcript?k=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, durationS: 25 }),
  });
  if (!res.ok) throw new Error(`Tranche ${i + 1} : HTTP ${res.status} ${await res.text()}`);
  console.log(`tranche ${i + 1}/${chunks.length} envoyée`);
  if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, every));
}
console.log('Rejeu terminé.');
