import Anthropic from "../vendor/anthropic.js";

let client = null;
let clientKey = null;

function getClient(apiKey) {
  if (!client || clientKey !== apiKey) {
    // The key belongs to the person using this app and never leaves their
    // phone except to call Anthropic directly.
    client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
    clientKey = apiKey;
  }
  return client;
}

function baseParams(settings, system, messages) {
  return {
    model: settings.model,
    max_tokens: 16000,
    system,
    messages,
    // Sonnet 5.5 can skip thinking entirely, which makes replies start sooner.
    thinking: settings.model === "claude-sonnet-5-5" ? { type: "between_tools" } : { type: "adaptive" },
    output_config: { effort: settings.effort },
    cache_control: { type: "ephemeral" },
    // Re-run a declined request on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
}

export class TutorError extends Error {}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Your Anthropic API key was rejected. Check it in Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Your Anthropic key doesn't have access to this model.";
  if (err instanceof Anthropic.RateLimitError) return "Anthropic rate limit hit. Wait a moment and try again.";
  if (err instanceof Anthropic.BadRequestError) return `Anthropic rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic error: ${err.message}`;
  return err?.message || String(err);
}

// Streams one tutor turn. onText receives text deltas as they arrive.
// Returns the full assistant content array (thinking blocks included), which
// must be appended to history unchanged.
export async function streamTurn({ settings, system, messages, onText, signal }) {
  if (!settings.anthropicKey) throw new TutorError("Add your Anthropic API key in Settings first.");
  const api = getClient(settings.anthropicKey);
  try {
    const stream = api.beta.messages.stream(baseParams(settings, system, messages), { signal });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") onText?.(event.delta.text);
    }
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      throw new TutorError("The tutor declined to continue this turn. Try rephrasing, or start a new session.");
    }
    return message;
  } catch (err) {
    if (err instanceof TutorError || err?.name === "AbortError" || err instanceof Anthropic.APIUserAbortError) throw err;
    throw new TutorError(describeError(err));
  }
}

export async function summarize({ settings, system, messages }) {
  const api = getClient(settings.anthropicKey);
  try {
    const stream = api.beta.messages.stream(baseParams(settings, system, messages));
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") return "";
    return message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (err) {
    throw new TutorError(describeError(err));
  }
}

export function textOf(content) {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}
