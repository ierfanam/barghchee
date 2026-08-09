export interface RealtimeRuntimeConfig {
  geminiApiKey: string;
}

/**
 * Fail closed when the realtime provider credential is absent.
 * Never manufacture, bypass, or substitute a credential at runtime.
 */
export function loadRealtimeRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RealtimeRuntimeConfig {
  const geminiApiKey = env.GEMINI_API_KEY?.trim();

  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required for realtime voice sessions.');
  }

  return { geminiApiKey };
}
