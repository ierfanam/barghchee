import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { OpenAIRealtimeProvider } from './openaiRealtime';
import { getRealtimeRuntimeConfig } from './config';
import { PRODUCTION_SESSION_POLICY } from './session-policy';

const PATH = '/live-openai';

function tokenAllowed(request: IncomingMessage): boolean {
  const expected = process.env.REALTIME_SESSION_TOKEN;
  if (!expected) return true;
  const url = new URL(request.url ?? '/', 'http://localhost');
  return url.searchParams.get('token') === expected;
}

function isPcm16(data: Buffer): boolean {
  return data.byteLength > 0 && data.byteLength % 2 === 0;
}

/**
 * Attaches the production Full-Duplex gateway to an existing HTTP server.
 * The host application remains responsible for creating/listening on the HTTP server.
 */
export function attachRealtimeGateway(server: import('node:http').Server): WebSocketServer {
  const gateway = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== PATH) return;

    if (!tokenAllowed(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    gateway.handleUpgrade(request, socket, head, ws => gateway.emit('connection', ws, request));
  });

  gateway.on('connection', ws => {
    let provider: OpenAIRealtimeProvider | null = null;
    let closed = false;
    const config = getRealtimeRuntimeConfig();

    const send = (value: unknown) => {
      if (!closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
    };

    provider = new OpenAIRealtimeProvider(event => {
      if (event.type === 'input_audio_buffer.speech_started') send({ type: 'user.speech.started' });
      if (event.type === 'input_audio_buffer.speech_stopped') send({ type: 'user.speech.stopped' });
      if (event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta') {
        const audio = typeof event.delta === 'string' ? Buffer.from(event.delta, 'base64') : null;
        if (audio) ws.send(audio);
        send({ type: 'response.output_audio.started' });
      }
      if (event.type === 'response.output_audio.done' || event.type === 'response.audio.done') {
        send({ type: 'response.output_audio.done' });
      }
      if (event.type === 'response.output_audio_transcript.delta' || event.type === 'response.audio_transcript.delta') {
        send({ type: 'transcript', source: 'assistant', text: typeof event.delta === 'string' ? event.delta : '' });
      }
      if (event.type === 'error') send({ type: 'error', message: String((event.error as any)?.message ?? 'Realtime provider error') });
    });

    send({ type: 'session.ready', provider: config.provider, model: config.model, fullDuplex: PRODUCTION_SESSION_POLICY.allowOverlap });

    void provider.connect({ model: config.model, voice: 'marin' }).then(() => {
      send({ type: 'session.connected' });
    }).catch(error => {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      ws.close(1011, 'provider connection failed');
    });

    ws.on('message', (raw, isBinary) => {
      try {
        if (isBinary) {
          const audio = Buffer.from(raw as Buffer);
          if (isPcm16(audio)) provider?.sendAudio(audio);
          return;
        }
        const message = JSON.parse(raw.toString()) as { type?: string; text?: string };
        if (message.type === 'input_text' && message.text) provider?.sendText(message.text);
        if (message.type === 'interrupt') provider?.interrupt();
      } catch (error) {
        send({ type: 'error', message: error instanceof Error ? error.message : 'Invalid realtime message' });
      }
    });

    ws.on('close', () => {
      closed = true;
      void provider?.close();
    });
  });

  return gateway;
}
