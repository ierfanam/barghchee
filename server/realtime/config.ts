export const DEFAULT_REALTIME_PROVIDER = process.env.REALTIME_PROVIDER ?? 'openai';

/**
 * BARghCHEE's product-facing compatibility label requested by the project.
 * It is an alias, not an API model identifier.
 */
export const DEFAULT_REALTIME_MODEL = process.env.REALTIME_MODEL ?? 'gpt-4o-live';

/** Resolve product aliases to a current OpenAI Realtime API model. */
export function resolveRealtimeModel(model = DEFAULT_REALTIME_MODEL): string {
  const aliases: Record<string, string> = {
    // Product compatibility label -> current flagship realtime voice model.
    'gpt-4o-live': 'gpt-realtime-2.1',
  };
  return aliases[model] ?? model;
}

export interface RealtimeRuntimeConfig {
  provider: string;
  model: string;
  apiModel: string;
}

export function getRealtimeRuntimeConfig(): RealtimeRuntimeConfig {
  return {
    provider: DEFAULT_REALTIME_PROVIDER,
    model: DEFAULT_REALTIME_MODEL,
    apiModel: resolveRealtimeModel(DEFAULT_REALTIME_MODEL),
  };
}
