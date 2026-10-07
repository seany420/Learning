import { kokoroSpeak, kokoroState, loadKokoro } from "./kokoro.js";

// Speech in and speech out.
//
// Speaking: tutor text is split into sentence-sized chunks as it streams in.
// Each chunk is sent to the TTS provider right away and played in order, so
// the tutor starts talking before the full reply has arrived.
//
// Listening: either OpenAI transcription of a recorded clip (best for mixed
// English, Spanish, and Japanese) or the iPhone's built-in recognizer.

const LANG_TAGS = { es: "es", ja: "ja" };
const DEVICE_LOCALES = { en: "en-US", es: "es-MX", ja: "ja-JP" };

// ---------- text helpers ----------

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function stripMarkdown(s) {
  return s.replace(/[*_#`]+/g, "").replace(/^\s*>\s?/gm, "").replace(/^\s*[-•]\s+/gm, "");
}

// What gets read aloud by a multilingual voice: tags removed, guides dropped.
export function toSpeech(text) {
  return stripMarkdown(text.replace(/\[\[[\s\S]*?\]\]/g, "").replace(/<\/?(es|ja)>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

// Splits text into language runs for device voices.
export function toSegments(text) {
  const clean = stripMarkdown(text.replace(/\[\[[\s\S]*?\]\]/g, ""));
  const out = [];
  const re = /<(es|ja)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  let m;
  const push = (lang, t) => {
    t = t.replace(/\s+/g, " ").trim();
    if (t && /[\p{L}\p{N}]/u.test(t)) out.push({ lang, text: t });
  };
  while ((m = re.exec(clean))) {
    push("en", clean.slice(last, m.index));
    push(LANG_TAGS[m[1]], m[2]);
    last = re.lastIndex;
  }
  push("en", clean.slice(last).replace(/<\/?(es|ja)>/g, ""));
  return out;
}

// Transcript HTML: target-language phrases highlighted, guides shown small.
export function toDisplayHtml(text) {
  let html = escapeHtml(text);
  html = html.replace(/&lt;(es|ja)&gt;([\s\S]*?)&lt;\/\1&gt;/g, '<span class="tl" lang="$1">$2</span>');
  html = html.replace(/&lt;\/?(es|ja)&gt;/g, "");
  html = html.replace(/\[\[([\s\S]*?)\]\]/g, '<span class="pron">$1</span>');
  html = html.replace(/\*\*([^*]+)\*\*/g, "$1");
  return html.replace(/\n/g, "<br>");
}

// Incremental sentence chunker that never splits inside a language tag or a
// pronunciation guide.
export class Chunker {
  constructor(onChunk, minLen = 60) {
    this.buf = "";
    this.onChunk = onChunk;
    this.minLen = minLen;
    this.first = true;
  }
  push(delta) {
    this.buf += delta;
    let start = 0;
    let depth = 0;
    let cut = -1;
    const b = this.buf;
    for (let i = 0; i < b.length; i++) {
      if (b.startsWith("<es>", i) || b.startsWith("<ja>", i) || b.startsWith("[[", i)) depth++;
      else if (b.startsWith("</es>", i) || b.startsWith("</ja>", i) || b.startsWith("]]", i)) depth = Math.max(0, depth - 1);
      if (depth > 0) continue;
      const ch = b[i];
      const isEnd = ".!?。！？…".includes(ch) || ch === "\n";
      if (!isEnd) continue;
      let j = i + 1;
      while (j < b.length && `"'”’)]`.includes(b[j])) j++;
      // Western punctuation needs following whitespace; Japanese doesn't.
      if (".!?…".includes(ch) && !(j < b.length && /\s/.test(b[j]))) continue;
      // A closing tag right after punctuation belongs to this chunk.
      const minLen = this.first ? 20 : this.minLen;
      if (j - start >= minLen || ch === "\n") {
        cut = j;
        this.emit(b.slice(start, j));
        start = j;
      }
    }
    if (cut >= 0) this.buf = b.slice(start);
  }
  emit(text) {
    if (toSpeech(text)) {
      this.first = false;
      this.onChunk(text);
    }
  }
  flush() {
    if (this.buf) this.emit(this.buf);
    this.buf = "";
  }
}

// ---------- audio session helpers (iOS) ----------

function setAudioSession(type) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = type;
  } catch {}
}

// One shared Web Audio context for playback and the mic level meter. iOS
// only lets it start from a tap; once running it can play at any time.
let sharedCtx = null;

export function audioCtx() {
  if (!sharedCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) sharedCtx = new AC();
  }
  return sharedCtx;
}

// Call from a tap handler.
export function resumeAudio() {
  const ctx = audioCtx();
  if (!ctx) return;
  try {
    if (ctx.state !== "running") ctx.resume();
    // Playing a tiny silent buffer inside the tap fully unlocks iOS audio.
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch {}
}

const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

// ---------- Speaker ----------

export class Speaker {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.audio = new Audio();
    this.audio.setAttribute("playsinline", "");
    this.audio.preload = "auto";
    this.queue = [];
    this.running = false;
    this.gen = 0;
    this.finishCurrent = null;
    this.unlocked = false;
    this.onStateChange = null; // (speaking: boolean) => void
    this.onError = null;
    this.onNotice = null; // natural voice not ready yet: (kokoroState) => void
    this.idleWaiters = [];
    this.lastText = "";
  }

  // Must be called from a tap handler once, so iOS lets us play audio later.
  unlock() {
    setAudioSession("playback");
    resumeAudio();
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      this.audio.src = SILENT_WAV;
      const p = this.audio.play();
      if (p) p.then(() => this.audio.pause()).catch(() => {});
    } catch {}
    try {
      if ("speechSynthesis" in window) {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        speechSynthesis.speak(u);
      }
    } catch {}
  }

  get speaking() {
    return this.running;
  }

  // Queue a chunk of tutor text.
  say(text) {
    const s = this.getSettings();
    const gen = this.gen;
    this.lastText += text + " ";
    let ready;
    let engine = effectiveTts(s);
    let downloaded = false;
    try {
      downloaded = !!localStorage.getItem("lv:kokoroDownloaded");
    } catch {}
    const kState = kokoroState().status;
    // Already on the phone: just wait the few seconds it takes to start.
    if (engine === "kokoro" && downloaded && kState !== "error") loadKokoro().catch(() => {});
    else if (engine === "kokoro" && kState !== "ready") {
      // Never sit silent while the natural voice downloads: speak with the
      // iPhone voice for now and keep loading in the background.
      if (kokoroState().status !== "error") loadKokoro().catch(() => {});
      this.onNotice?.(kokoroState());
      engine = "device";
    }
    if (engine === "kokoro") {
      // English goes to the on-phone natural voice; Spanish and Japanese
      // phrases go to iPhone voices, in order.
      for (const seg of toSegments(text)) {
        if (seg.lang !== "en") {
          this.queue.push(Promise.resolve(() => this.playDevice([seg], s, gen)));
          continue;
        }
        const job = withTimeout(kokoroSpeak(seg.text, s.kokoroVoice, s.speechRate || 1), 60000, "it took over a minute");
        this.queue.push(
          job.then(
            (pcm) => () => this.playPcm(pcm, gen),
            (err) => {
              this.onError?.(new Error(`Natural voice failed (${err.message}). Using iPhone voice instead.`));
              return () => this.playDevice([seg], s, gen);
            }
          )
        );
      }
      this.run();
      return;
    }
    if (engine === "device") {
      const segs = toSegments(text);
      ready = Promise.resolve(() => this.playDevice(segs, s, gen));
    } else {
      const spoken = toSpeech(text);
      if (!spoken) return;
      const fetcher = s.ttsProvider === "elevenlabs" ? fetchEleven(spoken, s) : fetchOpenAI(spoken, s);
      // Swallow here so an early failure isn't reported as unhandled; the
      // playback loop surfaces it in order.
      fetcher.catch(() => {});
      ready = fetcher.then((blob) => () => this.playBlob(blob, s, gen));
    }
    this.queue.push(ready);
    this.run();
  }

  async run() {
    if (this.running) return;
    this.running = true;
    this.onStateChange?.(true);
    const gen = this.gen;
    while (this.queue.length && gen === this.gen) {
      const item = this.queue.shift();
      try {
        const play = await item;
        if (gen !== this.gen) break;
        await play();
      } catch (err) {
        if (gen === this.gen) this.onError?.(err);
      }
    }
    this.running = false;
    if (gen === this.gen) {
      this.onStateChange?.(false);
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  // Resolves once everything queued so far has been spoken (or stopped).
  whenIdle() {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((res) => this.idleWaiters.push(res));
  }

  stop() {
    this.gen++;
    this.queue = [];
    try {
      this.audio.pause();
    } catch {}
    try {
      if ("speechSynthesis" in window) speechSynthesis.cancel();
    } catch {}
    this.finishCurrent?.();
    this.finishCurrent = null;
    const wasRunning = this.running;
    this.running = false;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((w) => w());
    if (wasRunning) this.onStateChange?.(false);
  }

  resetTranscript() {
    this.lastText = "";
  }

  playBlob(blob, s, gen) {
    return new Promise((resolve) => {
      if (gen !== this.gen) return resolve();
      setAudioSession("playback");
      const url = URL.createObjectURL(blob);
      const done = () => {
        this.audio.onended = this.audio.onerror = null;
        URL.revokeObjectURL(url);
        this.finishCurrent = null;
        resolve();
      };
      this.finishCurrent = done;
      this.audio.onended = done;
      this.audio.onerror = () => {
        this.onError?.(new Error("This phone couldn't play that audio."));
        done();
      };
      this.audio.src = url;
      this.audio.playbackRate = s.speechRate || 1;
      this.audio.preservesPitch = true;
      const p = this.audio.play();
      if (p) p.catch((err) => {
        this.onError?.(new Error("Audio playback was blocked. Tap the mic button once to enable sound."));
        done();
      });
    });
  }

  // Plays raw samples through Web Audio (used by the natural voice).
  async playPcm({ samples, rate }, gen) {
    if (gen !== this.gen || !samples?.length) return;
    const ctx = audioCtx();
    if (!ctx) throw new Error("This browser can't play generated audio.");
    setAudioSession("playback");
    if (ctx.state !== "running") {
      try {
        await ctx.resume();
      } catch {}
    }
    if (ctx.state !== "running") throw new Error("Sound is blocked. Tap the mic or Test voice again to enable it.");
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples instanceof Float32Array ? samples : Float32Array.from(samples), 0);
    await new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const done = () => {
        src.onended = null;
        this.finishCurrent = null;
        resolve();
      };
      src.onended = done;
      this.finishCurrent = () => {
        try {
          src.stop();
        } catch {}
        done();
      };
      src.start();
    });
  }

  async playDevice(segs, s, gen) {
    if (!("speechSynthesis" in window)) throw new Error("This browser has no built-in speech voices.");
    for (const seg of segs) {
      if (gen !== this.gen) return;
      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(seg.text);
        u.lang = DEVICE_LOCALES[seg.lang] || "en-US";
        const voice = pickDeviceVoice(seg.lang, s.deviceVoices?.[seg.lang]);
        if (voice) u.voice = voice;
        u.rate = Math.min(2, Math.max(0.5, s.speechRate || 1));
        const done = () => {
          this.finishCurrent = null;
          resolve();
        };
        this.finishCurrent = done;
        u.onend = done;
        u.onerror = done;
        speechSynthesis.speak(u);
      });
    }
  }
}

