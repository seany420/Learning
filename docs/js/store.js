// Everything lives in this device's localStorage: keys, settings, progress,
// lesson transcripts, and the tutor's notes about the learner.

const PREFIX = "lv:";

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn("Storage write failed", key, e);
    return false;
  }
}

export const DEFAULT_SETTINGS = {
  learnerName: "",
  anthropicKey: "",
  openaiKey: "",
  elevenKey: "",
  model: "claude-opus-5-5",
  effort: "low",
  ttsProvider: "openai", // openai | elevenlabs | device
  openaiVoice: "marin",
  elevenVoiceId: "21m00Tcm4TlvDq8ikWAM",
  elevenModel: "eleven_multilingual_v2",
  deviceVoices: { en: "", es: "", ja: "" },
  speechRate: 1.0,
  sttProvider: "openai", // openai | device
  handsFree: true,
  silenceMs: 1600,
};

export function getSettings() {
  const s = { ...DEFAULT_SETTINGS, ...read("settings", {}) };
  s.deviceVoices = { ...DEFAULT_SETTINGS.deviceVoices, ...(s.deviceVoices || {}) };
  return s;
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  write("settings", next);
  return next;
}

// Progress: { [trackId]: { done: {lessonId: isoDate}, notes: [{date, lessonId, text}] } }
export function getProgress(trackId) {
  const all = read("progress", {});
  return { done: {}, notes: [], ...(all[trackId] || {}) };
}

function saveProgress(trackId, p) {
  const all = read("progress", {});
  all[trackId] = p;
  write("progress", all);
}

export function markDone(trackId, lessonId) {
  const p = getProgress(trackId);
  p.done[lessonId] = new Date().toISOString();
  saveProgress(trackId, p);
}

export function addNote(trackId, lessonId, text) {
  const p = getProgress(trackId);
  p.notes.push({ date: new Date().toISOString().slice(0, 10), lessonId, text: text.trim() });
  p.notes = p.notes.slice(-12); // keep the most recent sessions
  saveProgress(trackId, p);
}

export function notesText(trackId) {
  return getProgress(trackId)
    .notes.map((n) => `[${n.date}${n.lessonId ? " " + n.lessonId : " free talk"}] ${n.text}`)
    .join("\n");
}

// Sessions: the full API message history for an in-progress lesson, so a
// lesson can be resumed exactly where it stopped.
export function getSession(sessionKey) {
  return read("session:" + sessionKey, null);
}

export function saveSession(sessionKey, session) {
  if (!write("session:" + sessionKey, session)) {
    // Storage full: drop other saved sessions and retry once.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX + "session:") && k !== PREFIX + "session:" + sessionKey) localStorage.removeItem(k);
    }
    write("session:" + sessionKey, session);
  }
}

export function clearSession(sessionKey) {
  try {
    localStorage.removeItem(PREFIX + "session:" + sessionKey);
  } catch {}
}

export function exportBackup() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX) && !k.startsWith(PREFIX + "session:")) data[k] = localStorage.getItem(k);
  }
  const s = JSON.parse(data[PREFIX + "settings"] || "{}");
  delete s.anthropicKey;
  delete s.openaiKey;
  delete s.elevenKey;
  data[PREFIX + "settings"] = JSON.stringify(s);
  return JSON.stringify({ app: "learning-voice", version: 1, data }, null, 2);
}

export function importBackup(json) {
  const parsed = JSON.parse(json);
  if (parsed.app !== "learning-voice" || !parsed.data) throw new Error("Not a backup file from this app.");
  const keep = getSettings();
  for (const [k, v] of Object.entries(parsed.data)) {
    if (k.startsWith(PREFIX)) localStorage.setItem(k, v);
  }
  // Restore API keys from this device; backups never carry them.
  saveSettings({ anthropicKey: keep.anthropicKey, openaiKey: keep.openaiKey, elevenKey: keep.elevenKey });
}
