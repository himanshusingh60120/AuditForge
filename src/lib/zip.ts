"use client";

/**
 * Minimal streaming ZIP reader built on File.slice() + DecompressionStream.
 * The archive is NEVER loaded whole: we read the central directory from the
 * tail of the file, then slice + stream-inflate only the entries we want.
 * Handles Zip64 (archives/entries past 4GB markers). Deflate + stored only,
 * which covers every archive Screaming Frog produces.
 */

export interface ZipEntry {
  name: string;
  method: number; // 0 = stored, 8 = deflate
  compSize: number;
  uncompSize: number;
  localHeaderOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export async function listZipEntries(file: File): Promise<ZipEntry[]> {
  // EOCD lives in the last 22..(22+65535) bytes.
  const tailSize = Math.min(file.size, 22 + 65535 + 20);
  const tailStart = file.size - tailSize;
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a readable ZIP: end-of-central-directory record not found.");

  let count: number = tv.getUint16(eocd + 10, true);
  let cdSize: number = tv.getUint32(eocd + 12, true);
  let cdOffset: number = tv.getUint32(eocd + 16, true);

  // Zip64: markers maxed out → follow the Zip64 EOCD locator.
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tv.getUint32(loc, true) === SIG_EOCD64_LOC) {
      const z64Offset = Number(tv.getBigUint64(loc + 8, true));
      const z64 = new DataView(await file.slice(z64Offset, z64Offset + 56).arrayBuffer());
      count = Number(z64.getBigUint64(32, true));
      cdSize = Number(z64.getBigUint64(40, true));
      cdOffset = Number(z64.getBigUint64(48, true));
    }
  }

  const cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries: ZipEntry[] = [];
  let p = 0;
  while (p + 46 <= cd.length && entries.length < count) {
    if (cv.getUint32(p, true) !== SIG_CENTRAL) break;
    const method = cv.getUint16(p + 10, true);
    let compSize: number = cv.getUint32(p + 20, true);
    let uncompSize: number = cv.getUint32(p + 24, true);
    const nameLen = cv.getUint16(p + 28, true);
    const extraLen = cv.getUint16(p + 30, true);
    const commentLen = cv.getUint16(p + 32, true);
    let lho: number = cv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));

    // Zip64 extra field (id 0x0001) supplies the real 64-bit values in order.
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || lho === 0xffffffff) {
      let ep = p + 46 + nameLen;
      const end = ep + extraLen;
      while (ep + 4 <= end) {
        const id = cv.getUint16(ep, true);
        const sz = cv.getUint16(ep + 2, true);
        if (id === 0x0001) {
          let fp = ep + 4;
          if (uncompSize === 0xffffffff) {
            uncompSize = Number(cv.getBigUint64(fp, true));
            fp += 8;
          }
          if (compSize === 0xffffffff) {
            compSize = Number(cv.getBigUint64(fp, true));
            fp += 8;
          }
          if (lho === 0xffffffff) lho = Number(cv.getBigUint64(fp, true));
          break;
        }
        ep += 4 + sz;
      }
    }
    entries.push({ name, method, compSize, uncompSize, localHeaderOffset: lho });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function entryDataBlob(file: File, e: ZipEntry): Promise<Blob> {
  const lh = new DataView(await file.slice(e.localHeaderOffset, e.localHeaderOffset + 30).arrayBuffer());
  if (lh.getUint32(0, true) !== SIG_LOCAL) throw new Error(`Corrupt ZIP: bad local header for "${e.name}".`);
  const nameLen = lh.getUint16(26, true);
  const extraLen = lh.getUint16(28, true);
  const start = e.localHeaderOffset + 30 + nameLen + extraLen;
  return file.slice(start, start + e.compSize);
}

async function collectStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Entry exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB extraction limit.`);
    }
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Extract a single entry fully. Only that entry's bytes are ever in memory. */
export async function readZipEntry(file: File, e: ZipEntry, maxBytes: number): Promise<Uint8Array> {
  const blob = await entryDataBlob(file, e);
  if (e.method === 0) {
    if (e.compSize > maxBytes) throw new Error(`Entry exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB extraction limit.`);
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (e.method === 8) {
    return collectStream(blob.stream().pipeThrough(new DecompressionStream("deflate-raw")), maxBytes);
  }
  throw new Error(`"${e.name}" uses unsupported compression method ${e.method}.`);
}

/** Peek the first N decompressed bytes of an entry (for magic sniffing) — cheap even on huge entries. */
export async function peekZipEntry(file: File, e: ZipEntry, n = 16): Promise<Uint8Array> {
  const blob = await entryDataBlob(file, e);
  if (e.method === 0) return new Uint8Array(await blob.slice(0, n).arrayBuffer());
  if (e.method !== 8) return new Uint8Array(0);
  // Feed only the head of the compressed stream; enough to inflate the first bytes.
  const head = blob.slice(0, Math.min(blob.size, 256 * 1024));
  const reader = head.stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < n) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch {
    /* truncated deflate stream throws at the end — the bytes we already read are valid */
  }
  await reader.cancel().catch(() => undefined);
  const out = new Uint8Array(Math.min(total, n));
  let o = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, n - o);
    out.set(c.subarray(0, take), o);
    o += take;
    if (o >= n) break;
  }
  return out;
}
