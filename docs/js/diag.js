// A short on-screen log of what the voice system did, for troubleshooting
// on the phone. Shown under Test voice in Settings.

const lines = [];
const listeners = new Set();
const t0 = performance.now();

export function diag(msg) {
  const t = ((performance.now() - t0) / 1000).toFixed(1);
  lines.push(`${t}s ${msg}`);
  if (lines.length > 60) lines.shift();
  listeners.forEach((fn) => fn(lines));
}

export function onDiag(fn) {
  listeners.add(fn);
  fn(lines);
  return () => listeners.delete(fn);
}

export function diagText() {
  return lines.join("\n");
}
