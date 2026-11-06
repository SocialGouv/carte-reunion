function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} doit être un nombre, reçu « ${v} »`);
  return n;
}

function str(name: string, def = ''): string {
  return process.env[name] ?? def;
}

export const config = {
  port: num('PORT', 3000),
  litellmBaseUrl: str('LITELLM_BASE_URL').replace(/\/+$/, ''),
  litellmApiKey: str('LITELLM_API_KEY'),
  sttModel: str('STT_MODEL', 'scaleway/whisper-large-v3'),
  llmModel: str('LLM_MODEL', 'scaleway/gpt-oss-120b'),
  chunkSeconds: num('CHUNK_SECONDS', 25),
  mapIntervalSeconds: num('MAP_INTERVAL_SECONDS', 30),
  mapMinNewWords: num('MAP_MIN_NEW_WORDS', 150),
  /** Sous ce nombre de mots nouveaux, l'intervalle ne déclenche pas de cycle. */
  mapIntervalMinWords: num('MAP_INTERVAL_MIN_WORDS', 20),
  sessionTtlHours: num('SESSION_TTL_HOURS', 24),
  dataDir: str('DATA_DIR', './data'),
  /** Si renseigné, exigé pour créer une séance. */
  createToken: str('CREATE_TOKEN'),
  /** Active POST /api/sessions/:id/transcript (texte sans audio), pour le rejeu et les tests. */
  devTextInput: str('DEV_TEXT_INPUT') === 'true',
  /** Prix de la transcription, € par seconde d'audio, si LiteLLM ne renvoie pas de coût. */
  sttEurPerSecond: num('STT_EUR_PER_SECOND', 0.003 / 60),
};

export type Config = typeof config;
