/**
 * SSE keepalive — chèn `: keepalive\n\n` định kỳ khi upstream idle giữa chunks.
 * Ngăn client (Claude Code/opencode) abort "Connection lost mid-response"
 * khi free provider (openrouter/nemotron...) stall 10-20s giữa stream.
 * Pattern: responsesTransformer.ts (Codex CLI #2544) — interval tự clear khi
 * stream đóng (enqueue throw → clearInterval), timer unref để không giữ event loop.
 */
export function withSseKeepalive(
  stream: ReadableStream<Uint8Array>,
  keepaliveIntervalMs = 3000
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  return stream.pipeThrough(
    new TransformStream({
      start(controller) {
        keepaliveTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            if (keepaliveTimer) {
              clearInterval(keepaliveTimer);
              keepaliveTimer = null;
            }
          }
        }, keepaliveIntervalMs);
        (keepaliveTimer as { unref?: () => void })?.unref?.();
      },
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush() {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      },
    })
  );
}
