// Kokoro: a free, open-source voice model (Apache 2.0) that runs on the
// phone itself. The library is bundled in vendor/; the model weights (about
// 90 MB) download from Hugging Face on first use and stay cached afterward.
// It speaks English only, so Spanish and Japanese still use iPhone voices.

import { diag } from "./diag.js";

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

let lastActivity = 0;

function onProgress(e) {
  lastActivity = Date.now();
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
    lastActivity = Date.now();
    const started = performance.now();
    diag("natural voice: loading library");
    const load = (async () => {
      const { KokoroTTS } = await import("../vendor/kokoro.web.js");
      diag("natural voice: library loaded, starting model");
      return KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "wasm", progress_callback: onProgress });
    })();
    // Give up if nothing happens for 2 minutes, so the app never waits forever.
    const stalled = new Promise((_, reject) => {
      const timer = setInterval(() => {
        if (Date.now() - lastActivity > 120000) {
          clearInterval(timer);
          reject(new Error("the download stalled. Check your connection and try again"));
        }
      }, 5000);
      load.finally(() => clearInterval(timer)).catch(() => {});
    });
    ttsPromise = Promise.race([load, stalled]);
    ttsPromise.then(
      () => {
        diag(`natural voice: ready after ${((performance.now() - started) / 1000).toFixed(1)}s`);
        try {
          localStorage.setItem("lv:kokoroDownloaded", "1");
        } catch {}
        emit({ status: "ready", progress: 100 });
      },
      (err) => {
        diag(`natural voice: FAILED to start: ${err?.message || err}`);
        ttsPromise = null;
        emit({ status: "error", error: err?.message || String(err) });
      }
    );
  }
  return ttsPromise;
}

// Generates one clip at a time (the model can't run 2 jobs at once), in the
// order requested.
// Resolves with raw samples ({ samples: Float32Array, rate }) rather than a
// WAV file: Kokoro writes 32-bit float WAV, which Safari's audio player
// can't open, so the app plays the samples through Web Audio instead.
export function kokoroSpeak(text, voice, speed = 1) {
  const job = chain.then(async () => {
    const tts = await loadKokoro();
    const t = performance.now();
    diag(`generate: "${text.slice(0, 30)}"`);
    try {
      const audio = await tts.generate(text, { voice: voice || "af_heart", speed: Math.min(2, Math.max(0.5, speed)) });
      const secs = audio?.audio?.length / audio?.sampling_rate;
      diag(`generated ${secs.toFixed(1)}s of audio in ${((performance.now() - t) / 1000).toFixed(1)}s`);
      return { samples: audio.audio, rate: audio.sampling_rate };
    } catch (err) {
      diag(`generate FAILED: ${err?.message || err}`);
      throw err;
    }
  });
  chain = job.catch(() => {});
  return job;
}
