import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { CHUNK_PATH_PATTERN } from '@atlas/schema';

/**
 * Private object storage for published artifacts (plan §5.2, §8.6, §13.3). Keys are fixed
 * shapes, never caller paths: an upload prefix plus the manifest or one chunk path the
 * artifact contract already constrains. Nothing here is publicly addressable; the API
 * streams objects only after its visibility, expiry and revocation checks.
 */
export const UPLOAD_ID_PATTERN = /^up_[0-9a-f]{32}$/;
const KEY_PATTERN = /^uploads\/up_[0-9a-f]{32}\/(?:manifest\.json|(?:graphs\/snap_[0-9a-f]{64}|history\/history|layout\/layout)\.json\.gz)$/;
const PREFIX_PATTERN = /^uploads\/(?:up_[0-9a-f]{32}\/)?$/;

export const newUploadId = () => `up_${randomBytes(16).toString('hex')}`;
export function uploadPrefix(uploadId: string): string {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) throw new Error('Invalid upload ID');
  return `uploads/${uploadId}/`;
}
/** The storage key of `relative` (manifest or chunk path) inside an upload. */
export function objectKey(uploadId: string, relative: string): string {
  const key = `${uploadPrefix(uploadId)}${relative}`;
  if (relative !== 'manifest.json' && !CHUNK_PATH_PATTERN.test(relative)) throw new Error('Invalid artifact object path');
  if (!KEY_PATTERN.test(key)) throw new Error('Invalid object key');
  return key;
}
function checkKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error('Invalid object key');
}
function checkPrefix(prefix: string): void {
  if (!PREFIX_PATTERN.test(prefix)) throw new Error('Invalid object prefix');
}

