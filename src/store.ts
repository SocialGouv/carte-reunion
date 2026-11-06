import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.ts';
import { publicState, type PublicState } from './session.ts';
import type { Session } from './types.ts';

type Listener = (state: PublicState) => void;

const sessions = new Map<string, Session>();
const listeners = new Map<string, Set<Listener>>();
const dirty = new Set<string>();

const file = (id: string) => path.join(config.dataDir, `${id}.json`);
const ttlMs = () => config.sessionTtlHours * 3600_000;
const expired = (s: Session) => Date.now() - Date.parse(s.lastActivityAt) > ttlMs();

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function allSessions(): Session[] {
  return [...sessions.values()];
}

export function addSession(s: Session): void {
  sessions.set(s.id, s);
  dirty.add(s.id);
}

/** À appeler après chaque changement : marque la séance à sauvegarder et rediffuse l'état. */
export function changed(s: Session): void {
  dirty.add(s.id);
  const ls = listeners.get(s.id);
  if (!ls?.size) return;
  const state = publicState(s);
  for (const l of ls) {
    try {
      l(state);
    } catch (e) {
      console.error('diffusion', s.id, e);
    }
  }
}

export function subscribe(id: string, l: Listener): () => void {
  let ls = listeners.get(id);
  if (!ls) listeners.set(id, (ls = new Set()));
  ls.add(l);
  return () => {
    ls.delete(l);
    if (!ls.size) listeners.delete(id);
  };
}

export function listenerCount(id: string): number {
  return listeners.get(id)?.size ?? 0;
}

export async function loadAll(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  for (const f of await readdir(config.dataDir)) {
    if (!/^s_[0-9a-f]+\.json$/.test(f)) continue;
    try {
      const s = JSON.parse(await readFile(path.join(config.dataDir, f), 'utf8')) as Session;
      if (expired(s)) await rm(path.join(config.dataDir, f), { force: true });
      else sessions.set(s.id, s);
    } catch (e) {
      console.error('lecture sauvegarde', f, e);
    }
  }
  console.log(`${sessions.size} séance(s) rechargée(s) depuis ${config.dataDir}`);
}

export async function flush(): Promise<void> {
  const ids = [...dirty];
  dirty.clear();
  for (const id of ids) {
    const s = sessions.get(id);
    if (!s) continue;
    const tmp = file(id) + '.tmp';
    try {
      await writeFile(tmp, JSON.stringify(s));
      await rename(tmp, file(id));
    } catch (e) {
      dirty.add(id);
      console.error('sauvegarde', id, e);
    }
  }
}

export async function sweep(onRemove?: (id: string) => void): Promise<void> {
  for (const s of sessions.values()) {
    if (!expired(s) || listenerCount(s.id) > 0) continue;
    sessions.delete(s.id);
    dirty.delete(s.id);
    onRemove?.(s.id);
    await rm(file(s.id), { force: true });
    console.log('séance expirée supprimée', s.id);
  }
}
