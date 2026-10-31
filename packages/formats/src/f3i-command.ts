import {
  createEmptyStructure,
  extractModNamespaces,
  nbtString,
  nbtCompound,
  parseBlockStateString,
  setRegionBlock,
  type UniversalStructureIR
} from '@mcvis/core';
import { parseSnbt, stringifySnbt } from './snbt.js';

/**
 * Parses Minecraft F3+I debug clipboard `/setblock x y z namespace:block[props]{nbt}` commands
 * (including multi-line `/setblock` scripts!) into a UniversalStructureIR!
 */
export function parseF3ICommand(input: string): UniversalStructureIR {
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/setblock ') || l.startsWith('setblock '));

  if (lines.length === 0) {
    throw new Error('No valid /setblock command found in clipboard text');
  }

  interface ParsedPlacement {
    x: number;
    y: number;
    z: number;
    blockPart: string;
    nbtPart?: string;
  }

  const placements: ParsedPlacement[] = [];
  for (const line of lines) {
    const m = line.match(
      /^\/?setblock\s+(~?-?\d+(?:\.\d+)?|~)\s+(~?-?\d+(?:\.\d+)?|~)\s+(~?-?\d+(?:\.\d+)?|~)\s+(.+)$/
    );
    if (!m) continue;
    const parseCoord = (tok: string) => {
      const stripped = tok.startsWith('~') ? tok.slice(1) : tok;
      return stripped ? Math.floor(Number(stripped)) : 0;
    };
    const x = parseCoord(m[1]!);
    const y = parseCoord(m[2]!);
    const z = parseCoord(m[3]!);
    let rest = m[4]!.trim();
    // Strip trailing 'replace' / 'destroy' / 'keep' mode keyword
    rest = rest.replace(/\s+(replace|destroy|keep)$/i, '').trim();

    const braceStart = rest.indexOf('{');
    if (braceStart >= 0) {
      placements.push({
        x,
        y,
        z,
        blockPart: rest.slice(0, braceStart),
        nbtPart: rest.slice(braceStart)
      });
    } else {
      placements.push({ x, y, z, blockPart: rest });
    }
  }

  if (placements.length === 0) {
    throw new Error('Unable to parse coordinates or block state from /setblock command');
  }

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const p of placements) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
    maxZ = Math.max(maxZ, p.z);
  }

  const ir = createEmptyStructure(
    placements.length === 1 ? 'F3+I Block Inspect' : `Setblock Batch (${placements.length})`,
    {
      x: Math.max(1, maxX - minX + 1),
      y: Math.max(1, maxY - minY + 1),
      z: Math.max(1, maxZ - minZ + 1)
    },
    { sourceFormat: 'f3i_command' }
  );

  for (const p of placements) {
    const state = parseBlockStateString(p.blockPart);
    let nbt = undefined;
    if (p.nbtPart) {
      const parsed = parseSnbt(p.nbtPart);
      nbt = nbtCompound({ ...parsed.value, id: nbtString(state.name) });
    }
    setRegionBlock(ir.regions[0]!, p.x - minX, p.y - minY, p.z - minZ, state, nbt);
  }

  ir.requiredMods = extractModNamespaces(ir);
  return ir;
}

export function exportAsSetblockCommands(
  ir: UniversalStructureIR,
  origin?: { x: number; y: number; z: number }
): string {
  const cmds: string[] = [];
  for (const reg of ir.regions) {
    for (let y = 0; y < reg.size.y; y++) {
      for (let z = 0; z < reg.size.z; z++) {
        for (let x = 0; x < reg.size.x; x++) {
          const idx = reg.blocks[x + z * reg.size.x + y * reg.size.x * reg.size.z]!;
          if (idx === 0) continue;
          const st = reg.palette[idx]!;
          const propsKeys = Object.keys(st.properties).sort();
          const propsStr =
            propsKeys.length > 0
              ? `[${propsKeys.map((k) => `${k}=${st.properties[k]}`).join(',')}]`
              : '';
          const be = reg.blockEntities.get(`${x},${y},${z}`);
          let nbtStr = '';
          if (be) {
            const copy = { ...be.nbt.value };
            delete copy.x;
            delete copy.y;
            delete copy.z;
            delete copy.id;
            if (Object.keys(copy).length > 0) {
              nbtStr = stringifySnbt(nbtCompound(copy));
            }
          }
          const wx = reg.offset.x + x;
          const wy = reg.offset.y + y;
          const wz = reg.offset.z + z;
          const coordStr = origin
            ? `${origin.x + wx} ${origin.y + wy} ${origin.z + wz}`
            : `~${wx} ~${wy} ~${wz}`;
          cmds.push(`/setblock ${coordStr} ${st.name}${propsStr}${nbtStr} replace`);
        }
      }
    }
  }
  return cmds.join('\n');
}
