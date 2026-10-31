import {
  NbtTagType,
  type NbtCompound,
  type NbtTag,
  nbtByte,
  nbtByteArray,
  nbtCompound,
  nbtDouble,
  nbtFloat,
  nbtInt,
  nbtIntArray,
  nbtList,
  nbtLong,
  nbtLongArray,
  nbtShort,
  nbtString
} from '@mcvis/core';

const UNQUOTED_CHAR = /[0-9A-Za-z_+.\-]/;

class SnbtParser {
  private pos = 0;

  constructor(private src: string) {}

  private skipWs(): void {
    while (this.pos < this.src.length) {
      const ch = this.src.charCodeAt(this.pos);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 0xfeff || ch === 0x200b) {
        this.pos++;
      } else {
        break;
      }
    }
  }

  private peek(): string {
    return this.src[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.src[this.pos] !== ch) {
      throw new Error(
        `SNBT syntax error at ${this.pos}: expected '${ch}', got '${this.src.slice(this.pos, this.pos + 16)}'`
      );
    }
    this.pos++;
  }

  parseValue(): NbtTag {
    this.skipWs();
    const ch = this.peek();
    if (ch === '{') return this.parseCompound();
    if (ch === '[') return this.parseBracket();
    if (ch === '"' || ch === "'") return nbtString(this.parseQuotedString());
    return this.parsePrimitiveOrUnquoted();
  }

  parseCompound(): NbtCompound {
    this.expect('{');
    const map: Record<string, NbtTag> = {};
    this.skipWs();
    if (this.peek() === '}') {
      this.pos++;
      return nbtCompound(map);
    }

    while (this.pos < this.src.length) {
      this.skipWs();
      if (this.peek() === '}') {
        this.pos++;
        break;
      }
      const key = this.parseKey();
      this.expect(':');
      const val = this.parseValue();
      map[key] = val;
      this.skipWs();
      if (this.peek() === ',') {
        this.pos++;
      } else if (this.peek() === '}') {
        this.pos++;
        break;
      } else {
        break;
      }
    }
    return nbtCompound(map);
  }

  private parseKey(): string {
    this.skipWs();
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.parseQuotedString();
    const start = this.pos;
    while (this.pos < this.src.length && /[0-9A-Za-z_+.\-]/.test(this.src[this.pos]!)) {
      this.pos++;
    }
    if (this.pos === start) {
      throw new Error(`SNBT empty key at position ${this.pos}`);
    }
    return this.src.slice(start, this.pos);
  }

  private parseQuotedString(): string {
    const quote = this.src[this.pos++]!;
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos++]!;
      if (ch === quote) return out;
      if (ch === '\\') {
        const next = this.src[this.pos++] ?? '';
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else if (next === 'u') {
          const hex = this.src.slice(this.pos, this.pos + 4);
          this.pos += 4;
          out += String.fromCharCode(parseInt(hex, 16) || 0);
        } else out += next;
      } else {
        out += ch;
      }
    }
    return out;
  }

  private parseBracket(): NbtTag {
    this.expect('[');
    this.skipWs();

    // Check typed arrays [B; ...], [I; ...], [L; ...]
    const prefix = this.src.slice(this.pos, this.pos + 2);
    if (prefix === 'B;' || prefix === 'I;' || prefix === 'L;') {
      const kind = prefix[0]!;
      this.pos += 2;
      this.skipWs();
      const rawVals: NbtTag[] = [];
      while (this.pos < this.src.length && this.peek() !== ']') {
        rawVals.push(this.parseValue());
        this.skipWs();
        if (this.peek() === ',') {
          this.pos++;
          this.skipWs();
        }
      }
      this.expect(']');
      if (kind === 'B') {
        return nbtByteArray(rawVals.map((t) => Number(t.value)));
      }
      if (kind === 'I') {
        return nbtIntArray(rawVals.map((t) => Number(t.value)));
      }
      return nbtLongArray(
        rawVals.map((t) => (typeof t.value === 'bigint' ? t.value : BigInt(Number(t.value))))
      );
    }

    const items: NbtTag[] = [];
    while (this.pos < this.src.length && this.peek() !== ']') {
      items.push(this.parseValue());
      this.skipWs();
      if (this.peek() === ',') {
        this.pos++;
        this.skipWs();
      } else {
        break;
      }
    }
    this.expect(']');
    const elemType = items.length > 0 ? items[0]!.type : NbtTagType.End;
    return nbtList(elemType, items);
  }

  private parsePrimitiveOrUnquoted(): NbtTag {
    const start = this.pos;
    while (this.pos < this.src.length && UNQUOTED_CHAR.test(this.src[this.pos]!)) {
      this.pos++;
    }
    const token = this.src.slice(start, this.pos);
    if (!token) {
      throw new Error(`Unexpected SNBT character '${this.peek()}' at ${this.pos}`);
    }

    if (token === 'true') return nbtByte(1);
    if (token === 'false') return nbtByte(0);

    if (/^[+-]?\d+[bB]$/.test(token)) return nbtByte(parseInt(token.slice(0, -1), 10));
    if (/^[+-]?\d+[sS]$/.test(token)) return nbtShort(parseInt(token.slice(0, -1), 10));
    if (/^[+-]?\d+[lL]$/.test(token)) return nbtLong(BigInt(token.slice(0, -1)));
    if (/^[+-]?\d+$/.test(token)) {
      const n = Number(token);
      if (n >= -2147483648 && n <= 2147483647) return nbtInt(n);
      return nbtLong(BigInt(token));
    }
    if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?[fF]$/.test(token)) {
      return nbtFloat(parseFloat(token.slice(0, -1)));
    }
    if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?[dD]$/.test(token)) {
      return nbtDouble(parseFloat(token.slice(0, -1)));
    }
    if (/^[+-]?(\d+\.\d+|\.\d+)([eE][+-]?\d+)?$/.test(token)) {
      return nbtDouble(parseFloat(token));
    }

    return nbtString(token);
  }
}

