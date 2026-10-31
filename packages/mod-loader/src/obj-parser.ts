export interface ObjTriangle {
  positions: [
    [number, number, number],
    [number, number, number],
    [number, number, number]
  ];
  uvs: [[number, number], [number, number], [number, number]];
  normal: [number, number, number];
  materialName: string;
}

export interface ParsedObjMesh {
  triangles: ObjTriangle[];
  mtllib?: string;
}

/**
 * Parses Wavefront .obj meshes referenced by `forge:obj` / `neoforge:obj` modded block models
 * (e.g., Create waterwheels, gears, Immersive Engineering machines).
 */
export function parseWavefrontObj(objText: string): ParsedObjMesh {
  const vertices: Array<[number, number, number]> = [];
  const texcoords: Array<[number, number]> = [];
  const normals: Array<[number, number, number]> = [];
  const triangles: ObjTriangle[] = [];

  let currentMtl = 'default';
  let mtllib: string | undefined;

  const lines = objText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    const cmd = parts[0];

    if (cmd === 'v' && parts.length >= 4) {
      vertices.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
    } else if (cmd === 'vt' && parts.length >= 3) {
      texcoords.push([Number(parts[1]), Number(parts[2])]);
    } else if (cmd === 'vn' && parts.length >= 4) {
      normals.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
    } else if (cmd === 'usemtl' && parts[1]) {
      currentMtl = parts[1];
    } else if (cmd === 'mtllib' && parts[1]) {
      mtllib = parts[1];
    } else if (cmd === 'f' && parts.length >= 4) {
      const faceVerts = parts.slice(1).map((tok) => {
        const [viStr, tiStr, niStr] = tok.split('/');
        const resolveIdx = (s: string | undefined, len: number) => {
          if (!s) return -1;
          const idx = parseInt(s, 10);
          return idx < 0 ? len + idx : idx - 1;
        };
        const vi = resolveIdx(viStr, vertices.length);
        const ti = resolveIdx(tiStr, texcoords.length);
        const ni = resolveIdx(niStr, normals.length);
        return {
          pos: vertices[vi] ?? ([0, 0, 0] as [number, number, number]),
          uv: texcoords[ti] ?? ([0, 0] as [number, number]),
          norm: normals[ni]
        };
      });

      // Fan triangulation for quads / n-gons
      for (let i = 1; i + 1 < faceVerts.length; i++) {
        const v0 = faceVerts[0]!;
        const v1 = faceVerts[i]!;
        const v2 = faceVerts[i + 1]!;
        const norm = v0.norm ?? computeFaceNormal(v0.pos, v1.pos, v2.pos);
        triangles.push({
          positions: [v0.pos, v1.pos, v2.pos],
          uvs: [v0.uv, v1.uv, v2.uv],
          normal: norm,
          materialName: currentMtl
        });
      }
    }
  }

  return { triangles, mtllib };
}

export function parseWavefrontMtl(mtlText: string): Record<string, string> {
  const mtlToTexture: Record<string, string> = {};
  let current = '';
  for (const raw of mtlText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [cmd, ...rest] = line.split(/\s+/);
    if (cmd === 'newmtl' && rest[0]) {
      current = rest[0];
    } else if (cmd === 'map_Kd' && current && rest.length > 0) {
      mtlToTexture[current] = rest[rest.length - 1]!;
    }
  }
  return mtlToTexture;
}

function computeFaceNormal(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number]
): [number, number, number] {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}
