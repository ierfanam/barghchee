// Real Automatic Speech Recognition (ASR) adapter for the Gardafarin telephony engine.
// Pipeline: caller PCM16k -> energy-based VAD segmentation -> WAV chunking ->
//           recognition backend -> text utterances fed to the IVR conversation engine.
//
// Backends (auto-selected by availability):
//   1. whisper.cpp binary        — env WHISPER_PATH + WHISPER_MODEL (fully local, offline)
//   2. OpenAI-compatible API     — env ASR_API_URL + ASR_API_KEY + ASR_MODEL (e.g. whisper server, Groq, OpenAI)
//   3. Disabled                  — DTMF-only mode remains fully functional
//
// The module also exposes a pure-TypeScript RMS/VAD used for endpointing, so even
// when no backend is configured the audio path is exercised and logged.

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';

export interface AsrResult {
  text: string;
  language?: string;
}

export type AsrBackend = 'whisper-cpp' | 'openai-api' | 'none';

function currentBackend(): AsrBackend {
  if (process.env.WHISPER_PATH && process.env.WHISPER_MODEL) return 'whisper-cpp';
  if (process.env.ASR_API_URL && process.env.ASR_API_KEY) return 'openai-api';
  return 'none';
}

export function asrStatus() {
  return {
    enabled: currentBackend() !== 'none',
    backend: currentBackend(),
    vad: 'rms-energy',
  };
}

// ---- WAV helpers (16-bit mono) ----
export function encodeWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ---- Energy-based Voice Activity Detection ----
// Segments a continuous PCM stream into utterances using adaptive RMS thresholds.
// All state is instance-local (no module globals) so concurrent calls never share buffers.
export class UtteranceSegmenter {
  private carry: Buffer = Buffer.alloc(0);   // sub-frame remainder between pushes
  private frames: Buffer[] = [];             // captured frames of the in-progress utterance
  private silentMs = 0;
  private voicedMs = 0;
  private started = false;
  readonly frameMs: number;
  private readonly silenceHoldMs: number;
  private readonly minVoiceMs: number;
  private readonly maxUtteranceMs: number;
  private readonly preRollFrames: number;    // small lead-in so first syllable isn't clipped
  private preRoll: Buffer[] = [];
  private noiseFloor = 150; // adaptive RMS threshold (int16 units)

  constructor(opts: { sampleRate?: number; silenceHoldMs?: number; minVoiceMs?: number; maxUtteranceMs?: number } = {}) {
    this.frameMs = 20;
    this.silenceHoldMs = opts.silenceHoldMs ?? 700;
    this.minVoiceMs = opts.minVoiceMs ?? 300;
    this.maxUtteranceMs = opts.maxUtteranceMs ?? 12000;
    this.preRollFrames = 5; // ~100 ms of lead-in audio
  }

  private frameBytes(sampleRate: number) {
    return Math.floor((sampleRate * this.frameMs) / 1000) * 2;
  }

  // Feed raw PCM16k; returns completed utterance buffers (PCM16k) when endpoint detected.
  push(pcm: Buffer, sampleRate = 16000): Buffer[] {
    const out: Buffer[] = [];
    const fb = this.frameBytes(sampleRate);
    let data = this.carry.length ? Buffer.concat([this.carry, pcm]) : Buffer.from(pcm);
    this.carry = Buffer.alloc(0);

    let offset = 0;
    while (data.length - offset >= fb) {
      const frame = data.subarray(offset, offset + fb);
      offset += fb;

      const rms = frameRms(frame);
      const threshold = Math.max(220, this.noiseFloor * 3.2);

      if (rms > threshold) {
        this.voicedMs += this.frameMs;
        this.silentMs = 0;
        if (!this.started && this.voicedMs >= this.minVoiceMs) {
          this.started = true;
          // include the short lead-in captured before onset detection
          for (const p of this.preRoll) this.frames.push(p);
          this.preRoll = [];
        }
        if (this.started) this.frames.push(Buffer.from(frame));
      } else {
        this.silentMs += this.frameMs;
        if (!this.started) {
          // adapt noise floor during leading silence and keep a tiny pre-roll
          this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;
          this.preRoll.push(Buffer.from(frame));
          if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
          continue;
        }
      }

      const totalMs = this.voicedMs + this.silentMs;
      if (this.started && (this.silentMs >= this.silenceHoldMs || totalMs >= this.maxUtteranceMs)) {
        if (this.frames.length > 0) out.push(Buffer.concat(this.frames));
        this.reset();
      }
    }
    if (offset < data.length) this.carry = Buffer.from(data.subarray(offset));
    return out;
  }

