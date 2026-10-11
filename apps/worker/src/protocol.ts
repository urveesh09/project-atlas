import { MANIFEST_PATH } from '@atlas/artifact';
import { CHUNK_PATH_PATTERN, LIMITS } from '@atlas/schema';

/**
 * Sandbox output protocol. A sandbox has no writable mount shared with the host for its
 * results; it reports on stdout as length-prefixed frames, which the coordinator parses
 * incrementally under fixed caps. Everything a sandbox says is untrusted until the
 * coordinator has verified the artifact itself (plan §8.1).
 *
 *   frame := type:u8 length:u32be payload[length]
 *   FILE  payload := nameLength:u16be name[nameLength] bytes
 */
export const FRAME = { PROGRESS: 1, FILE: 2, RESULT: 3 } as const;
export type FrameType = (typeof FRAME)[keyof typeof FRAME];

const HEADER_BYTES = 5;
/** Largest single frame: a compressed chunk at the transport cap plus framing. */
export const MAX_FRAME_BYTES = LIMITS.artifactCompressedBytes + 4096;
/** All output of one sandbox run: the whole compressed artifact, its manifest and progress. */
export const MAX_SANDBOX_OUTPUT_BYTES = LIMITS.artifactCompressedBytes + 8 * 1024 * 1024;
export const MAX_FILES = LIMITS.analyzedFrames + 3;
const MAX_JSON_FRAME = 64 * 1024;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export type Frame =
  | { type: typeof FRAME.PROGRESS; value: unknown }
  | { type: typeof FRAME.RESULT; value: unknown }
  | { type: typeof FRAME.FILE; name: string; bytes: Buffer };

export function encodeFrame(frame: Frame): Buffer {
  let payload: Buffer;
  if (frame.type === FRAME.FILE) {
    const name = Buffer.from(frame.name, 'utf8');
    payload = Buffer.concat([Buffer.from([name.length >> 8, name.length & 0xff]), name, frame.bytes]);
  } else payload = Buffer.from(JSON.stringify(frame.value), 'utf8');
  const header = Buffer.alloc(HEADER_BYTES);
  header[0] = frame.type;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

const isArtifactFile = (name: string) => name === MANIFEST_PATH || CHUNK_PATH_PATTERN.test(name);

/** Incremental decoder. Rejects unknown types, oversized frames, bad names and duplicates. */
export class FrameDecoder {
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private total = 0;
  private readonly names = new Set<string>();

  push(chunk: Buffer): Frame[] {
    this.total += chunk.length;
    if (this.total > MAX_SANDBOX_OUTPUT_BYTES) throw new ProtocolError('Sandbox output exceeded its byte limit');
    this.buffered.push(chunk);
    this.bufferedBytes += chunk.length;
    const frames: Frame[] = [];
    for (;;) {
      if (this.bufferedBytes < HEADER_BYTES) break;
      const head = this.peek(HEADER_BYTES);
      const type = head[0]!;
      const length = head.readUInt32BE(1);
      if (type !== FRAME.PROGRESS && type !== FRAME.FILE && type !== FRAME.RESULT) throw new ProtocolError('Unknown sandbox frame');
      if (length > (type === FRAME.FILE ? MAX_FRAME_BYTES : MAX_JSON_FRAME)) throw new ProtocolError('Sandbox frame exceeded its limit');
      if (this.bufferedBytes < HEADER_BYTES + length) break;
      const payload = this.take(HEADER_BYTES + length).subarray(HEADER_BYTES);
      frames.push(this.parse(type, payload));
    }
    return frames;
  }

  /** Call at end of stream: a partial frame means truncated output. */
  end(): void {
    if (this.bufferedBytes > 0) throw new ProtocolError('Sandbox output ended inside a frame');
  }

  private parse(type: number, payload: Buffer): Frame {
    if (type === FRAME.FILE) {
      if (payload.length < 2) throw new ProtocolError('Malformed file frame');
      const nameLength = payload.readUInt16BE(0);
      const name = payload.subarray(2, 2 + nameLength).toString('utf8');
      if (2 + nameLength > payload.length || !isArtifactFile(name)) throw new ProtocolError('Invalid artifact file name');
      if (this.names.has(name)) throw new ProtocolError('Duplicate artifact file');
      if (this.names.size >= MAX_FILES) throw new ProtocolError('Too many artifact files');
      this.names.add(name);
      return { type: FRAME.FILE, name, bytes: Buffer.from(payload.subarray(2 + nameLength)) };
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    } catch {
      throw new ProtocolError('Malformed sandbox message');
    }
    return type === FRAME.PROGRESS ? { type: FRAME.PROGRESS, value } : { type: FRAME.RESULT, value };
  }

  private peek(bytes: number): Buffer {
    if (this.buffered[0]!.length < bytes) this.buffered = [Buffer.concat(this.buffered)];
    return this.buffered[0]!.subarray(0, bytes);
  }

  private take(bytes: number): Buffer {
    const all = this.buffered.length === 1 ? this.buffered[0]! : Buffer.concat(this.buffered);
    const out = all.subarray(0, bytes);
    const rest = all.subarray(bytes);
    this.buffered = rest.length > 0 ? [rest] : [];
    this.bufferedBytes = rest.length;
    return out;
  }
}
