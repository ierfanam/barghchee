export type ClientSpeechState = 'SILENT' | 'STARTING' | 'SPEAKING' | 'ENDING' | 'INTERRUPTED';

export interface RealtimeClientState {
  connection: 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'DISCONNECTED';
  userSpeech: ClientSpeechState;
  assistantSpeech: ClientSpeechState;
  overlap: boolean;
}

export interface RealtimeClientOptions {
  url?: string;
  token?: string;
  onState?: (state: RealtimeClientState) => void;
  onAudio?: (pcm16: Int16Array) => void;
  onTranscript?: (text: string, source: 'user' | 'assistant') => void;
  onError?: (error: Error) => void;
}

/** Browser-side transport for the Full-Duplex gateway.
 * It deliberately never contains an OpenAI API key.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private state: RealtimeClientState = {
    connection: 'IDLE',
    userSpeech: 'SILENT',
    assistantSpeech: 'SILENT',
    overlap: false,
  };
  private readonly options: RealtimeClientOptions;

  constructor(options: RealtimeClientOptions = {}) {
    this.options = options;
  }

  getState(): RealtimeClientState { return {...this.state}; }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.setState({connection: 'CONNECTING'});
    const url = this.options.url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live-openai`;
    const token = this.options.token ? `?token=${encodeURIComponent(this.options.token)}` : '';

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${url}${token}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => { this.setState({connection: 'CONNECTED'}); resolve(); };
      ws.onerror = () => {
        const error = new Error('Realtime WebSocket connection failed');
        this.setState({connection: 'ERROR'});
        this.options.onError?.(error);
        reject(error);
      };
      ws.onclose = () => {
        this.ws = null;
        this.setState({connection: 'DISCONNECTED'});
      };
      ws.onmessage = (event) => this.handleMessage(event.data);
    });
  }

  sendAudio(pcm16: Int16Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Realtime session is not connected');
    this.setState({userSpeech: 'SPEAKING'});
    this.ws.send(pcm16.buffer.slice(pcm16.byteOffset, pcm16.byteOffset + pcm16.byteLength));
    this.updateOverlap();
  }

  sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Realtime session is not connected');
    this.ws.send(JSON.stringify({type: 'input_text', text}));
  }

  interrupt(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({type: 'interrupt'}));
    this.setState({assistantSpeech: 'INTERRUPTED'});
    this.updateOverlap();
  }

  close(): void { this.ws?.close(); this.ws = null; }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') {
      const bytes = raw instanceof ArrayBuffer ? new Int16Array(raw) : new Int16Array();
      if (bytes.length) {
        this.setState({assistantSpeech: 'SPEAKING'});
        this.options.onAudio?.(bytes);
        this.updateOverlap();
      }
      return;
    }
    let event: any;
    try { event = JSON.parse(raw); } catch { return; }
    switch (event.type) {
      case 'user.speech.started':
        this.setState({userSpeech: 'SPEAKING'}); break;
      case 'user.speech.stopped':
        this.setState({userSpeech: 'SILENT'}); break;
      case 'assistant.speech.started':
      case 'response.output_audio.started':
        this.setState({assistantSpeech: 'SPEAKING'}); break;
      case 'assistant.speech.stopped':
      case 'response.output_audio.done':
        this.setState({assistantSpeech: 'SILENT'}); break;
      case 'transcript':
        if (typeof event.text === 'string') this.options.onTranscript?.(event.text, event.source === 'user' ? 'user' : 'assistant');
        break;
      case 'error':
        this.options.onError?.(new Error(event.message || 'Realtime gateway error')); break;
    }
    this.updateOverlap();
  }

  private setState(patch: Partial<RealtimeClientState>): void {
    this.state = {...this.state, ...patch};
    this.options.onState?.(this.getState());
  }

  private updateOverlap(): void {
    this.setState({overlap: this.state.userSpeech === 'SPEAKING' && this.state.assistantSpeech === 'SPEAKING'});
  }
}
