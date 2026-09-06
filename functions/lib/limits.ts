/** Stream limits apply while reading, not after allocating an unbounded body. */
export async function readLimited(request: Request, max: number): Promise<string> {
  if (Number(request.headers.get("content-length")) > max) throw new RangeError("body too large");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  const timer = setTimeout(() => void reader.cancel(), 10_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > max) { void reader.cancel(); throw new RangeError("body too large"); }
      text += decoder.decode(value, { stream: true });
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

export function limitedStream(source: ReadableStream<Uint8Array>, max: number, done: () => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let size = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { done(); reader.releaseLock(); controller.close(); return; }
        size += chunk.value.byteLength;
        if (size > max) {
          void reader.cancel();
          throw new Error("Upstream response exceeded size limit");
        }
        controller.enqueue(chunk.value);
      } catch (error) { done(); controller.error(error); }
    },
    cancel(reason) { done(); return reader.cancel(reason); },
  });
}
