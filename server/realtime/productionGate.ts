import { DEFAULT_REALTIME_PROVIDER, DEFAULT_REALTIME_MODEL, resolveRealtimeModel } from './config';

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function getRealtimeReadiness(): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [
    {
      name: 'provider-configured',
      ok: Boolean(DEFAULT_REALTIME_PROVIDER),
      detail: DEFAULT_REALTIME_PROVIDER,
    },
    {
      name: 'model-configured',
      ok: Boolean(DEFAULT_REALTIME_MODEL),
      detail: `${DEFAULT_REALTIME_MODEL} -> ${resolveRealtimeModel(DEFAULT_REALTIME_MODEL)}`,
    },
    {
      name: 'openai-secret',
      ok: Boolean(process.env.OPENAI_API_KEY),
      detail: process.env.OPENAI_API_KEY ? 'configured' : 'missing',
    },
  ];

  return checks;
}

export function assertRealtimeReady(): void {
  const failed = getRealtimeReadiness().filter(check => !check.ok);
  if (failed.length) {
    throw new Error(`Realtime readiness failed: ${failed.map(check => `${check.name}: ${check.detail}`).join('; ')}`);
  }
}
