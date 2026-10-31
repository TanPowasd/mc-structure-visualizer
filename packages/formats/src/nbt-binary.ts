import { gunzipSync, gzipSync, unzlibSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';
import {
  NbtTagType,
  type NbtCompound,
  type NbtTag
} from '@mcvis/core';

export type CompressionKind = 'gzip' | 'zlib' | 'zstd' | 'none';

export function detectCompression(data: Uint8Array): CompressionKind {
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    return 'gzip';
  }
  if (
    data.length >= 4 &&
    data[0] === 0x28 &&
    data[1] === 0xb5 &&
    data[2] === 0x2f &&
    data[3] === 0xfd
  ) {
    return 'zstd';
  }
  if (
    data.length >= 2 &&
    data[0] === 0x78 &&
    (data[1] === 0x01 || data[1] === 0x5e || data[1] === 0x9c || data[1] === 0xda)
  ) {
    return 'zlib';
  }
  return 'none';
}

export function decompressIfNeeded(data: Uint8Array): {
  bytes: Uint8Array;
  compression: CompressionKind;
} {
  const kind = detectCompression(data);
  if (kind === 'gzip') return { bytes: gunzipSync(data), compression: 'gzip' };
  if (kind === 'zlib') return { bytes: unzlibSync(data), compression: 'zlib' };
  if (kind === 'zstd') return { bytes: zstdDecompress(data), compression: 'zstd' };
  return { bytes: data, compression: 'none' };
}

class BinaryReader {
  private view: DataView;
  public offset = 0;
  private decoder = new TextDecoder('utf-8');

  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  readUInt8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  readInt8(): number {
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readInt16BE(): number {
    const v = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return v;
  }

  readUInt16BE(): number {
    const v = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return v;
  }

  readInt32BE(): number {
    const v = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return v;
  }

  readInt64BE(): bigint {
    const v = this.view.getBigInt64(this.offset, false);
    this.offset += 8;
    return v;
  }

  readFloat32BE(): number {
    const v = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return v;
  }

  readFloat64BE(): number {
    const v = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return v;
  }

  readString(): string {
    const len = this.readUInt16BE();
    if (len === 0) return '';
    const slice = this.bytes.subarray(this.offset, this.offset + len);
    this.offset += len;
    return this.decoder.decode(slice);
  }

  readPayload(type: NbtTagType): NbtTag {
    switch (type) {
      case NbtTagType.Byte:
        return { type: NbtTagType.Byte, value: this.readInt8() };
      case NbtTagType.Short:
        return { type: NbtTagType.Short, value: this.readInt16BE() };
      case NbtTagType.Int:
        return { type: NbtTagType.Int, value: this.readInt32BE() };
      case NbtTagType.Long:
        return { type: NbtTagType.Long, value: this.readInt64BE() };
      case NbtTagType.Float:
        return { type: NbtTagType.Float, value: this.readFloat32BE() };
      case NbtTagType.Double:
        return { type: NbtTagType.Double, value: this.readFloat64BE() };
      case NbtTagType.ByteArray: {
        const len = this.readInt32BE();
        const arr = new Int8Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.readInt8();
        return { type: NbtTagType.ByteArray, value: arr };
      }
      case NbtTagType.String:
        return { type: NbtTagType.String, value: this.readString() };
      case NbtTagType.List: {
        const elemType = this.readUInt8() as NbtTagType;
        const len = this.readInt32BE();
        const items: NbtTag[] = new Array(Math.max(0, len));
        for (let i = 0; i < len; i++) {
          items[i] = this.readPayload(elemType);
        }
        return { type: NbtTagType.List, elementType: elemType, value: items };
      }
      case NbtTagType.Compound: {
        const record: Record<string, NbtTag> = {};
        while (this.offset < this.bytes.length) {
          const childType = this.readUInt8() as NbtTagType;
          if (childType === NbtTagType.End) break;
          const name = this.readString();
          record[name] = this.readPayload(childType);
        }
        return { type: NbtTagType.Compound, value: record };
      }
      case NbtTagType.IntArray: {
        const len = this.readInt32BE();
        const arr = new Int32Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.readInt32BE();
        return { type: NbtTagType.IntArray, value: arr };
      }
      case NbtTagType.LongArray: {
        const len = this.readInt32BE();
        const arr = new BigInt64Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.readInt64BE();
        return { type: NbtTagType.LongArray, value: arr };
      }
      default:
        throw new Error(`Unsupported NBT tag type ID: ${type} at offset ${this.offset}`);
    }
  }
}

export function readNbt(
  input: Uint8Array,
  options?: { allowNamelessRoot?: boolean }
): { rootName: string; root: NbtCompound; compression: CompressionKind } {
  const { bytes, compression } = decompressIfNeeded(input);
  const reader = new BinaryReader(bytes);
  const firstType = reader.readUInt8() as NbtTagType;
  if (firstType !== NbtTagType.Compound) {
    throw new Error(`Expected root NBT tag to be Compound (10), got ${firstType}`);
  }

  // Detect nameless network NBT (MC 1.20.2+ / Axiom chunks) vs standard named root NBT
  let rootName = '';
  if (options?.allowNamelessRoot) {
    // Peek next byte: in standard named NBT, next 2 bytes are uint16 name length.
    // Try standard named parse first, fallback to nameless if invalid tag follows.
    const savedOffset = reader.offset;
    try {
      rootName = reader.readString();
      const root = reader.readPayload(NbtTagType.Compound) as NbtCompound;
      return { rootName, root, compression };
    } catch {
      reader.offset = savedOffset;
      const root = reader.readPayload(NbtTagType.Compound) as NbtCompound;
      return { rootName: '', root, compression };
    }
  }

  rootName = reader.readString();
  const root = reader.readPayload(NbtTagType.Compound) as NbtCompound;
  return { rootName, root, compression };
}

class BinaryWriter {
  private buf: Uint8Array;
  private view: DataView;
  public length = 0;
  private encoder = new TextEncoder();

