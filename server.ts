import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

// Load config from .env.local first (local dev), then fall back to .env. Neither
// overrides variables already present in the environment (e.g. injected by Cloud Run).
const localEnv = dotenv.config({ path: '.env.local' }).parsed || {};
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type TranslationStyle = 'chuẩn' | 'genz';

// VieNeu-TTS sidecar (Python/FastAPI, holds the model). See tts-server/main.py.
const TTS_URL = process.env.TTS_URL || 'http://127.0.0.1:4100';

// Auth modes:
//   - Vertex AI (bills to Google Cloud, e.g. Trial GenAI Credit): set GOOGLE_GENAI_USE_VERTEXAI=true
//     + GOOGLE_CLOUD_PROJECT, and authenticate with ADC (`gcloud auth application-default login`
//     or a service-account key via GOOGLE_APPLICATION_CREDENTIALS).
//   - Gemini Developer API (AI Studio): set GEMINI_API_KEY.
// Vertex is preferred when configured; the preview models below require location "global".
const useVertex =
  process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' || !!process.env.GOOGLE_CLOUD_PROJECT;

// This machine may have a global GOOGLE_APPLICATION_CREDENTIALS pointing at an unrelated
// service account. In Vertex mode, prefer the developer's gcloud ADC
// (`gcloud auth application-default login`) unless a key file is explicitly set in .env.local.
if (useVertex && !localEnv.GOOGLE_APPLICATION_CREDENTIALS) {
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
}

const getAI = () => {
  if (useVertex) {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) {
      throw new Error('Vertex AI mode requires GOOGLE_CLOUD_PROJECT to be set.');
    }
    // gemini-3.1-pro-preview is only served on the global endpoint (regional endpoints 404).
    const location = process.env.GOOGLE_CLOUD_LOCATION || 'global';
    return new GoogleGenAI({ vertexai: true, project, location });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing credentials: set GOOGLE_CLOUD_PROJECT (Vertex AI) or GEMINI_API_KEY (AI Studio) in .env.local.',
    );
  }
  return new GoogleGenAI({ apiKey });
};

function buildSystemInstruction(style: TranslationStyle): string {
  if (style === 'chuẩn') {
    return "Bạn là một biên dịch viên chuyên nghiệp. Hãy dịch văn bản được cung cấp sang tiếng Việt một cách chuẩn xác, bám sát nghĩa gốc. \n\nSỬ DỤNG ĐỊNH DẠNG MARKDOWN:\n- Dùng ## cho các tiêu đề chương hoặc đề mục lớn.\n- Dùng **bold** cho các khái niệm quan trọng hoặc thuật ngữ chính.\n- Dùng dấu - cho các danh sách liệt kê.\n- Nếu có chú thích dịch thuật, hãy đặt chúng trong một khối trích dẫn (using >). \n\nGiữ nguyên cấu trúc văn bản gốc nhưng làm nổi bật các phần bằng Markdown.";
  }
  return `Bạn là một người trẻ Gen Z Việt Nam chính hiệu. Hãy dịch văn bản được cung cấp sang tiếng Việt theo phong cách của Gen Z: dùng các từ lóng tiếng Việt tự nhiên (như "ảo ma", "bất ổn", "cảm lạnh", "keo lỳ", "hết cứu", "chằm zn", v.v.), giọng văn hài hước, thoải mái và năng động.

PHẢI TUÂN THỦ NGHIÊM NGẶT CÁC QUY TẮC SAU ĐỂ KHÔNG BỊ "Ô DỀ":

1. TIẾNG ANH (SLANG):
- HẠN CHẾ TỐI ĐA tiếng Anh lai tạp. Hãy dùng từ lóng thuần Việt.
- CHỈ ĐƯỢC PHÉP dùng những từ tiếng Anh quá phổ thông như: ok, chill, vibe, flex, drama, crush, team. Đừng lạm dụng.
- Dứt khoát KHÔNG dùng những từ như: hype, slay, high-tech, combat, no hope, bad day, make sense, out of box... (Hãy dùng "hào hứng", "đỉnh", "công nghệ cao", "đối đầu/cãi cọ", "hết cửa", "ngày xu cà na", "hợp lý", "sáng tạo").
- Người Mới học tiếng Anh cũng phải hiểu 100% bản dịch.

2. EMOJI (BẮT BUỘC):
- Dùng TỐI ĐA 2 EMOJI cho TOÀN BỘ MỘT ĐOẠN DỊCH (segment). KHÔNG ĐƯỢC dùng quá 2.
- KHÔNG BAO GIỜ đặt nhiều emoji đứng sát nhau (ví dụ: 😭😭 bỏ ngay).
- Chỉ cho phép đặt emoji ở cuối câu để tạo cảm xúc, tuyệt đối không chèn vào giữa câu hay thay thế chữ.

3. MARKDOWN:
- Dùng ## cho các câu tiêu đề.
- Dùng **bold** để nhấn mạnh các thông tin quan trọng.
- Dùng dấu gạch ngang ( - ) cho danh sách. (Không dùng emoji làm bullet point).
- Dùng blockquote (>) nếu cần tóm tắt hoặc bình luận vui.

Văn phong trẻ trung, gần gũi nhưng vẫn phải truyền đạt CHÍNH XÁC 100% thông điệp và ý nghĩa của văn bản gốc.`;
}

