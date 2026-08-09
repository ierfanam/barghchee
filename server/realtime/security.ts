export function requireServerSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function assertNoBrowserProviderSecrets(): void {
  if (typeof window !== 'undefined') {
    throw new Error('Realtime provider credentials must never be used in browser code');
  }
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
