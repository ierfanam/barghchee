export interface RealtimeRuntimeConfig {
  provider: string;
  model: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
}

/** Fail closed; never manufacture, bypass, or substitute a credential. */
export function loadRealtimeRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RealtimeRuntimeConfig {
  const provider = (env.REALTIME_PROVIDER ?? 'openai').trim().toLowerCase();
  const model = (env.REALTIME_MODEL ?? 'gpt-4o-live').trim();

  if (!model) throw new Error('REALTIME_MODEL is required for realtime voice sessions.');

  if (provider === 'openai') {
    const openaiApiKey = env.OPENAI_API_KEY?.trim();
    if (!openaiApiKey) throw new Error('OPENAI_API_KEY is required for OpenAI realtime voice sessions.');
    return { provider, model, openaiApiKey };
  }

  if (provider === 'gemini') {
    const geminiApiKey = env.GEMINI_API_KEY?.trim();
    if (!geminiApiKey) throw new Error('GEMINI_API_KEY is required for Gemini realtime voice sessions.');
    return { provider, model, geminiApiKey };
  }

  throw new Error(`Unsupported realtime provider: ${provider}`);
}
