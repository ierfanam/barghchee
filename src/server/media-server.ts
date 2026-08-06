// src/server/media-server.ts
import WebSocket from 'ws';
import { GeminiLiveClient } from './ai/gemini-live';
import { SipConnector } from './voip/sip-connector';
import { WebAgent } from './agents/web-agent';

export class MediaServer {
  private wss: WebSocket.Server;
  private geminiClient: GeminiLiveClient;
  private sipConnector: SipConnector;
  private webAgent: WebAgent;

  constructor(port: number = 8080) {
    this.wss = new WebSocket.Server({ port });
    this.geminiClient = new GeminiLiveClient(process.env.GEMINI_API_KEY!);
    this.sipConnector = new SipConnector();
    this.webAgent = new WebAgent();
    
    this.setupHandlers();
    console.log(`🎙️ Media Server running on port ${port}`);
  }

  private setupHandlers() {
    this.wss.on('connection', async (ws) => {
      console.log('📞 New media session started');
      
      const sessionId = Math.random().toString(36).substring(7);
      const callContext = {
        sessionId,
        phoneNumber: '',
        isBrowsing: false
      };

      ws.on('message', async (data) => {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'AUDIO_INPUT') {
          // ارسال صوت به هوش مصنوعی
          const response = await this.geminiClient.processAudio(message.audioBuffer);
          
          // اگر هوش مصنوعی دستور وب‌گردی داد
          if (response.action === 'WEB_NAVIGATE') {
            callContext.isBrowsing = true;
            const result = await this.webAgent.execute(response.url, response.form_data);
            ws.send(JSON.stringify({ type: 'WEB_RESULT', data: result }));
          }

          // ارسال پاسخ صوتی به کلاینت
          ws.send(JSON.stringify({
            type: 'AUDIO_OUTPUT',
            audioBuffer: response.audioBuffer
          }));
        }

        if (message.type === 'CALL_INIT') {
          callContext.phoneNumber = message.phoneNumber;
          await this.sipConnector.initiateCall(message.phoneNumber, sessionId);
        }
      });

      ws.on('close', () => {
        console.log(`Session ${sessionId} ended`);
        this.sipConnector.terminateCall(sessionId);
      });
    });
  }
}

// شروع سرور
const server = new MediaServer(8080);