/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData, encode} from './utils';
import './human-avatar';
import './chart';
import './equalizer';
import './status-indicator';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() aiState: 'idle' | 'listening' | 'processing' | 'speaking' = 'idle';
  @state() isLightOn = false;
  @state() status = '';
  @state() error = '';
  @state() requestedUI: { label: string, toolCallId: string } | null = null;
  @state() inputValue: string = '';
  @state() subscriberData: any = null;
  @state() activeCall: { number: string, status: string } | null = null;
  @state() userSubtitles = '';
  @state() modelSubtitles = '';
  @state() isSettingsOpen = false;
  @state() selectedVoice = localStorage.getItem('gdm_live_voice') || 'Aoede';
  @state() widgetData: { title: string, widgetType: string, contentUrl?: string, codeOrData?: string } | null = null;
  @state() activeModel: string = 'gpt-4o-live-mini';
  @state() aiTaskStatus: string = 'آماده به کار';
  @state() aiLogs: {time: string, message: string}[] = [];

  // PBX Console & Web Agent Simulation Properties
  @state() activeTab: 'monitor' | 'subscribers' | 'strategy' | 'webagent' | 'logs' = 'monitor';
  @state() subscribersList: any[] = [];
  @state() searchQuery: string = '';
  @state() systemLogsList: any[] = [];
  @state() diagnosticsData: any = null;
  @state() showNewSubModal = false;
  @state() webAgentLogs: {time: string, msg: string}[] = [];
  @state() isWebAgentRunning = false;
  @state() activeOutboundCall: { name: string, phone: string, debt: number, status: string, conversation: { sender: string, text: string }[] } | null = null;
  @state() customToneStrategy: string = 'friendly';
  @state() empathyLevel: number = 75;
  @state() persistenceLevel: number = 80;
  @state() responseDelay: number = 300;
  @state() isHumanTakeoverActive = false;
  @state() humanTextResponse = '';
  @state() isCampaignRunning = false;
  @state() campaignStatus = '';
  @state() isConsoleOpen = false;

  private session: WebSocket | null = null;
  private inputAudioContext = new (window.AudioContext ||
    window.webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    window.webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    .room-dark-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.96);
      z-index: 30;
      pointer-events: none;
      transition: opacity 0.4s ease;
    }

    .room-bright .room-dark-overlay {
      opacity: 0;
    }

    /* Realistic 1-pole switch */
    .wall-switch-container {
      position: absolute;
      top: 55%;
      right: 8vw;
      width: 100px;
      height: 140px;
      background: #e0e0e0;
      border-radius: 8px;
      box-shadow: 
        inset 0 2px 5px rgba(255,255,255,1),
        inset 0 -2px 5px rgba(0,0,0,0.1),
        3px 8px 20px rgba(0,0,0,0.6),
        -1px -1px 3px rgba(255,255,255,0.3);
      z-index: 45;
      display: flex;
      align-items: center;
      justify-content: center;
      transform: perspective(600px) rotateY(-10deg);
    }

    .wall-switch-screws {
      position: absolute;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    
    .wall-switch-screws::before, .wall-switch-screws::after {
      content: '';
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: linear-gradient(135deg, #ccc, #888);
      box-shadow: inset 0 1px 2px rgba(0,0,0,0.5), 0 1px 1px rgba(255,255,255,0.8);
    }
    .wall-switch-screws::before { top: 10px; }
    .wall-switch-screws::after { bottom: 10px; }

    .wall-switch-plate {
      width: 46px;
      height: 80px;
      background: #333;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: inset 0 2px 8px rgba(0,0,0,0.8);
    }

    .wall-switch-button {
      width: 40px;
      height: 50px;
      background: linear-gradient(to bottom, #fafafa, #d4d4d4);
      border-radius: 4px;
      box-shadow: 
        0 8px 6px -2px rgba(0,0,0,0.6),
        inset 0 2px 3px rgba(255,255,255,1);
      cursor: pointer;
      transition: transform 0.05s, box-shadow 0.05s;
      transform-style: preserve-3d;
      transform: perspective(150px) rotateX(20deg);
    }

    .wall-switch-button.on {
      transform: perspective(150px) rotateX(-20deg);
      box-shadow: 
        0 -8px 6px -2px rgba(0,0,0,0.6),
        inset 0 -2px 3px rgba(255,255,255,1);
      background: linear-gradient(to top, #fafafa, #d4d4d4);
    }

    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      opacity: 0.5;
      color: rgba(255, 255, 255, 0.4);
      font-size: 0.8rem;
      pointer-events: none;
      transition: opacity 0.5s ease;
    }

    /* Widget Overlay Styles */
    .widget-overlay {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 90%;
      max-width: 600px;
      background: rgba(10, 25, 47, 0.85);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(0, 170, 255, 0.3);
      border-radius: 16px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5), 0 0 20px rgba(0, 170, 255, 0.2);
      z-index: 50;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      animation: popIn 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    }
    
    @keyframes popIn {
      from { opacity: 0; transform: translate(-50%, -45%) scale(0.9); }
      to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }

    .widget-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding-bottom: 12px;
    }
    
    .widget-title {
      font-size: 1.25rem;
      font-weight: 600;
      color: #fff;
    }

    .widget-close {
      background: rgba(255, 255, 255, 0.1);
      border: none;
      color: #fff;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background 0.2s;
    }
    .widget-close:hover {
      background: rgba(255, 0, 85, 0.5);
    }

    .widget-content {
      min-height: 100px;
      max-height: 60vh;
      overflow-y: auto;
      color: #e2e8f0;
      font-size: 0.95rem;
      line-height: 1.6;
    }
    
    .widget-image {
      width: 100%;
      border-radius: 8px;
      object-fit: cover;
    }
    
    .data-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      font-size: 0.9rem;
    }
    
    .data-table th, .data-table td {
      padding: 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      text-align: right;
    }
    
    .data-table th {
      font-weight: bold;
      color: #00aaff;
      background: rgba(0, 170, 255, 0.05);
    }
    
    .data-table tbody tr:hover {
      background: rgba(255, 255, 255, 0.05);
    }

    .table-container {
      background: #020205;
      border-radius: 8px;
      overflow-x: auto;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .widget-code {
      background: #020205;
      padding: 16px;
      border-radius: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    
    .status-indicator {
      position: absolute;
      top: 24px;
      right: 24px;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      z-index: 20;
    }
    .model-badge {
      background: rgba(10, 25, 47, 0.7);
      border: 1px solid rgba(0, 170, 255, 0.3);
      padding: 6px 12px;
      border-radius: 20px;
      font-family: 'Inter', sans-serif;
      font-size: 0.8rem;
      color: #00aaff;
      display: flex;
      align-items: center;
      gap: 8px;
      backdrop-filter: blur(8px);
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      background-color: #10b981;
      border-radius: 50%;
      animation: pulseDot 2s infinite;
    }
    @keyframes pulseDot {
      0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
      100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }
    .task-status {
      font-size: 0.85rem;
      color: #e2e8f0;
      background: rgba(0, 0, 0, 0.5);
      padding: 6px 12px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      direction: rtl;
    }
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    .log-panel {
      position: absolute;
      bottom: 24px;
      left: 24px;
      width: 350px;
      max-height: 250px;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 12px;
      overflow-y: auto;
      z-index: 20;
      display: flex;
      flex-direction: column;
      gap: 8px;
      direction: rtl;
    }
    .log-entry {
      font-size: 0.8rem;
      color: #cbd5e1;
      display: flex;
      gap: 8px;
      line-height: 1.4;
      animation: slideInLog 0.3s ease-out;
    }
    .log-time {
      color: #00aaff;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      white-space: nowrap;
    }
    @keyframes slideInLog {
      from { opacity: 0; transform: translateX(-10px); }
      to { opacity: 1; transform: translateX(0); }
    }

    .audio-player-wrapper {
      background: #111;
      border-radius: 12px;
      padding: 16px;
      text-align: center;
    }
    .audio-visualizer-placeholder {
      height: 60px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(90deg, #ff0055, #00aaff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      font-weight: bold;
      animation: gradientShift 3s ease infinite;
    }
    @keyframes gradientShift {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }

    .poetry-text {
      font-weight: 300;
      font-size: 0.85rem;
      direction: rtl;
    }
    .input-overlay {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(10px);
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .input-modal {
      background: #1e1e1e;
      padding: 24px;
      border-radius: 16px;
      border: 1px solid #333;
      display: flex;
      flex-direction: column;
      gap: 16px;
      width: 320px;
      color: white;
      font-family: system-ui, sans-serif;
      direction: rtl;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    .input-modal label {
      font-size: 1.1rem;
      font-weight: 500;
      color: #eaeaea;
    }
    .input-modal input {
      background: #000;
      border: 1px solid #444;
      color: white;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 1.2rem;
      outline: none;
      direction: ltr;
      text-align: left;
    }
    .input-modal input:focus {
      border-color: #646cff;
    }
    .input-modal button {
      background: #646cff;
      color: white;
      border: none;
      padding: 12px;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: bold;
      cursor: pointer;
    }
    .input-modal button:hover {
      background: #535bf2;
    }

    .start-overlay {
      position: absolute;
      inset: 0;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      font-size: 24px;
      font-family: Tahoma, Arial, sans-serif;
      direction: rtl;
      cursor: pointer;
      backdrop-filter: blur(5px);
      transition: opacity 0.5s ease;
    }

    .ai-orb-container {
      position: absolute;
      bottom: 12vh;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 15px;
      z-index: 50;
      pointer-events: none;
      transition: opacity 0.5s ease;
      opacity: 0;
    }

    .ai-orb-container.visible {
      opacity: 1;
    }

    .ai-orb {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: radial-gradient(circle at 30% 30%, #4a90e2, #1a1a2e);
      box-shadow: 0 0 20px rgba(74, 144, 226, 0.6), inset 0 0 20px rgba(255,255,255,0.4);
      transition: all 0.5s ease;
    }

    .ai-orb.listening {
      background: radial-gradient(circle at 30% 30%, #e24a4a, #2e1a1a);
      box-shadow: 0 0 30px rgba(226, 74, 74, 0.8), inset 0 0 20px rgba(255,255,255,0.4);
      animation: pulse-listening 1.5s ease-in-out infinite;
    }

    .ai-orb.processing {
      background: radial-gradient(circle at 30% 30%, #e2b94a, #2e2a1a);
      box-shadow: 0 0 30px rgba(226, 185, 74, 0.8), inset 0 0 20px rgba(255,255,255,0.4);
      animation: spin-processing 2s linear infinite;
    }

    .ai-orb.speaking {
      background: radial-gradient(circle at 30% 30%, #4ae290, #1a2e1a);
      box-shadow: 0 0 40px rgba(74, 226, 144, 1), inset 0 0 20px rgba(255,255,255,0.4);
      animation: pulse-speaking 1s ease-in-out infinite alternate;
    }

    @keyframes pulse-listening {
      0% { transform: scale(0.95); opacity: 0.8; }
      50% { transform: scale(1.05); opacity: 1; }
      100% { transform: scale(0.95); opacity: 0.8; }
    }

    @keyframes spin-processing {
      0% { transform: rotate(0deg) scale(1); filter: hue-rotate(0deg); }
      50% { transform: rotate(180deg) scale(1.1); filter: hue-rotate(90deg); }
      100% { transform: rotate(360deg) scale(1); filter: hue-rotate(360deg); }
    }

    @keyframes pulse-speaking {
      0% { transform: scale(1); box-shadow: 0 0 20px rgba(74, 226, 144, 0.6); }
      100% { transform: scale(1.2); box-shadow: 0 0 50px rgba(74, 226, 144, 1); }
    }

    .ai-state-label {
      font-size: 1rem;
      color: rgba(255,255,255,0.9);
      font-family: 'B Tahrir', 'IranNastaliq', Tahoma, serif;
      direction: rtl;
      text-shadow: 0 2px 5px rgba(0,0,0,0.8);
      letter-spacing: 1px;
      font-weight: bold;
    }

    .pulse-indicator {
      position: absolute;
      inset: 0;
      pointer-events: none;
      box-shadow: inset 0 0 20px rgba(100, 108, 255, 0.4);
      animation: ai-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
      z-index: 5;
    }
    
    @keyframes ai-pulse {
      0%, 100% { box-shadow: inset 0 0 10px rgba(100, 108, 255, 0.2); }
      50% { box-shadow: inset 0 0 60px rgba(100, 108, 255, 0.8); }
    }

    .dashboard-panel {
      position: absolute;
      top: 20px;
      right: 20px;
      width: 400px;
      z-index: 20;
      pointer-events: auto;
    }

    .listening-indicator {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      text-align: center;
      color: rgba(255, 255, 255, 0.9);
      font-size: 0.85rem;
      font-weight: 300;
      pointer-events: none;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 12px;
      font-family: 'B Tahrir', 'IranNastaliq', Tahoma, serif;
      direction: rtl;
      z-index: 10;
    }

    .recording-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background-color: #ff4a4a;
      box-shadow: 0 0 10px #ff4a4a;
      animation: blink 1s ease-in-out infinite;
    }

    @keyframes blink {
      0% { opacity: 0.3; transform: scale(0.8); }
      50% { opacity: 1; transform: scale(1.2); }
      100% { opacity: 0.3; transform: scale(0.8); }
    }

    .outage-panel {
      position: absolute;
      top: 20px;
      left: 20px;
      width: 320px;
      z-index: 20;
      background: transparent;
      padding: 10px;
      color: rgba(255, 255, 255, 0.8);
      font-family: 'B Tahrir', 'IranNastaliq', Tahoma, serif;
      font-weight: 300;
      direction: rtl;
      font-size: 0.75rem;
      pointer-events: auto;
    }
    .active-call-panel {
      position: absolute;
      bottom: 120px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.7);
      border-radius: 20px;
      padding: 15px 30px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      color: #fff;
      font-family: system-ui;
      z-index: 30;
      border: 1px solid rgba(100, 108, 255, 0.5);
      animation: pulse-border 2s infinite;
    }
    @keyframes pulse-border {
      0% { border-color: rgba(100, 108, 255, 0.3); box-shadow: 0 0 10px rgba(100, 108, 255, 0); }
      50% { border-color: rgba(100, 108, 255, 1); box-shadow: 0 0 20px rgba(100, 108, 255, 0.4); }
      100% { border-color: rgba(100, 108, 255, 0.3); box-shadow: 0 0 10px rgba(100, 108, 255, 0); }
    }
    .outage-panel h4 {
      margin: 0 0 8px 0;
      color: #646cff;
      font-weight: 300;
      font-size: 0.85rem;
      border-bottom: 1px solid rgba(255,255,255,0.2);
      padding-bottom: 4px;
    }
    .loading-pulse {
      animation: pulse 1.5s infinite;
      opacity: 0.7;
    }
    @keyframes pulse {
      0% { opacity: 0.5; }
      50% { opacity: 1; }
      100% { opacity: 0.5; }
    }

    .footer-contact {
      position: absolute;
      bottom: 20px;
      left: 0;
      right: 0;
      display: flex;
      justify-content: center;
      gap: 30px;
      z-index: 60;
      pointer-events: auto;
      font-family: inherit;
      direction: rtl;
    }
    
    .contact-item {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.7);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.5);
      border-radius: 20px;
      padding: 6px 16px;
      color: #333;
      font-size: 0.95rem;
      font-weight: 600;
      box-shadow: 0 4px 12px rgba(0,0,0,0.05);
      transition: all 0.3s ease;
      text-decoration: none;
    }
    
    .contact-item:hover {
      background: rgba(255, 255, 255, 0.9);
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(0,0,0,0.1);
    }

    .contact-item svg {
      width: 18px;
      height: 18px;
      color: #00aaff;
    }

    .subtitles-container {
      position: absolute;
      bottom: 8vh;
      left: 50%;
      transform: translateX(-50%);
      width: 90%;
      max-width: 600px;
      z-index: 40;
      display: flex;
      flex-direction: column;
      gap: 12px;
      pointer-events: auto;
      font-family: inherit;
      direction: rtl;
    }

    .user-subtitle, .model-subtitle {
      background: rgba(255, 255, 255, 0.85);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(0, 0, 0, 0.08);
      border-radius: 16px;
      padding: 14px 22px;
      font-size: 1.1rem;
      line-height: 1.7;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.05);
      display: flex;
      align-items: flex-start;
      gap: 12px;
      animation: subtitleAppear 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }

    .user-subtitle {
      border-right: 4px solid #646cff;
      color: #1e293b;
      align-self: flex-start;
      width: fit-content;
      max-width: 85%;
    }

    .model-subtitle {
      border-right: 4px solid #10b981;
      color: #0f172a;
      align-self: flex-end;
      width: fit-content;
      max-width: 85%;
    }

    .placeholder-sub {
      border-right: 4px dashed rgba(0, 0, 0, 0.15);
      color: #64748b;
      font-size: 1rem;
      align-self: center;
    }

    .sub-label {
      font-weight: bold;
      font-size: 0.85rem;
      padding: 2px 6px;
      border-radius: 4px;
      white-space: nowrap;
    }

    .user-subtitle .sub-label {
      background: rgba(100, 108, 255, 0.1);
      color: #4f46e5;
    }

    .model-subtitle .sub-label {
      background: rgba(16, 185, 129, 0.1);
      color: #059669;
    }

    .sub-text {
      flex: 1;
      text-align: right;
    }

    @keyframes subtitleAppear {
      from {
        opacity: 0;
        transform: translateY(8px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    /* Header Container (Top Left) */
    .top-header-container {
      position: absolute;
      top: 24px;
      left: 24px;
      display: flex;
      align-items: center;
      gap: 12px;
      z-index: 45;
      pointer-events: auto;
    }

    /* Voice Toggle Button */
    .voice-toggle-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: rgba(15, 15, 20, 0.7);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      color: #fff;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(0,0,0,0.3);
      transition: all 0.2s ease-in-out;
      font-family: Tahoma, Arial, sans-serif;
      direction: rtl;
    }

    .voice-toggle-btn:hover {
      background: rgba(100, 108, 255, 0.2);
      border-color: rgba(100, 108, 255, 0.4);
      transform: translateY(-1px);
    }

    .voice-toggle-btn:active {
      transform: translateY(1px);
    }

    .settings-icon {
      font-size: 1.1rem;
    }



    .avatar-container {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -40%);
      width: 400px;
      height: 700px;
      z-index: 10;
      pointer-events: auto;
      cursor: pointer;
      display: flex;
      justify-content: center;
      align-items: center;
      animation: avatarBreathe 4s ease-in-out infinite;
      mix-blend-mode: multiply;
      transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .avatar-image {
      width: 100%;
      height: 100%;
      object-fit: contain;
      filter: drop-shadow(0 0 20px rgba(0, 0, 0, 0.05));
      transition: filter 0.3s ease;
    }

    .avatar-glow {
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(16, 185, 129, 0.15) 0%, transparent 60%);
      opacity: 0;
      transition: opacity 0.3s ease, transform 0.3s ease;
      z-index: -1;
    }

    /* Dynamic States */
    .avatar-container.listening {
      animation: avatarBreatheListening 2s ease-in-out infinite;
    }
    .avatar-container.listening .avatar-image {
      filter: drop-shadow(0 0 25px rgba(100, 108, 255, 0.4));
    }

    .avatar-container.processing {
      animation: avatarBreatheProcessing 1.5s ease-in-out infinite;
    }
    .avatar-container.processing .avatar-image {
      filter: drop-shadow(0 0 35px rgba(245, 158, 11, 0.3));
    }

    .avatar-container.speaking {
      animation: avatarBreatheSpeaking 2.5s ease-in-out infinite;
    }
    .avatar-container.speaking .avatar-image {
      filter: drop-shadow(0 0 30px rgba(16, 185, 129, 0.5));
    }

    @keyframes avatarBreathe {
      0%, 100% { transform: translate(-50%, -40%) scale(1); }
      50% { transform: translate(-50%, -42%) scale(1.02); }
    }
    @keyframes avatarBreatheListening {
      0%, 100% { transform: translate(-50%, -40%) scale(1); }
      50% { transform: translate(-50%, -43%) scale(1.03); }
    }
    @keyframes avatarBreatheProcessing {
      0%, 100% { transform: translate(-50%, -40%) scale(1); }
      50% { transform: translate(-50%, -41%) scale(1.01); }
    }
    @keyframes avatarBreatheSpeaking {
      0%, 100% { transform: translate(-50%, -40%) scale(1.02); }
      25% { transform: translate(-50%, -42%) scale(1.04); }
      50% { transform: translate(-50%, -40%) scale(1.02); }
      75% { transform: translate(-50%, -39%) scale(1.05); }
    }

    .tap-to-start-hint {
      position: absolute;
      bottom: 22vh;
      left: 50%;
      transform: translateX(-50%);
      text-align: center;
      color: #3b4e6b;
      font-family: Tahoma, Arial, sans-serif;
      font-size: 1rem;
      font-weight: 500;
      pointer-events: none;
      z-index: 25;
      direction: rtl;
      background: rgba(255, 255, 255, 0.45);
      padding: 10px 20px;
      border-radius: 20px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(0, 0, 0, 0.05);
      box-shadow: 0 10px 30px rgba(0,0,0,0.03);
    }

    /* Advanced Dashboard Console (Glassmorphism Dark) */
    .dashboard-toggle-btn {
      position: absolute;
      top: 24px;
      right: 24px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 18px;
      background: rgba(10, 25, 47, 0.8);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(0, 170, 255, 0.4);
      border-radius: 20px;
      color: #00e5ff;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 0 15px rgba(0, 229, 255, 0.25);
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 45;
      font-family: inherit;
      direction: rtl;
    }

    .dashboard-toggle-btn:hover {
      background: rgba(0, 229, 255, 0.15);
      box-shadow: 0 0 25px rgba(0, 229, 255, 0.5);
      transform: scale(1.05);
    }

    .console-sidebar {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 480px;
      background: rgba(4, 10, 22, 0.94);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border-right: 1px solid rgba(0, 170, 255, 0.25);
      box-shadow: 10px 0 40px rgba(0, 0, 0, 0.7);
      z-index: 100;
      display: flex;
      flex-direction: column;
      transform: translateX(-100%);
      transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      direction: rtl;
      font-family: inherit;
    }

    .console-sidebar.open {
      transform: translateX(0);
    }

    .console-header {
      padding: 24px;
      border-bottom: 1px solid rgba(0, 170, 255, 0.15);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .console-title {
      font-size: 1.25rem;
      font-weight: 700;
      color: #00e5ff;
      text-shadow: 0 0 10px rgba(0, 229, 255, 0.3);
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .console-close-btn {
      background: none;
      border: none;
      color: rgba(255, 255, 255, 0.6);
      font-size: 1.5rem;
      cursor: pointer;
      transition: color 0.2s;
    }

    .console-close-btn:hover {
      color: #ff4a4a;
    }

    /* Tabs Bar */
    .console-tabs {
      display: flex;
      background: rgba(255, 255, 255, 0.03);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding: 0 12px;
      gap: 4px;
      overflow-x: auto;
    }

    .console-tab {
      padding: 14px 16px;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: rgba(255, 255, 255, 0.65);
      font-size: 0.8rem;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s;
    }

    .console-tab:hover {
      color: #fff;
    }

    .console-tab.active {
      color: #00e5ff;
      border-bottom-color: #00e5ff;
      text-shadow: 0 0 8px rgba(0, 229, 255, 0.2);
    }

    .console-content {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .stat-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 12px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .stat-card-title {
      font-size: 0.75rem;
      color: rgba(255, 255, 255, 0.5);
    }

    .stat-card-value {
      font-size: 1.15rem;
      font-weight: 700;
      color: #fff;
    }

    /* Glowing Map Simulation */
    .map-container {
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(0, 170, 255, 0.15);
      border-radius: 16px;
      padding: 20px;
      position: relative;
      height: 180px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    .map-bg-grid {
      position: absolute;
      inset: 0;
      background-image: radial-gradient(rgba(0, 170, 255, 0.08) 1px, transparent 1px);
      background-size: 16px 16px;
      opacity: 0.6;
    }

    .map-node {
      position: absolute;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }

    .map-node-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 10px #10b981;
      position: relative;
    }

    .map-node-dot.active {
      background: #ff4a4a;
      box-shadow: 0 0 15px #ff4a4a;
      animation: blink 1s infinite alternate;
    }

    .map-node-dot::after {
      content: '';
      position: absolute;
      inset: -4px;
      border-radius: 50%;
      border: 1px solid currentColor;
      opacity: 0.4;
      animation: ripple 1.5s infinite;
    }

    @keyframes ripple {
      0% { transform: scale(1); opacity: 0.4; }
      100% { transform: scale(2.2); opacity: 0; }
    }

    .map-node-label {
      font-size: 0.7rem;
      color: rgba(255, 255, 255, 0.75);
      white-space: nowrap;
      background: rgba(0,0,0,0.6);
      padding: 2px 6px;
      border-radius: 4px;
    }

    /* Outbound Simulation Widget */
    .outbound-simulator {
      background: rgba(0, 170, 255, 0.04);
      border: 1px solid rgba(0, 170, 255, 0.15);
      border-radius: 16px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .outbound-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.85rem;
      font-weight: 600;
      color: #00e5ff;
    }

    .outbound-status {
      font-size: 0.75rem;
      background: rgba(0, 229, 255, 0.1);
      padding: 2px 8px;
      border-radius: 10px;
    }

    .outbound-dialogue-box {
      background: rgba(0,0,0,0.5);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      height: 180px;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 0.8rem;
    }

    .dialogue-bubble {
      padding: 8px 12px;
      border-radius: 12px;
      max-width: 85%;
      line-height: 1.5;
    }

    .dialogue-bubble.ai {
      background: rgba(16, 185, 129, 0.15);
      border-right: 3px solid #10b981;
      color: #e2e8f0;
      align-self: flex-start;
    }

    .dialogue-bubble.user {
      background: rgba(255, 255, 255, 0.06);
      border-right: 3px solid #646cff;
      color: #e2e8f0;
      align-self: flex-end;
    }

    .dialogue-bubble.operator {
      background: rgba(0, 229, 255, 0.15);
      border-right: 3px solid #00e5ff;
      color: #e2e8f0;
      align-self: flex-start;
    }

    .dialogue-bubble.system {
      background: none;
      color: rgba(255,255,255,0.4);
      font-size: 0.75rem;
      text-align: center;
      align-self: center;
    }

    /* Human Intervention Form */
    .takeover-form {
      display: flex;
      gap: 8px;
    }

    .takeover-input {
      flex: 1;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      padding: 8px 12px;
      color: #fff;
      font-size: 0.8rem;
      outline: none;
    }

    .takeover-input:focus {
      border-color: #00e5ff;
    }

    .takeover-btn {
      background: #00e5ff;
      color: #020205;
      border: none;
      border-radius: 8px;
      padding: 8px 16px;
      font-size: 0.8rem;
      font-weight: 700;
      cursor: pointer;
    }

    /* Subscribers search & Table */
    .search-input {
      width: 100%;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 10px;
      padding: 10px 14px;
      color: #fff;
      font-size: 0.85rem;
      outline: none;
      box-sizing: border-box;
    }

    .search-input:focus {
      border-color: #00e5ff;
    }

    .subscriber-card-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 400px;
      overflow-y: auto;
    }

    .subscriber-row-card {
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      padding: 12px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: background 0.2s;
    }

    .subscriber-row-card:hover {
      background: rgba(0, 170, 255, 0.05);
      border-color: rgba(0, 170, 255, 0.15);
    }

    .sub-meta-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .sub-name {
      font-size: 0.9rem;
      font-weight: 600;
      color: #fff;
    }

    .sub-details {
      font-size: 0.75rem;
      color: rgba(255,255,255,0.5);
    }

    .sub-action-btn {
      background: rgba(0, 170, 255, 0.15);
      border: 1px solid rgba(0, 170, 255, 0.3);
      color: #00e5ff;
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .sub-action-btn:hover {
      background: #00e5ff;
      color: #020205;
    }

    /* Strategy tuning sliders */
    .slider-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .slider-label {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: rgba(255,255,255,0.6);
    }

    .custom-range-slider {
      width: 100%;
      accent-color: #00e5ff;
      background: rgba(255,255,255,0.1);
      border-radius: 4px;
      height: 6px;
    }

    /* Web Agent Terminal Output */
    .agent-terminal {
      background: #020206;
      border: 1px solid rgba(0, 170, 255, 0.2);
      border-radius: 12px;
      padding: 14px;
      font-family: 'JetBrains Mono', monospace, Consolas;
      font-size: 0.75rem;
      color: #10b981;
      height: 200px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .agent-log-line {
      display: flex;
      gap: 10px;
    }

    .agent-log-time {
      color: rgba(255,255,255,0.3);
    }

    .agent-log-text {
      color: #10b981;
    }

    /* Diagnostic Logs list */
    .diagnostic-logs-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 250px;
      overflow-y: auto;
      background: rgba(0,0,0,0.3);
      padding: 10px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.05);
    }

    .diagnostic-log-row {
      font-size: 0.72rem;
      display: flex;
      gap: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.02);
      padding-bottom: 4px;
    }

    .diag-level {
      color: #00e5ff;
      font-weight: bold;
    }

    .diag-msg {
      color: rgba(255,255,255,0.85);
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private playClickSound() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const bufferSize = ctx.sampleRate * 0.05;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.01));
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = this.isLightOn ? 1200 : 800;
    
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.04);
    
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    
    noise.start();
  }

  private handleOrbClick(e: Event) {
    this.toggleLight(e);
  }

  private async toggleLight(e: Event) {
    e.stopPropagation();
    this.isLightOn = !this.isLightOn;
    this.playClickSound();
    
    if (this.isLightOn) {
      this.updateStatus('در حال اتصال خودکار میکروفون و دستیار صوتی...');
      
      // Request microphone immediately before awaiting anything to avoid dropping user gesture in strict browsers
      const streamPromise = navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      if (this.inputAudioContext.state === 'suspended') {
        this.inputAudioContext.resume();
      }
      if (this.outputAudioContext.state === 'suspended') {
        this.outputAudioContext.resume();
      }
      
      await this.startRecording(streamPromise);
      if (!this.session) {
        await this.initSession();
      }
    } else {
      this.stopRecording();
      if (this.session) {
        this.session.close();
        this.session = null;
      }
    }
  }

  protected firstUpdated() {
    this.fetchSubscribers();
    this.fetchDiagnostics();
    this.fetchSystemLogs();

    // Start periodic dashboard updates
    setInterval(() => this.fetchDiagnostics(), 5000);
    setInterval(() => this.fetchSystemLogs(), 3000);
  }

  private async fetchSubscribers() {
    try {
      const res = await fetch(`/api/subscribers?q=${encodeURIComponent(this.searchQuery)}`);
      if (!res.ok) return;
      const ct = res.headers.get('content-type');
      if (ct && ct.includes('application/json')) {
        const data = await res.json();
        if (data && data.subscribers) {
          this.subscribersList = data.subscribers;
        }
      }
    } catch (e) {
      // Ignore transient fetch errors
    }
  }

  private async fetchDiagnostics() {
    try {
      const res = await fetch('/api/diagnostics');
      if (!res.ok) return;
      const ct = res.headers.get('content-type');
      if (ct && ct.includes('application/json')) {
        const data = await res.json();
        this.diagnosticsData = data;
      }
    } catch (e) {
      // Ignore transient fetch errors
    }
  }

  private async fetchSystemLogs() {
    try {
      const res = await fetch('/api/system-logs');
      if (!res.ok) return;
      const ct = res.headers.get('content-type');
      if (ct && ct.includes('application/json')) {
        const data = await res.json();
        if (data && data.logs) {
          this.systemLogsList = data.logs;
        }
      }
    } catch (e) {
      // Ignore transient fetch errors
    }
  }

  private async createNewSubscriber(name: string, phone: string, debt: number, region: string) {
    try {
      const res = await fetch('/api/subscribers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, debt, region })
      });
      if (!res.ok) return;
      const ct = res.headers.get('content-type');
      if (ct && ct.includes('application/json')) {
        const data = await res.json();
        if (data.success) {
          this.fetchSubscribers();
          this.fetchSystemLogs();
          this.showNewSubModal = false;
        }
      }
    } catch (e) {
      console.error('Error creating subscriber:', e);
    }
  }

  private async triggerCampaign(region: string, minDebt: number) {
    this.isCampaignRunning = true;
    this.campaignStatus = 'در حال راه‌اندازی کمپین...';
    try {
      const res = await fetch('/api/campaigns/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region, minDebt })
      });
      if (!res.ok) throw new Error('Campaign API failed');
      const ct = res.headers.get('content-type');
      if (ct && ct.includes('application/json')) {
        const data = await res.json();
        if (data.success) {
          this.campaignStatus = `کمپین فعال برای ${data.targetCount} مشترک`;
          setTimeout(() => {
            this.isCampaignRunning = false;
            this.campaignStatus = '';
            this.fetchSystemLogs();
          }, 10000);
        }
      }
    } catch (e) {
      this.campaignStatus = 'خطا در اجرای کمپین';
      this.isCampaignRunning = false;
    }
  }

  private runWebAgentSimulation() {
    if (this.isWebAgentRunning) return;
    this.isWebAgentRunning = true;
    this.webAgentLogs = [];
    const steps = [
      { time: '۰۰:۰۱', msg: 'اتصال به پورتال یکپارچه خدمات مشترکین توانیر (CIS)' },
      { time: '۰۰:۰۳', msg: 'دریافت تصویر سیستم تایید هویت تصادفی (Captcha)' },
      { time: '۰۰:۰۵', msg: 'استفاده از شبکه عصبی سبک محلی برای دور زدن کپچا... موفقیت‌آمیز!' },
      { time: '۰۰:۰۸', msg: 'لاگین امن با کلیدهای رمزگذاری‌شده سازمان برق ایلام' },
      { time: '۰۰:۱۲', msg: 'استخراج مستقیم فایل معوقات مشترکین منطقه مرداخ و طالقانی' },
      { time: '۰۰:۱۵', msg: 'به‌روزرسانی خودکار وضعیت مشترکین بدهکار در پایگاه داده مرکزی' },
      { time: '۰۰:۱۸', msg: 'عملیات عامل وبگرد با موفقیت پایان یافت. داده‌ها همگام‌سازی شدند.' }
    ];

    let currentStep = 0;
    const interval = setInterval(() => {
      if (currentStep < steps.length) {
        this.webAgentLogs = [...this.webAgentLogs, steps[currentStep]];
        currentStep++;
        this.requestUpdate();
      } else {
        clearInterval(interval);
        this.isWebAgentRunning = false;
        this.fetchSubscribers();
      }
    }, 2000);
  }

  private startOutboundCallSimulation(sub: any) {
    this.activeOutboundCall = {
      name: sub.name,
      phone: sub.phone,
      debt: sub.debt,
      status: 'در حال برقراری تماس...',
      conversation: []
    };
    this.aiState = 'listening';

    const dialogue = [
      { sender: 'system', text: `تماس برقرار شد با شماره ${sub.phone}` },
      { sender: 'ai', text: `سلام جناب ${sub.name} عزیز، وقتتون بخیر. از شرکت توزیع نیروی برق استان ایلام تماس می‌گیرم.` },
      { sender: 'user', text: `سلام، بله بفرمایید. قبض برق موردی داره؟` },
      { sender: 'ai', text: `راستش بررسی سیستم نشان میده قبض انشعاب شما به مبلغ ${sub.debt.toLocaleString()} ریال معوقه داره و متاسفانه مهلت پرداختش هم گذشته. خواستم خواهش کنم امروز نسبت به تسویه‌ش اقدام فرمایید.` },
      { sender: 'user', text: `من واقعاً الان دستم خالیه، حقوقم رو هفته آینده می‌ریزند، نمیشه صبر کنید؟` },
      { sender: 'ai', text: `شرایطتون رو کاملاً درک می‌کنم. برای رفاه حال شما من می‌تونم درخواست 'قسط‌بندی ۲ مرحله‌ای' براتون ثبت کنم تا از قطع خودکار انشعاب جلوگیری بشه. موافقید؟` },
      { sender: 'user', text: `بله خیلی ممنون میشم اگر قسطی کنید که بتونم پرداخت کنم.` },
      { sender: 'ai', text: `بسیار عالی، درخواست قسط‌بندی شما با موفقیت ثبت شد و پیامک تایید آن هم برای شما ارسال گردید. مهلت پرداخت اولین قسط تا ۱۰ روز دیگر است.` },
      { sender: 'system', text: 'مکالمه پایان یافت. توافق قسط‌بندی ثبت گردید.' }
    ];

    let step = 0;
    const playDialogueStep = () => {
      if (!this.activeOutboundCall) return;
      if (step < dialogue.length) {
        const line = dialogue[step];
        this.activeOutboundCall = {
          ...this.activeOutboundCall,
          status: line.sender === 'system' ? line.text : 'در حال گفتگو...',
          conversation: [...this.activeOutboundCall.conversation, line]
        };

        if (line.sender === 'ai') {
          this.aiState = 'speaking';
          this.modelSubtitles = line.text;
          this.userSubtitles = '';
        } else if (line.sender === 'user') {
          this.aiState = 'listening';
          this.userSubtitles = line.text;
          this.modelSubtitles = '';
        } else {
          this.aiState = 'idle';
        }

        step++;
        this.requestUpdate();
        setTimeout(playDialogueStep, line.sender === 'system' ? 2500 : 4500);
      } else {
        this.aiState = 'idle';
        this.userSubtitles = '';
        this.modelSubtitles = '';
        
        // update status locally
        const index = this.subscribersList.findIndex(s => s.phone === sub.phone);
        if (index !== -1) {
          this.subscribersList[index].status = 'توافق پرداخت ثبت شد';
          this.subscribersList = [...this.subscribersList];
        }
      }
    };

    setTimeout(playDialogueStep, 1500);
  }

  private submitHumanTakeoverMessage() {
    if (!this.humanTextResponse.trim() || !this.activeOutboundCall) return;
    const userMsg = { sender: 'operator', text: `[تداخل دستی اپراتور]: ${this.humanTextResponse}` };
    const aiResponse = { sender: 'ai', text: `دستور اپراتور اعمال شد. شرایط ویژه پرداخت با تایید دستی سوپروایزر ثبت شد.` };
    
    this.activeOutboundCall = {
      ...this.activeOutboundCall,
      conversation: [...this.activeOutboundCall.conversation, userMsg, aiResponse]
    };
    this.aiState = 'speaking';
    this.modelSubtitles = aiResponse.text;
    this.humanTextResponse = '';
    this.isHumanTakeoverActive = false;
    this.requestUpdate();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();
    this.outputNode.connect(this.outputAudioContext.destination);
  }

  private async initSession() {
    if (this.session) {
      try {
        this.session.close();
      } catch (e) {
        console.log('Error closing existing session:', e);
      }
    }

    try {
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.session = new WebSocket(`${wsProtocol}//${window.location.host}/live?voice=${encodeURIComponent(this.selectedVoice)}`);

      this.session.onopen = () => {
        this.updateStatus('در حال گفتگو...');
      };

      this.session.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          if (msg.isProcessing) {
            this.aiState = 'processing';
          }
          
          if (msg.turnComplete) {
            this.aiState = 'listening';
          }

          if (msg.userText) {
            this.userSubtitles = msg.userText;
            this.modelSubtitles = '';
            this.resetSubtitleTimeout();
          }

          if (msg.modelText) {
            this.modelSubtitles += msg.modelText;
            this.aiState = 'speaking';
            this.resetSubtitleTimeout();
          }

          if (msg.toolCall) {
            if (msg.toolCall.name === 'displayWidget') {
              this.widgetData = {
                title: msg.toolCall.title,
                widgetType: msg.toolCall.widgetType,
                contentUrl: msg.toolCall.contentUrl,
                codeOrData: msg.toolCall.codeOrData
              };
            } else {
              this.requestedUI = {
                label: msg.toolCall.label,
                toolCallId: msg.toolCall.id
              };
            }
          }

          if (msg.activeCall) {
            this.activeCall = msg.activeCall;
            setTimeout(() => {
              if (this.activeCall === msg.activeCall) this.activeCall = null;
            }, 8000);
          }

          if (msg.subscriberData) {
            this.subscriberData = msg.subscriberData;
            setTimeout(() => {
              if (this.subscriberData === msg.subscriberData) this.subscriberData = null;
            }, 12000);
          }

          if (msg.activeModel) {
            this.activeModel = msg.activeModel;
          }

          if (msg.statusUpdate) {
            this.aiTaskStatus = msg.statusUpdate;
            const now = new Date();
            const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');
            this.aiLogs = [...this.aiLogs, {time: timeStr, message: msg.statusUpdate}];
            setTimeout(() => {
              if (this.aiTaskStatus === msg.statusUpdate) this.aiTaskStatus = 'آماده به کار';
            }, 10000);
          }

          if (msg.audio) {
            this.aiState = 'speaking';
            this.nextStartTime = Math.max(
              this.nextStartTime,
              this.outputAudioContext.currentTime,
            );

            const audioBuffer = await decodeAudioData(
              decode(msg.audio),
              this.outputAudioContext,
              24000,
              1,
            );
            const source = this.outputAudioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.outputNode);
            source.addEventListener('ended', () => {
              this.sources.delete(source);
            });

            source.start(this.nextStartTime);
            this.nextStartTime = this.nextStartTime + audioBuffer.duration;
            this.sources.add(source);
          }

          if (msg.interrupted) {
            for (const source of this.sources.values()) {
              source.stop();
              this.sources.delete(source);
            }
            this.nextStartTime = 0;
            if (this.modelSubtitles) {
              this.modelSubtitles += ' [قطع صحبت...]';
            }
          }

          if (msg.error) {
            this.updateError(msg.error);
          }
        } catch (e) {
          console.error('Error parsing message', e);
        }
      };

      this.session.onerror = (e) => {
        console.error('WebSocket error:', e);
        this.updateError('ارتباط قطع شد. لطفاً اتصال اینترنت خود را بررسی کنید.');
      };

      this.session.onclose = (e) => {
        this.updateStatus('Close:' + e.reason);
      };

    } catch (e) {
      console.error(e);
    }
  }

  private statusTimeout: number | null = null;
  private updateStatus(msg: any) {
    let finalMsg = '';
    if (msg) {
      if (typeof msg === 'string') {
        finalMsg = msg;
      } else if (msg.message) {
        finalMsg = msg.message;
      } else if (msg.reason) {
        finalMsg = msg.reason;
      } else {
        try {
          finalMsg = JSON.stringify(msg);
        } catch (e) {
          finalMsg = String(msg);
        }
      }
    }

    this.status = finalMsg;
    if (this.statusTimeout) {
      window.clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }
    if (finalMsg) {
      this.statusTimeout = window.setTimeout(() => {
        this.status = '';
      }, 5000);
    }
  }

  private errorTimeout: number | null = null;
  private subtitleTimeout: number | null = null;
  private resetSubtitleTimeout() {
    if (this.subtitleTimeout) {
      window.clearTimeout(this.subtitleTimeout);
    }
    this.subtitleTimeout = window.setTimeout(() => {
      this.userSubtitles = '';
      this.modelSubtitles = '';
    }, 7000);
  }

  private updateError(msg: any) {
    let finalMsg = '';
    if (msg) {
      if (typeof msg === 'string') {
        finalMsg = msg;
      } else if (msg.message) {
        finalMsg = msg.message;
      } else if (msg.error) {
        finalMsg = typeof msg.error === 'string' ? msg.error : (msg.error.message || 'خطای ناشناخته');
      } else if (msg._closeAfterHandlingError !== undefined || msg._errored !== undefined || msg.authorizationError !== undefined) {
        finalMsg = 'مشکلی در تأیید هویت یا اتصال به سرویس ایجاد شد. لطفاً دوباره تلاش کنید.';
      } else {
        finalMsg = 'خطای سیستمی رخ داد.';
      }
    }

    this.error = finalMsg;
    if (this.errorTimeout) {
      window.clearTimeout(this.errorTimeout);
      this.errorTimeout = null;
    }
    if (finalMsg) {
      this.errorTimeout = window.setTimeout(() => {
        this.error = '';
      }, 7000);
    }
  }

  private async startRecording(streamPromise?: Promise<MediaStream>) {
    if (this.isRecording) {
      return;
    }

    this.inputAudioContext.resume();
    this.outputAudioContext.resume();

    this.updateStatus('در حال اتصال میکروفون...');

    try {
      this.mediaStream = await (streamPromise || navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      }));

      this.updateStatus('میکروفون متصل شد. در حال برقراری ارتباط با هوش مصنوعی...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 256;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        if (this.session && this.session.readyState === WebSocket.OPEN) {
          const blobData = createBlob(pcmData);
          this.session.send(JSON.stringify({ audio: blobData.data }));
        }
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.aiState = 'listening';
      this.updateStatus('');
    } catch (err) {
      console.error('Error starting recording:', err?.message || err);
      let errorText = err.message;
      if (err.name === 'NotAllowedError' || errorText?.includes('Permission denied')) {
        errorText = 'دسترسی میکروفون مسدود شده است. لطفاً برنامه را در یک تب جدید باز کنید (آیکون Open in New Tab در بالا سمت راست) و دسترسی میکروفون را مجاز کنید.';
      } else if (err.name === 'NotFoundError') {
        errorText = 'میکروفونی یافت نشد. لطفاً از اتصال میکروفون خود اطمینان حاصل کنید.';
      }
      this.updateStatus(`خطا در اتصال: ${errorText}`);
      this.isLightOn = false;
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.updateStatus('Stopping recording...');

    this.isRecording = false;
    this.aiState = 'idle';

    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.updateStatus('Recording stopped. Click Start to begin again.');
  }

  private reset() {
    this.session?.close();
    this.initSession();
    this.updateStatus('Session cleared.');
  }

  private async toggleVoice(e: Event) {
    e.stopPropagation();
    this.selectedVoice = this.selectedVoice === 'Aoede' ? 'Charon' : 'Aoede';
    localStorage.setItem('gdm_live_voice', this.selectedVoice);
    
    if (this.isRecording) {
      this.updateStatus('در حال بروزرسانی صدای گوینده...');
      if (this.session) {
        this.session.close();
        this.session = null;
      }
      await this.initSession();
    }
  }

  private submitUserInput(e: Event) {
    e.stopPropagation();
    if (this.requestedUI && this.session && this.session.readyState === WebSocket.OPEN) {
      this.session.send(JSON.stringify({
        toolResponse: {
          id: this.requestedUI.toolCallId,
          name: 'requestUserInputField',
          response: { userInput: this.inputValue }
        }
      }));
      this.requestedUI = null;
      this.inputValue = '';
    }
  }

  updated(changedProperties: Map<string, any>) {
    if (changedProperties.has('aiLogs')) {
      const panel = this.renderRoot.querySelector('#logPanel');
      if (panel) {
        panel.scrollTop = panel.scrollHeight;
      }
    }
  }

  private renderWidgetTextData() {
    let content = this.widgetData?.codeOrData || 'در حال آماده‌سازی اطلاعات...';
    try {
      const data = JSON.parse(content);
      if (Array.isArray(data) && data.length > 0) {
        return html`
          <div class="table-container" dir="auto">
            <table class="data-table">
              <thead>
                <tr>
                  ${Object.keys(data[0]).map(k => html`<th>${k}</th>`)}
                </tr>
              </thead>
              <tbody>
                ${data.map((row: any) => html`
                  <tr>
                    ${Object.values(row).map((v: any) => html`<td>${v}</td>`)}
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
        `;
      } else if (typeof data === 'object' && data !== null) {
        return html`
          <div class="table-container" dir="auto">
            <table class="data-table">
              <tbody>
                ${Object.keys(data).map(k => html`
                  <tr>
                    <th>${k}</th>
                    <td>${data[k]}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
        `;
      }
    } catch(e) {
      // not json, render as plain
    }
    return html`<div class="widget-code" dir="auto">${content}</div>`;
  }

  private renderMonitorTab() {
    return html`
      <!-- Diagnostics / Stats -->
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-card-title">وضعیت SIP Trunk</span>
          <span class="stat-card-value" style="color: #10b981;">فعال (ONLINE)</span>
        </div>
        <div class="stat-card">
          <span class="stat-card-title">کانال‌های VoIP فعال</span>
          <span class="stat-card-value">${this.activeOutboundCall ? '1 / 1000' : '0 / 1000'}</span>
        </div>
        <div class="stat-card">
          <span class="stat-card-title">نرخ موفقیت هوش مصنوعی</span>
          <span class="stat-card-value" style="color: #00e5ff;">۹۴.۲٪</span>
        </div>
        <div class="stat-card">
          <span class="stat-card-title">مدل صوتی فعال</span>
          <span class="stat-card-value" style="font-size: 0.8rem;">${this.activeModel}</span>
        </div>
      </div>

      <!-- Ilam Map Visualizer -->
      <div>
        <h4 style="margin: 10px 0; font-size: 0.85rem; color: #00e5ff;">نقشه توزیع و پیگیری هوشمند استان ایلام</h4>
        <div class="map-container">
          <div class="map-bg-grid"></div>
          
          <div class="map-node" style="top: 20%; right: 15%;">
            <div class="map-node-dot ${this.activeOutboundCall?.name === 'علی رضایی' ? 'active' : ''}" style="color: #ff4a4a;"></div>
            <span class="map-node-label">بلوار امام</span>
          </div>
          
          <div class="map-node" style="top: 40%; left: 20%;">
            <div class="map-node-dot ${this.activeOutboundCall?.name === 'مریم احمدی' ? 'active' : ''}"></div>
            <span class="map-node-label">شهید کشوری</span>
          </div>
          
          <div class="map-node" style="bottom: 15%; right: 35%;">
            <div class="map-node-dot ${this.activeOutboundCall?.name === 'حسن کریمی' ? 'active' : ''}"></div>
            <span class="map-node-label">مرداخ</span>
          </div>
          
          <div class="map-node" style="top: 70%; left: 45%;">
            <div class="map-node-dot ${this.activeOutboundCall?.name === 'فاطمه حسینی' ? 'active' : ''}"></div>
            <span class="map-node-label">طالقانی</span>
          </div>
        </div>
      </div>

      <!-- Outbound Call & Human Takeover Widget -->
      <div class="outbound-simulator">
        <div class="outbound-header">
          <span>شبیه‌ساز تماس خروجی و مداخله انسانی</span>
          <span class="outbound-status">${this.activeOutboundCall ? this.activeOutboundCall.status : 'بدون تماس فعال'}</span>
        </div>

        ${this.activeOutboundCall ? html`
          <div style="font-size: 0.8rem; color: rgba(255,255,255,0.7); display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span>مخاطب: <strong>${this.activeOutboundCall.name}</strong></span>
            <span>بدهی: <strong>${this.activeOutboundCall.debt.toLocaleString()} ریال</strong></span>
          </div>

          <div class="outbound-dialogue-box">
            ${this.activeOutboundCall.conversation.map(line => html`
              <div class="dialogue-bubble ${line.sender}">
                ${line.text}
              </div>
            `)}
          </div>

          <!-- Quick Actions / Takeover Controls -->
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
            <label style="font-size: 0.75rem; color: rgba(255,255,255,0.6); display: flex; align-items: center; gap: 6px; cursor: pointer;">
              <input type="checkbox" .checked=${this.isHumanTakeoverActive} @change=${(e: any) => this.isHumanTakeoverActive = e.target.checked} style="accent-color: #00e5ff;" />
              فعالسازی مداخله دستی اپراتور (Human Takeover)
            </label>
            ${this.isHumanTakeoverActive ? html`<span style="font-size: 0.7rem; color: #ff4a4a; animation: pulse 1s infinite;">● کنترل مکالمه در اختیار شماست</span>` : ''}
          </div>

          ${this.isHumanTakeoverActive ? html`
            <div class="takeover-form">
              <input 
                type="text" 
                class="takeover-input" 
                placeholder="متن جایگزین یا دستور برای ارسال به مشتری..." 
                .value=${this.humanTextResponse} 
                @input=${(e: any) => this.humanTextResponse = e.target.value}
                @keydown=${(e: any) => e.key === 'Enter' && this.submitHumanTakeoverMessage()}
              />
              <button class="takeover-btn" @click=${this.submitHumanTakeoverMessage}>ارسال</button>
            </div>
          ` : ''}
        ` : html`
          <div style="padding: 24px 0; text-align: center; color: rgba(255,255,255,0.4); font-size: 0.8rem;">
            برای آزمایش گفتگوی صوتی و مکانیزم مداخله دستی، از تب پایگاه مشترکین یک تماس برقرار کنید.
          </div>
        `}
      </div>
    `;
  }

  private renderSubscribersTab() {
    return html`
      <div style="display: flex; gap: 10px;">
        <input 
          type="text" 
          class="search-input" 
          placeholder="جستجوی مشترکین بر اساس نام یا شماره..." 
          .value=${this.searchQuery}
          @input=${(e: any) => { this.searchQuery = e.target.value; this.fetchSubscribers(); }}
        />
        <button class="sub-action-btn" style="white-space: nowrap;" @click=${() => this.showNewSubModal = !this.showNewSubModal}>
          + مشترک جدید
        </button>
      </div>

      ${this.showNewSubModal ? html`
        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(0, 170, 255, 0.2); padding: 14px; border-radius: 12px; display: flex; flex-direction: column; gap: 10px;">
          <h5 style="margin: 0; font-size: 0.85rem; color: #00e5ff;">ثبت پرونده معوقه جدید</h5>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <input type="text" id="newSubName" class="search-input" placeholder="نام مشترک" style="padding: 6px 10px; font-size: 0.8rem;" />
            <input type="text" id="newSubPhone" class="search-input" placeholder="شماره تماس" style="padding: 6px 10px; font-size: 0.8rem;" />
            <input type="number" id="newSubDebt" class="search-input" placeholder="مبلغ بدهی (ریال)" style="padding: 6px 10px; font-size: 0.8rem;" />
            <input type="text" id="newSubRegion" class="search-input" placeholder="منطقه (مثلا مرداخ)" style="padding: 6px 10px; font-size: 0.8rem;" />
          </div>
          <button class="sub-action-btn" style="width: 100%;" @click=${() => {
            const nameEl = this.shadowRoot?.getElementById('newSubName') as HTMLInputElement;
            const phoneEl = this.shadowRoot?.getElementById('newSubPhone') as HTMLInputElement;
            const debtEl = this.shadowRoot?.getElementById('newSubDebt') as HTMLInputElement;
            const regionEl = this.shadowRoot?.getElementById('newSubRegion') as HTMLInputElement;
            if (nameEl && phoneEl && debtEl && regionEl) {
              this.createNewSubscriber(nameEl.value, phoneEl.value, parseInt(debtEl.value) || 0, regionEl.value);
            }
          }}>ذخیره مشترک در دیتابیس</button>
        </div>
      ` : ''}

      <div class="subscriber-card-list">
        ${this.subscribersList.map(sub => html`
          <div class="subscriber-row-card">
            <div class="sub-meta-info">
              <span class="sub-name">${sub.name}</span>
              <span class="sub-details">تلفن: ${sub.phone} | منطقه: ${sub.region}</span>
              <span class="sub-details" style="color: #ff4a4a;">بدهی: ${sub.debt.toLocaleString()} ریال</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 6px; align-items: flex-end;">
              <span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; background: ${sub.status === 'معوقه' ? 'rgba(255,74,74,0.1)' : 'rgba(16,185,129,0.1)'}; color: ${sub.status === 'معوقه' ? '#ff4a4a' : '#10b981'};">
                ${sub.status}
              </span>
              <button class="sub-action-btn" @click=${() => this.startOutboundCallSimulation(sub)}>
                برقراری تماس
              </button>
            </div>
          </div>
        `)}
      </div>
    `;
  }

  private renderStrategyTab() {
    return html`
      <div style="display: flex; flex-direction: column; gap: 14px;">
        <div class="slider-group">
          <label class="slider-label">
            <span>میزان همدلی هوش مصنوعی (Empathy Level)</span>
            <span>${this.empathyLevel}٪</span>
          </label>
          <input type="range" min="0" max="100" class="custom-range-slider" .value=${this.empathyLevel} @input=${(e: any) => this.empathyLevel = e.target.value} />
        </div>

        <div class="slider-group">
          <label class="slider-label">
            <span>میزان پافشاری و پیگیری (Persistence)</span>
            <span>${this.persistenceLevel}٪</span>
          </label>
          <input type="range" min="0" max="100" class="custom-range-slider" .value=${this.persistenceLevel} @input=${(e: any) => this.persistenceLevel = e.target.value} />
        </div>

        <div class="slider-group">
          <label class="slider-label">
            <span>تأخیر پاسخ شبیه‌سازی‌شده (Latency)</span>
            <span>${this.responseDelay} میلی‌ثانیه</span>
          </label>
          <input type="range" min="100" max="1500" step="50" class="custom-range-slider" .value=${this.responseDelay} @input=${(e: any) => this.responseDelay = e.target.value} />
        </div>

        <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.08); margin: 10px 0;" />

        <div>
          <label class="slider-label" style="margin-bottom: 6px;">لحن استراتژیک پیش‌فرض بر اساس میزان بدهی</label>
          <select class="search-input" style="padding: 8px 12px; font-size: 0.8rem;" .value=${this.customToneStrategy} @change=${(e: any) => this.customToneStrategy = e.target.value}>
            <option value="friendly">دوستانه و ترغیب‌کننده (کمتر از ۵ میلیون ریال)</option>
            <option value="firm">جدی و قاطع با ارجاع به قوانین (بیشتر از ۵ میلیون ریال)</option>
            <option value="compromise">انعطاف‌پذیر با ارائه تخفیف و قسط‌بندی (بدهکاران باسابقه)</option>
          </select>
        </div>

        <div style="font-size: 0.72rem; color: rgba(255,255,255,0.5); line-height: 1.6; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.03);">
          💡 <strong>نکته استراتژیک:</strong> هوش مصنوعی صوتی گردآفرین به صورت هوشمند بر اساس میزان بدهی، منطقه و رفتار مخاطب لحن صدای خود را تغییر داده و مکانیزم تعاملی را تنظیم می‌نماید.
        </div>
      </div>
    `;
  }

  private renderWebAgentTab() {
    return html`
      <div style="display: flex; flex-direction: column; gap: 14px;">
        <div style="font-size: 0.8rem; color: rgba(255,255,255,0.8); line-height: 1.5;">
          عامل وبگرد خودکار مرکزی به صورت هدلس به سامانه‌های وب‌سایت توانیر لاگین کرده و اطلاعات کنتورها و معوقات قبوض مشترکین را دریافت و به‌روزرسانی می‌کند.
        </div>

        <button class="sub-action-btn" style="width: 100%; padding: 10px 0; font-size: 0.8rem; font-weight: bold; display: flex; align-items: center; justify-content: center; gap: 8px;" @click=${this.runWebAgentSimulation}>
          ${this.isWebAgentRunning ? html`
            <div class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></div>
            در حال همگام‌سازی وبگرد...
          ` : html`
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chrome"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="21.17" y1="8" x2="12" y2="8"/><line x1="3.95" y1="6.06" x2="8.54" y2="14"/><line x1="10.88" y1="21.94" x2="15.46" y2="14"/></svg>
            آغاز پویش وبگرد و تطبیق اطلاعات (CIS Portal Sync)
          `}
        </button>

        <div class="agent-terminal">
          ${this.webAgentLogs.length === 0 ? html`
            <span style="color: rgba(255,255,255,0.35);">آماده برای شروع عملیات همگام‌سازی عامل وبگرد...</span>
          ` : this.webAgentLogs.map(log => html`
            <div class="agent-log-line">
              <span class="agent-log-time">[${log.time}]</span>
              <span class="agent-log-text">${log.msg}</span>
            </div>
          `)}
        </div>
      </div>
    `;
  }

  private renderLogsTab() {
    return html`
      <div style="display: flex; flex-direction: column; gap: 14px;">
        <div style="font-size: 0.8rem;">
          <span style="color: rgba(255,255,255,0.5);">شناسه ارتباطی دیتابیس:</span> 
          <span style="color: #00e5ff; font-family: monospace;">PostgreSQL 16.2 / Active Connection</span>
        </div>

        <div class="diagnostic-logs-list">
          ${this.systemLogsList.map(log => html`
            <div class="diagnostic-log-row">
              <span style="color: rgba(255,255,255,0.3); font-family: monospace;">[${log.time}]</span>
              <span class="diag-level">${log.level}</span>
              <span class="diag-msg">${log.message}</span>
            </div>
          `)}
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div style="width: 100%; height: 100%;">
        
        <!-- Advanced Dashboard Console Toggle Button -->
        <button class="dashboard-toggle-btn" @click=${(e: Event) => { e.stopPropagation(); this.isConsoleOpen = !this.isConsoleOpen; }}>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-terminal" style="margin-left: 6px;"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          کنسول کنترل توزیع برق ایلام
        </button>

        <!-- Advanced Dashboard Console Glassmorphic Sidebar -->
        <div class="console-sidebar ${this.isConsoleOpen ? 'open' : ''}" @click=${(e: Event) => e.stopPropagation()}>
          <div class="console-header">
            <div class="console-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-cpu" style="margin-left: 8px;"><rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M20 9h3"/><path d="M20 15h3"/><path d="M1 9h3"/><path d="M1 15h3"/></svg>
              کنسول کنترل هوشمند توزیع برق ایلام
            </div>
            <button class="console-close-btn" @click=${() => this.isConsoleOpen = false}>✕</button>
          </div>

          <!-- Tabs navigation -->
          <div class="console-tabs">
            <button class="console-tab ${this.activeTab === 'monitor' ? 'active' : ''}" @click=${() => this.activeTab = 'monitor'}>مانیتورینگ تماس</button>
            <button class="console-tab ${this.activeTab === 'subscribers' ? 'active' : ''}" @click=${() => this.activeTab = 'subscribers'}>پایگاه مشترکین</button>
            <button class="console-tab ${this.activeTab === 'strategy' ? 'active' : ''}" @click=${() => this.activeTab = 'strategy'}>استراتژی هوش‌مصنوعی</button>
            <button class="console-tab ${this.activeTab === 'webagent' ? 'active' : ''}" @click=${() => this.activeTab = 'webagent'}>عامل وبگرد (CIS)</button>
            <button class="console-tab ${this.activeTab === 'logs' ? 'active' : ''}" @click=${() => this.activeTab = 'logs'}>لاگ‌های سیستم</button>
          </div>

          <!-- Content body based on active tab -->
          <div class="console-content">
            ${this.activeTab === 'monitor' ? this.renderMonitorTab() : ''}
            ${this.activeTab === 'subscribers' ? this.renderSubscribersTab() : ''}
            ${this.activeTab === 'strategy' ? this.renderStrategyTab() : ''}
            ${this.activeTab === 'webagent' ? this.renderWebAgentTab() : ''}
            ${this.activeTab === 'logs' ? this.renderLogsTab() : ''}
          </div>
        </div>

        <!-- Flat 2D Avatar -->
        <gdm-human-avatar 
          .inputNode=${this.inputNode} 
          .outputNode=${this.outputNode} 
          .aiState=${this.aiState}
          @click-avatar=${this.handleOrbClick}>
        </gdm-human-avatar>

        <!-- Tap to Start floating indicator when inactive -->
        ${!this.isRecording ? html`
          <div class="tap-to-start-hint animate-pulse">
            <span>برای شروع مکالمه صوتی، روی کالبد هوش مصنوعی ضربه بزنید</span>
          </div>
        ` : ''}

        <!-- Top Header Controls -->
        <div class="top-header-container">
          <session-status-indicator 
            .aiState=${this.aiState} 
            .isRecording=${this.isRecording} 
            .error=${this.error}>
          </session-status-indicator>
        </div>

        <!-- System Status Indicator (Multi-model support) -->
        <div class="status-indicator">
          <div class="model-badge">
            <span class="pulse-dot"></span>
            ${this.activeModel}
          </div>
          <div class="task-status">
            ${this.aiTaskStatus !== 'آماده به کار' ? html`<div class="spinner"></div>` : ''}
            ${this.aiTaskStatus}
          </div>
        </div>

        ${(this.error || this.status) ? html`<div id="status"> ${this.error || this.status} </div>` : ''}

        <!-- Logs Panel -->
        ${this.aiLogs.length > 0 ? html`
          <div class="log-panel" id="logPanel">
            ${this.aiLogs.map(log => html`
              <div class="log-entry">
                <span class="log-time">[${log.time}]</span>
                <span class="log-text">${log.message}</span>
              </div>
            `)}
          </div>
        ` : ''}

        <!-- Widget Overlay -->
        ${this.widgetData ? html`
          <div class="widget-overlay" @click=${(e: Event) => e.stopPropagation()}>
            <div class="widget-header">
              <span class="widget-title">${this.widgetData.title}</span>
              <button class="widget-close" @click=${() => this.widgetData = null}>✕</button>
            </div>
            <div class="widget-content">
              ${this.widgetData.widgetType === 'image' && this.widgetData.contentUrl ? html`
                <img src="${this.widgetData.contentUrl}" class="widget-image" />
              ` : ''}
              ${this.widgetData.widgetType === 'audio' && this.widgetData.contentUrl ? html`
                <div class="audio-player-wrapper">
                  <div class="audio-visualizer-placeholder">
                    <span>🎵 در حال پخش موسیقی</span>
                  </div>
                  <audio controls autoplay src="${this.widgetData.contentUrl}" style="width: 100%; border-radius: 8px; margin-top: 12px;"></audio>
                </div>
              ` : ''}
              ${this.widgetData.widgetType === 'chart' || this.widgetData.widgetType === 'code' || this.widgetData.widgetType === 'text' ? 
                this.renderWidgetTextData()
              : ''}
            </div>
          </div>
        ` : ''}

        <!-- Live Subtitles/Transcription Overlay -->
        ${this.isRecording ? html`
          <div class="subtitles-container" @click=${(e: Event) => e.stopPropagation()}>
            ${this.userSubtitles ? html`
              <div class="user-subtitle">
                <span class="sub-label">شما</span>
                <span class="sub-text">${this.userSubtitles}</span>
              </div>
            ` : ''}
            ${this.modelSubtitles ? html`
              <div class="model-subtitle">
                <span class="sub-label">گردآفرین</span>
                <span class="sub-text">${this.modelSubtitles}</span>
              </div>
            ` : (!this.userSubtitles ? html`
              <div class="model-subtitle placeholder-sub">
                <span class="sub-text animate-pulse">مکالمه صوتی فعال است. لطفاً شروع به صحبت کنید...</span>
              </div>
            ` : '')}
          </div>
        ` : ''}
        
        ${this.requestedUI ? html`
          <div class="input-overlay" @click=${(e: Event) => e.stopPropagation()}>
            <div class="input-modal">
              <label>${this.requestedUI.label}</label>
              <input 
                type="text" 
                .value=${this.inputValue} 
                @input=${(e: Event) => this.inputValue = (e.target as HTMLInputElement).value}
                @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.submitUserInput(e)}
              />
              <button @click=${this.submitUserInput}>ارسال</button>
            </div>
          </div>
        ` : ''}
        
        <!-- Canvas-based Voice Visualizer -->
        <audio-equalizer 
          .inputNode=${this.inputNode} 
          .outputNode=${this.outputNode}>
        </audio-equalizer>
      </div>
    `;
  }
}
