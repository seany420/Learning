import { TRACKS, findLesson, lessonCount } from "./curriculum.js";
import { buildSystemPrompt, SUMMARY_REQUEST } from "./prompts.js";
import * as store from "./store.js";
import { streamTurn, summarize, textOf } from "./tutor.js";
import {
  Speaker,
  Listener,
  Chunker,
  toDisplayHtml,
  toSpeech,
  escapeHtml,
  deviceVoices,
  deviceSttAvailable,
} from "./voice.js";
import { KOKORO_VOICES, loadKokoro, kokoroState, onKokoroState } from "./kokoro.js";

const $app = document.getElementById("app");
const speaker = new Speaker(store.getSettings);
const listener = new Listener(store.getSettings);
const KICKOFF = "(The learner just opened this session. Begin.)";
const RESUME = "(The learner is back after a break. Welcome them back in one sentence and pick up where you left off.)";

let session = null; // active lesson controller
let saveTimer = null;

// ---------- routing ----------

function route() {
  if (session) session.leave();
  const hash = location.hash.replace(/^#\/?/, "");
  const [view, a, b] = hash.split("/");
  window.scrollTo(0, 0);
  if (view === "track" && TRACKS[a]) return renderTrack(a);
  if (view === "lesson" && TRACKS[a]) return renderSession(a, b || null);
  if (view === "settings") return renderSettings();
  if (view === "notes" && TRACKS[a]) return renderNotes(a);
  renderHome();
}

window.addEventListener("hashchange", route);

function go(hash) {
  location.hash = hash;
}

// ---------- home ----------

function nextLesson(trackId) {
  const { done } = store.getProgress(trackId);
  for (const [ui, unit] of TRACKS[trackId].units.entries()) {
    for (const lesson of unit.lessons) if (!done[lesson.id]) return { lesson, unit, ui };
  }
  return null;
}

function renderHome() {
  const s = store.getSettings();
  const needsKey = !s.anthropicKey;
  const cards = Object.values(TRACKS)
    .map((t) => {
      const total = lessonCount(t.id);
      const done = Object.keys(store.getProgress(t.id).done).length;
      const next = nextLesson(t.id);
      const pct = Math.round((done / total) * 100);
      return `
      <a class="card track-card" data-accent="${t.id}" href="#/track/${t.id}">
        <div class="card-top">
          <span class="eyebrow">${t.group}</span>
          <span class="count">${done}/${total}</span>
        </div>
        <h2>${t.name}</h2>
        <p class="muted">${t.blurb}</p>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <p class="next">${next ? `Next: ${escapeHtml(next.lesson.title)}` : "Course complete"}</p>
      </a>`;
    })
    .join("");
  $app.innerHTML = `
    <header class="topbar">
      <h1 class="brand">Learning</h1>
      <a class="icon-btn" href="#/settings" aria-label="Settings">${ICONS.gear}</a>
    </header>
    <main class="page">
      ${
        needsKey
          ? `<a class="banner" href="#/settings"><strong>Set up first.</strong> Add your Anthropic key (and an OpenAI key for the natural voice) in Settings.</a>`
          : ""
      }
      <div class="grid">${cards}</div>
    </main>`;
}

// ---------- track ----------

function renderTrack(trackId) {
  const t = TRACKS[trackId];
  const { done } = store.getProgress(trackId);
  const next = nextLesson(trackId);
  const units = t.units
    .map((u, ui) => {
      const doneCount = u.lessons.filter((l) => done[l.id]).length;
      const open = next ? next.ui === ui : ui === 0;
      const lessons = u.lessons
        .map((l) => {
          const saved = store.getSession(l.id);
          const state = done[l.id] ? "done" : saved?.messages?.length ? "inprogress" : "";
          return `
          <li>
            <a class="lesson ${state}" href="#/lesson/${trackId}/${l.id}">
              <span class="tick">${done[l.id] ? ICONS.check : saved?.messages?.length ? ICONS.dot : ""}</span>
              <span class="lesson-text">
                <span class="lesson-title">${escapeHtml(l.title)}</span>
                <span class="lesson-focus">${escapeHtml(l.focus)}</span>
              </span>
            </a>
          </li>`;
        })
        .join("");
      return `
      <details class="unit" ${open ? "open" : ""}>
        <summary>
          <span class="unit-num">Unit ${ui + 1}</span>
          <span class="unit-title">${escapeHtml(u.title)}</span>
          <span class="count">${doneCount}/${u.lessons.length}</span>
        </summary>
        <ol class="lessons">${lessons}</ol>
      </details>`;
    })
    .join("");
  $app.innerHTML = `
    <header class="topbar" data-accent="${trackId}">
      <a class="icon-btn" href="#/" aria-label="Back">${ICONS.back}</a>
      <h1>${t.name}</h1>
      <a class="icon-btn" href="#/notes/${trackId}" aria-label="Tutor notes">${ICONS.notes}</a>
    </header>
    <main class="page" data-accent="${trackId}">
      <div class="actions">
        ${
          next
            ? `<a class="btn primary" href="#/lesson/${trackId}/${next.lesson.id}">${ICONS.play} ${
                store.getSession(next.lesson.id)?.messages?.length ? "Resume" : "Start"
              }: ${escapeHtml(next.lesson.title)}</a>`
            : ""
        }
        <a class="btn" href="#/lesson/${trackId}/free">${ICONS.chat} Free conversation</a>
      </div>
      ${units}
    </main>`;
}

function renderNotes(trackId) {
  const t = TRACKS[trackId];
  const notes = store.getProgress(trackId).notes.slice().reverse();
  $app.innerHTML = `
    <header class="topbar" data-accent="${trackId}">
      <a class="icon-btn" href="#/track/${trackId}" aria-label="Back">${ICONS.back}</a>
      <h1>Tutor notes</h1>
      <span class="icon-btn"></span>
    </header>
    <main class="page">
      <p class="muted">What the ${escapeHtml(t.name)} tutor remembers about you. These notes are written at the end of each lesson and reused to review and personalize later sessions.</p>
      ${
        notes.length
          ? notes
              .map(
                (n) => `<div class="card note"><div class="eyebrow">${n.date} · ${
                  n.lessonId ? escapeHtml(findLesson(trackId, n.lessonId)?.lesson.title || n.lessonId) : "Free conversation"
                }</div><p>${escapeHtml(n.text).replace(/\n/g, "<br>")}</p></div>`
              )
              .join("")
          : `<p class="muted">No notes yet. Finish a lesson with "End lesson" and the tutor will write some.</p>`
      }
    </main>`;
}

// ---------- session ----------

function renderSession(trackId, lessonId) {
  const track = TRACKS[trackId];
  const isFree = !lessonId || lessonId === "free";
  const found = isFree ? null : findLesson(trackId, lessonId);
  if (!isFree && !found) return go(`#/track/${trackId}`);
  const key = isFree ? `free-${trackId}` : lessonId;
  const title = isFree ? "Free conversation" : found.lesson.title;
  const unitIndex = isFree ? null : track.units.indexOf(found.unit);
  const s = store.getSettings();

  $app.innerHTML = `
    <div class="session" data-accent="${trackId}">
      <header class="topbar">
        <a class="icon-btn" href="#/track/${trackId}" aria-label="Back">${ICONS.back}</a>
        <div class="session-title">
          <span class="eyebrow">${isFree ? track.name : `Unit ${unitIndex + 1} · ${escapeHtml(found.unit.title)}`}</span>
          <h1>${escapeHtml(title)}</h1>
        </div>
        <button class="icon-btn" id="menu-btn" aria-label="Lesson options">${ICONS.more}</button>
      </header>
      <div class="menu" id="menu" hidden>
        <button id="end-btn">${ICONS.check} End lesson and save notes</button>
        <button id="restart-btn">${ICONS.restart} Restart this lesson</button>
      </div>
      <div class="transcript" id="transcript" aria-live="polite"></div>
      <div class="dock">
        <div class="status" id="status">Tap the mic to begin</div>
        <div class="interim" id="interim"></div>
        <div class="controls">
          <button class="chip" id="kbd-btn" aria-label="Type instead">${ICONS.keyboard}</button>
          <button class="mic" id="mic" aria-label="Talk">
            <span class="ring" id="ring"></span>
            <span class="mic-icon" id="mic-icon">${ICONS.mic}</span>
          </button>
          <button class="chip" id="replay-btn" aria-label="Replay last answer">${ICONS.replay}</button>
        </div>
        <div class="chips">
          <button class="chip small ${s.handsFree ? "on" : ""}" id="hf-btn">Hands-free</button>
          ${track.group === "Language" ? `<button class="chip small" id="lang-btn"></button>` : ""}
          <button class="chip small" id="rate-btn"></button>
        </div>
        <form class="typebox" id="typebox" hidden>
          <input id="typed" autocomplete="off" placeholder="Type a message" enterkeyhint="send" />
          <button class="btn primary" type="submit">Send</button>
        </form>
      </div>
    </div>`;

  session = new SessionController({ track, trackId, lesson: found?.lesson, unit: found?.unit, unitIndex, key, isFree });
}

class SessionController {
  constructor(opts) {
    Object.assign(this, opts);
    this.state = "idle";
    this.abort = null;
    this.alive = true;
    this.wakeLock = null;
    const saved = store.getSession(this.key);
    this.data = saved?.messages ? saved : { messages: [], hidden: [] };
    this.micLang = "auto";
    this.$t = document.getElementById("transcript");
    this.$status = document.getElementById("status");
    this.$interim = document.getElementById("interim");
    this.$mic = document.getElementById("mic");
    this.$ring = document.getElementById("ring");
    this.bind();
    this.renderTranscript();
    this.updateChips();
    if (this.data.messages.length) this.setStatus("Tap the mic to continue");
    else this.setStatus("Tap the mic to start the lesson");
  }

  get system() {
    const s = store.getSettings();
    return buildSystemPrompt({
      track: this.track,
      lesson: this.lesson,
      unit: this.unit,
      unitIndex: this.unitIndex,
      notes: store.notesText(this.trackId),
      learnerName: s.learnerName,
    });
  }

  bind() {
    this.$mic.addEventListener("click", () => this.onMic());
    document.getElementById("replay-btn").onclick = () => this.replay();
    document.getElementById("kbd-btn").onclick = () => {
      const box = document.getElementById("typebox");
      box.hidden = !box.hidden;
      if (!box.hidden) document.getElementById("typed").focus();
    };
    document.getElementById("typebox").onsubmit = (e) => {
      e.preventDefault();
      const input = document.getElementById("typed");
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      this.prime();
      this.interruptOutput();
      if (listener.listening) listener.cancel();
      this.sendUser(text);
    };
    document.getElementById("hf-btn").onclick = (e) => {
      const s = store.saveSettings({ handsFree: !store.getSettings().handsFree });
      e.currentTarget.classList.toggle("on", s.handsFree);
    };
    const langBtn = document.getElementById("lang-btn");
    if (langBtn) {
      langBtn.onclick = () => {
        const order = ["auto", "en", this.track.lang];
        this.micLang = order[(order.indexOf(this.micLang) + 1) % order.length];
        this.updateChips();
      };
    }
    document.getElementById("rate-btn").onclick = () => {
      const rates = [1, 0.85, 0.7, 1.15];
      const cur = store.getSettings().speechRate || 1;
      const next = rates[(rates.indexOf(cur) + 1) % rates.length] || 1;
      store.saveSettings({ speechRate: next });
      this.updateChips();
    };
    const menu = document.getElementById("menu");
    document.getElementById("menu-btn").onclick = () => (menu.hidden = !menu.hidden);
    document.getElementById("end-btn").onclick = () => {
      menu.hidden = true;
      this.end();
    };
    document.getElementById("restart-btn").onclick = () => {
      menu.hidden = true;
      if (!confirm("Clear this lesson's conversation and start over?")) return;
      this.stopAll();
      store.clearSession(this.key);
      this.data = { messages: [], hidden: [] };
      this.renderTranscript();
      this.setStatus("Tap the mic to start the lesson");
    };

    speaker.onStateChange = (speaking) => {
      if (!this.alive) return;
      if (speaking) this.setState("speaking");
      else if (this.state === "speaking") this.setState(this.abort ? "thinking" : "idle");
    };
    speaker.onError = (err) => this.showError(err.message);
    listener.onLevel = (lvl) => this.$ring.style.setProperty("--lvl", lvl.toFixed(2));
    listener.onInterim = (t) => (this.$interim.textContent = t);
    listener.onRecorded = () => this.alive && this.setState("transcribing");

    this.unsubKokoro = onKokoroState((st) => {
      if (!this.alive || st.status !== "loading") return;
      if (this.state === "thinking" || this.state === "speaking") {
        this.setStatus(`Loading the natural voice (first time only)… ${st.progress}%`);
      }
    });

    this.onVisibility = () => {
      if (document.visibilityState === "visible" && this.state !== "idle") this.requestWakeLock();
    };
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  updateChips() {
    const s = store.getSettings();
    const langBtn = document.getElementById("lang-btn");
    if (langBtn) {
      const label = { auto: "Mic: auto", en: "Mic: English", es: "Mic: Español", ja: "Mic: 日本語" }[this.micLang];
      const deviceNoAuto = (s.sttProvider === "device" || !s.openaiKey) && this.micLang === "auto";
      langBtn.textContent = deviceNoAuto ? "Mic: English" : label;
    }
    document.getElementById("rate-btn").textContent = `Voice ${s.speechRate || 1}x`;
  }

  prime() {
    speaker.unlock();
    listener.prime();
    this.requestWakeLock();
  }

  async requestWakeLock() {
    try {
      if ("wakeLock" in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => (this.wakeLock = null));
      }
    } catch {}
  }

  setState(state) {
    this.state = state;
    this.$mic.dataset.state = state;
    const labels = {
      idle: "Tap the mic to talk",
      listening: store.getSettings().handsFree ? "Listening… pause when you're done" : "Listening… tap when you're done",
      transcribing: "Got it…",
      thinking: "Thinking…",
      speaking: "Speaking… tap to interrupt",
      saving: "Writing lesson notes…",
    };
    this.setStatus(labels[state] || "");
    document.getElementById("mic-icon").innerHTML = state === "listening" ? ICONS.stop : state === "speaking" ? ICONS.hand : ICONS.mic;
  }

  setStatus(text) {
    this.$status.textContent = text;
    this.$status.classList.remove("error");
  }

  showError(msg) {
    this.$status.textContent = msg;
    this.$status.classList.add("error");
  }

  // ----- transcript -----

  renderTranscript() {
    this.$t.innerHTML = "";
    this.data.messages.forEach((m, i) => {
      if (this.data.hidden.includes(i)) return;
      const text = textOf(m.content);
      if (text.trim()) this.addBubble(m.role, text);
    });
    if (!this.data.messages.length) {
      const intro = this.lesson
        ? `<div class="intro"><p class="eyebrow">Today</p><p>${escapeHtml(this.lesson.focus)}</p></div>`
        : `<div class="intro"><p>Talk about anything. The tutor will follow your lead and keep teaching as you go.</p></div>`;
      this.$t.innerHTML = intro;
    }
    this.scroll();
  }

  addBubble(role, text) {
    this.$t.querySelector(".intro")?.remove();
    const el = document.createElement("div");
    el.className = `bubble ${role === "user" ? "me" : "tutor"}`;
    el.innerHTML = role === "user" ? escapeHtml(text) : toDisplayHtml(text);
    this.$t.appendChild(el);
    this.scroll();
    return el;
  }

  scroll() {
    requestAnimationFrame(() => (this.$t.scrollTop = this.$t.scrollHeight));
  }

  persist() {
    clearTimeout(saveTimer);
    store.saveSession(this.key, this.data);
  }

  // ----- turn-taking -----

  onMic() {
    this.prime();
    if (this.state === "listening") return listener.stop();
    if (this.state === "transcribing" || this.state === "saving") return;
    if (this.state === "thinking" || this.state === "speaking") {
      this.interruptOutput();
      return this.listen();
    }
    if (!this.data.messages.length) return this.tutorTurn(KICKOFF);
    const last = this.data.messages[this.data.messages.length - 1];
    const stale = Date.now() - (this.data.updated || 0) > 10 * 60 * 1000;
    if (last.role === "user" || (this.resumed !== true && stale)) {
      this.resumed = true;
      return this.tutorTurn(RESUME);
    }
    this.resumed = true;
    this.listen();
  }

  interruptOutput() {
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
      // Keep what the tutor already said so the history stays truthful.
      const raw = this.pending?.raw.trim();
      if (raw) {
        this.data.messages.push({ role: "assistant", content: [{ type: "text", text: raw + " …" }] });
        this.persist();
      } else this.pending?.bubble.remove();
      this.pending = null;
    }
    speaker.stop();
  }

  stopAll() {
    this.interruptOutput();
    if (listener.listening) listener.cancel();
    this.setState("idle");
  }

  sttPrompt() {
    const last = [...this.data.messages].reverse().find((m) => m.role === "assistant");
    const context = last ? toSpeech(textOf(last.content)).slice(-300) : "";
    const who =
      this.track.group === "Language"
        ? `An English speaker learning ${this.track.name}, mixing English and ${this.track.name}. Transcribe exactly what is said in the language it's said in, keeping any mistakes.`
        : this.track.id === "clinical"
          ? "A clinical social worker discussing behavioral health cases and terminology."
          : "A learner discussing Irish history, with Irish place and personal names.";
    return `${who} ${context}`.slice(0, 900);
  }

  async listen() {
    if (!this.alive || listener.listening) return;
    this.setState("listening");
    this.$interim.textContent = "";
    let text = "";
    try {
      const lang = this.micLang;
      const p = listener.listen({ lang, prompt: this.sttPrompt() });
      // OpenAI path: the recording ends, then transcription runs.
      text = await p;
    } catch (err) {
      if (!this.alive) return;
      this.setState("idle");
      return this.showError(err.message);
    }
    if (!this.alive) return;
    this.$interim.textContent = "";
    if (!text) {
      this.setState("idle");
      return this.setStatus("Didn't catch anything. Tap the mic to talk.");
    }
    this.sendUser(text);
  }

  sendUser(text) {
    this.addBubble("user", text);
    this.tutorTurn(text, { shown: true });
  }

  async tutorTurn(userText, { shown = false } = {}) {
    if (!this.alive) return;
    const s = store.getSettings();
    this.data.messages.push({ role: "user", content: userText });
    if (!shown) this.data.hidden.push(this.data.messages.length - 1);
    this.data.updated = Date.now();
    this.persist();

    this.setState("thinking");
    speaker.resetTranscript();
    const bubble = this.addBubble("assistant", "");
    bubble.classList.add("pending");
    let raw = "";
    const pending = { raw: "", bubble };
    this.pending = pending;
    const chunker = new Chunker((chunk) => speaker.say(chunk));
    const abort = new AbortController();
    this.abort = abort;
    let message;
    try {
      message = await streamTurn({
        settings: s,
        system: this.system,
        messages: this.data.messages,
        signal: abort.signal,
        onText: (delta) => {
          raw += delta;
          pending.raw = raw;
          bubble.classList.remove("pending");
          bubble.innerHTML = toDisplayHtml(raw);
          chunker.push(delta);
          this.scroll();
        },
      });
      chunker.flush();
    } catch (err) {
      bubble.classList.remove("pending");
      // Interrupted: interruptOutput() already recorded the partial reply.
      if (abort.signal.aborted) return;
      if (this.abort === abort) this.abort = null;
      if (this.pending === pending) this.pending = null;
      if (!raw) bubble.remove();
      if (this.alive) {
        this.setState("idle");
        this.showError(err.message);
      }
      return;
    }
    if (abort.signal.aborted) return;
    if (this.abort === abort) this.abort = null;
    if (this.pending === pending) this.pending = null;
    bubble.classList.remove("pending");
    if (!raw.trim()) bubble.remove();
    this.data.messages.push({ role: "assistant", content: message.content });
    this.data.updated = Date.now();
    this.persist();
    if (!this.alive) return;

    if (this.state === "thinking" && !speaker.speaking) this.setState("idle");
    await speaker.whenIdle();
    if (!this.alive || this.abort) return;
    if (this.state === "listening") return;
    if (store.getSettings().handsFree) this.listen();
    else this.setState("idle");
  }

  replay() {
    this.prime();
    const last = [...this.data.messages].reverse().find((m) => m.role === "assistant");
    if (!last) return;
    this.interruptOutput();
    if (listener.listening) listener.cancel();
    speaker.say(textOf(last.content));
  }

  async end() {
    const userTurns = this.data.messages.filter((m, i) => m.role === "user" && !this.data.hidden.includes(i)).length;
    this.stopAll();
    if (!userTurns) {
      if (this.lesson && confirm("You haven't spoken in this lesson yet. Mark it complete anyway?")) {
        store.markDone(this.trackId, this.lesson.id);
        store.clearSession(this.key);
      }
      return go(`#/track/${this.trackId}`);
    }
    this.setState("saving");
    try {
      const s = store.getSettings();
      const notes = await summarize({
        settings: s,
        system: this.system,
        messages: [...this.data.messages, { role: "user", content: SUMMARY_REQUEST }],
      });
      if (notes) store.addNote(this.trackId, this.lesson?.id || null, notes);
    } catch (err) {
      if (!confirm(`Couldn't write notes (${err.message}). End the lesson anyway?`)) {
        this.setState("idle");
        return;
      }
    }
    if (this.lesson) store.markDone(this.trackId, this.lesson.id);
    store.clearSession(this.key);
    go(`#/track/${this.trackId}`);
  }

  leave() {
    this.alive = false;
    this.interruptOutput();
    if (listener.listening) listener.cancel();
    if (this.data.messages.length) store.saveSession(this.key, this.data);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.unsubKokoro?.();
    try {
      this.wakeLock?.release();
    } catch {}
    speaker.onStateChange = null;
    listener.onLevel = listener.onInterim = listener.onRecorded = null;
    session = null;
  }
}

