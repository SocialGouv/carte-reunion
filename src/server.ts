import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { config } from './config.ts';
import { forgetCycle, startCycleTicker } from './cycle.ts';
import { toJson, toMarkdown } from './export.ts';
import {
  acceptProposal,
  ApiError,
  closeSession,
  createNode,
  createSession,
  deleteNode,
  patchNode,
  publicState,
  recordActor,
  rejectProposal,
} from './session.ts';
import { addTextSegment, enqueueChunk } from './stt.ts';
import { addSession, changed, flush, getSession, loadAll, subscribe, sweep } from './store.ts';
import type { Role, Session } from './types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: 'Erreur interne.' }, 500);
});

function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Vérifie la clé `k` et renvoie la séance. La clé animateur vaut aussi clé participant. */
function auth(c: Context, need: Role): { s: Session; role: Role } {
  const s = getSession(c.req.param('id') ?? '');
  if (!s) throw new ApiError(404, 'Séance introuvable ou expirée.');
  const k = c.req.query('k') ?? c.req.header('x-session-key') ?? '';
  const role: Role | null = sameKey(k, s.keys.host) ? 'host' : sameKey(k, s.keys.guest) ? 'guest' : null;
  if (!role || (need === 'host' && role !== 'host')) throw new ApiError(403, 'Clé de séance invalide.');
  return { s, role };
}

/** Pour les actions sur la carte : authentifie et note l'identifiant anonyme du navigateur. */
function actor(c: Context): Session {
  const { s, role } = auth(c, 'guest');
  recordActor(s, c.req.header('x-client-id'), role);
  return s;
}

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- pages et fichiers

app.get('/healthz', (c) => c.text('ok'));
// Fichiers légers et changeants d'une version à l'autre : toujours revalider.
app.use('*', async (c, next) => {
  await next();
  if (!c.req.path.startsWith('/api/') && !c.req.path.startsWith('/vendor/')) c.header('Cache-Control', 'no-cache');
});
app.get('/', serveStatic({ path: path.join(root, 'public/index.html') }));
app.get('/s/:id', serveStatic({ path: path.join(root, 'public/session.html') }));
app.use('/assets/*', serveStatic({ root: path.join(root, 'public'), rewriteRequestPath: (p) => p.replace(/^\/assets/, '') }));
app.get('/vendor/dagre.min.js', async (c) => {
  const js = await readFile(path.join(root, 'node_modules/@dagrejs/dagre/dist/dagre.min.js'));
  return c.body(js, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
});
app.get('/api/config', (c) =>
  c.json({ createTokenRequired: Boolean(config.createToken), chunkSeconds: config.chunkSeconds, devTextInput: config.devTextInput }),
);

// ---------------------------------------------------------------- API

app.post('/api/sessions', async (c) => {
  const b = await body(c);
  if (config.createToken && !sameKey(String(b.token ?? ''), config.createToken)) {
    throw new ApiError(403, 'Jeton de création invalide.');
  }
  const s = createSession(String(b.title ?? ''));
  addSession(s);
  // Derrière l'Ingress, la requête arrive en http : on reprend le schéma et l'hôte vus par le navigateur.
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim() ?? url.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host;
  const base = `${proto}://${host}`;
  return c.json(
    {
      id: s.id,
      hostKey: s.keys.host,
      guestKey: s.keys.guest,
      hostUrl: `${base}/s/${s.id}?k=${s.keys.host}`,
      guestUrl: `${base}/s/${s.id}?k=${s.keys.guest}`,
    },
    201,
  );
});

app.get('/api/sessions/:id', (c) => {
  const { s, role } = auth(c, 'guest');
  return c.json({ ...publicState(s), role, guestKey: role === 'host' ? s.keys.guest : undefined });
});

app.get('/api/sessions/:id/events', (c) => {
  const { s } = auth(c, 'guest');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = subscribe(s.id, (state) => {
      queue.length = 0; // seul le dernier état compte
      queue.push(JSON.stringify(state));
      wake?.();
    });
    let open = true;
    stream.onAbort(() => {
      open = false;
      unsubscribe();
      wake?.();
    });
    await stream.writeSSE({ event: 'state', data: JSON.stringify(publicState(s)) });
    while (open) {
      const data = queue.shift();
      if (data) {
        await stream.writeSSE({ event: 'state', data });
        continue;
      }
      const timedOut = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), 20_000);
        wake = () => {
          clearTimeout(t);
          resolve(false);
        };
      });
      wake = null;
      if (timedOut && open) await stream.writeSSE({ event: 'ping', data: '' });
    }
  });
});