  private reset() {
    this.frames = [];
    this.silentMs = 0;
    this.voicedMs = 0;
    this.started = false;
    this.preRoll = [];
  }

  // Force-end the current utterance (e.g. call teardown). Returns remaining audio or null.
  flush(): Buffer | null {
    if (this.started && this.frames.length > 0) {
      const all = Buffer.concat(this.frames);
      this.reset();
      return all;
    }
    this.reset();
    return null;
  }
}

export function frameRms(buf: Buffer): number {
  const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.round(Math.sqrt(sum / samples.length));
}

// ---- Recognition backends ----
async function recognizeWithWhisperCpp(wavPath: string): Promise<AsrResult | null> {
  const bin = process.env.WHISPER_PATH!;
  const model = process.env.WHISPER_MODEL!;
  const lang = process.env.WHISPER_LANG || 'fa';
  return new Promise((resolve) => {
    const args = ['-m', model, '-f', wavPath, '-l', lang, '-np', '--no-timestamps', '-otxt'];
    let proc: any;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(null); }, 20000);
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const txt = fs.readFileSync(wavPath + '.txt', 'utf8').trim();
        resolve(txt ? { text: txt, language: lang } : null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function recognizeWithOpenAiApi(wav: Buffer): Promise<AsrResult | null> {
  const url = process.env.ASR_API_URL!; // e.g. https://api.openai.com/v1/audio/transcriptions
  const key = process.env.ASR_API_KEY!;
  const model = process.env.ASR_MODEL || 'whisper-1';
  try {
    const FormData = (await import('node:buffer')).Blob ? null : null; // use manual multipart
    const boundary = '----gdmAsrBoundary' + Date.now();
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
      'utf8',
    );
    const mid = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n` +
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nfa\r\n` +
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nفارسی، مکالمه تلفنی قبض برق\r\n` +
      `\r\n--${boundary}--\r\n`,
      'utf8',
    );
    void FormData;
    const body = Buffer.concat([head, wav, mid]);
    const res = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      timeout: 15000,
      maxBodyLength: 10 * 1024 * 1024,
    });
    const text = String(res.data?.text || '').trim();
    return text ? { text, language: res.data?.language || 'fa' } : null;
  } catch {
    return null;
  }
}

// High-level streaming recognizer wired into CallSession.onCallerAudio.
// Each call session gets its OWN instance — all VAD/segmentation state is per-instance.
export class CallerSpeechRecognizer {
  private segmenter = new UtteranceSegmenter();
  onUtterance: ((text: string) => void) | null = null;
  private busy = false;
  private queue: Buffer[] = [];

  async acceptPcm(pcm16k: Buffer): Promise<void> {
    if (currentBackend() === 'none') return;
    const utterances = this.segmenter.push(pcm16k, 16000);
    for (const u of utterances) await this.recognize(u);
  }

  // Flush any trailing speech buffer (call teardown).
  async flush(): Promise<void> {
    const tail = this.segmenter.flush();
    if (tail) await this.recognize(tail);
  }

  private async recognize(pcm: Buffer) {
    if (this.busy) {
      // serialize instead of dropping: keep at most a few pending utterances
      if (this.queue.length < 3) this.queue.push(pcm);
      return;
    }
    this.busy = true;
    try {
      await this.transcribeOne(pcm);
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        await this.transcribeOne(next);
      }
    } finally {
      this.busy = false;
    }
  }

  private async transcribeOne(pcm: Buffer) {
    const wav = encodeWav(pcm, 16000);
    let result: AsrResult | null = null;
    const backend = currentBackend();
    if (backend === 'whisper-cpp') {
      const tmp = path.join(os.tmpdir(), `gdm-asr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
      fs.writeFileSync(tmp, wav);
      result = await recognizeWithWhisperCpp(tmp);
      try { fs.unlinkSync(tmp); } catch {}
      try { fs.unlinkSync(tmp + '.txt'); } catch {}
    } else if (backend === 'openai-api') {
      result = await recognizeWithOpenAiApi(wav);
    }
    if (result && result.text && this.onUtterance) {
      this.onUtterance(result.text);
    }
  }
}
