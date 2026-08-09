import WebSocket from 'ws';
import type { RealtimeProvider, RealtimeProviderConfig } from './provider';
import { resolveRealtimeModel } from './config';

export type OpenAIRealtimeEventHandler = (event: Record<string, unknown>) => void;

/** Server-side OpenAI Realtime GA transport. The API key never leaves the server. */
export class OpenAIRealtimeProvider implements RealtimeProvider {
  readonly name = 'openai-realtime';
  private socket: WebSocket | null = null;
  private eventHandler?: OpenAIRealtimeEventHandler;

  constructor(eventHandler?: OpenAIRealtimeEventHandler) {
    this.eventHandler = eventHandler;
  }

  async connect(config: RealtimeProviderConfig): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

    const model = resolveRealtimeModel(config.model);
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      let settled = false;

      socket.once('open', () => {
        this.socket = socket;
        socket.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            model,
            output_modalities: ['audio'],
            instructions: config.systemInstruction,
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                turn_detection: { type: 'semantic_vad' },
              },
              output: {
                format: { type: 'audio/pcm' },
                voice: config.voice ?? 'marin',
              },
            },
          },
        }));
        settled = true;
        resolve();
      });

      socket.on('message', data => {
        try {
          this.eventHandler?.(JSON.parse(data.toString()) as Record<string, unknown>);
        } catch {
          this.eventHandler?.({ type: 'error', error: { message: 'Invalid provider event JSON' } });
        }
      });

      socket.on('error', err => {
        if (!settled) reject(err);
        this.eventHandler?.({ type: 'error', error: { message: err.message } });
      });

      socket.on('close', (code, reason) => {
        this.socket = null;
        this.eventHandler?.({ type: 'transport.closed', code, reason: reason.toString() });
      });
    });
  }

  sendAudio(data: Buffer | Uint8Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('OpenAI Realtime session is not connected');
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(data).toString('base64') }));
  }

  sendText(text: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('OpenAI Realtime session is not connected');
    this.socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
    this.socket.send(JSON.stringify({ type: 'response.create' }));
  }

  interrupt(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 'response.cancel' }));
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 1500);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
      socket.close(1000, 'session ended');
    });
  }
}
