# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

READZO — a web app that translates English PDFs into Vietnamese (standard or "Gen Z" style) via Gemini and reads the translation aloud via a **local VieNeu-TTS** model. UI/comments are in Vietnamese; match that when editing user-facing strings.

## Architecture

Three processes, split by trust boundary:

- **Frontend** — Vite + React 19 + TypeScript + Tailwind v4, dev port **3000**.
  - `src/App.tsx` — all UI and state (single component file). `src/PDFPagePreview.tsx` is lazy-loaded.
  - `src/lib/pdf.ts` — PDF parsing via `pdfjs-dist`. `parsePDF` is lazy (numPages + outline + `docHash` only); `extractPageText(pdfDoc, pageNo)` pulls text on demand.
  - `src/lib/ai.ts` — **client-side AI layer; calls `/api/*` only.** No credentials, no `@google/genai`. `translateText`, `generateTTSBlob` (returns a WAV Blob), and the static `VIENEU_VOICES` catalog.
  - `src/lib/db.ts` — IndexedDB (DB `readzo`): `documents` / `pages` / `audio` stores, keyed by document content hash. `src/lib/pool.ts` — `runPool` + `withRetry`.
- **Backend** — Express in `server.ts`, dev port **4000**.
  - `POST /api/translate` `{ text, style }` → `{ translated }` (Gemini; holds credentials).
  - `POST /api/tts` `{ text, voiceName, style }` → `{ audio }` (base64 **WAV**, 48kHz mono) — **proxies to the TTS sidecar** at `TTS_URL` (default `http://127.0.0.1:4100`).
  - `GET /api/voices` → sidecar's voice catalog. Serves `dist/` in production.
- **TTS sidecar** — Python/FastAPI in `tts-server/main.py`, port **4100**. Holds the VieNeu-TTS v3-Turbo model (48kHz, CPU via ONNX). `POST /tts { text, voice?, style? }` → base64 WAV; `GET /voices`, `GET /health`. Its own venv in `tts-server/.venv` (gitignored); model cached in `tts-server/hf-cache` (gitignored).

In dev, Vite proxies `/api` → `http://127.0.0.1:4000`, which proxies TTS to `:4100`. The Gemini key/credentials must **never** reach the client bundle.

## Commands

- `npm run dev` — sidecar + server + client together (concurrently: `dev:tts`, `dev:server`, `dev:client`).
- `npm run lint` — type-check (`tsc --noEmit`). Run this before declaring work done; there is no JS test suite.
- `npm run build` — frontend → `dist/` (code-split: `pdfjs`, `markdown`, `motion`, and `html2pdf` load on demand).
- TTS setup (once): `cd tts-server && uv venv .venv --python 3.12 && uv pip install --python .venv/Scripts/python.exe -r requirements.txt`. First model run downloads ~1–2GB from HuggingFace into `hf-cache`.

## Auth & models

- **Translate** — `getAI()` in `server.ts` picks the mode:
  - **Vertex AI** when `GOOGLE_GENAI_USE_VERTEXAI=true` or `GOOGLE_CLOUD_PROJECT` is set → `new GoogleGenAI({ vertexai:true, project, location })` with ADC. Bills to Google Cloud.
  - **AI Studio** otherwise → `new GoogleGenAI({ apiKey: GEMINI_API_KEY })`.
  - Model `gemini-3.1-pro-preview` is **preview → requires `location=global`** on Vertex (regional endpoints 404).
- **TTS** — VieNeu-TTS v3-Turbo (`pnnbao-ump/VieNeu-TTS-v3-Turbo`), no Google credentials. 14 preset voices × 3 reading styles (`tu_nhien` / `tin_tuc` / `doc_truyen`). CPU synthesis is ~2.5x realtime, so the client caches every page's WAV in IndexedDB and pre-generates the range in the background after translating.

## Gotchas (do not regress these)

- **Ports 4000 (Express) & 4100 (sidecar), not 3001–3500.** Windows reserves TCP `3001–3500` (and `2721–2920`) via Hyper-V/WSL; binding there fails with `EACCES`. Pick ports outside those ranges.
- **`dev:tts` uses backslash paths.** On Windows, npm runs scripts via `cmd.exe`, which rejects a command whose executable path uses forward slashes — the script must be `tts-server\.venv\Scripts\python.exe ...`. This script is Windows-specific.
- **`GOOGLE_APPLICATION_CREDENTIALS` override.** This machine may have a global `GOOGLE_APPLICATION_CREDENTIALS` pointing at an unrelated service account. In Vertex mode `server.ts` deletes the inherited var (unless set in `.env.local`) so it falls back to the developer's gcloud ADC. Keep this behavior.
- **`.env.local` is gitignored** and is the source of truth for local config; `.env.example` documents both auth paths.
- **No secrets in the client.** Anything touching the API key stays in `server.ts`.

## Conventions

- Neo-brutalist Tailwind styling (thick black borders, hard box-shadows like `shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]`, uppercase `font-black`). Match it for new UI.
- The translate `style` discriminator is the literal `'chuẩn' | 'genz'` — keep both client and server using the exact same accented string. (The TTS reading `style` is a separate `'tu_nhien' | 'tin_tuc' | 'doc_truyen'`.)
- Persistence: **IndexedDB** (`src/lib/db.ts`) for translations, per-page status, generated audio, and document list — keyed by document content hash so progress resumes on reopen. Lightweight settings (voice, style, font size, page range, speed) live in `localStorage`.
