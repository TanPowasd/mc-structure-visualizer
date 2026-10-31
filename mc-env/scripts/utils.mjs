import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MC_ENV_DIR = path.resolve(__dirname, '..');
export const ROOT_DIR = path.resolve(MC_ENV_DIR, '..');
export const CACHE_DIR = path.join(MC_ENV_DIR, '.cache');
export const ASSETS_DIR = path.join(MC_ENV_DIR, 'assets');
export const SERVERS_DIR = path.join(MC_ENV_DIR, 'servers');

export const USER_AGENT = 'MCStructureVisualizer/0.1.0 (local-mc-env-setup)';

export function loadConfig() {
  const raw = fs.readFileSync(path.join(MC_ENV_DIR, 'config.json'), 'utf8');
  return JSON.parse(raw);
}

export function resolveJava(javaKey = 'jdk21') {
  const cfg = loadConfig();
  const candidates = [
    cfg.java?.[javaKey],
    cfg.java?.jdk21,
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : null,
    'C:\\Program Files\\Microsoft\\jdk-21.0.6.7-hotspot\\bin\\java.exe',
    'C:\\Program Files\\Java\\jdk-25.0.2\\bin\\java.exe',
    'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe',
    'java'
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      if (bin !== 'java' && !fs.existsSync(bin)) continue;
      execFileSync(bin, ['-version'], { stdio: 'pipe' });
      return bin;
    } catch {
      // try next
    }
  }
  throw new Error(`Unable to locate a working Java executable for ${javaKey}`);
}

export function hashBuffer(buf, algo = 'sha1') {
  return crypto.createHash(algo).update(buf).digest('hex');
}

export async function hashFile(filePath, algo = 'sha1') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.json();
}

export async function downloadFile(url, destPath, { sha1, sha512, label } = {}) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  if (fs.existsSync(destPath)) {
    if (sha1) {
      const actual = await hashFile(destPath, 'sha1');
      if (actual.toLowerCase() === sha1.toLowerCase()) {
        return { cached: true, path: destPath };
      }
    } else if (sha512) {
      const actual = await hashFile(destPath, 'sha512');
      if (actual.toLowerCase() === sha512.toLowerCase()) {
        return { cached: true, path: destPath };
      }
    } else {
      const stat = await fsp.stat(destPath);
      if (stat.size > 0) return { cached: true, path: destPath };
    }
  }

  const tag = label || path.basename(destPath);
  console.log(`  [download] ${tag} <- ${url}`);

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  if (sha1) {
    const actual = hashBuffer(buf, 'sha1');
    if (actual.toLowerCase() !== sha1.toLowerCase()) {
      throw new Error(`SHA-1 mismatch for ${tag}: expected ${sha1}, got ${actual}`);
    }
  }
  if (sha512) {
    const actual = hashBuffer(buf, 'sha512');
    if (actual.toLowerCase() !== sha512.toLowerCase()) {
      throw new Error(`SHA-512 mismatch for ${tag}: expected ${sha512}, got ${actual}`);
    }
  }

  const tmpPath = `${destPath}.part-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmpPath, buf);
  await fsp.rename(tmpPath, destPath);
  return { cached: false, path: destPath, size: buf.length };
}

/**
 * Pure Node.js Central Directory ZIP / JAR reader.
 * Supports reading nested JARs (Jar-in-Jar) directly from Buffers in memory!
 */
export function openZipBuffer(buf) {
  // Locate End of Central Directory (0x06054b50) searching backwards up to 65557 bytes
  const minPos = Math.max(0, buf.length - 65557);
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen <= buf.length) {
        eocdPos = i;
        break;
      }
    }
  }
  if (eocdPos === -1) {
    throw new Error('Invalid ZIP/JAR buffer: End of Central Directory signature not found');
  }

  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  const cdSize = buf.readUInt32LE(eocdPos + 12);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);

  const entries = new Map();
  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;

  while (pos < cdEnd && pos + 46 <= buf.length) {
    const sig = buf.readUInt32LE(pos);
    if (sig !== 0x02014b50) break;

    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const fileNameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);

    const name = buf.toString('utf8', pos + 46, pos + 46 + fileNameLen);
    if (!name.endsWith('/')) {
      entries.set(name, {
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset
      });
    }

    pos += 46 + fileNameLen + extraLen + commentLen;
  }

  function readEntry(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    const lh = entry.localHeaderOffset;
    if (buf.readUInt32LE(lh) !== 0x04034b50) {
      throw new Error(`Invalid local file header for ${name}`);
    }
    const localNameLen = buf.readUInt16LE(lh + 26);
    const localExtraLen = buf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.compressionMethod === 0) {
      return Buffer.from(raw);
    }
    if (entry.compressionMethod === 8) {
      return zlib.inflateRawSync(raw);
    }
    throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for ${name}`);
  }

  return {
    totalEntries,
    entries,
    listNames: () => Array.from(entries.keys()),
    has: (name) => entries.has(name),
    readEntry,
    readText: (name) => {
      const data = readEntry(name);
      return data ? data.toString('utf8') : null;
    },
    readJson: (name) => {
      const txt = readEntry(name);
      return txt ? JSON.parse(txt.toString('utf8')) : null;
    }
  };
}
