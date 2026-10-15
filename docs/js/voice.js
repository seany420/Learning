import { kokoroSpeak, kokoroState, loadKokoro } from "./kokoro.js";
import { diag } from "./diag.js";

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

// Incremental sentence chunker. Splits at sentence ends as text streams in,
// including inside <es>/<ja> passages: a long Spanish or Japanese stretch is
// closed at the cut and reopened in the next chunk, so speech can start
// without waiting for the whole reply. Never splits inside a [[guide]].
export class Chunker {
  constructor(onChunk, minLen = 60) {
    this.buf = "";
    this.openLang = null; // language tag still open at the start of buf
    this.onChunk = onChunk;
    this.minLen = minLen;
    this.first = true;
  }
  push(delta) {
    this.buf += delta;
    const b = this.buf;
    let start = 0;
    let startLang = this.openLang;
    let lang = this.openLang;
    let guide = false;
    for (let i = 0; i < b.length; i++) {
      const open = b.startsWith("<es>", i) ? "es" : b.startsWith("<ja>", i) ? "ja" : null;
      if (open) {
        lang = open;
        i += 3;
        continue;
      }
      if (b.startsWith("</es>", i) || b.startsWith("</ja>", i)) {
        lang = null;
        i += 4;
        continue;
      }
      if (b.startsWith("[[", i)) {
        guide = true;
        i += 1;
        continue;
      }
      if (b.startsWith("]]", i)) {
        guide = false;
        i += 1;
        continue;
      }
      if (guide) continue;
      const ch = b[i];
      const isEnd = ".!?。！？…".includes(ch) || ch === "\n";
      if (!isEnd) continue;
      let j = i + 1;
      while (j < b.length && `"'”’)]»`.includes(b[j])) j++;
      // Punctuation right before a closing tag: the tag belongs to this chunk.
      let cutLang = lang;
      if (b.startsWith("</es>", j) || b.startsWith("</ja>", j)) {
        j += 5;
        cutLang = null;
      }
      // Western punctuation needs following whitespace; Japanese doesn't.
      if (".!?…".includes(ch) && !(j < b.length && /\s/.test(b[j]))) continue;
      // "Now say ¿Cómo estás? and I'll answer." keeps going: a lowercase word
      // after the punctuation means the sentence isn't over.
      if (ch !== "\n") {
        let k = j;
        while (k < b.length && /\s/.test(b[k])) k++;
        if (k >= b.length) continue; // wait to see the next word
        if (/\p{Ll}/u.test(b[k])) continue;
      }
      const minLen = this.first ? 20 : this.minLen;
      if (j - start >= minLen || ch === "\n") {
        const prefix = startLang ? `<${startLang}>` : "";
        const suffix = cutLang ? `</${cutLang}>` : "";
        this.emit(prefix + b.slice(start, j) + suffix);
        start = j;
        startLang = cutLang;
        lang = cutLang;
        i = j - 1;
      }
    }
    if (start > 0) {
      this.buf = b.slice(start);
      this.openLang = startLang;
    }
  }
  emit(text) {
    if (toSpeech(text)) {
      this.first = false;
      this.onChunk(text);
    }
  }
  flush() {
    if (this.buf) this.emit((this.openLang ? `<${this.openLang}>` : "") + this.buf);
    this.buf = "";
    this.openLang = null;
  }
}

// ---------- audio session helpers (iOS) ----------

// While a lesson keeps the mic open, stay in play-and-record. Switching the
// session type makes AirPods change Bluetooth mode, which costs a second or
// more each time.
let micHeld = false;

function setAudioSession(type) {
  if (micHeld && type === "playback") return;
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
    if (AC) {
      sharedCtx = new AC();
      // Bluetooth reconnects, calls, and Siri can interrupt audio. Log it and
      // try to resume so the lesson keeps going.
      sharedCtx.onstatechange = () => {
        diag(`audio: ${sharedCtx.state}`);
        if (keepAliveSrc && sharedCtx.state !== "running" && sharedCtx.state !== "closed") {
          sharedCtx.resume().catch(() => {});
        }
      };
      try {
        navigator.mediaDevices?.addEventListener?.("devicechange", () => {
          diag("audio: device changed (Bluetooth connect or disconnect)");
          if (keepAliveSrc) sharedCtx.resume().catch(() => {});
        });
      } catch {}
    }
  }
  return sharedCtx;
}

// Bluetooth earbuds and glasses power down their audio link after a moment
// of silence, which clips the first word of the next sentence. During a
// lesson, play an inaudible hiss to keep the link awake.
let keepAliveSrc = null;

