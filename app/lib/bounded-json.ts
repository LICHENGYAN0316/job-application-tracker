export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds the configured byte limit.');
    this.name = 'RequestBodyTooLargeError';
  }
}

export class InvalidJsonBodyError extends Error {
  constructor(cause?: unknown) {
    super('Request body is not valid JSON.', cause instanceof Error ? { cause } : undefined);
    this.name = 'InvalidJsonBodyError';
  }
}

export async function readBoundedJson(request: Request, maximumBytes: number) {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0) throw new InvalidJsonBodyError();
    if (contentLength > maximumBytes) throw new RequestBodyTooLargeError();
  }

  if (!request.body) throw new InvalidJsonBodyError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    throw new InvalidJsonBodyError(error);
  } finally {
    reader.releaseLock();
  }

  const serialized = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    serialized.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(serialized);
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new InvalidJsonBodyError(error);
  }
}
