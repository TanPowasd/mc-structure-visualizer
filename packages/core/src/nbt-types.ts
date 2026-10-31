export enum NbtTagType {
  End = 0,
  Byte = 1,
  Short = 2,
  Int = 3,
  Long = 4,
  Float = 5,
  Double = 6,
  ByteArray = 7,
  String = 8,
  List = 9,
  Compound = 10,
  IntArray = 11,
  LongArray = 12
}

export type NbtTag =
  | { type: NbtTagType.Byte; value: number }
  | { type: NbtTagType.Short; value: number }
  | { type: NbtTagType.Int; value: number }
  | { type: NbtTagType.Long; value: bigint }
  | { type: NbtTagType.Float; value: number }
  | { type: NbtTagType.Double; value: number }
  | { type: NbtTagType.ByteArray; value: Int8Array }
  | { type: NbtTagType.String; value: string }
  | { type: NbtTagType.List; elementType: NbtTagType; value: NbtTag[] }
  | { type: NbtTagType.Compound; value: Record<string, NbtTag> }
  | { type: NbtTagType.IntArray; value: Int32Array }
  | { type: NbtTagType.LongArray; value: BigInt64Array };

export type NbtCompound = Extract<NbtTag, { type: NbtTagType.Compound }>;

export const nbtByte = (value: number): NbtTag => ({ type: NbtTagType.Byte, value: value | 0 });
export const nbtShort = (value: number): NbtTag => ({ type: NbtTagType.Short, value: value | 0 });
export const nbtInt = (value: number): NbtTag => ({ type: NbtTagType.Int, value: value | 0 });
export const nbtLong = (value: bigint | number): NbtTag => ({
  type: NbtTagType.Long,
  value: typeof value === 'bigint' ? value : BigInt(Math.trunc(value))
});
export const nbtFloat = (value: number): NbtTag => ({ type: NbtTagType.Float, value });
export const nbtDouble = (value: number): NbtTag => ({ type: NbtTagType.Double, value });
export const nbtByteArray = (value: Int8Array | Uint8Array | number[]): NbtTag => ({
  type: NbtTagType.ByteArray,
  value: value instanceof Int8Array ? value : new Int8Array(value)
});
export const nbtString = (value: string): NbtTag => ({ type: NbtTagType.String, value });
export const nbtList = (elementType: NbtTagType, value: NbtTag[]): NbtTag => ({
  type: NbtTagType.List,
  elementType: value.length === 0 ? NbtTagType.End : elementType,
  value
});
export const nbtCompound = (value: Record<string, NbtTag> = {}): NbtCompound => ({
  type: NbtTagType.Compound,
  value
});
export const nbtIntArray = (value: Int32Array | number[]): NbtTag => ({
  type: NbtTagType.IntArray,
  value: value instanceof Int32Array ? value : new Int32Array(value)
});
export const nbtLongArray = (value: BigInt64Array | bigint[]): NbtTag => ({
  type: NbtTagType.LongArray,
  value: value instanceof BigInt64Array ? value : BigInt64Array.from(value)
});

export function getNbtString(comp: Record<string, NbtTag> | undefined, key: string): string | undefined {
  const t = comp?.[key];
  return t?.type === NbtTagType.String ? t.value : undefined;
}

export function getNbtNumber(comp: Record<string, NbtTag> | undefined, key: string): number | undefined {
  const t = comp?.[key];
  if (!t) return undefined;
  switch (t.type) {
    case NbtTagType.Byte:
    case NbtTagType.Short:
    case NbtTagType.Int:
    case NbtTagType.Float:
    case NbtTagType.Double:
      return t.value;
    case NbtTagType.Long:
      return Number(t.value);
    default:
      return undefined;
  }
}

export function getNbtCompound(
  comp: Record<string, NbtTag> | undefined,
  key: string
): Record<string, NbtTag> | undefined {
  const t = comp?.[key];
  return t?.type === NbtTagType.Compound ? t.value : undefined;
}

export function unwrapNbtToJson(tag: NbtTag): unknown {
  switch (tag.type) {
    case NbtTagType.Byte:
    case NbtTagType.Short:
    case NbtTagType.Int:
    case NbtTagType.Float:
    case NbtTagType.Double:
    case NbtTagType.String:
      return tag.value;
    case NbtTagType.Long:
      return tag.value.toString() + 'L';
    case NbtTagType.ByteArray:
      return Array.from(tag.value);
    case NbtTagType.IntArray:
      return Array.from(tag.value);
    case NbtTagType.LongArray:
      return Array.from(tag.value, (v) => v.toString() + 'L');
    case NbtTagType.List:
      return tag.value.map(unwrapNbtToJson);
    case NbtTagType.Compound: {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(tag.value)) {
        out[k] = unwrapNbtToJson(v);
      }
      return out;
    }
  }
}