const app = express();
app.use(express.json({ limit: '5mb' }));

app.post('/api/translate', async (req, res) => {
  try {
    const { text, style } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Thiếu nội dung cần dịch.' });
    }
    const safeStyle: TranslationStyle = style === 'chuẩn' ? 'chuẩn' : 'genz';

    const ai = getAI();
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: `[VĂN BẢN CẦN DỊCH]\n${text}`,
      config: {
        systemInstruction: buildSystemInstruction(safeStyle),
        temperature: 0.7,
      },
    });

    res.json({ translated: response.text?.trim() || '' });
  } catch (err: any) {
    console.error('translate error:', err);
    res.status(500).json({ error: err?.message || 'Lỗi khi dịch văn bản.' });
  }
});

// TTS is handled by the VieNeu-TTS Python sidecar; Express just proxies to it.
// The sidecar returns a full 48kHz WAV as base64 (the client uses it directly).
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voiceName, style } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Thiếu nội dung cần đọc.' });
    }

    const upstream = await fetch(`${TTS_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: voiceName, style }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      throw new Error(`TTS sidecar lỗi ${upstream.status}: ${detail.slice(0, 200)}`);
    }

    const data = (await upstream.json()) as { audio?: string; error?: string };
    if (data.error) throw new Error(data.error);
    if (!data.audio) throw new Error('Không thể tạo audio từ văn bản.');

    res.json({ audio: data.audio });
  } catch (err: any) {
    console.error('tts error:', err);
    const offline = /fetch failed|ECONNREFUSED/i.test(err?.message || '');
    res.status(offline ? 503 : 500).json({
      error: offline
        ? 'Máy chủ giọng đọc (VieNeu) chưa sẵn sàng. Vui lòng đợi model tải xong rồi thử lại.'
        : err?.message || 'Lỗi khi tạo audio.',
    });
  }
});

// Expose the sidecar's voice catalog to the client.
app.get('/api/voices', async (_req, res) => {
  try {
    const upstream = await fetch(`${TTS_URL}/voices`);
    res.json(await upstream.json());
  } catch {
    res.status(503).json({ error: 'TTS sidecar chưa sẵn sàng.' });
  }
});

// Serve the built frontend in production (Cloud Run / `npm run serve`).
const distDir = path.resolve(__dirname, 'dist');
app.use(express.static(distDir));
app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

// Default 4000: avoids Windows' reserved/excluded TCP port ranges (e.g. 3001-3500).
// Cloud Run injects PORT and requires binding 0.0.0.0; HOST overrides locally if needed.
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`READZO API server listening on http://${HOST}:${PORT}`);
});