  constructor(initialCapacity = 65536) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    if (this.length + extra <= this.buf.length) return;
    let nextCap = this.buf.length * 2;
    while (nextCap < this.length + extra) nextCap *= 2;
    const next = new Uint8Array(nextCap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  writeUInt8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.length, v & 0xff);
    this.length += 1;
  }

  writeInt8(v: number): void {
    this.ensure(1);
    this.view.setInt8(this.length, v);
    this.length += 1;
  }

  writeInt16BE(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.length, v, false);
    this.length += 2;
  }

  writeUInt16BE(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.length, v, false);
    this.length += 2;
  }

  writeInt32BE(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.length, v, false);
    this.length += 4;
  }

  writeInt64BE(v: bigint): void {
    this.ensure(8);
    this.view.setBigInt64(this.length, v, false);
    this.length += 8;
  }

  writeFloat32BE(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.length, v, false);
    this.length += 4;
  }

  writeFloat64BE(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.length, v, false);
    this.length += 8;
  }

  writeString(s: string): void {
    const encoded = this.encoder.encode(s);
    this.writeUInt16BE(encoded.length);
    this.ensure(encoded.length);
    this.buf.set(encoded, this.length);
    this.length += encoded.length;
  }

  writePayload(tag: NbtTag): void {
    switch (tag.type) {
      case NbtTagType.Byte:
        this.writeInt8(tag.value);
        break;
      case NbtTagType.Short:
        this.writeInt16BE(tag.value);
        break;
      case NbtTagType.Int:
        this.writeInt32BE(tag.value);
        break;
      case NbtTagType.Long:
        this.writeInt64BE(tag.value);
        break;
      case NbtTagType.Float:
        this.writeFloat32BE(tag.value);
        break;
      case NbtTagType.Double:
        this.writeFloat64BE(tag.value);
        break;
      case NbtTagType.ByteArray:
        this.writeInt32BE(tag.value.length);
        this.ensure(tag.value.length);
        for (let i = 0; i < tag.value.length; i++) this.writeInt8(tag.value[i]!);
        break;
      case NbtTagType.String:
        this.writeString(tag.value);
        break;
      case NbtTagType.List: {
        const elemType = tag.value.length > 0 ? tag.value[0]!.type : NbtTagType.End;
        this.writeUInt8(elemType);
        this.writeInt32BE(tag.value.length);
        for (const item of tag.value) {
          this.writePayload(item);
        }
        break;
      }
      case NbtTagType.Compound:
        for (const [k, v] of Object.entries(tag.value)) {
          this.writeUInt8(v.type);
          this.writeString(k);
          this.writePayload(v);
        }
        this.writeUInt8(NbtTagType.End);
        break;
      case NbtTagType.IntArray:
        this.writeInt32BE(tag.value.length);
        for (let i = 0; i < tag.value.length; i++) this.writeInt32BE(tag.value[i]!);
        break;
      case NbtTagType.LongArray:
        this.writeInt32BE(tag.value.length);
        for (let i = 0; i < tag.value.length; i++) this.writeInt64BE(tag.value[i]!);
        break;
    }
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

export function writeNbt(
  root: NbtCompound,
  options?: { rootName?: string; compress?: 'gzip' | 'none'; namelessRoot?: boolean }
): Uint8Array {
  const writer = new BinaryWriter();
  writer.writeUInt8(NbtTagType.Compound);
  if (!options?.namelessRoot) {
    writer.writeString(options?.rootName ?? '');
  }
  writer.writePayload(root);
  const raw = writer.toUint8Array();
  if ((options?.compress ?? 'gzip') === 'gzip') {
    return gzipSync(raw);
  }
  return raw;
}
