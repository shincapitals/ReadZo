import { withRetry } from './pool';

export type TranslationStyle = 'chuẩn' | 'genz';

// VieNeu-TTS v3-Turbo reading styles + preset voices (see tts-server/main.py).
export type ReadingStyle = 'tu_nhien' | 'tin_tuc' | 'doc_truyen';
export type VoiceName = string;

export interface VoicePreset {
  name: VoiceName;
  region: string; // Bắc / Trung / Nam
  gender: 'Nam' | 'Nữ';
  style: ReadingStyle;
}

// Mirrors the sidecar's voices_v3_turbo.json (kept static so the UI needs no round-trip).
export const VIENEU_VOICES: VoicePreset[] = [
  { name: 'Phạm Tuyên', region: 'Bắc', gender: 'Nam', style: 'tu_nhien' },
  { name: 'Trúc Ly', region: 'Bắc', gender: 'Nữ', style: 'tu_nhien' },
  { name: 'Đoan Trang', region: 'Bắc', gender: 'Nữ', style: 'tu_nhien' },
  { name: 'Xuân Vĩnh', region: 'Nam', gender: 'Nam', style: 'tu_nhien' },
  { name: 'Quang Sơn', region: 'Trung', gender: 'Nam', style: 'tu_nhien' },
  { name: 'Ngọc Trân', region: 'Trung', gender: 'Nữ', style: 'tu_nhien' },
  { name: 'Minh Đức', region: 'Bắc', gender: 'Nam', style: 'tin_tuc' },
  { name: 'Mai Anh', region: 'Bắc', gender: 'Nữ', style: 'tin_tuc' },
  { name: 'Minh Triết', region: 'Nam', gender: 'Nam', style: 'tin_tuc' },
  { name: 'Thùy Dung', region: 'Nam', gender: 'Nữ', style: 'tin_tuc' },
  { name: 'Thanh Bình', region: 'Bắc', gender: 'Nam', style: 'doc_truyen' },
  { name: 'Ngọc Linh', region: 'Bắc', gender: 'Nữ', style: 'doc_truyen' },
  { name: 'Thái Sơn', region: 'Nam', gender: 'Nam', style: 'doc_truyen' },
  { name: 'Thục Đoan', region: 'Nam', gender: 'Nữ', style: 'doc_truyen' },
];

export const READING_STYLE_LABELS: Record<ReadingStyle, string> = {
  tu_nhien: 'Tự nhiên',
  tin_tuc: 'Tin tức',
  doc_truyen: 'Kể chuyện',
};

interface ApiError extends Error {
  status?: number;
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* ignore non-JSON error bodies */
    }
    const err: ApiError = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export async function translateText(text: string, style: TranslationStyle): Promise<string> {
  const { translated } = await withRetry(() =>
    postJSON<{ translated: string }>('/api/translate', { text, style }),
  );
  return translated || '';
}

// Ask the VieNeu sidecar (via Express) for a full 48kHz WAV of `text` and return it as a Blob.
// CPU synthesis is slow (~2.5x realtime), so retries are minimal — the caller caches the result.
export async function generateTTSBlob(
  text: string,
  voice: VoiceName,
  style: ReadingStyle,
): Promise<Blob> {
  const { audio } = await withRetry(
    () => postJSON<{ audio: string }>('/api/tts', { text, voiceName: voice, style }),
    { retries: 1, baseMs: 2000 },
  );
  if (!audio) throw new Error('Không thể tạo audio từ văn bản.');

  const binaryStr = atob(audio);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return new Blob([bytes], { type: 'audio/wav' });
}
