export function ulawEncode(sample: number): number {
  let sign = 0;
  let value = sample;
  if (value < 0) {
    sign = 0x80;
    value = -value;
  }
  value += 0x84;
  if (value > 0x7fff) value = 0x7fff;
  let exponent = 7;
  let mask = 0x4000;
  while ((value & mask) === 0 && exponent > 0) {
    mask >>= 1;
    exponent--;
  }
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function ulawDecode(byte: number): number {
  const b = ~byte;
  const sign = b & 0x80;
  const exponent = (b >> 4) & 0x07;
  const mantissa = b & 0x0f;
  let value = ((mantissa << 3) + 0x84) << exponent;
  value -= 0x84;
  if (sign) value = -value;
  return value;
}

export function resamplePcm(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || input.length === 0) return input;
  const inputSamples = new Int16Array(input.buffer, input.byteOffset, input.length >> 1);
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(inputSamples.length / ratio));
  const output = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = inputSamples[Math.min(idx, inputSamples.length - 1)];
    const b = inputSamples[Math.min(idx + 1, inputSamples.length - 1)];
    output[i] = Math.round(a + (b - a) * frac);
  }
  return Buffer.from(output.buffer);
}

export function parseWav(wav: Buffer): { pcm: Buffer; sampleRate: number } {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
    return { pcm: Buffer.alloc(0), sampleRate: 22050 };
  }
  let offset = 12;
  let sampleRate = 22050;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      if (offset + 16 <= wav.length) {
        sampleRate = wav.readUInt32LE(offset + 12);
      }
    } else if (id === 'data') {
      const end = Math.min(offset + 8 + size, wav.length);
      return { pcm: wav.subarray(offset + 8, end), sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  return { pcm: Buffer.alloc(0), sampleRate };
}

export function dtmfCode(digit: string): number {
  if (digit >= '0' && digit <= '9') return digit.charCodeAt(0) - 48;
  if (digit === '*') return 10;
  if (digit === '#') return 11;
  return -1;
}

export function dtmfDigit(code: number): string | null {
  if (code >= 0 && code <= 9) return String(code);
  if (code === 10) return '*';
  if (code === 11) return '#';
  return null;
}

export function normalizePersian(input: string): string {
  return (input || '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/ك/g, 'ک')
    .replace(/ي/g, 'ی')
    .replace(/ئ/g, 'ی')
    .replace(/ة/g, 'ه')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/‌/g, '')   // remove ZWNJ (zero-width non-joiner)
    .replace(/[،؛]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
