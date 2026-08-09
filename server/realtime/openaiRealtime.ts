import type { RealtimeProvider, RealtimeProviderConfig } from './provider';

/**
 * Transport boundary for OpenAI Realtime.
 *
 * The server owns the provider credential and transport. The browser must
 * never receive OPENAI_API_KEY. Concrete transport wiring belongs here so
 * the rest of BARghCHEE remains provider-agnostic.
 */
export class OpenAIRealtimeProvider implements RealtimeProvider {
  readonly name = 'openai-realtime';
  private connected = false;

  async connect(config: RealtimeProviderConfig): Promise<void> {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured');
    }

    if (!config.model) {
      throw new Error('REALTIME_MODEL is not configured');
    }

    // Transport/session creation is intentionally isolated from the provider
    // interface. This class must not silently fall back to Gemini or invent a
    // model identifier that the API does not support.
    this.connected = true;
  }

  sendAudio(_data: Buffer | Uint8Array): void {
    if (!this.connected) throw new Error('OpenAI Realtime session is not connected');
    // TODO: wire the authenticated OpenAI Realtime transport.
  }

  sendText(_text: string): void {
    if (!this.connected) throw new Error('OpenAI Realtime session is not connected');
    // TODO: wire the authenticated OpenAI Realtime transport.
  }

  interrupt(): void {
    if (!this.connected) return;
    // TODO: send provider-native interruption event.
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}
