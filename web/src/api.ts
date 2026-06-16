import type { Review, ReviewConfig, StreamEvent } from "./types.js";

function base(backendUrl: string): string {
  return backendUrl.replace(/\/$/, "");
}

/**
 * Stream a review from the backend. Reads the streamed SSE response body and
 * invokes `onEvent` for each parsed event. Resolves when the stream ends.
 */
export async function streamReview(
  backendUrl: string,
  prUrl: string,
  config: ReviewConfig,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const res = await fetch(`${base(backendUrl)}/api/review/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prUrl, config }),
  });

  if (!res.ok || !res.body) {
    // Non-stream error path: the backend returned JSON before streaming.
    let message = `Request failed (${res.status}).`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // SSE frames are separated by a blank line. Each frame has "data: <json>".
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try {
        onEvent(JSON.parse(json) as StreamEvent);
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}

/** Post a generated review back to the PR using a user-supplied GitHub token. */
export async function postReview(
  backendUrl: string,
  params: { prUrl: string; githubToken: string; review: Review },
): Promise<{ url: string; posted: { inline: number; summaryOnly: number } }> {
  const res = await fetch(`${base(backendUrl)}/api/review/post`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}
