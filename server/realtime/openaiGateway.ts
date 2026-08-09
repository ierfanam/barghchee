import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { OpenAIRealtimeProvider } from './openaiRealtime';
import { getRealtimeRuntimeConfig } from './config';
import { createFullDuplexState, updateOverlap, type FullDuplexState } from './fullDuplexState';

/** Bridge the browser audio contract to OpenAI Realtime GA. */
export function attachOpenAIRealtimeGateway(server: Server, path = '/live-openai'): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const configuredToken = process.env.REALTIME_SESSION_TOKEN?.trim();

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== path) return;

    if (configuredToken && url.searchParams.get('token') !== configuredToken) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });

  wss.on('connection', async client => {
    const runtime = getRealtimeRuntimeConfig();
    const sessionId = crypto.randomUUID();
    let state: FullDuplexState = createFullDuplexState(sessionId);

    const send = (payload: Record<string, unknown>) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
    };

    const publishState = () => {
      state = updateOverlap(state);
      send({
        sessionId,
        connectionState: state.connection,
        userSpeechState: state.userSpeech,
        assistantSpeechState: state.assistantSpeech,
        overlap: state.overlap,
      });
    };

    if (runtime.provider !== 'openai') {
      send({ error: 'OpenAI realtime gateway is disabled by REALTIME_PROVIDER.' });
      client.close(1008, 'provider disabled');
      return;
    }

    const provider = new OpenAIRealtimeProvider(event => {
      switch (event.type) {
        case 'response.audio.delta':
        case 'response.output_audio.delta':
          if (typeof event.delta === 'string') {
            state = { ...state, assistantSpeech: 'SPEAKING' };
            send({ audio: event.delta, assistantSpeechState: 'SPEAKING' });
            publishState();
          }
          break;
        case 'response.audio.done':
        case 'response.output_audio.done':
          state = { ...state, assistantSpeech: 'ENDING' };
          publishState();
          state = { ...state, assistantSpeech: 'SILENT' };
          publishState();
          break;
        case 'input_audio_buffer.speech_started':
          state = { ...state, userSpeech: 'SPEAKING' };
          publishState();
          break;
        case 'input_audio_buffer.speech_stopped':
          state = { ...state, userSpeech: 'ENDING' };
          publishState();
          state = { ...state, userSpeech: 'SILENT' };
          publishState();
          break;
        case 'response.cancelled':
          state = { ...state, assistantSpeech: 'INTERRUPTED' };
          send({ interrupted: true, assistantSpeechState: 'INTERRUPTED' });
          publishState();
          state = { ...state, assistantSpeech: 'SILENT' };
          publishState();
          break;
        case 'response.output_audio_transcript.delta':
          if (typeof event.delta === 'string') send({ modelSubtitleDelta: event.delta });
          break;
        case 'response.output_audio_transcript.done':
          if (typeof event.transcript === 'string') send({ modelSubtitles: event.transcript });
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
        case 'transport.closed':
          state = { ...state, connection: 'DISCONNECTED' };
          publishState();
          break;
        default:
          break;
      }
    });

    try {
      state = { ...state, connection: 'CONNECTING' };
      publishState();
      await provider.connect({
        model: runtime.model,
        voice: 'marin',
        systemInstruction:
          'زبان پیش‌فرض فارسی است. مکالمه طبیعی و محاوره‌ای داشته باش. کاربر می‌تواند هر زمان، حتی هنگام صحبت تو، صحبت کند. مکالمه اجباری نوبتی نیست و هم‌پوشانی گفتار یک حالت معتبر است.',
      });
      state = { ...state, connection: 'CONNECTED' };
      send({ activeModel: runtime.model, provider: provider.name, statusUpdate: 'اتصال OpenAI Realtime برقرار شد.' });
      publishState();
    } catch (error) {
      state = { ...state, connection: 'ERROR' };
      publishState();
      send({ error: error instanceof Error ? error.message : 'Realtime connection failed' });
      client.close(1011, 'provider connection failed');
      return;
    }

    client.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (typeof message.audio === 'string') {
          // Input is intentionally accepted regardless of assistant speech state:
          // microphone capture and assistant playback are independent streams.
          provider.sendAudio(Buffer.from(message.audio, 'base64'));
        } else if (typeof message.text === 'string') {
          provider.sendText(message.text);
        } else if (message.interrupt === true) {
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
