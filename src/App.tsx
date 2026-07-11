import React, { useState, useRef, useEffect, Suspense } from 'react';
import {
  Upload,
  FileText,
  Play,
  Square,
  Pause,
  History,
  Loader2,
  Volume2,
  Download,
  Check,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { parsePDF, extractPageText, ParsedPDF } from './lib/pdf';
import {
  translateText,
  generateTTSBlob,
  TranslationStyle,
  VoiceName,
  ReadingStyle,
  VIENEU_VOICES,
  READING_STYLE_LABELS,
} from './lib/ai';
import {
  PageStatus,
  PageRecord,
  DocMeta,
  getPage,
  putPage,
  getDocPages,
  getAudio,
  putAudio,
  getDocMeta,
  putDocMeta,
  listDocuments,
  deleteDocument,
  touchDocMeta,
} from './lib/db';
import { runPool } from './lib/pool';
import { motion } from 'motion/react';
import Markdown from 'react-markdown';

const PDFPagePreview = React.lazy(() => import('./PDFPagePreview'));

interface Segment {
  pageNumber: number;
  original: string;
  translated: string | null;
  status: PageStatus;
}

interface ActiveDoc {
  hash: string;
  name: string;
}

const SETTINGS_KEY = 'readzo_settings';
const TRANSLATE_CONCURRENCY = 3;

function loadSettings(): Record<string, any> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

function formatTime(seconds: number) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function pagesToSegments(pages: PageRecord[]): Segment[] {
  return pages
    .map((p) => ({
      pageNumber: p.pageNo,
      original: p.original,
      translated: p.status === 'done' ? p.translated : null,
      status: p.status,
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

export default function App() {
  const settings = React.useMemo(loadSettings, []);

  const [file, setFile] = useState<File | null>(null);
  const [parsedPdf, setParsedPdf] = useState<ParsedPDF | null>(null);
  const [activeDoc, setActiveDoc] = useState<ActiveDoc | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState('');

  const [startPage, setStartPage] = useState<number>(settings.startPage ?? 1);
  const [endPage, setEndPage] = useState<number>(settings.endPage ?? 1);
  const [style, setStyle] = useState<TranslationStyle>(settings.style ?? 'genz');

  const [isTranslating, setIsTranslating] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [translateError, setTranslateError] = useState('');

  const [activeTab, setActiveTab] = useState<'translate' | 'history'>('translate');
  const [documents, setDocuments] = useState<DocMeta[]>([]);

  const [fontSize, setFontSize] = useState<number>(settings.fontSize ?? 16);

  // TTS / playlist state
  const [voice, setVoice] = useState<VoiceName>(settings.voice ?? 'Phạm Tuyên');
  const [readingStyle, setReadingStyle] = useState<ReadingStyle>(settings.readingStyle ?? 'tu_nhien');
  const [speed, setSpeed] = useState<number>(settings.speed ?? 1.2);
  const [activeAudioSegment, setActiveAudioSegment] = useState<number | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isGeneratingTTS, setIsGeneratingTTS] = useState(false);
  const [playlistPos, setPlaylistPos] = useState({ idx: -1, total: 0 });
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Background audio pre-generation (VieNeu is slow, so warm the cache after translating).
  const [pregen, setPregen] = useState<{ done: number; total: number } | null>(null);
  const pregenRef = useRef<{ cancel: boolean }>({ cancel: false });

  const segmentsRef = useRef<Segment[]>([]);
  const playlistRef = useRef<number[]>([]);
  const playlistIdxRef = useRef<number>(-1);
  const objectUrlRef = useRef<string | null>(null);
  const voiceRef = useRef(voice);
  const styleRef = useRef(readingStyle);
  voiceRef.current = voice;
  styleRef.current = readingStyle;

  const docHash = activeDoc?.hash ?? '';
  const docName = activeDoc?.name ?? '';

  // Audio cache key combines the voice + reading style (different combos = different audio).
  const audioKey = (v: VoiceName, st: ReadingStyle) => `${v}__${st}`;

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  // Persist lightweight settings (debounced) to localStorage so they survive tab close.
  useEffect(() => {
    const id = setTimeout(() => {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ startPage, endPage, style, fontSize, voice, readingStyle, speed }),
      );
    }, 400);
    return () => clearTimeout(id);
  }, [startPage, endPage, style, fontSize, voice, readingStyle, speed]);

  // Changing voice/style invalidates the audio cache key, so stop any in-flight pre-generation.
  useEffect(() => {
    pregenRef.current.cancel = true;
    setPregen(null);
  }, [voice, readingStyle]);

  const refreshDocuments = () => listDocuments().then(setDocuments).catch(() => {});
  useEffect(() => {
    refreshDocuments();
  }, []);

  // ── Audio helpers ──────────────────────────────────────────────────────────
  const setAudioUrlSafe = (url: string | null) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = url;
    setAudioUrl(url);
  };

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setIsPlaying(false);
    setAudioUrlSafe(null);
    setActiveAudioSegment(null);
    setAudioProgress(0);
    setAudioDuration(0);
    playlistRef.current = [];
    playlistIdxRef.current = -1;
    setPlaylistPos({ idx: -1, total: 0 });
  };

  // Get the cached audio Blob for a page, generating (and caching) it via the VieNeu sidecar
  // if missing. The sidecar handles long-text chunking and returns a full 48kHz WAV.
  const ensurePageAudio = async (pageNo: number): Promise<Blob> => {
    const v = voiceRef.current;
    const st = styleRef.current;
    const key = audioKey(v, st);
    const cached = await getAudio(docHash, pageNo, key);
    if (cached) return cached.blob;

    const seg = segmentsRef.current.find((s) => s.pageNumber === pageNo);
    const txt = seg?.translated;
    if (!txt || !txt.trim()) throw new Error('Trang không có nội dung để đọc.');

    const blob = await generateTTSBlob(txt, v, st);
    await putAudio({ docHash, pageNo, voice: key, blob, updatedAt: Date.now() });
    return blob;
  };

  // Warm the audio cache for a set of pages in the background (sequential — the sidecar
  // serializes CPU inference anyway). Cancels when voice/style changes or a new translate starts.
  const pregenerateAudio = async (pageNos: number[]) => {
    pregenRef.current.cancel = false;
    const todo = pageNos.filter((p) => {
      const seg = segmentsRef.current.find((s) => s.pageNumber === p);
      return seg?.translated && seg.translated.trim();
    });
    if (!todo.length) return;
    setPregen({ done: 0, total: todo.length });
    for (let i = 0; i < todo.length; i++) {
      if (pregenRef.current.cancel) break;
      try {
        await ensurePageAudio(todo[i]);
      } catch {
        /* skip pages that fail; user can retry by listening */
      }
      setPregen({ done: i + 1, total: todo.length });
    }
    setPregen(null);
  };

  const playFrom = async (idx: number) => {
    const list = playlistRef.current;
    if (idx < 0 || idx >= list.length) {
      stopAudio();
      return;
    }
    playlistIdxRef.current = idx;
    const pageNo = list[idx];
    setPlaylistPos({ idx, total: list.length });
    setActiveAudioSegment(pageNo);
    setIsGeneratingTTS(true);
    try {
      const blob = await ensurePageAudio(pageNo);
      const url = URL.createObjectURL(blob);
      setAudioUrlSafe(url);
      setIsGeneratingTTS(false);
      setIsPlaying(true);
      // Prefetch the next page's audio into the cache in the background.
      const nextPage = list[idx + 1];
      if (nextPage !== undefined) ensurePageAudio(nextPage).catch(() => {});
    } catch (err) {
      setIsGeneratingTTS(false);
      // Skip a failing page rather than killing the whole playlist.
      if (idx + 1 < list.length) playFrom(idx + 1);
      else stopAudio();
    }
  };

  const playablePages = () =>
    segmentsRef.current.filter((s) => s.translated && s.translated.trim()).map((s) => s.pageNumber);

  const listenAll = () => {
    const list = playablePages();
    if (!list.length) return;
    stopAudio();
    playlistRef.current = list;
    playFrom(0);
  };

  const listenPage = (pageNo: number) => {
    const list = playablePages();
    const idx = list.indexOf(pageNo);
    if (idx < 0) return;
    stopAudio();
    playlistRef.current = list;
    playFrom(idx);
  };

  const togglePlayAudio = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  // ── Document loading ────────────────────────────────────────────────────────
  const loadSegmentsFor = async (hash: string, st: TranslationStyle) => {
    const pages = await getDocPages(hash, st);
    setSegments(pagesToSegments(pages));
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.type !== 'application/pdf') {
      setParseError('Vui lòng chọn file PDF.');
      return;
    }
    if (f.size > 20 * 1024 * 1024) {
      setParseError('File quá lớn (> 20MB).');
      return;
    }

    setFile(f);
    setIsParsing(true);
    setParseError('');
    setTranslateError('');
    setParsedPdf(null);
    setSegments([]);
    stopAudio();

    try {
      const pdf = await parsePDF(f);
      setParsedPdf(pdf);
      setActiveDoc({ hash: pdf.docHash, name: f.name });

      const existingMeta = await getDocMeta(pdf.docHash);
      await putDocMeta({
        docHash: pdf.docHash,
        fileName: f.name,
        numPages: pdf.numPages,
        createdAt: existingMeta?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      refreshDocuments();

      setStartPage(1);
      setEndPage(Math.min(pdf.numPages, 3));
      await loadSegmentsFor(pdf.docHash, style);
    } catch (err: any) {
      setParseError(err.message || 'Lỗi đọc file PDF.');
    } finally {
      setIsParsing(false);
    }
  };

  const changeStyle = async (newStyle: TranslationStyle) => {
    setStyle(newStyle);
    if (activeDoc) await loadSegmentsFor(activeDoc.hash, newStyle);
  };

  // ── Translation ─────────────────────────────────────────────────────────────
  const upsertSegment = (pageNo: number, patch: Partial<Segment>) => {
    setSegments((prev) => {
      const next = [...prev];
      const idx = next.findIndex((s) => s.pageNumber === pageNo);
      if (idx >= 0) next[idx] = { ...next[idx], ...patch };
      else
        next.push({ pageNumber: pageNo, original: '', translated: null, status: 'pending', ...patch });
      return next.sort((a, b) => a.pageNumber - b.pageNumber);
    });
  };

  const translatePage = async (pageNo: number) => {
    if (!parsedPdf || !activeDoc) return;
    upsertSegment(pageNo, { status: 'pending', translated: null });
    try {
      const text = (await extractPageText(parsedPdf.pdfDoc, pageNo)).trim();
      if (!text) {
        const rec: PageRecord = {
          docHash,
          pageNo,
          style,
          status: 'done',
          original: '',
          translated: '',
          updatedAt: Date.now(),
        };
        await putPage(rec);
        upsertSegment(pageNo, { original: '', translated: '', status: 'done' });
        return;
      }
      const cached = await getPage(docHash, pageNo, style);
      const translated =
        cached?.status === 'done' && cached.translated
          ? cached.translated
          : await translateText(text, style);
      const rec: PageRecord = {
        docHash,
        pageNo,
        style,
        status: 'done',
        original: text,
        translated,
        updatedAt: Date.now(),
      };
      await putPage(rec); // write-through: progress survives an interruption
      upsertSegment(pageNo, { original: text, translated, status: 'done' });
    } catch (err: any) {
      await putPage({
        docHash,
        pageNo,
        style,
        status: 'error',
        original: '',
        translated: '',
        updatedAt: Date.now(),
      }).catch(() => {});
      upsertSegment(pageNo, { status: 'error', translated: null });
      throw err;
    }
  };

  const handleTranslate = async () => {
    if (!parsedPdf || !activeDoc) return;
    if (
      startPage < 1 ||
      startPage > parsedPdf.numPages ||
      endPage < startPage ||
      endPage > parsedPdf.numPages
    ) {
      alert('Khoảng trang không hợp lệ.');
      return;
    }

    setTranslateError('');
    stopAudio();
    pregenRef.current.cancel = true; // supersede any running pre-generation

    // Build the view: prior work (all done/error pages) + the selected range.
    const existing = await getDocPages(docHash, style);
    const map = new Map<number, Segment>();
    for (const seg of pagesToSegments(existing)) map.set(seg.pageNumber, seg);
    const todo: number[] = [];
    for (let p = startPage; p <= endPage; p++) {
      const ex = map.get(p);
      if (!ex || ex.status !== 'done') {
        map.set(p, {
          pageNumber: p,
          original: ex?.original ?? '',
          translated: null,
          status: 'pending',
        });
        todo.push(p);
      }
    }
    setSegments([...map.values()].sort((a, b) => a.pageNumber - b.pageNumber));

    if (todo.length === 0) return;

    setIsTranslating(true);
    let failed = 0;
    await runPool(todo, TRANSLATE_CONCURRENCY, async (pageNo) => {
      try {
        await translatePage(pageNo);
      } catch {
        failed++;
      }
    });
    setIsTranslating(false);

    if (failed > 0) setTranslateError(`Có ${failed} trang bị lỗi. Bấm thử lại trên từng trang.`);
    await touchDocMeta(docHash);
    refreshDocuments();

    // Warm the audio cache for the whole range in the background so playback is instant later.
    const rangePages: number[] = [];
    for (let p = startPage; p <= endPage; p++) rangePages.push(p);
    pregenerateAudio(rangePages);
  };

  const retryPage = async (pageNo: number) => {
    setTranslateError('');
    setIsTranslating(true);
    try {
      await translatePage(pageNo);
    } catch {
      /* status already set to error */
    }
    setIsTranslating(false);
    await touchDocMeta(docHash);
  };

  // ── History ─────────────────────────────────────────────────────────────────
  const openHistoryDoc = async (meta: DocMeta) => {
    let st = style;
    let pages = await getDocPages(meta.docHash, st);
    if (!pages.length) {
      const other: TranslationStyle = st === 'genz' ? 'chuẩn' : 'genz';
      const otherPages = await getDocPages(meta.docHash, other);
      if (otherPages.length) {
        st = other;
        pages = otherPages;
      }
    }
    stopAudio();
    setStyle(st);
    setFile(null);
    setParsedPdf(null);
    setActiveDoc({ hash: meta.docHash, name: meta.fileName });
    setSegments(pagesToSegments(pages));
    setActiveTab('translate');
  };

  const removeHistoryDoc = async (hash: string) => {
    await deleteDocument(hash);
    if (activeDoc?.hash === hash) {
      setActiveDoc(null);
      setSegments([]);
      setParsedPdf(null);
      setFile(null);
    }
    refreshDocuments();
  };

  // ── PDF export ──────────────────────────────────────────────────────────────
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const [isExportingPDF, setIsExportingPDF] = useState(false);

  const downloadPDF = async () => {
    if (!pdfContainerRef.current) return;
    setIsExportingPDF(true);
    const opt = {
      margin: 0.5,
      filename: `${docName ? docName.replace('.pdf', '') : 'Document'}_Translated_${style}.pdf`,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' as const },
    };
    try {
      // Loaded on demand to keep it out of the initial bundle.
      const { default: html2pdf } = await import('html2pdf.js');
      await html2pdf().from(pdfContainerRef.current).set(opt).save();
    } catch (err) {
      console.error('PDF generation failed', err);
      alert('Lỗi khi tạo PDF.');
    } finally {
      setIsExportingPDF(false);
    }
  };

  // ── Derived ─────────────────────────────────────────────────────────────────
  const doneInRange = (() => {
    if (!parsedPdf) return 0;
    const done = new Set(segments.filter((s) => s.status === 'done').map((s) => s.pageNumber));
    let n = 0;
    for (let p = startPage; p <= endPage; p++) if (done.has(p)) n++;
    return n;
  })();
  const rangeSize = parsedPdf ? Math.max(0, endPage - startPage + 1) : 0;
  const remainingInRange = rangeSize - doneInRange;
  const hasPlayable = segments.some((s) => s.translated && s.translated.trim());

  let translateLabel = 'DỊCH NGAY';
  if (isTranslating) translateLabel = 'ĐANG DỊCH';
  else if (doneInRange > 0 && remainingInRange > 0)
    translateLabel = `TIẾP TỤC (CÒN ${remainingInRange})`;
  else if (rangeSize > 0 && remainingInRange === 0) translateLabel = 'DỊCH LẠI';

  return (
    <div className="h-screen bg-[#FAF9F6] text-black font-sans flex flex-col overflow-hidden">
      {/* Header */}
      <header className="flex justify-between items-center p-6 pb-2 shrink-0">
        <div className="flex flex-col">
          <h1 className="text-5xl font-black tracking-tighter leading-none">
            READ<span className="text-[#6366F1]">ZO</span>
          </h1>
          <p className="text-xs font-bold uppercase tracking-widest opacity-60 mt-1">
            AI-Powered PDF Translation & TTS
          </p>
        </div>
        <div className="flex gap-4 items-center">
          <div className="flex bg-white p-1 border-2 border-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
            <button
              onClick={() => setActiveTab('translate')}
              className={`px-4 py-2 text-sm font-black uppercase transition-colors ${activeTab === 'translate' ? 'bg-black text-white' : 'hover:bg-gray-100'}`}
            >
              Dịch
            </button>
            <button
              onClick={() => {
                refreshDocuments();
                setActiveTab('history');
              }}
              className={`px-4 py-2 text-sm font-black uppercase transition-colors ${activeTab === 'history' ? 'bg-black text-white' : 'hover:bg-gray-100'}`}
            >
              Lịch sử
            </button>
          </div>
        </div>
      </header>

      {/* Main Layout */}
      <div className="flex flex-1 gap-6 min-h-0 p-6 pt-4">
        {activeTab === 'translate' ? (
          <>
            {/* Left Sidebar - Controls */}
            <aside className="w-80 flex flex-col gap-4 overflow-y-auto custom-scrollbar pr-2 pb-2">
              {/* Upload Card */}
              {!file ? (
                <div className="bg-white border-2 border-black p-4 flex flex-col gap-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] shrink-0">
                  <h2 className="text-lg font-black uppercase border-b-2 border-black pb-2">
                    Upload PDF
                  </h2>
                  {activeDoc && !parsedPdf && segments.length > 0 && (
                    <div className="bg-[#E0F2FE] p-2 border-2 border-black text-[11px] font-bold text-black leading-snug">
                      Đang hiển thị bản dịch đã lưu của <strong className="font-black">{docName}</strong>.
                      Tải lên lại file này để dịch thêm trang hoặc xem bản gốc.
                    </div>
                  )}
                  <label className="relative flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-black hover:bg-gray-100 cursor-pointer">
                    <div className="flex flex-col items-center justify-center pt-5 pb-6">
                      <Upload className="w-8 h-8 text-black mb-2" />
                      <p className="mb-2 text-sm text-black font-bold uppercase">Tải lên file PDF</p>
                      <p className="text-[10px] font-black opacity-50 uppercase">Tối đa 20MB</p>
                    </div>
                    <input
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                  </label>
                  {isParsing && (
                    <div className="mt-2 flex items-center gap-2 text-black text-sm font-bold uppercase">
                      <Loader2 className="w-4 h-4 animate-spin" /> Đang đọc PDF...
                    </div>
                  )}
                  {parseError && (
                    <div className="mt-2 text-white text-sm font-bold px-3 py-2 bg-red-500 border-2 border-black">
                      {parseError}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex justify-between items-center bg-white border-2 border-black p-2 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] shrink-0">
                  <span className="text-xs font-bold truncate max-w-[180px]">{file.name}</span>
                  <label className="cursor-pointer bg-black text-white px-3 py-1.5 text-[10px] uppercase font-black hover:-translate-y-0.5 hover:shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all">
                    Đổi file
                    <input
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                  </label>
                </div>
              )}

              {/* Mini PDF Preview */}
              {parsedPdf && !isParsing && !parseError && (
                <Suspense fallback={null}>
                  <PDFPagePreview parsedPdf={parsedPdf} currentPage={startPage} />
                </Suspense>
              )}

              {/* Translation Settings View */}
              {parsedPdf && !isParsing && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white border-2 border-black p-4 flex flex-col gap-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] shrink-0"
                >
                  <h2 className="text-lg font-black uppercase border-b-2 border-black pb-2">
                    Cấu hình Dịch
                  </h2>

                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase opacity-50">
                      Phạm vi trang (1 - {parsedPdf.numPages})
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={parsedPdf.numPages}
                        value={startPage}
                        onChange={(e) => setStartPage(Number(e.target.value))}
                        className="w-full border-2 border-black p-2 text-sm font-bold bg-white text-center"
                      />
                      <span className="font-black">-</span>
                      <input
                        type="number"
                        min={startPage}
                        max={parsedPdf.numPages}
                        value={endPage}
                        onChange={(e) => setEndPage(Number(e.target.value))}
                        className="w-full border-2 border-black p-2 text-sm font-bold bg-white text-center"
                      />
                    </div>

                    {parsedPdf.outline.length > 0 && (
                      <div className="mt-3">
                        <label className="text-[10px] font-black uppercase opacity-50">Chương lục</label>
                        <select
                          className="w-full border-2 border-black p-2 text-sm font-bold bg-white"
                          onChange={(e) => {
                            const p = Number(e.target.value);
                            if (p) {
                              setStartPage(p);
                              setEndPage(p);
                            }
                          }}
                        >
                          <option value="">-- Chọn nhanh chương --</option>
                          {parsedPdf.outline.map((item, idx) => (
                            <option key={idx} value={item.pageNumber}>
                              {item.title} (Trg {item.pageNumber})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase opacity-50">Phong cách dịch</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => changeStyle('chuẩn')}
                        className={`py-2 text-sm font-bold uppercase border-2 ${style === 'chuẩn' ? 'bg-black text-white border-black' : 'bg-gray-100 border-black hover:bg-gray-200'}`}
                      >
                        Chuẩn
                      </button>
                      <button
                        onClick={() => changeStyle('genz')}
                        className={`py-2 text-sm font-bold uppercase border-2 ${style === 'genz' ? 'bg-black text-white border-black' : 'bg-gray-100 border-black hover:bg-gray-200'}`}
                      >
                        Gen Z
                      </button>
                    </div>
                  </div>

                  <button
                    onClick={handleTranslate}
                    disabled={isTranslating || !parsedPdf}
                    className="w-full bg-[#FACC15] border-2 border-black px-6 py-3 text-lg font-black uppercase
                               hover:-translate-y-1 hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]
                               active:translate-y-0 active:translate-x-0 active:shadow-none transition-all disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none flex justify-center items-center gap-2 mt-2"
                  >
                    {isTranslating ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" /> {translateLabel}
                      </>
                    ) : (
                      translateLabel
                    )}
                  </button>
                </motion.div>
              )}

              {/* Global Settings */}
              <div className="bg-white border-2 border-black p-4 flex flex-col gap-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] shrink-0">
                <h2 className="text-lg font-black uppercase border-b-2 border-black pb-2">Tùy chỉnh & Đọc</h2>

                <div className="space-y-1 mb-2">
                  <label className="text-[10px] font-black uppercase opacity-50">Cỡ chữ bản dịch</label>
                  <div className="flex justify-between items-center bg-gray-100 border-2 border-black p-1">
                    <button
                      onClick={() => setFontSize((p) => Math.max(12, p - 2))}
                      className="px-3 py-1 font-black hover:bg-black hover:text-white transition-colors"
                    >
                      A-
                    </button>
                    <span className="text-sm font-bold">{fontSize}px</span>
                    <button
                      onClick={() => setFontSize((p) => Math.min(32, p + 2))}
                      className="px-3 py-1 font-black hover:bg-black hover:text-white transition-colors"
                    >
                      A+
                    </button>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">
                    Giọng đọc (VieNeu · 48kHz)
                  </label>
                  <select
                    value={voice}
                    onChange={(e) => setVoice(e.target.value as VoiceName)}
                    className="w-full border-2 border-black p-2 text-sm font-bold bg-white"
                  >
                    {(['tu_nhien', 'tin_tuc', 'doc_truyen'] as ReadingStyle[]).map((st) => (
                      <optgroup key={st} label={READING_STYLE_LABELS[st]}>
                        {VIENEU_VOICES.filter((v) => v.style === st).map((v) => (
                          <option key={v.name} value={v.name}>
                            {v.name} · {v.gender} · {v.region}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Kiểu đọc</label>
                  <div className="grid grid-cols-3 gap-1 bg-gray-100 p-1 border-2 border-black">
                    {(['tu_nhien', 'tin_tuc', 'doc_truyen'] as ReadingStyle[]).map((st) => (
                      <button
                        key={st}
                        onClick={() => setReadingStyle(st)}
                        className={`py-1.5 text-[11px] font-black uppercase border-2 ${readingStyle === st ? 'bg-black text-white border-black' : 'border-transparent hover:border-black/20'}`}
                      >
                        {READING_STYLE_LABELS[st]}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase opacity-50">Tốc độ ({speed}x)</label>
                  <div className="flex justify-between bg-gray-100 p-1 border-2 border-black">
                    {[1.2, 1.25, 1.3, 1.35, 1.5].map((s) => (
                      <button
                        key={s}
                        onClick={() => setSpeed(s)}
                        className={`px-1 lg:px-2 py-1 text-xs font-black border-2 ${speed === s ? 'bg-white border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]' : 'border-transparent hover:border-black/20'}`}
                      >
                        {s}x
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </aside>

            {/* Right Main Content - Results */}
            <div className="flex-1 flex flex-col min-h-0">
              {audioUrl && (
                <audio
                  ref={audioRef}
                  src={audioUrl}
                  autoPlay
                  onEnded={() => {
                    const ni = playlistIdxRef.current + 1;
                    if (ni < playlistRef.current.length) playFrom(ni);
                    else setIsPlaying(false);
                  }}
                  onPlay={() => {
                    if (audioRef.current) audioRef.current.playbackRate = speed;
                    setIsPlaying(true);
                  }}
                  onPause={() => setIsPlaying(false)}
                  onRateChange={() => {
                    if (audioRef.current && audioRef.current.playbackRate !== speed)
                      audioRef.current.playbackRate = speed;
                  }}
                  onTimeUpdate={(e) => setAudioProgress(e.currentTarget.currentTime)}
                  onLoadedMetadata={(e) => setAudioDuration(e.currentTarget.duration)}
                />
              )}

              {pregen && (
                <div className="flex items-center gap-2 mb-3 shrink-0 bg-[#FEF3C7] border-2 border-black px-3 py-2 text-[11px] font-black uppercase text-black">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Đang tạo audio nền: {pregen.done}/{pregen.total} trang
                  <button
                    onClick={() => {
                      pregenRef.current.cancel = true;
                      setPregen(null);
                    }}
                    className="ml-auto underline hover:no-underline"
                  >
                    Dừng
                  </button>
                </div>
              )}

              {segments.length > 0 && !isTranslating && (
                <div className="flex justify-end gap-2 mb-4 shrink-0">
                  <button
                    onClick={listenAll}
                    disabled={!hasPlayable || isGeneratingTTS}
                    className="bg-[#22C55E] text-white px-4 py-2 border-2 border-black font-black uppercase text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all flex items-center gap-2 disabled:opacity-50"
                  >
                    {isGeneratingTTS ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Volume2 className="w-4 h-4" />
                    )}
                    Nghe toàn bộ
                  </button>
                  <button
                    onClick={downloadPDF}
                    disabled={isExportingPDF}
                    className="bg-[#A21CAF] text-white px-4 py-2 border-2 border-black font-black uppercase text-sm shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none transition-all flex items-center gap-2 disabled:opacity-50"
                  >
                    {isExportingPDF ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                    {isExportingPDF ? 'Đang tạo PDF...' : 'Tải bản dịch (PDF)'}
                  </button>
                </div>
              )}

              <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-4">
                {segments.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center border-2 border-black border-dashed bg-gray-50 opacity-50 p-12">
                    <FileText className="w-12 h-12 mb-4" />
                    <p className="font-bold uppercase tracking-widest text-sm">
                      Kết quả biên dịch sẽ hiển thị tại đây.
                    </p>
                  </div>
                ) : (
                  <div className="bg-[#E0F2FE] border-2 border-black flex flex-col shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] transition-all">
                    <div className="border-b-2 border-black px-4 py-3 bg-[#BAE6FD] flex justify-between items-center sticky top-0 z-10 shadow-sm">
                      <span className="text-xs font-black uppercase tracking-widest text-[#0369A1]">
                        Bản dịch ({style}) · {segments.filter((s) => s.status === 'done').length} trang đã lưu
                      </span>
                    </div>

                    <div className="p-8 overflow-auto h-full min-h-[400px] custom-scrollbar selection:bg-pink-300">
                      {segments.map((segment, idx) => (
                        <motion.div
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          key={segment.pageNumber}
                          className={idx > 0 ? 'mt-8' : ''}
                        >
                          {/* Page divider + status + TTS control */}
                          <div className="flex items-center mb-6 mt-4 opacity-80 hover:opacity-100 transition-opacity">
                            <div className="h-px bg-blue-300 flex-1"></div>
                            <span className="mx-4 text-[10px] font-black uppercase text-blue-600 tracking-widest text-center">
                              · Trang {segment.pageNumber} ·
                            </span>
                            <div className="h-px bg-blue-300 w-8 mr-2"></div>

                            <div className="flex items-center gap-1">
                              {segment.status === 'done' && segment.translated && segment.translated.trim() && (
                                <>
                                  {activeAudioSegment === segment.pageNumber && audioUrl ? (
                                    <div className="flex items-center gap-1 bg-[#FACC15] text-black px-2 py-1 border border-black font-black uppercase text-[10px] shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] scale-90 origin-right">
                                      <button onClick={togglePlayAudio} className="hover:scale-110 transition-transform">
                                        {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3 fill-current" />}
                                      </button>
                                      <button onClick={stopAudio} className="hover:scale-110 transition-transform">
                                        <Square className="w-2.5 h-2.5 fill-current" />
                                      </button>
                                    </div>
                                  ) : activeAudioSegment === segment.pageNumber && isGeneratingTTS ? (
                                    <div className="flex items-center gap-1 bg-gray-100 text-black px-2 py-1 border border-black font-black uppercase text-[10px] scale-90 origin-right">
                                      <Loader2 className="w-3 h-3 animate-spin" /> ...
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => listenPage(segment.pageNumber)}
                                      className="flex items-center gap-1 bg-black hover:bg-gray-800 text-white px-2 py-1 text-[10px] font-black uppercase border border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] transition-all scale-90 origin-right"
                                      disabled={isGeneratingTTS}
                                    >
                                      <Volume2 className="w-3 h-3" /> Nghe
                                    </button>
                                  )}
                                </>
                              )}
                              {segment.status === 'done' && (
                                <span title="Đã dịch & lưu">
                                  <Check className="w-3.5 h-3.5 text-green-600" />
                                </span>
                              )}
                              {segment.status === 'error' && (
                                <button
                                  onClick={() => retryPage(segment.pageNumber)}
                                  disabled={isTranslating}
                                  className="flex items-center gap-1 bg-red-500 text-white px-2 py-1 text-[10px] font-black uppercase border border-black scale-90 origin-right disabled:opacity-50"
                                >
                                  <RotateCw className="w-3 h-3" /> Thử lại
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Translated content */}
                          <div className="markdown-body" style={{ fontSize: `${fontSize}px` }}>
                            {segment.translated !== null && segment.translated !== '' ? (
                              <Markdown>{segment.translated}</Markdown>
                            ) : segment.translated === '' ? (
                              <span className="text-[10px] font-black uppercase opacity-50 block text-center py-4">
                                Nội dung trang trống
                              </span>
                            ) : segment.status === 'error' ? (
                              <span className="text-[10px] font-black uppercase opacity-50 block text-center py-4 text-red-500">
                                Lỗi / Bị gián đoạn — bấm Thử lại
                              </span>
                            ) : (
                              <div className="flex justify-center py-8">
                                <div className="flex gap-2 mb-2">
                                  <div className="w-3 h-3 bg-pink-500 rounded-full animate-bounce"></div>
                                  <div
                                    className="w-3 h-3 bg-pink-500 rounded-full animate-bounce"
                                    style={{ animationDelay: '0.15s' }}
                                  ></div>
                                  <div
                                    className="w-3 h-3 bg-pink-500 rounded-full animate-bounce"
                                    style={{ animationDelay: '0.3s' }}
                                  ></div>
                                </div>
                              </div>
                            )}
                          </div>
                        </motion.div>
                      ))}

                      {translateError && (
                        <div className="mt-8 mb-4 mx-8 p-4 bg-red-50 text-red-600 border-2 border-red-200 text-sm font-bold text-center">
                          {translateError}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {activeAudioSegment !== null && (
                <div className="mt-4 bg-black text-white p-4 flex flex-col sm:flex-row sm:items-center gap-6 shadow-[8px_8px_0px_0px_rgba(242,125,38,1)] border-2 border-white">
                  <div className="flex items-center gap-4 shrink-0">
                    <button
                      onClick={togglePlayAudio}
                      className="w-12 h-12 bg-white rounded-full flex items-center justify-center text-black hover:scale-105 active:scale-95 transition-transform"
                    >
                      {isPlaying ? (
                        <Pause className="w-5 h-5 fill-current" />
                      ) : (
                        <Play className="w-5 h-5 fill-current ml-1" />
                      )}
                    </button>
                    <div className="flex flex-col">
                      <span className="text-[10px] font-black uppercase text-gray-400">
                        Đang phát {playlistPos.total > 1 ? `(${playlistPos.idx + 1}/${playlistPos.total})` : ''}
                      </span>
                      <span className="text-sm font-bold truncate w-32 sm:w-48 text-white">
                        Trang {activeAudioSegment}
                      </span>
                    </div>
                  </div>
                  <div className="flex-1 flex flex-col gap-2 relative group">
                    <div className="flex justify-between text-[10px] font-black">
                      <span>{formatTime(audioProgress)}</span>
                      <span>{formatTime(audioDuration)}</span>
                    </div>
                    <div
                      className="w-full h-3 bg-gray-800 cursor-pointer overflow-hidden relative"
                      onClick={(e) => {
                        if (audioRef.current && audioDuration) {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                          audioRef.current.currentTime = (x / rect.width) * audioDuration;
                        }
                      }}
                    >
                      <div
                        className="absolute top-0 left-0 h-full bg-[#FACC15] pointer-events-none"
                        style={{ width: `${audioDuration ? (audioProgress / audioDuration) * 100 : 0}%` }}
                      ></div>
                    </div>
                  </div>
                  <button
                    onClick={stopAudio}
                    className="border-2 border-white px-4 py-2 text-xs font-black uppercase hover:bg-white hover:text-black transition-colors shrink-0"
                  >
                    Đóng
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          /* History View */
          <div className="w-full max-w-4xl mx-auto bg-white border-2 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] overflow-hidden flex flex-col relative h-full">
            <div className="px-6 py-4 border-b-2 border-black bg-gray-50 flex items-center gap-3">
              <History className="w-5 h-5 text-black" />
              <h2 className="text-lg font-black uppercase">Lịch sử biên dịch</h2>
            </div>
            <div className="p-6 overflow-y-auto flex-1 custom-scrollbar">
              {documents.length === 0 ? (
                <div className="text-center py-12 text-sm font-black uppercase opacity-40">
                  Chưa có bản dịch nào được lưu.
                </div>
              ) : (
                <div className="space-y-4">
                  {documents.map((doc) => (
                    <div
                      key={doc.docHash}
                      className="border-2 border-black bg-white hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] transition-all flex items-center justify-between px-4 py-3"
                    >
                      <button onClick={() => openHistoryDoc(doc)} className="flex flex-col text-left flex-1 min-w-0">
                        <span className="font-bold text-black truncate">{doc.fileName}</span>
                        <span className="text-[10px] font-black uppercase opacity-60 mt-1">
                          {new Date(doc.updatedAt).toLocaleString()} • {doc.numPages} trang
                        </span>
                      </button>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => openHistoryDoc(doc)}
                          className="bg-black text-white px-3 py-1.5 text-[10px] uppercase font-black hover:-translate-y-0.5 transition-all"
                        >
                          Mở
                        </button>
                        <button
                          onClick={() => removeHistoryDoc(doc.docHash)}
                          className="p-1.5 border-2 border-black hover:bg-red-500 hover:text-white transition-colors"
                          title="Xóa"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Hidden Container for PDF Export */}
      <div className="absolute left-[-9999px] top-0 w-[1000px] z-[-1] overflow-hidden">
        <div ref={pdfContainerRef} className="bg-white p-8 text-black font-sans leading-relaxed">
          <h1 className="text-3xl font-black uppercase mb-4 border-b-4 border-black pb-4">
            {docName || 'Tài liệu PDF'}
          </h1>
          <div className="flex justify-between text-sm font-black uppercase border-b-2 border-black pb-2 mb-6">
            <span className="w-1/2 pr-4 border-r-2 border-black">Bản gốc (Tiếng Anh)</span>
            <span className="w-1/2 pl-4">Bản dịch ({style === 'chuẩn' ? 'Chuẩn' : 'Gen Z'})</span>
          </div>

          <div className="flex flex-col gap-6">
            {segments.map((seg) => (
              <div
                key={seg.pageNumber}
                className="flex flex-row border-b-2 border-dashed border-gray-300 pb-6 gap-8 html2pdf__page-break"
              >
                <div className="w-1/2 font-serif text-sm whitespace-pre-wrap break-words">
                  {seg.original}
                </div>
                <div className="w-1/2 font-sans font-medium text-[15px] break-words markdown-body">
                  <Markdown>{seg.translated || ''}</Markdown>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-8 pt-4 border-t-2 border-black text-center text-xs font-black uppercase opacity-50">
            Tạo bởi READZO
          </div>
        </div>
      </div>
    </div>
  );
}
