export const DEFAULT_REALTIME_PROVIDER = process.env.REALTIME_PROVIDER ?? 'openai';

/**
 * Compatibility alias requested by BARghCHEE.
 * OpenAI's API expects a supported Realtime model identifier, not the
 * application label `gpt-4o-live`.
 */
export const REALTIME_MODEL_ALIASES: Record<string, string> = {
  'gpt-4o-live': 'gpt-4o-realtime-preview',
};

export const DEFAULT_REALTIME_MODEL_ALIAS =
  process.env.REALTIME_MODEL ?? 'gpt-4o-live';

export function resolveRealtimeModel(modelOrAlias: string): string {
  return REALTIME_MODEL_ALIASES[modelOrAlias] ?? modelOrAlias;
}

export interface RealtimeRuntimeConfig {
  provider: string;
  modelAlias: string;
  model: string;
}

export function getRealtimeRuntimeConfig(): RealtimeRuntimeConfig {
  return {
    provider: DEFAULT_REALTIME_PROVIDER,
    modelAlias: DEFAULT_REALTIME_MODEL_ALIAS,
    model: resolveRealtimeModel(DEFAULT_REALTIME_MODEL_ALIAS),
  };
}
