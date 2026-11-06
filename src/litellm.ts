import { config } from './config.ts';

export interface CallCost {
  /** Coût renvoyé par LiteLLM (en-tête x-litellm-response-cost), dans la devise des prix posés sur l'instance. */
  cost: number | null;
}

function headers(): Record<string, string> {
  if (!config.litellmBaseUrl || !config.litellmApiKey) {
    throw new Error('LITELLM_BASE_URL et LITELLM_API_KEY doivent être renseignés.');
  }
  return { Authorization: `Bearer ${config.litellmApiKey}` };
}

function costOf(res: Response): number | null {
  const v = Number(res.headers.get('x-litellm-response-cost'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

async function fail(res: Response, what: string): Promise<never> {
  const body = (await res.text().catch(() => '')).slice(0, 500);
  throw new Error(`${what} : HTTP ${res.status} ${body}`);
}

export async function transcribe(
  audio: Blob,
  filename: string,
  prompt: string,
): Promise<{ text: string } & CallCost> {
  const form = new FormData();
  form.set('model', config.sttModel);
  form.set('language', 'fr');
  form.set('response_format', 'json');
  if (prompt) form.set('prompt', prompt);
  form.set('file', audio, filename);
  const res = await fetch(`${config.litellmBaseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: headers(),
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return fail(res, 'Transcription');
  const data = (await res.json()) as { text?: string };
  return { text: (data.text ?? '').trim(), cost: costOf(res) };
}

export interface ChatResult extends CallCost {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export async function chat(
  messages: { role: 'system' | 'user'; content: string }[],
  responseFormat?: object,
  model = config.llmModel,
): Promise<ChatResult> {
  const res = await fetch(`${config.litellmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 3000,
      ...(responseFormat ? { response_format: responseFormat } : {}),
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return fail(res, 'Appel LLM');
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    cost: costOf(res),
  };
}
