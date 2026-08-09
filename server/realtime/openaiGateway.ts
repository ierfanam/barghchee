import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { OpenAIRealtimeProvider } from './openaiRealtime';
import { getRealtimeRuntimeConfig } from './config';

/**
 * Bridges the existing browser `/live` message shape to OpenAI Realtime.
 * The browser continues sending `{ audio: base64Pcm16 }` while provider events
 * are normalized back to the legacy UI event vocabulary.
 */
export function attachOpenAIRealtimeGateway(server: Server, path = '/live-openai'): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== path) return;

    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });

  wss.on('connection', async client => {
    const runtime = getRealtimeRuntimeConfig();

    if (runtime.provider !== 'openai') {
      client.send(JSON.stringify({ error: 'OpenAI realtime gateway is disabled by REALTIME_PROVIDER.' }));
      client.close(1008, 'provider disabled');
      return;
    }

    const send = (payload: Record<string, unknown>) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
    };

    const provider = new OpenAIRealtimeProvider(event => {
      switch (event.type) {
        case 'response.audio.delta':
          if (typeof event.delta === 'string') send({ audio: event.delta, assistantSpeechState: 'SPEAKING' });
          break;
        case 'response.audio.done':
          send({ assistantSpeechState: 'ENDING' });
          break;
        case 'input_audio_buffer.speech_started':
          send({ userSpeechState: 'SPEAKING' });
          break;
        case 'input_audio_buffer.speech_stopped':
          send({ userSpeechState: 'ENDING' });
          break;
        case 'response.cancelled':
          send({ interrupted: true, assistantSpeechState: 'INTERRUPTED' });
          break;
        case 'conversation.item.input_audio_transcription.delta':
          if (typeof event.delta === 'string') send({ userTranscriptDelta: event.delta });
          break;
        case 'conversation.item.input_audio_transcription.completed':
          if (typeof event.transcript === 'string') send({ userTranscript: event.transcript });
          break;
        case 'error':
          send({ error: event.error ?? 'Realtime provider error' });
          break;
        default:
          break;
      }
    });

    try {
      await provider.connect({
        model: runtime.model,
        voice: 'alloy',
        systemInstruction:
          'پیش‌فرض زبان فارسی است. مکالمه طبیعی و محاوره‌ای داشته باش. کاربر می‌تواند هر زمان، حتی هنگام صحبت تو، صحبت کند. مکالمه اجباری نوبتی نیست و هم‌پوشانی گفتار یک حالت معتبر است.',
      });
      send({
        activeModel: runtime.model,
        provider: provider.name,
        connectionState: 'CONNECTED',
        statusUpdate: 'اتصال OpenAI Realtime برقرار شد.',
      });
    } catch (error) {
      send({ error: error instanceof Error ? error.message : 'Realtime connection failed' });
      client.close(1011, 'provider connection failed');
      return;
    }

    client.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (typeof message.audio === 'string') {
          provider.sendAudio(Buffer.from(message.audio, 'base64'));
          return;
        }
        if (typeof message.text === 'string') {
          provider.sendText(message.text);
          return;
        }
        if (message.interrupt === true) {
          provider.interrupt();
        }
      } catch {
        send({ error: 'Invalid realtime client message.' });
      }
    });

    client.on('close', () => {
      void provider.close();
    });
  });

  return wss;
}
