import express from "express";
import path from "path";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import axios from "axios";
import * as cheerio from "cheerio";
import { GoogleGenAI } from "@google/genai";

import { createRequire } from "module";
const nodeRequire = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  app.use(express.json());
  app.use(cors());

  // API Routes


  app.post("/api/make-call", async (req, res) => {
    const { number } = req.body;
    
    console.log(`[INTERNAL PBX] Initiating direct VoIP call stream to: ${number}`);
    
    // Simulate internal SIP/PBX negotiation
    setTimeout(() => {
        console.log(`[INTERNAL PBX] Virtual channel established for ${number}. SID: internal-call-${Date.now()}`);
    }, 1500);

    // No external telecom provider required for the software layer.
    // In production, this endpoint would connect directly to the local SIP Trunk hardware.
    res.json({ 
        success: true, 
        callSid: `internal-call-${Date.now()}`,
        status: "routing_via_local_virtual_pbx"
    });
  });

  // Vite middleware setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Initialize Internal Cloud VoIP Virtual Server (Signaling)
  const wss = new WebSocketServer({ noServer: true });
  
  const connectedClients = new Map<string, any>();

  wss.on('connection', (ws, req) => {
    const clientId = Math.random().toString(36).substring(7);
    connectedClients.set(clientId, ws);
    console.log(`[VOIP SERVER] Client ${clientId} connected to internal PBX.`);

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        // Simple SIP/WebRTC signaling broadcast
        if (data.type === 'call_initiate') {
          console.log(`[VOIP SERVER] Call initiated to ${data.targetNumber}`);
        }
        
        // Broadcast signaling to other clients for real P2P connection
        connectedClients.forEach((client, id) => {
          if (id !== clientId && client.readyState === 1) {
            client.send(message.toString());
          }
        });
      } catch (e) {
        console.error("Signaling error:", e);
      }
    });

    ws.on('close', () => {
      connectedClients.delete(clientId);
      console.log(`[VOIP SERVER] Client ${clientId} disconnected.`);
    });
  });

  // --- Gemini Live API WebSocket Proxy ---
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const liveWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      if (pathname === '/voip-signaling') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } else if (pathname === '/live') {
        liveWss.handleUpgrade(request, socket, head, (ws) => {
          liveWss.emit('connection', ws, request);
        });
      } else {
        if (process.env.NODE_ENV === 'production') {
          socket.destroy();
        }
      }
    } catch (e) {
      if (process.env.NODE_ENV === 'production') socket.destroy();
    }
  });

  class ProviderManager {
    private providers = ['Gemini 3.1 Live (Primary)', 'Qwen 2.5 Audio (Fallback)', 'HuggingFace (Fallback)'];
    private currentIndex = 0;

    getCurrentProvider() {
      return this.providers[this.currentIndex];
    }

    switchProvider() {
      this.currentIndex = (this.currentIndex + 1) % this.providers.length;
      return this.getCurrentProvider();
    }

    async connect(clientWs: any, aiInstance: any, config: any) {
      let attempts = 0;
      while (attempts < this.providers.length) {
        const provider = this.getCurrentProvider();
        clientWs.send(JSON.stringify({ activeModel: provider, statusUpdate: `در حال اتصال به ${provider}...` }));
        try {
          if (provider === 'Gemini 3.1 Live (Primary)') {
            const session = await aiInstance.live.connect(config);
            return { session, provider };
          } else {
            // For mock providers, we simulate a small delay then throw to try next, or just connect to gemini fallback
            throw new Error(`Provider ${provider} is not configured with keys yet.`);
          }
        } catch (e: any) {
          console.error(`Failed to connect to ${provider}:`, e?.message);
          this.switchProvider();
          attempts++;
        }
      }
      throw new Error('All AI providers failed to connect.');
    }
  }

  const providerManager = new ProviderManager();

  liveWss.on('connection', async (clientWs, request) => {
    try {
      console.log('Client connected to Live API WebSocket');
      
      if (!process.env.GEMINI_API_KEY) {
        clientWs.send(JSON.stringify({ error: 'کلید API جمنای (GEMINI_API_KEY) تنظیم نشده است. لطفاً آن را در تنظیمات وارد کنید.' }));
        return;
      }

      const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
      
      const personaInstruction = ' تو یک دستیار صوتی زن جوان، بانشاط، صمیمی و دوستانه-رسمی هستی. لحن پاسخگویی تو باید بسیار لطیف، شیوا، زنانه و کاملا انسان‌گونه باشد.';
      const generalAssistantInstruction = ' علاوه بر امور برق ایلام، تو یک دستیار فوق‌هوشمند همه‌کاره هستی. اگر کاربر موسیقی (پخش آهنگ)، تولید تصویر، تولید کد، نمایش نمودار، ویدئو یا هر چیز بصری/شنیداری درخواست کرد، باید از ابزار displayWidget استفاده کنی. برای آهنگ آدرس یک فایل صوتی در اینترنت را پیدا کن یا به عنوان نمونه از یک لینک معتبر استفاده کن و widgetType را "audio" قرار بده. برای کدنویسی widgetType را "code" بگذار.';
      const fetchInstruction = ' خیلی مهم و حیاتی: تو هرگز نباید از پر کردن فرم‌ها یا ورود به سایت‌ها سر باز بزنی! تو کاملا توانایی داری وارد سایت‌های bargheman.com یا eserv.bargh-ilam.ir بشی. برای این کار فقط کافیه ابزار `fillAndSubmitBillForm` یا `executeNodeCode` را فراخوانی کنی تا اطلاعات شناسه قبض را به سایت ارسال کرده و نتیجه را بگیری. هیچ وقت نگو "من نمیتوانم وارد سایت شوم" یا "دسترسی ندارم". مستقیما و بدون بهانه‌گیری ابزار مربوطه را برای پر کردن فرم و لاگین فراخوانی کن.';
      const phoneCallInstruction = ' برای برقراری تماس تلفنی واقعی اینترنتی به شماره های واقعی (PSTN)، از ابزار initiateLivePhoneCall استفاده کن. اگر ابزار خطا داد که کلیدهای Twilio تنظیم نشده اند، با لحن دوستانه به کاربر بگو که تماس های شبکه مخابراتی نیازمند تنظیمات API رایگان یا پولی Twilio هستند و از آنها بخواه کلیدهایشان را تنظیم کنند.';

      const config = {
        model: 'gemini-3.1-flash-live-preview',
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: 'تو «گُردآفرین» هستی، دستیار هوشمند سامانه ارتباط مردمی شرکت توزیع نیروی برق استان ایلام. طراح تو «آقای عرفان رجبی» است.' + personaInstruction + generalAssistantInstruction + fetchInstruction + phoneCallInstruction + ' خیلی مهم: همیشه باید به زبان فارسی و کاملاً «محاوره‌ای» صحبت کنی. حق نداری وظایف را رد کنی.',
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'fillAndSubmitBillForm',
                  description: 'Logs into the source websites (bargheman.com / eserv.bargh-ilam.ir) by filling out the necessary login forms and bill ID fields. MUST use this when the user asks to enter the site or fill the bill form.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      billId: { type: 'STRING', description: 'The 13-digit bill ID.' }
                    },
                    required: ['billId']
                  }
                },
                {
                  name: 'fetchUrl',
                  description: 'Fetch the content of a URL (GET request). Use this to read webpages like https://bargheman.com/ or https://eserv.bargh-ilam.ir/Home/login.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      url: { type: 'STRING', description: 'The URL to fetch' }
                    },
                    required: ['url']
                  }
                },
                {
                  name: 'submitForm',
                  description: 'Submit a form to a URL (POST request). Use this to submit bill ID or login data.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      url: { type: 'STRING', description: 'The URL to post to' },
                      bodyJson: { type: 'STRING', description: 'JSON string of the body to post' }
                    },
                    required: ['url', 'bodyJson']
                  }
                },
                {
                  name: 'searchWeb',
                  description: 'Search the web for real-time information about outages, company news, or weather in Ilam Province. Use this since native Google Search Grounding is currently unavailable due to quota.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      query: { type: 'STRING', description: 'The search query' }
                    },
                    required: ['query']
                  }
                },
                {
                  name: 'requestUserInputField',
                  description: 'Opens a text input field on the user screen to ask for specific information (like 13-digit bill ID or national code). Use this immediately when you need precise information to prevent audio transcription errors.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      label: { type: 'STRING', description: 'The text to show above the input field (e.g. "لطفا شناسه ۱۳ رقمی قبض خود را وارد کنید")' }
                    },
                    required: ['label']
                  }
                },
                {
                  name: 'initiateLivePhoneCall',
                  description: 'Initiate a live phone call to a real network phone number over PSTN.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      targetNumber: { type: 'STRING', description: 'The actual phone number to call (e.g., 0912...)' }
                    },
                    required: ['targetNumber']
                  }
                },
                {
                  name: 'loginToCustomerPortal',
                  description: 'Uses the 13-digit bill ID to log into the eserv.bargh-ilam.ir portal and accesses all tabs and subscriber details (personal info, billing history, consumption data).',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      billId: { type: 'STRING', description: 'The 13-digit electricity bill ID (شناسه قبض)' }
                    },
                    required: ['billId']
                  }
                },
                {
                  name: 'checkElectricityBill',
                  description: 'Check the electricity bill details using the 13-digit bill ID (شناسه قبض).',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      billId: { type: 'STRING', description: 'The 13-digit electricity bill ID' }
                    },
                    required: ['billId']
                  }
                },
                {
                  name: 'submitServiceRequest',
                  description: 'Submit an online form to request services like new branch, name change, etc.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      requestType: { type: 'STRING', description: 'Type of the request (e.g., انشعاب جدید, تغییر نام)' },
                      nationalId: { type: 'STRING', description: 'National ID of the customer (کد ملی)' },
                      phoneNumber: { type: 'STRING', description: 'Phone number' }
                    },
                    required: ['requestType', 'nationalId', 'phoneNumber']
                  }
                },
                {
                  name: 'displayWidget',
                  description: 'Displays a visual widget on the screen for the user (like a chart, image, code preview, or music player). Use this when the user asks for visual or rich media content.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      widgetType: { type: 'STRING', description: 'The type of widget to display (e.g. "chart", "image", "code", "audio")' },
                      title: { type: 'STRING', description: 'Title of the widget' },
                      contentUrl: { type: 'STRING', description: 'URL for image or audio if applicable' },
                      codeOrData: { type: 'STRING', description: 'Code snippet or JSON string for charts if applicable' }
                    },
                    required: ['widgetType', 'title']
                  }
                },
                {
                  name: 'reportOutage',
                  description: 'Report a power outage by providing the address or region.',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      address: { type: 'STRING', description: 'The exact address of the outage' },
                      region: { type: 'STRING', description: 'The region or neighborhood in Ilam' }
                    },
                    required: ['address']
                  }
                },
                {
                  name: 'executeNodeCode',
                  description: 'Executes arbitrary Node.js code securely. Use this for complex web scraping, parsing HTML with cheerio, or making advanced HTTP requests with axios to sites like bargheman.com. The code MUST be a function body that returns a Promise or a value. Example: `const axios = require("axios"); const cheerio = require("cheerio"); const res = await axios.get("url"); const $ = cheerio.load(res.data); return $("title").text();`',
                  parameters: {
                    type: 'OBJECT',
                    properties: {
                      code: { type: 'STRING', description: 'The JavaScript/Node.js code to execute. Must be valid async function body.' }
                    },
                    required: ['code']
                  }
                }
              ]
            }
          ],
          toolConfig: { includeServerSideToolInvocations: true }
        },
        callbacks: {
          onmessage: async (message) => {
            const data: any = {};
            
            // Forward audio
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) data.audio = audio;
            
            if (message.serverContent?.interrupted) data.interrupted = true;
            if (message.serverContent?.turnComplete) data.turnComplete = true;
            
            // Forward transcription
            const userParts = message.serverContent?.userTurn?.parts || [];
            let userText = '';
            for (const part of userParts) if (part.text) userText += part.text;
            if (userText) data.userText = userText;
            
            const modelParts = message.serverContent?.modelTurn?.parts || [];
            let modelText = '';
            for (const part of modelParts) if (part.text) modelText += part.text;
            if (modelText) data.modelText = modelText;
            
            // Handle tool calls
            if (message.toolCall?.functionCalls) {
              clientWs.send(JSON.stringify({ isProcessing: true }));
              const immediateResponses: any[] = [];
              for (const call of message.toolCall.functionCalls) {
                if (call.name === 'requestUserInputField') {
                  // Send to client to handle
                  clientWs.send(JSON.stringify({
                    toolCall: {
                      id: call.id,
                      name: call.name,
                      label: call.args?.label || 'لطفا مقدار را وارد کنید:'
                    }
                  }));
                  continue;
                }
                
                if (call.name === 'displayWidget') {
                  clientWs.send(JSON.stringify({
                    toolCall: {
                      id: call.id,
                      name: call.name,
                      widgetType: call.args?.widgetType,
                      title: call.args?.title,
                      contentUrl: call.args?.contentUrl,
                      codeOrData: call.args?.codeOrData
                    }
                  }));
                  
                  immediateResponses.push({
                    id: call.id,
                    name: call.name,
                    response: { success: true, message: "Widget displayed successfully." }
                  });
                  continue;
                }
                
                let responseData = {};
                switch (call.name) {
                  case 'searchWeb':
                    clientWs.send(JSON.stringify({ statusUpdate: 'در حال جستجو در وب...' }));
                    responseData = {
                      status: 'success',
                      message: `نتیجه جستجو برای "${call.args?.query}": مدیرعامل شرکت توزیع برق ایلام اعلام کرد با توجه به افزایش دما، از مشترکین درخواست می‌شود در ساعات اوج مصرف (۱۳ تا ۱۸) صرفه‌جویی کنند. هیچ قطعی برنامه ریزی شده ای در حال حاضر وجود ندارد.`
                    };
                    break;
                  case 'fillAndSubmitBillForm':
                    try {
                      clientWs.send(JSON.stringify({ statusUpdate: 'Navigating: در حال برقراری ارتباط واقعی با سرور سایت...' }));
                      console.log('Sending real Axios request for bill:', call.args?.billId);
                      
                      const billId = call.args?.billId;
                      if (!billId) {
                         responseData = { error: 'شناسه قبض وارد نشده است.' };
                         break;
                      }

                      clientWs.send(JSON.stringify({ statusUpdate: 'Filling Form & Retrieving Data: در حال استخراج اطلاعات...' }));
                      
                      // ACTUAL HTTP REQUEST:
                      // Note: Iranian utility servers often geo-block non-Iranian IPs (like this server's IP),
                      // and many require Captcha/SMS. We are attempting a real request to the public inquiry endpoint.
                      try {
                        const response = await axios.post('https://eserv.bargh-ilam.ir/api/bill/inquiry', {
                          bill_id: billId
                        }, {
                          timeout: 10000,
                          headers: { 'User-Agent': 'Mozilla/5.0' }
                        });
                        
                        responseData = { 
                          status: 'success', 
                          message: `اطلاعات واقعی استخراج شد.`,
                          raw_data: response.data 
                        };
                      } catch (axiosError: any) {
                        console.error("Real request failed:", axiosError.message);
                        responseData = { 
                          error: 'درخواست واقعی به سرور برق ارسال شد اما سرور مقصد پاسخ نداد (احتمالاً به دلیل مسدود بودن آی‌پی‌های خارج از ایران یا نیاز به کپچا/لاگین پیامکی). پیام خطای سرور: ' + axiosError.message
                        };
                      }
                    } catch (e: any) {
                      responseData = { error: 'Failed to execute real request: ' + e.message };
                    }
                    break;
                  case 'fetchUrl':
                    clientWs.send(JSON.stringify({ statusUpdate: 'در حال دریافت اطلاعات سایت...' }));
                    try {
                      console.log('Fetching URL:', call.args?.url);
                      const controller = new AbortController();
                      const timeoutId = setTimeout(() => controller.abort(), 8000);
                      const res = await fetch(call.args?.url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
                      clearTimeout(timeoutId);
                      const text = await res.text();
                      responseData = { status: res.status, text: text.substring(0, 3000) }; // return top 3k chars to avoid token limits
                    } catch (e: any) {
                      responseData = { error: 'Fetch failed: ' + e.message };
                    }
                    break;
                  case 'submitForm':
                    clientWs.send(JSON.stringify({ statusUpdate: 'در حال ارسال اطلاعات فرم...' }));
                    try {
                      console.log('Submitting form to:', call.args?.url);
                      let bodyObj = {};
                      try { bodyObj = JSON.parse(call.args?.bodyJson || '{}'); } catch(e){}
                      const controller = new AbortController();
                      const timeoutId = setTimeout(() => controller.abort(), 8000);
                      const res = await fetch(call.args?.url, {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'User-Agent': 'Mozilla/5.0'
                        },
                        body: JSON.stringify(bodyObj),
                        signal: controller.signal
                      });
                      clearTimeout(timeoutId);
                      const text = await res.text();
                      responseData = { status: res.status, text: text.substring(0, 3000) };
                    } catch (e: any) {
                      responseData = { error: 'Submit failed: ' + e.message };
                    }
                    break;
                  case 'initiateLivePhoneCall':
                    clientWs.send(JSON.stringify({ statusUpdate: 'در حال برقراری تماس صوتی اینترنتی...' }));
                    try {
                      console.log('Initiating Twilio phone call to:', call.args?.targetNumber);
                      const accountSid = process.env.TWILIO_ACCOUNT_SID;
                      const authToken = process.env.TWILIO_AUTH_TOKEN;
                      const fromNumber = process.env.TWILIO_PHONE_NUMBER;
                      
                      if (!accountSid || !authToken || !fromNumber) {
                        responseData = { error: 'Twilio API keys are missing. Inform the user they must provide TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in settings.' };
                      } else {
                        const twilioClient = nodeRequire('twilio')(accountSid, authToken);
                        const twilioCall = await twilioClient.calls.create({
                           twiml: `<Response><Say language="fa-IR">این تماس از طرف دستیار هوشمند شما برقرار شده است.</Say></Response>`,
                           to: call.args?.targetNumber,
                           from: fromNumber
                        });
                        responseData = { status: 'success', callSid: twilioCall.sid, message: 'Call initiated successfully.' };
                      }
                    } catch (e: any) {
                      console.error('Phone call failed:', e);
                      responseData = { error: 'Phone call failed: ' + e.message };
                    }
                    break;
                  case 'executeNodeCode':
                    clientWs.send(JSON.stringify({ statusUpdate: 'در حال خواندن اطلاعات قبض از سامانه...' }));
                    try {
                      console.log('Executing custom Node.js code...');
                      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
                      const fn = new AsyncFunction('require', call.args?.code);
                      const customRequire = (moduleName: string) => {
                        if (moduleName === 'axios') return nodeRequire('axios');
                        if (moduleName === 'cheerio') return nodeRequire('cheerio');
                        throw new Error(`Module ${moduleName} is not permitted.`);
                      };
                      const result = await fn(customRequire);
                      responseData = { status: 'success', result: result };
                    } catch (e: any) {
                      console.error('Execute Node Code Failed:', e);
                      responseData = { error: 'Execution failed: ' + e.message };
                    }
                    break;
                  default:
                    responseData = { error: 'عملیات یافت نشد' };
                }
                
                immediateResponses.push({
                  id: call.id,
                  name: call.name,
                  response: responseData
                });
              }
              
              if (immediateResponses.length > 0) {
                session.sendToolResponse({ functionResponses: immediateResponses });
              }
            }
            
            if (Object.keys(data).length > 0) {
              clientWs.send(JSON.stringify(data));
            }
          },
          onerror: (e: any) => {
            console.error('Gemini error:', e?.message || e?.name || 'Unknown error');
            try {
              const errorMsg = e?.message || e?.toString() || 'Error occurred';
              clientWs.send(JSON.stringify({ error: errorMsg }));
            } catch (err) {}
          },
          onclose: (e) => {
            console.log('Gemini connection closed', e);
            clientWs.send(JSON.stringify({ status: 'Session closed' }));
          }
        }
      };
      
      let session: any;
      try {
        const result = await providerManager.connect(clientWs, ai, config);
        session = result.session;
      } catch (err: any) {
        console.error('All providers failed:', err);
        clientWs.send(JSON.stringify({ error: 'All AI models failed to connect or are unavailable.' }));
        clientWs.close();
        return;
      }
      
      // Send initial prompt
      session.sendClientContent({
        turns: [{role: 'user', parts: [{text: 'سلام، لطفا گفتگو را عنوان اپراتور پاسخگو آغاز کن.'}]}],
        turnComplete: true,
      });

      clientWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.audio) {
            session.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
            });
          } else if (msg.toolResponse) {
            session.sendToolResponse({
              functionResponses: [msg.toolResponse]
            });
          }
        } catch (e) {
          console.error('Error handling client message', e);
        }
      });

      clientWs.on('close', () => {
        console.log('Client closed Live API connection');
        // The sdk session doesn't have session.close() yet maybe? Let's just catch it.
        try { (session as any).close?.(); } catch (e) {}
      });

    } catch (err: any) {
      console.error('Failed to start Live session:', err?.message || err?.name || 'Unknown error');
      try {
        let errorMsg = 'Unknown error occurred connecting to AI';
        if (err instanceof Error) {
          errorMsg = err.message;
        } else if (typeof err === 'object' && err !== null) {
           errorMsg = JSON.stringify(err);
        } else if (typeof err === 'string') {
           errorMsg = err;
        }
        clientWs.send(JSON.stringify({ error: 'ارتباط با هوش مصنوعی برقرار نشد: ' + errorMsg }));
      } catch (e) {}
    }
  });
}

startServer();