function withTimeout(promise, ms, why) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(why)), ms))]);
}

// ---------- TTS providers ----------

// Falls back to the iPhone's own voices when the chosen service has no key.
export function effectiveTts(s) {
  if (s.ttsProvider === "openai" && !s.openaiKey) return "device";
  if (s.ttsProvider === "elevenlabs" && !s.elevenKey) return "device";
  return s.ttsProvider;
}

const OPENAI_STYLE =
  "Speak like a warm, engaged human tutor on a phone call: natural pacing, real warmth, light humor where it fits. " +
  "When you say Spanish or Japanese words, pronounce them like a native speaker, a little slower and very clearly so a learner can imitate them.";

async function fetchOpenAI(text, s) {
  if (!s.openaiKey) throw new Error("Add an OpenAI API key in Settings, or switch the voice to iPhone voices.");
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${s.openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: s.openaiVoice || "marin",
      input: text,
      instructions: OPENAI_STYLE,
      response_format: "mp3",
    }),
  });
  if (!res.ok) throw new Error(`OpenAI voice error (${res.status}): ${await safeText(res)}`);
  return res.blob();
}

async function fetchEleven(text, s) {
  if (!s.elevenKey) throw new Error("Add an ElevenLabs API key in Settings, or switch voices.");
  const voice = encodeURIComponent(s.elevenVoiceId || "21m00Tcm4TlvDq8ikWAM");
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": s.elevenKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: s.elevenModel || "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs error (${res.status}): ${await safeText(res)}`);
  return res.blob();
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return res.statusText;
  }
}

export function deviceVoices() {
  if (!("speechSynthesis" in window)) return [];
  return speechSynthesis.getVoices();
}

const QUALITY = /(premium|enhanced|siri|neural|natural)/i;

export function pickDeviceVoice(lang, preferredName) {
  const voices = deviceVoices();
  if (preferredName) {
    const v = voices.find((x) => x.name === preferredName || x.voiceURI === preferredName);
    if (v) return v;
  }
  const locale = DEVICE_LOCALES[lang] || "en-US";
  const base = locale.slice(0, 2);
  const matches = voices.filter((v) => v.lang?.replace("_", "-").toLowerCase().startsWith(base));
  const exact = matches.filter((v) => v.lang.replace("_", "-").toLowerCase() === locale.toLowerCase());
  const pool = exact.length ? exact : matches;
  return (
    pool.find((v) => /premium/i.test(`${v.name} ${v.voiceURI}`)) ||
    pool.find((v) => QUALITY.test(`${v.name} ${v.voiceURI}`)) ||
    pool[0] ||
    null
  );
}

// ---------- Listening ----------

export function deviceSttAvailable() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// Records until the speaker goes quiet (or stop() is called), then
// transcribes. Resolves with the text, or "" when nothing was said.
export class Listener {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.active = null;
    this.ctx = null;
    this.onLevel = null; // (0..1) => void
    this.onInterim = null; // (text) => void
    this.onRecorded = null; // recording finished, transcription starting
  }

  // Call inside a tap handler so iOS allows the audio context to run.
  prime() {
    try {
      if (!this.ctx) this.ctx = audioCtx();
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    } catch {}
  }

  get listening() {
    return !!this.active;
  }

  stop() {
    this.active?.finish();
  }

  cancel() {
    this.active?.cancel();
  }

  async listen({ lang, prompt }) {
    const s = this.getSettings();
    if (s.sttProvider === "device" || !s.openaiKey) {
      if (deviceSttAvailable()) return this.listenDevice(lang);
      if (!s.openaiKey) throw new Error("Speech recognition needs an OpenAI key here. Add one in Settings, or type instead.");
    }
    return this.listenOpenAI(s, lang, prompt);
  }

  listenDevice(lang) {
    return new Promise((resolve, reject) => {
      const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new Rec();
      rec.lang = DEVICE_LOCALES[lang] || "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      let finalText = "";
      let interim = "";
      let settled = false;
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        this.active = null;
        fn();
      };
      rec.onresult = (e) => {
        interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        this.onInterim?.((finalText + " " + interim).trim());
      };
      rec.onerror = (e) => {
        if (e.error === "no-speech" || e.error === "aborted") settle(() => resolve(""));
        else settle(() => reject(new Error(`Speech recognition error: ${e.error}`)));
      };
      rec.onend = () => settle(() => resolve((finalText || interim).trim()));
      this.active = {
        finish: () => rec.stop(),
        cancel: () => {
          finalText = interim = "";
          rec.abort();
        },
      };
      setAudioSession("play-and-record");
      rec.start();
    });
  }

  async listenOpenAI(s, lang, prompt) {
    this.prime();
    setAudioSession("play-and-record");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      throw new Error("Microphone access was denied. Allow it in Settings > Safari > Microphone (or for this app).");
    }

    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find(
      (t) => window.MediaRecorder?.isTypeSupported?.(t)
    );
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    let analyser = null;
    let source = null;
    try {
      if (this.ctx) {
        source = this.ctx.createMediaStreamSource(stream);
        analyser = this.ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
      }
    } catch {
      analyser = null;
    }

    let cancelled = false;
    const stopped = new Promise((res) => (rec.onstop = res));
    const finishRec = () => {
      if (rec.state !== "inactive") rec.stop();
    };
    this.active = {
      finish: finishRec,
      cancel: () => {
        cancelled = true;
        finishRec();
      },
    };

    rec.start(250);
    const started = performance.now();
    let heardSpeech = false;
    let lastLoud = performance.now();
    let noise = 0.01;
    const data = analyser ? new Float32Array(analyser.fftSize) : null;
    const timer = setInterval(() => {
      const now = performance.now();
      if (now - started > 90000) return finishRec();
      if (!analyser) return;
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      this.onLevel?.(Math.min(1, rms * 12));
      if (now - started < 400) noise = Math.max(noise, rms);
      const threshold = Math.max(0.015, noise * 2.5);
      if (rms > threshold) {
        if (!heardSpeech && now - started > 150) heardSpeech = true;
        lastLoud = now;
      }
      if (!s.handsFree) return;
      if (heardSpeech && now - lastLoud > (s.silenceMs || 1600)) finishRec();
      if (!heardSpeech && now - started > 15000) {
        cancelled = true;
        finishRec();
      }
    }, 60);

    await stopped;
    clearInterval(timer);
    if (!cancelled) this.onRecorded?.();
    this.onLevel?.(0);
    stream.getTracks().forEach((t) => t.stop());
    try {
      source?.disconnect();
    } catch {}
    this.active = null;
    setAudioSession("playback");

    if (cancelled || !chunks.length) return "";
    const type = rec.mimeType || mime || "audio/webm";
    const blob = new Blob(chunks, { type });
    if (blob.size < 2000) return "";
    return transcribeOpenAI(blob, type, s, lang, prompt);
  }
}

async function transcribeOpenAI(blob, type, s, lang, prompt) {
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  const form = new FormData();
  form.append("file", blob, `speech.${ext}`);
  form.append("model", "gpt-4o-transcribe");
  if (lang && lang !== "auto") form.append("language", lang);
  if (prompt) form.append("prompt", prompt);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${s.openaiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Transcription error (${res.status}): ${await safeText(res)}`);
  const json = await res.json();
  return (json.text || "").trim();
}
