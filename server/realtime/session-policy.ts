export interface SessionPolicy {
  continuousInput: boolean;
  allowOverlap: boolean;
  allowBargeIn: boolean;
  requireServerCredential: boolean;
}

export const PRODUCTION_SESSION_POLICY: SessionPolicy = {
  continuousInput: true,
  allowOverlap: true,
  allowBargeIn: true,
  requireServerCredential: true,
};

export function validateSessionPolicy(policy: SessionPolicy): void {
  if (!policy.continuousInput) throw new Error('Continuous microphone input is required');
  if (!policy.allowOverlap) throw new Error('Full-duplex overlap is required');
  if (!policy.allowBargeIn) throw new Error('Barge-in is required');
  if (!policy.requireServerCredential) throw new Error('Server-side credential isolation is required');
}