// ---------- settings ----------

function voiceRank(v) {
  const id = `${v.name} ${v.voiceURI}`.toLowerCase();
  if (id.includes("premium")) return 2;
  if (id.includes("enhanced") || id.includes("neural")) return 1;
  return 0;
}

function voiceLabel(v) {
  const tier = ["", " · Enhanced", " · Premium"][voiceRank(v)];
  const name = /\((premium|enhanced)\)/i.test(v.name) ? v.name : v.name + tier;
  return `${name} (${v.lang})`;
}

const OPENAI_VOICES = ["marin", "cedar", "coral", "sage", "ballad", "verse", "ash", "alloy", "echo", "shimmer", "nova", "onyx", "fable"];

function renderSettings() {
  const s = store.getSettings();
  const opt = (v, cur, label = v) => `<option value="${escapeHtml(v)}" ${v === cur ? "selected" : ""}>${escapeHtml(label)}</option>`;
  $app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Back">${ICONS.back}</a>
      <h1>Settings</h1>
      <span class="icon-btn"></span>
    </header>
    <main class="page settings">
      <form id="settings-form">
        <section class="card">
          <h2>You</h2>
          <label>Your first name (optional)
            <input name="learnerName" value="${escapeHtml(s.learnerName)}" autocomplete="given-name" />
          </label>
        </section>

        <section class="card">
          <h2>Tutor brain</h2>
          <label>Anthropic API key
            <input name="anthropicKey" type="password" value="${escapeHtml(s.anthropicKey)}" placeholder="sk-ant-..." autocomplete="off" />
          </label>
          <p class="hint">Get one at console.anthropic.com. Stored only on this phone.</p>
          <label>Model
            <select name="model">
              ${opt("claude-opus-5-5", s.model, "Claude Opus 5.5 (best teaching)")}
              ${opt("claude-sonnet-5-5", s.model, "Claude Sonnet 5.5 (faster, cheaper)")}
            </select>
          </label>
          <label>Effort
            <select name="effort">
              ${opt("low", s.effort, "Low (fastest replies, good for conversation)")}
              ${opt("medium", s.effort, "Medium (deeper clinical and history answers)")}
              ${opt("high", s.effort, "High (slowest)")}
            </select>
          </label>
        </section>

        <section class="card">
          <h2>Tutor voice</h2>
          <label>Voice engine
            <select name="ttsProvider">
              ${opt("openai", s.ttsProvider, "OpenAI (natural, recommended)")}
              ${opt("elevenlabs", s.ttsProvider, "ElevenLabs (most human)")}
              ${opt("kokoro", s.ttsProvider, "Natural voice (free, runs on your phone)")}
              ${opt("device", s.ttsProvider, "iPhone voices (free, offline)")}
            </select>
          </label>
          <div data-show="openai">
            <label>OpenAI API key
              <input name="openaiKey" type="password" value="${escapeHtml(s.openaiKey)}" placeholder="sk-..." autocomplete="off" />
            </label>
            <p class="hint">Also used to understand your speech in English, Spanish, and Japanese. Get one at platform.openai.com.</p>
            <label>Voice
              <select name="openaiVoice">${OPENAI_VOICES.map((v) => opt(v, s.openaiVoice)).join("")}</select>
            </label>
          </div>
          <div data-show="elevenlabs">
            <label>ElevenLabs API key
              <input name="elevenKey" type="password" value="${escapeHtml(s.elevenKey)}" autocomplete="off" />
            </label>
            <label>Voice ID
              <input name="elevenVoiceId" value="${escapeHtml(s.elevenVoiceId)}" autocomplete="off" />
            </label>
            <p class="hint">Copy any voice ID from your ElevenLabs voice library.</p>
            <label>Model
              <select name="elevenModel">
                ${opt("eleven_multilingual_v2", s.elevenModel, "Multilingual v2 (best quality)")}
                ${opt("eleven_flash_v2_5", s.elevenModel, "Flash v2.5 (lowest delay)")}
              </select>
            </label>
          </div>
          <div data-show="kokoro">
            <p class="hint">A free, open-source voice that runs on your phone. It speaks English. Spanish and Japanese phrases use the iPhone voices below. The first time, it downloads about 90 MB (use Wi-Fi), then works without downloading again.</p>
            <label>Natural voice
              <select name="kokoroVoice">${KOKORO_VOICES.map(([id, label]) => opt(id, s.kokoroVoice, label)).join("")}</select>
            </label>
            <button type="button" class="btn" id="kokoro-load">Download voice now</button>
            <p class="hint" id="kokoro-status"></p>
          </div>
          <div data-show="device kokoro">
            <p class="hint">For much better iPhone voices, download Premium or Enhanced voices in iPhone Settings › Accessibility › Read &amp; Speak › Voices (on older iOS: Spoken Content › Voices). Then tap Refresh voice list.</p>
            <button type="button" class="btn" id="refresh-voices">${ICONS.replay} Refresh voice list</button>
            <p class="hint" id="voice-count"></p>
            <label>English voice <select name="dv-en"></select></label>
            <label>Spanish voice <select name="dv-es"></select></label>
            <label>Japanese voice <select name="dv-ja"></select></label>
          </div>
          <label>Speaking speed
            <select name="speechRate">
              ${[0.7, 0.85, 1, 1.15, 1.3].map((r) => opt(String(r), String(s.speechRate), `${r}x`)).join("")}
            </select>
          </label>
          <button type="button" class="btn" id="test-voice">${ICONS.play} Test voice</button>
        </section>

        <section class="card">
          <h2>Listening</h2>
          <label>Speech recognition
            <select name="sttProvider">
              ${opt("openai", s.sttProvider, "OpenAI (best for mixed languages)")}
              ${opt("device", s.sttProvider, "iPhone dictation (free)")}
            </select>
          </label>
          ${
            deviceSttAvailable()
              ? ""
              : `<p class="hint">iPhone dictation isn't available in this mode on this device, so OpenAI is used.</p>`
          }
          <label class="row">
            <input type="checkbox" name="handsFree" ${s.handsFree ? "checked" : ""} />
            Hands-free: start listening automatically after the tutor speaks
          </label>
          <label>Pause before your turn ends
            <select name="silenceMs">
              ${[1000, 1300, 1600, 2200, 3000].map((m) => opt(String(m), String(s.silenceMs), `${m / 1000} seconds`)).join("")}
            </select>
          </label>
          <p class="hint">Longer pauses help when you're thinking in Spanish or Japanese. You can always tap the mic to finish.</p>
        </section>

        <section class="card">
          <h2>Backup</h2>
          <p class="hint">Progress and tutor notes live on this phone. Back them up now and then. Keys are never included.</p>
          <div class="actions">
            <button type="button" class="btn" id="export-btn">Export backup</button>
            <label class="btn file-btn">Import backup<input type="file" id="import-file" accept="application/json,.json" hidden /></label>
          </div>
        </section>
        <p class="saved" id="saved" aria-live="polite"></p>
      </form>
    </main>`;

  const form = document.getElementById("settings-form");
  const showFor = () => {
    const p = form.ttsProvider.value;
    form.querySelectorAll("[data-show]").forEach((el) => (el.hidden = !el.dataset.show.split(" ").includes(p)));
  };
  const fillVoices = () => {
    const voices = deviceVoices();
    let found = 0;
    for (const lang of ["en", "es", "ja"]) {
      const sel = form[`dv-${lang}`];
      const cur = store.getSettings().deviceVoices[lang];
      const seen = new Set();
      const list = voices
        .filter((v) => v.lang?.replace("_", "-").toLowerCase().startsWith(lang))
        .filter((v) => !seen.has(v.name + v.lang) && seen.add(v.name + v.lang))
        .sort((a, b) => voiceRank(b) - voiceRank(a) || a.name.localeCompare(b.name));
      found += list.length;
      sel.innerHTML =
        opt("", cur, "Automatic (best available)") +
        list.map((v) => opt(v.name, cur, voiceLabel(v))).join("");
    }
    const count = document.getElementById("voice-count");
    if (count) {
      const better = voices.filter((v) => voiceRank(v) > 0).length;
      count.textContent = voices.length
        ? `Found ${found} English, Spanish, and Japanese voices on this phone (${better} Premium or Enhanced).`
        : "No voices loaded yet. Tap Refresh voice list.";
    }
    return voices.length;
  };
  // iPhones load their voice list late and don't always announce it, so keep
  // checking for a few seconds after Settings opens.
  const pollVoices = () => {
    let tries = 0;
    let last = -1;
    const tick = () => {
      if (!document.getElementById("voice-count")) return;
      const n = fillVoices();
      if (++tries < 15 && (n === 0 || n !== last)) setTimeout(tick, 400);
      last = n;
    };
    tick();
  };
  pollVoices();
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = fillVoices;
  document.getElementById("refresh-voices").onclick = () => {
    // Speaking once (silently) makes Safari load the full voice list.
    speaker.unlock();
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {}
    pollVoices();
  };
  showFor();

  const save = () => {
    const f = form;
    store.saveSettings({
      learnerName: f.learnerName.value.trim(),
      anthropicKey: f.anthropicKey.value.trim(),
      model: f.model.value,
      effort: f.effort.value,
      ttsProvider: f.ttsProvider.value,
      kokoroVoice: f.kokoroVoice.value,
      openaiKey: f.openaiKey.value.trim(),
      openaiVoice: f.openaiVoice.value,
      elevenKey: f.elevenKey.value.trim(),
      elevenVoiceId: f.elevenVoiceId.value.trim(),
      elevenModel: f.elevenModel.value,
      deviceVoices: { en: f["dv-en"].value, es: f["dv-es"].value, ja: f["dv-ja"].value },
      speechRate: parseFloat(f.speechRate.value),
      sttProvider: f.sttProvider.value,
      handsFree: f.handsFree.checked,
      silenceMs: parseInt(f.silenceMs.value, 10),
    });
    const el = document.getElementById("saved");
    el.textContent = "Saved";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => (el.textContent = ""), 1200);
  };
  form.addEventListener("change", () => {
    showFor();
    save();
  });
  form.addEventListener("input", (e) => {
    if (e.target.type === "password" || e.target.type === "text" || e.target.tagName === "INPUT") save();
  });
  form.addEventListener("submit", (e) => e.preventDefault());

  const kStatus = document.getElementById("kokoro-status");
  const kButton = document.getElementById("kokoro-load");
  const showKokoro = (st) => {
    if (!document.body.contains(kStatus)) return unsubKokoro();
    kStatus.textContent = {
      idle: "Not downloaded yet.",
      loading: `Downloading and starting the voice… ${st.progress}%`,
      ready: "Ready. The voice is on your phone.",
      error: `Couldn't load the voice: ${st.error}`,
    }[st.status];
    kButton.hidden = st.status === "ready" || st.status === "loading";
  };
  const unsubKokoro = onKokoroState(showKokoro);
  showKokoro(kokoroState());
  kButton.onclick = () => loadKokoro().catch(() => {});

  document.getElementById("test-voice").onclick = () => {
    save();
    speaker.unlock();
    speaker.stop();
    speaker.onError = (err) => {
      const el = document.getElementById("saved");
      if (el) el.textContent = err.message;
    };
    speaker.say("Hi! This is how I'll sound in your lessons.");
    speaker.say("En español: <es>¡Hola! ¿Cómo estás hoy?</es>");
    speaker.say("And in Japanese: <ja>こんにちは。よろしくお願いします。</ja> [[konnichiwa]]");
  };

  document.getElementById("export-btn").onclick = () => {
    const blob = new Blob([store.exportBackup()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `learning-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  document.getElementById("import-file").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      store.importBackup(await file.text());
      alert("Backup restored.");
      renderSettings();
    } catch (err) {
      alert(err.message);
    }
  };
}

// ---------- icons ----------

const svg = (d, extra = "") =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;

const ICONS = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  mic: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 18v4"/>', 'width="34" height="34"'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>', 'width="30" height="30"'),
  hand: svg('<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>', 'width="32" height="32"'),
  check: svg('<path d="M20 6L9 17l-5-5"/>'),
  dot: svg('<circle cx="12" cy="12" r="4" fill="currentColor"/>'),
  play: svg('<path d="M6 4l14 8-14 8z" fill="currentColor"/>', 'width="16" height="16"'),
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', 'width="18" height="18"'),
  notes: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'),
  more: svg('<circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/>'),
  keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  replay: svg('<path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'),
  restart: svg('<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>', 'width="18" height="18"'),
};

// ---------- boot ----------

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

route();