export function startKeepAlive() {
  const ctx = audioCtx();
  if (!ctx || keepAliveSrc) return;
  try {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * 0.0004;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(ctx.destination);
    src.start();
    keepAliveSrc = src;
  } catch {}
}

export function stopKeepAlive() {
  try {
    keepAliveSrc?.stop();
  } catch {}
  keepAliveSrc = null;
}

// After the mic turns off, Bluetooth needs a moment to switch from call mode
// back to high-quality audio. Speech started during the switch gets clipped.
let routeSettleUntil = 0;

async function waitForRoute() {
  const wait = routeSettleUntil - performance.now();
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
}

// A short, soft two-note chime: "your turn to talk".
export function playCue() {
  const ctx = audioCtx();
  if (!ctx || ctx.state !== "running") return;
  try {
    const t = ctx.currentTime + 0.02;
    for (const [freq, at] of [
      [660, 0],
      [880, 0.11],
    ]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t + at);
      gain.gain.linearRampToValueAtTime(0.12, t + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + at);
      osc.stop(t + at + 0.14);
    }
  } catch {}
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// iOS can pause the audio engine for a moment when the mic turns off or a
// Bluetooth device changes mode. Try a few times before giving up on it.
async function ensureRunning(ctx) {
  for (let i = 0; i < 4 && ctx.state !== "running"; i++) {
    try {
      await ctx.resume();
    } catch {}
    if (ctx.state !== "running") await sleep(150);
  }
  if (ctx.state !== "running") diag(`audio: engine stuck in "${ctx.state}", using the backup player`);
  return ctx.state === "running";
}