export class StorageError extends Error {
  constructor(readonly operation: 'put' | 'get' | 'delete' | 'list' | 'ready', message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** The object, or null when absent; throws when it is larger than `maxBytes`. */
  get(key: string, maxBytes: number): Promise<Uint8Array | null>;
  /** Idempotent: deleting an absent object succeeds. */
  delete(key: string): Promise<void>;
  /** Keys under a prefix, at most `limit`. */
  list(prefix: string, limit?: number): Promise<string[]>;
  ready(): Promise<boolean>;
}

/** Delete every object of an upload (purge and garbage collection). */
export async function deleteUpload(store: ObjectStore, uploadId: string): Promise<number> {
  const prefix = uploadPrefix(uploadId);
  let removed = 0;
  for (;;) {
    const keys = await store.list(prefix, 100);
    if (keys.length === 0) return removed;
    for (const key of keys) await store.delete(key);
    removed += keys.length;
  }
}

/**
 * Filesystem store for development, tests and single-host deployments. Writes are atomic
 * (temporary file then rename) and reads refuse anything but a regular file inside root.
 */
export class FileObjectStore implements ObjectStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  private file(key: string): string {
    checkKey(key);
    return path.join(this.root, ...key.split('/'));
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.file(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${randomBytes(6).toString('hex')}`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  }
  async get(key: string, maxBytes: number): Promise<Uint8Array | null> {
    const handle = await open(this.file(key), 'r').catch(() => null);
    if (!handle) return null;
    try {
      const info = await handle.stat();
      if (!info.isFile()) return null;
      if (info.size > maxBytes) throw new StorageError('get', 'Stored object exceeds its expected size');
      const buffer = Buffer.alloc(info.size);
      await handle.read(buffer, 0, info.size, 0);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, info.size);
    } finally {
      await handle.close();
    }
  }
  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }
  async list(prefix: string, limit = 1000): Promise<string[]> {
    checkPrefix(prefix);
    const out: string[] = [];
    const walk = async (relative: string) => {
      const entries = await readdir(path.join(this.root, ...relative.split('/').filter(Boolean)), { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (out.length >= limit) return;
        const child = `${relative}${entry.name}`;
        if (entry.isDirectory()) await walk(`${child}/`);
        else if (entry.isFile() && KEY_PATTERN.test(child)) out.push(child);
      }
    };
    await walk(prefix);
    return out;
  }
  async ready(): Promise<boolean> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return (await stat(this.root)).isDirectory();
  }
}

export interface S3Config {
  /** `https://host[:port]`; `http:` only for a loopback development endpoint. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  timeoutMs?: number;
  /** Development stacks only (ATLAS_DEVELOPMENT=1): plain HTTP to a private-network gateway. */
  allowHttp?: boolean;
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const encodeSegment = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * S3-compatible store over path-style requests signed with AWS Signature Version 4
 * (plan §5.2). The bucket stays private; no presigned or public URL is ever produced.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly endpoint: URL;
  constructor(private readonly config: S3Config) {
    this.endpoint = new URL(config.endpoint);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(this.endpoint.hostname);
    if (this.endpoint.pathname !== '/' || this.endpoint.search || this.endpoint.username || (this.endpoint.protocol !== 'https:' && !(this.endpoint.protocol === 'http:' && (loopback || config.allowHttp === true)))) {
      throw new Error('S3 endpoint must be an HTTPS origin (HTTP only on loopback)');
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || !/^[a-z0-9-]{1,32}$/.test(config.region)) throw new Error('Invalid S3 bucket or region');
    if (!config.accessKeyId || !config.secretAccessKey) throw new Error('S3 credentials are required');
  }

  private async request(method: 'GET' | 'PUT' | 'DELETE' | 'HEAD', key: string | null, options: { body?: Uint8Array; query?: Record<string, string>; maxBytes?: number } = {}) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const canonicalPath = `/${encodeSegment(this.config.bucket)}${key === null ? '' : `/${key.split('/').map(encodeSegment).join('/')}`}`;
    const query = Object.entries(options.query ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${encodeSegment(k)}=${encodeSegment(v)}`)
      .join('&');
    const payloadHash = sha256(options.body ?? '');
    const headers: Record<string, string> = { host: this.endpoint.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (options.body) headers['content-length'] = String(options.body.length);
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join('');
    const canonicalRequest = [method, canonicalPath, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${day}/${this.config.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, day), this.config.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const { host: _host, ...sent } = headers;
    const response = await fetch(`${this.endpoint.origin}${canonicalPath}${query ? `?${query}` : ''}`, {
      method,
      headers: { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
      ...(options.body ? { body: new Uint8Array(options.body) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
    });
    return response;
  }

  private static async readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      await response.body?.cancel();
      throw new StorageError('get', 'Stored object exceeds its expected size');
    }
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new StorageError('get', 'Stored object exceeds its expected size');
      }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    checkKey(key);
    const response = await this.request('PUT', key, { body: bytes }).catch(() => null);
    if (!response?.ok) throw new StorageError('put', `Object storage rejected a write (${response?.status ?? 'unreachable'})`);
    await response.body?.cancel();
  }
  async get(key: string, maxBytes: number): Promise<Uint8Array | null> {
    checkKey(key);
    const response = await this.request('GET', key).catch(() => null);
    if (!response) throw new StorageError('get', 'Object storage is unreachable');
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new StorageError('get', `Object storage read failed (${response.status})`);
    }
    return S3ObjectStore.readCapped(response, maxBytes);
  }
  async delete(key: string): Promise<void> {
    checkKey(key);
    const response = await this.request('DELETE', key).catch(() => null);
    if (!response || (!response.ok && response.status !== 404)) throw new StorageError('delete', `Object storage delete failed (${response?.status ?? 'unreachable'})`);
    await response.body?.cancel();
  }
  async list(prefix: string, limit = 1000): Promise<string[]> {
    checkPrefix(prefix);
    const response = await this.request('GET', null, { query: { 'list-type': '2', prefix, 'max-keys': String(Math.min(limit, 1000)) } }).catch(() => null);
    if (!response?.ok) throw new StorageError('list', `Object storage listing failed (${response?.status ?? 'unreachable'})`);
    const xml = new TextDecoder().decode(await S3ObjectStore.readCapped(response, 4 * 1024 * 1024));
    const keys = [...xml.matchAll(/<Key>([^<]{1,512})<\/Key>/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
    return keys.filter((k) => KEY_PATTERN.test(k)).slice(0, limit);
  }
  async ready(): Promise<boolean> {
    const response = await this.request('HEAD', null).catch(() => null);
    await response?.body?.cancel();
    return response?.ok === true;
  }
  /** Development and test environments only; production buckets are provisioned by operators. */
  async createBucketForDevelopment(): Promise<void> {
    const response = await this.request('PUT', null).catch(() => null);
    if (!response || (!response.ok && response.status !== 409)) throw new StorageError('put', `Could not create the development bucket (${response?.status ?? 'unreachable'})`);
    await response.body?.cancel();
  }
}
