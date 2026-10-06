// Kokoro: a free, open-source voice model (Apache 2.0) that runs on the
// phone itself. The library is bundled in vendor/; the model weights (about
// 90 MB) download from Hugging Face on first use and stay cached afterward.
// It speaks English only, so Spanish and Japanese still use iPhone voices.

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

export const KOKORO_VOICES = [
  ["af_heart", "Heart (American woman)"],
  ["af_bella", "Bella (American woman)"],
  ["af_nicole", "Nicole (American woman, soft)"],
  ["af_sarah", "Sarah (American woman)"],
  ["af_aoede", "Aoede (American woman)"],
  ["af_kore", "Kore (American woman)"],
  ["am_michael", "Michael (American man)"],
  ["am_fenrir", "Fenrir (American man)"],
  ["am_puck", "Puck (American man)"],
  ["bf_emma", "Emma (British woman)"],
  ["bm_george", "George (British man)"],
  ["bm_fable", "Fable (British man)"],
];

let ttsPromise = null;
let chain = Promise.resolve();
let state = { status: "idle", progress: 0 }; // idle | loading | ready | error
const listeners = new Set();
const fileProgress = new Map();

function emit(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn(state));
}

export function kokoroState() {
  return state;
}

// Subscribe to download progress. Returns an unsubscribe function.
export function onKokoroState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function onProgress(e) {
  if (e?.status !== "progress" || !e.file || !e.total) return;
  fileProgress.set(e.file, { loaded: e.loaded, total: e.total });
  let loaded = 0;
  let total = 0;
  for (const f of fileProgress.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  emit({ progress: total ? Math.min(99, Math.round((loaded / total) * 100)) : 0 });
}

export function loadKokoro() {
  if (!ttsPromise) {
    emit({ status: "loading", progress: 0, error: null });
    ttsPromise = (async () => {
      const { KokoroTTS } = await import("../vendor/kokoro.web.js");
      return KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "wasm", progress_callback: onProgress });
    })();
    ttsPromise.then(
      () => emit({ status: "ready", progress: 100 }),
      (err) => {
        ttsPromise = null;
        emit({ status: "error", error: err?.message || String(err) });
      }
    );
  }
  return ttsPromise;
}

// Generates one clip at a time (the model can't run 2 jobs at once), in the
// order requested. Resolves with a WAV blob.
export function kokoroSpeak(text, voice) {
  const job = chain.then(async () => {
    const tts = await loadKokoro();
    const audio = await tts.generate(text, { voice: voice || "af_heart" });
    return audio.toBlob();
  });
  chain = job.catch(() => {});
  return job;
}