// 16-bit WAV, which Safari's regular audio player can always play.
function wavBlob(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
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
    if (engine === "kokoro" || s.ttsProvider === "kokoro") diag(`say: engine=${engine} voiceState=${kState} downloaded=${downloaded}`);
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
              diag(`falling back to iPhone voice: ${err.message}`);
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
      if (s.ttsProvider === "openai") {
        diag(`voice: sentence queued (${spoken.length} chars): "${spoken.slice(0, 28)}"`);
        // Start downloading now; play the audio as it streams in.
        const stream = openaiPcmStream(spoken, s);
        this.queue.push(Promise.resolve(() => this.playOpenAI(spoken, s, gen, stream)));
        this.run();
        return;
      }
      const fetcher = fetchEleven(spoken, s);
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
      // Bluetooth plays audio a few hundred milliseconds behind the phone.
      // Before saying we're done (and opening the mic), let the last words
      // actually reach the listener's ears.
      if (!this.queue.length && gen === this.gen) {
        const ctx = sharedCtx;
        const latency = ((ctx?.outputLatency || 0) + (ctx?.baseLatency || 0)) * 1000;
        await sleep(Math.min(1800, latency + (this.getSettings().audioMode === "fast" ? 300 : 900)));
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

  // Plays one OpenAI sentence. If the connection drops partway, request the
  // sentence again and replay it rather than leaving it unfinished.
  async playOpenAI(text, s, gen, stream) {
    let st = stream;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.playPcmStream(st, gen);
      } catch (err) {
        if (attempt === 1 || gen !== this.gen) throw err;
      }
      if (!st.error || gen !== this.gen) return;
      if (attempt === 0) {
        diag(`voice: connection dropped (${st.error.message}), replaying the sentence`);
        st = openaiPcmStream(text, s);
      }
    }
  }

  // Plays audio that is still downloading: schedules each piece on the Web
  // Audio clock as it arrives, so speech starts within a fraction of a second.
  async playPcmStream(st, gen) {
    if (gen !== this.gen) return;
    const ctx = audioCtx();
    if (!ctx) throw new Error("This browser can't play streamed audio.");
    setAudioSession("playback");
    if (!(await ensureRunning(ctx))) {
      // Backup: wait for the whole sentence, then use the regular player.
      while (!st.done) await new Promise((res) => (st.notify = res));
      if (st.error && !st.chunks.length) throw st.error;
      const all = st.chunks.splice(0);
      const n = all.reduce((a, p) => a + p.length, 0);
      const joined = new Float32Array(n);
      let o = 0;
      for (const p of all) {
        joined.set(p, o);
        o += p.length;
      }
      if (n) await this.playBlob(wavBlob(joined, st.rate), { speechRate: 1 }, gen);
      return;
    }
    await waitForRoute();

    const sources = [];
    let stopped = false;
    let t = 0;
    let started = false;
    let last = null;
    this.finishCurrent = () => {
      stopped = true;
      sources.forEach((src) => {
        try {
          src.stop();
        } catch {}
      });
      st.wake();
    };
    const take = () => {
      const parts = st.chunks.splice(0);
      const n = parts.reduce((a, p) => a + p.length, 0);
      const out = new Float32Array(n);
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    };
    const buffered = () => st.chunks.reduce((a, p) => a + p.length, 0);

    while (!stopped && gen === this.gen) {
      // Buffer a quarter second before starting so the first words don't stutter.
      const ready = started ? buffered() > 0 : buffered() >= st.rate * st.prebuffer || (st.done && buffered() > 0);
      if (ready) {
        const data = take();
        const buf = ctx.createBuffer(1, data.length, st.rate);
        buf.copyToChannel(data, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        if (started && t < ctx.currentTime) diag("voice: audio arrived late (slow connection), short gap");
        t = Math.max(t, ctx.currentTime + 0.03);
        src.start(t);
        if (!started) {
          started = true;
          st.onFirstPlay?.();
        }
        t += buf.duration;
        sources.push(src);
        last = src;
        continue;
      }
      if (st.done) break;
      await new Promise((res) => (st.notify = res));
    }
    if (st.error && !started) throw st.error;
    if (!stopped && last) {
      const remaining = t - ctx.currentTime;
      if (remaining > 0) {
        await new Promise((res) => {
          const timer = setTimeout(res, remaining * 1000 + 50);
          this.finishCurrent = () => {
            clearTimeout(timer);
            sources.forEach((src) => {
              try {
                src.stop();
              } catch {}
            });
            res();
          };
        });
      }
    }
    this.finishCurrent = null;
  }

  // Plays raw samples through Web Audio (used by the natural voice).
  async playPcm({ samples, rate }, gen) {
    if (gen !== this.gen || !samples?.length) return;
    const ctx = audioCtx();
    if (!ctx) throw new Error("This browser can't play generated audio.");
    setAudioSession("playback");
    diag(`play: ${(samples.length / rate).toFixed(1)}s, audio state=${ctx.state}`);
    if (!(await ensureRunning(ctx))) {
      return this.playBlob(wavBlob(samples instanceof Float32Array ? samples : Float32Array.from(samples), rate), { speechRate: 1 }, gen);
    }
    await waitForRoute();
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
      src.onended = () => {
        diag("play: finished");
        done();
      };
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

function paceInstruction(rate) {
  if (!rate || rate === 1) return "";
  if (rate <= 0.75) return " Speak slowly, at about 70% of a normal pace, with clear pauses between phrases.";
  if (rate < 1) return " Speak a little slower than normal, very clearly.";
  return " Speak a little faster than normal.";
}

// Requests raw 24 kHz 16-bit PCM from OpenAI and exposes it as it streams.
// Returns a state object the player reads from: { chunks, done, error }.
function openaiPcmStream(text, s) {
  // Smooth mode buffers half a second before speaking so a slow connection
  // doesn't make the voice stutter.
  const st = { chunks: [], rate: 24000, prebuffer: s.audioMode === "fast" ? 0.25 : 0.5, done: false, error: null, notify: null };
  st.wake = () => {
    const n = st.notify;
    st.notify = null;
    n?.();
  };
  const t0 = performance.now();
  st.onFirstPlay = () => diag(`voice: first sound ${((performance.now() - t0) / 1000).toFixed(1)}s after request`);
  (async () => {
    try {
      if (!s.openaiKey) throw new Error("Add an OpenAI API key in Settings, or switch the voice to iPhone voices.");
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${s.openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          voice: s.openaiVoice || "marin",
          input: text,
          instructions: OPENAI_STYLE + paceInstruction(s.speechRate),
          response_format: "pcm",
        }),
      });
      if (!res.ok) throw new Error(`OpenAI voice error (${res.status}): ${await safeText(res)}`);
      const reader = res.body.getReader();
      let carry = null;
      for (;;) {
        let timer;
        const stall = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("no audio for 8 seconds")), 8000);
        });
        let result;
        try {
          result = await Promise.race([reader.read(), stall]);
        } catch (err) {
          reader.cancel().catch(() => {});
          throw err;
        } finally {
          clearTimeout(timer);
        }
        const { value, done } = result;
        if (done) break;
        let bytes = value;
        if (carry) {
          const merged = new Uint8Array(carry.length + bytes.length);
          merged.set(carry);
          merged.set(bytes, carry.length);
          bytes = merged;
          carry = null;
        }
        if (bytes.length % 2) {
          carry = bytes.slice(bytes.length - 1);
          bytes = bytes.slice(0, bytes.length - 1);
        }
        if (!bytes.length) continue;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const out = new Float32Array(bytes.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
        st.chunks.push(out);
        st.wake();
      }
    } catch (err) {
      st.error = err;
      diag(`voice: OpenAI error: ${err.message}`);
    }
    st.done = true;
    st.wake();
  })();
  return st;
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
    this.onReady = null; // mic is live: the learner can start talking
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

  // Turn the mic fully off (when leaving a lesson).
  releaseMic() {
    this.heldStream?.getTracks().forEach((t) => t.stop());
    this.heldStream = null;
    micHeld = false;
    setAudioSession("playback");
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
      rec.onstart = () => this.onReady?.();
      rec.start();
    });
  }

  async listenOpenAI(s, lang, prompt) {
    this.prime();
    setAudioSession("play-and-record");
    let stream = this.heldStream?.getAudioTracks().some((t) => t.readyState === "live") ? this.heldStream : null;
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        throw new Error("Microphone access was denied. Allow it in Settings > Safari > Microphone (or for this app).");
      }
    }
    const keep = s.audioMode === "fast";
    if (keep) {
      this.heldStream = stream;
      micHeld = true;
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

    // Recording starts right away, so nothing you say early is lost, but
    // Bluetooth mics (glasses, earbuds) take a moment to switch into call mode
    // and send silence or a pop meanwhile. Wait until the mic is live before
    // judging speech, then cue the learner.
    rec.start(250);
    const started = performance.now();
    const minWarmup = keep ? 100 : 500;
    let readyAt = 0;
    let heardSpeech = false;
    let loudRun = 0;
    let speechMs = 0;
    let lastLoud = performance.now();
    let noise = 0;
    const data = analyser ? new Float32Array(analyser.fftSize) : null;
    const patience = Math.max(800, s.silenceMs || 2000);
    const markReady = (now) => {
      readyAt = now;
      lastLoud = now;
      diag(`listen: mic ready after ${((now - started) / 1000).toFixed(1)}s`);
      this.onReady?.();
    };
    if (!analyser) markReady(started);
    const timer = setInterval(() => {
      const now = performance.now();
      if (now - started > 120000) return finishRec();
      if (!analyser) return;
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      this.onLevel?.(Math.min(1, rms * 25));
      if (!readyAt) {
        // Live once the mic sends real signal (or after 3 seconds regardless).
        if ((rms > 0.00003 && now - started > minWarmup) || now - started > 3000) {
          noise = rms;
          markReady(now);
        }
        return;
      }
      // Adaptive noise floor: follows the quiet background, not speech. Glasses
      // and earbud mics are quiet, so the speech threshold stays low.
      const threshold = Math.max(0.004, noise * 3);
      if (rms > threshold) {
        loudRun += 60;
        if (loudRun >= 180) {
          if (!heardSpeech) diag("listen: heard you start talking");
          heardSpeech = true;
        }
        if (heardSpeech) speechMs += 60;
        lastLoud = now;
      } else {
        loudRun = 0;
        noise = noise ? noise * 0.97 + rms * 0.03 : rms;
      }
      if (!s.handsFree) return;
      // Give longer answers more room to pause and think.
      const pause = patience + Math.min(1500, speechMs / 10);
      if (heardSpeech && now - lastLoud > pause) finishRec();
      // Nothing detected for 30 seconds: stop, but still transcribe in case
      // the voice was too quiet to detect.
      if (!heardSpeech && now - readyAt > 30000) finishRec();
    }, 60);

    await stopped;
    clearInterval(timer);
    if (!cancelled) this.onRecorded?.();
    this.onLevel?.(0);
    if (!keep) {
      stream.getTracks().forEach((t) => t.stop());
      routeSettleUntil = performance.now() + 900;
    }
    try {
      source?.disconnect();
    } catch {}
    this.active = null;
    setAudioSession("playback");
    const endedAt = performance.now();

    if (cancelled || !chunks.length) return "";
    const type = rec.mimeType || mime || "audio/webm";
    const blob = new Blob(chunks, { type });
    if (blob.size < 2000) return "";
    const text = await transcribeOpenAI(blob, type, s, lang, prompt);
    diag(`listen: transcribed in ${((performance.now() - endedAt) / 1000).toFixed(1)}s`);
    return text;
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