app.post('/api/sessions/:id/audio', async (c) => {
  const { s } = auth(c, 'host');
  if (s.status !== 'live') throw new ApiError(409, 'La séance est close.');
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File) || file.size === 0) throw new ApiError(400, 'Fichier audio manquant.');
  if (file.size > MAX_AUDIO_BYTES) throw new ApiError(413, 'Tranche audio trop lourde.');
  const durationS = Math.min(Math.max(Number(form.durationMs) / 1000 || config.chunkSeconds, 1), 120);
  enqueueChunk(s, file, file.name || 'tranche.webm', durationS, new Date());
  return c.json({ queued: true }, 202);
});

app.post('/api/sessions/:id/transcript', async (c) => {
  if (!config.devTextInput) throw new ApiError(404, 'Désactivé (DEV_TEXT_INPUT).');
  const { s } = auth(c, 'host');
  if (s.status !== 'live') throw new ApiError(409, 'La séance est close.');
  const b = await body(c);
  addTextSegment(s, String(b.text ?? ''), Number(b.durationS) || config.chunkSeconds);
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/proposals/:pid/accept', async (c) => {
  const s = actor(c);
  const b = await body(c);
  const node = acceptProposal(s, c.req.param('pid'), typeof b.parent === 'string' ? b.parent : undefined);
  changed(s);
  return c.json(node);
});

app.post('/api/sessions/:id/proposals/:pid/reject', (c) => {
  const s = actor(c);
  rejectProposal(s, c.req.param('pid'));
  changed(s);
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/nodes', async (c) => {
  const s = actor(c);
  const node = createNode(s, await body(c));
  changed(s);
  return c.json(node, 201);
});

app.patch('/api/sessions/:id/nodes/:nid', async (c) => {
  const s = actor(c);
  const node = patchNode(s, c.req.param('nid'), await body(c));
  changed(s);
  return c.json(node);
});

app.delete('/api/sessions/:id/nodes/:nid', (c) => {
  const s = actor(c);
  deleteNode(s, c.req.param('nid'));
  changed(s);
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/close', (c) => {
  const { s } = auth(c, 'host');
  closeSession(s);
  changed(s);
  return c.json({ ok: true });
});

app.get('/api/sessions/:id/export', (c) => {
  const { s } = auth(c, 'guest');
  const format = c.req.query('format') === 'json' ? 'json' : 'md';
  const name = `carte-${s.createdAt.slice(0, 10)}-${s.id}.${format}`;
  c.header('Content-Disposition', `attachment; filename="${name}"`);
  if (format === 'json') return c.json(toJson(s));
  return c.body(toMarkdown(s), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});

// ---------------------------------------------------------------- démarrage

await loadAll();
const timers = [
  setInterval(() => void flush(), 30_000),
  setInterval(() => void sweep(forgetCycle), 10 * 60_000),
  startCycleTicker(),
];
void sweep(forgetCycle);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`carte-reunion sur http://localhost:${info.port} · STT ${config.sttModel} · LLM ${config.llmModel}`);
  if (!config.litellmApiKey) console.warn('LITELLM_API_KEY absente : ni transcription ni propositions.');
});

async function shutdown(signal: string) {
  console.log(`${signal} : sauvegarde des séances`);
  timers.forEach(clearInterval);
  await flush();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
