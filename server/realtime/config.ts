export const DEFAULT_REALTIME_PROVIDER = process.env.REALTIME_PROVIDER ?? 'openai';

/**
 * BARghCHEE's public/default model label. It is an alias, not an assertion
 * that an API endpoint exposes a model literally named `gpt-4o-live`.
 */
export const DEFAULT_REALTIME_MODEL = process.env.REALTIME_MODEL ?? 'gpt-4o-live';

/** Resolve product aliases to an API model identifier. */
export function resolveRealtimeModel(model = DEFAULT_REALTIME_MODEL): string {
  const aliases: Record<string, string> = {
    'gpt-4o-live': 'gpt-4o-realtime-preview',
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