export function parseSnbt(snbt: string): NbtCompound {
  const parser = new SnbtParser(snbt.trim());
  const val = parser.parseValue();
  if (val.type !== NbtTagType.Compound) {
    throw new Error('Root SNBT value must be a Compound {...}');
  }
  return val;
}

function escapeSnbtString(s: string): string {
  if (/^[A-Za-z0-9_.\-+]+$/.test(s) && s !== 'true' && s !== 'false' && !/^[+-]?\d/.test(s)) {
    return s;
  }
  return JSON.stringify(s);
}

export function stringifySnbt(tag: NbtTag): string {
  switch (tag.type) {
    case NbtTagType.Byte:
      return `${tag.value}b`;
    case NbtTagType.Short:
      return `${tag.value}s`;
    case NbtTagType.Int:
      return `${tag.value}`;
    case NbtTagType.Long:
      return `${tag.value.toString()}L`;
    case NbtTagType.Float:
      return `${tag.value}f`;
    case NbtTagType.Double:
      return Number.isInteger(tag.value) ? `${tag.value}.0d` : `${tag.value}d`;
    case NbtTagType.String:
      return JSON.stringify(tag.value);
    case NbtTagType.ByteArray:
      return `[B;${Array.from(tag.value, (v) => `${v}b`).join(',')}]`;
    case NbtTagType.IntArray:
      return `[I;${Array.from(tag.value).join(',')}]`;
    case NbtTagType.LongArray:
      return `[L;${Array.from(tag.value, (v) => `${v.toString()}L`).join(',')}]`;
    case NbtTagType.List:
      return `[${tag.value.map(stringifySnbt).join(',')}]`;
    case NbtTagType.Compound: {
      const entries = Object.entries(tag.value).map(
        ([k, v]) => `${escapeSnbtString(k)}:${stringifySnbt(v)}`
      );
      return `{${entries.join(',')}}`;
    }
  }
}
