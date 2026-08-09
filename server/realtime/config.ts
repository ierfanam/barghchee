export const DEFAULT_REALTIME_PROVIDER = process.env.REALTIME_PROVIDER ?? 'openai';

/**
 * `gpt-4o-live` is intentionally not hard-coded as an API model identifier.
 * OpenAI Realtime model IDs must be supplied/configured with the exact model
 * identifier supported by the account/API deployment. This prevents a UI
 * label from becoming a non-existent API model.
 */
export const DEFAULT_REALTIME_MODEL =
  process.env.REALTIME_MODEL ?? 'gpt-4o-realtime-preview';

export interface RealtimeRuntimeConfig {
  provider: string;
  model: string;
}

export function getRealtimeRuntimeConfig(): RealtimeRuntimeConfig {
  return {
    provider: DEFAULT_REALTIME_PROVIDER,
    model: DEFAULT_REALTIME_MODEL,
  };
}
