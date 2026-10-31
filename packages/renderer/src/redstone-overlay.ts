import * as THREE from 'three';
import {
  type StructureRegion,
  type SuperGlueBox,
  posKey,
  voxelIndex
} from '@mcvis/core';
import { type SliceConfig, isCoordInActiveSlice } from './chunk-mesher.js';

const DIR_VECTORS: Record<string, [number, number, number]> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0]
};

/**
 * Builds toggleable 3D Technical Redstone & Modded Contraption Overlays:
 * - Observer dual arrows (cyan input -> red pulse output)
 * - Hopper spout direction + red lock warning badge
 * - Repeater delay (1t..4t) & lock badges, Comparator mode (CMP/SUB)
 * - Redstone Wire power level (1..15) badges
 * - Crafter orientation & triggered badge, Copper Bulb lit badge
 * - Create Mod Super Glue translucent bounding volumes!
 */
export function buildTechnicalOverlaysGroup(
  region: StructureRegion,
  slice: SliceConfig,
  superGlueBoxes?: SuperGlueBox[]
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'TechnicalOverlays';

  const sx = region.size.x;
  const sy = region.size.y;
  const sz = region.size.z;

  const arrowPositions: number[] = [];
  const arrowColors: number[] = [];

  const pushArrowLine = (
    cx: number,
    cy: number,
    cz: number,
    dir: [number, number, number],
    rgb: [number, number, number],
    len = 0.42
  ) => {
    const ex = cx + dir[0] * len;
    const ey = cy + dir[1] * len;
    const ez = cz + dir[2] * len;
    arrowPositions.push(cx, cy, cz, ex, ey, ez);
    arrowColors.push(...rgb, ...rgb);

    // Arrowhead wings
    const perp: [number, number, number] =
      Math.abs(dir[1]) > 0.9 ? [0.14, 0, 0] : [-dir[2] * 0.14, 0, dir[0] * 0.14];
    const bx = ex - dir[0] * 0.16;
    const by = ey - dir[1] * 0.16;
    const bz = ez - dir[2] * 0.16;
    arrowPositions.push(ex, ey, ez, bx + perp[0], by + perp[1], bz + perp[2]);
    arrowColors.push(...rgb, ...rgb);
    arrowPositions.push(ex, ey, ez, bx - perp[0], by - perp[1], bz - perp[2]);
    arrowColors.push(...rgb, ...rgb);
  };

  let badgeCount = 0;
  const MAX_BADGES = 600;

  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        if (isCoordInActiveSlice(x, y, z, slice) !== 'active') continue;
        const pIdx = region.blocks[voxelIndex(x, y, z, region.size)]!;
        if (pIdx === 0) continue;

        const st = region.palette[pIdx]!;
        const name = st.name;
        const props = st.properties;
        const cx = x + 0.5;
        const cy = y + 0.5;
        const cz = z + 0.5;

        // 1. Observer: facing = look target (cyan), opposite = redstone output (red)
        if (name === 'minecraft:observer') {
          const look = DIR_VECTORS[props.facing ?? 'south'];
          if (look) {
            pushArrowLine(cx, cy + 0.52, cz, look, [0.15, 0.88, 1.0], 0.44);
            pushArrowLine(
              cx,
              cy + 0.52,
              cz,
              [-look[0], -look[1], -look[2]],
              [1.0, 0.22, 0.22],
              0.44
            );
          }
        }
        // 2. Hopper: facing = item transfer spout
        else if (name === 'minecraft:hopper') {
          const outDir = DIR_VECTORS[props.facing ?? 'down'];
          const locked = props.enabled === 'false';
          if (outDir) {
            pushArrowLine(
              cx,
              cy + 0.52,
              cz,
              outDir,
              locked ? [1.0, 0.2, 0.2] : [0.3, 1.0, 0.52],
              0.44
            );
          }
          if (locked && badgeCount < MAX_BADGES) {
            group.add(createTextBadge('LOCK', cx, y + 1.18, cz, '#ef4444'));
            badgeCount++;
          }
        }
        // 3. Repeater delay & lock
        else if (name === 'minecraft:repeater') {
          const delay = props.delay ?? '1';
          const locked = props.locked === 'true';
          // In MC, repeater 'facing' points AWAY from output (toward input); output is opposite of facing!
          const f = DIR_VECTORS[props.facing ?? 'north'];
          if (f) {
            pushArrowLine(cx, cy - 0.15, cz, [-f[0], 0, -f[2]], [1.0, 0.65, 0.15], 0.4);
          }
          if (badgeCount < MAX_BADGES) {
            group.add(
              createTextBadge(
                locked ? `${delay}t🔒` : `${delay}t`,
                cx,
                y + 0.65,
                cz,
                locked ? '#f97316' : '#facc15'
              )
            );
            badgeCount++;
          }
        }
        // 4. Comparator mode
        else if (name === 'minecraft:comparator') {
          const sub = props.mode === 'subtract';
          if (badgeCount < MAX_BADGES) {
            group.add(
              createTextBadge(sub ? 'SUB' : 'CMP', cx, y + 0.65, cz, sub ? '#fb7185' : '#38bdf8')
            );
            badgeCount++;
          }
        }
        // 5. Redstone Wire power > 0
        else if (name === 'minecraft:redstone_wire') {
          const p = parseInt(props.power ?? '0', 10) || 0;
          if (p > 0 && badgeCount < MAX_BADGES) {
            group.add(createTextBadge(String(p), cx, y + 0.35, cz, '#ff4d4d'));
            badgeCount++;
          }
        }
        // 6. MC 1.21 Crafter & Copper Bulb
        else if (name === 'minecraft:crafter') {
          const outKey = (props.orientation ?? 'north_up').split('_')[0] ?? 'north';
          const d = DIR_VECTORS[outKey];
          if (d) pushArrowLine(cx, cy + 0.55, cz, d, [1.0, 0.78, 0.2], 0.45);
          if (props.triggered === 'true' && badgeCount < MAX_BADGES) {
            group.add(createTextBadge('TRIG', cx, y + 1.22, cz, '#f59e0b'));
            badgeCount++;
          }
        } else if (name.includes('copper_bulb') && props.lit === 'true' && badgeCount < MAX_BADGES) {
          group.add(createTextBadge('LIT', cx, y + 1.18, cz, '#fbbf24'));
          badgeCount++;
        }
        // 7. Pistons, Droppers, Dispensers & Modded Directional Machines
        else if (
          name.includes('piston') ||
          name === 'minecraft:dropper' ||
          name === 'minecraft:dispenser' ||
          (!name.startsWith('minecraft:') && props.facing)
        ) {
          const d = DIR_VECTORS[props.facing ?? ''];
          if (d) {
            pushArrowLine(cx, cy + 0.52, cz, d, [0.45, 0.75, 1.0], 0.42);
          }
        }

        // Container inventory indicator
        const be = region.blockEntities.get(posKey(x, y, z));
        if (be && be.nbt.value.Items && badgeCount < MAX_BADGES) {
          group.add(createTextBadge('INV', cx, y + 1.32, cz, '#34d399'));
          badgeCount++;
        }
      }
    }
  }

  if (arrowPositions.length > 0) {
    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(arrowPositions, 3));
    lineGeom.setAttribute('color', new THREE.Float32BufferAttribute(arrowColors, 3));
    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      depthTest: false,
      transparent: true,
      opacity: 0.95
    });
    const segments = new THREE.LineSegments(lineGeom, lineMat);
    segments.renderOrder = 20;
    group.add(segments);
  }

  // Create Mod SuperGlue bounding boxes!
  if (superGlueBoxes && superGlueBoxes.length > 0) {
    const glueMat = new THREE.MeshBasicMaterial({
      color: 0x4ade80,
      transparent: true,
      opacity: 0.2,
      depthWrite: false
    });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x22c55e });
    for (const box of superGlueBoxes) {
      const w = Math.max(0.2, Math.abs(box.to[0] - box.from[0]));
      const h = Math.max(0.2, Math.abs(box.to[1] - box.from[1]));
      const d = Math.max(0.2, Math.abs(box.to[2] - box.from[2]));
      const g = new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(g, glueMat);
      mesh.position.set(
        (box.from[0] + box.to[0]) / 2,
        (box.from[1] + box.to[1]) / 2,
        (box.from[2] + box.to[2]) / 2
      );
      group.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat);
      edges.position.copy(mesh.position);
      group.add(edges);
    }
  }

  return group;
}

function createTextBadge(
  text: string,
  x: number,
  y: number,
  z: number,
  accentHex: string
): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 48;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = 'rgba(13, 17, 26, 0.88)';
  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(4, 4, 120, 40, 10);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = accentHex;
  ctx.font = 'bold 22px Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 25);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    depthTest: false,
    transparent: true
  });
  const sprite = new THREE.Sprite(mat);
  sprite.position.set(x, y, z);
  sprite.scale.set(0.68, 0.26, 1);
  sprite.renderOrder = 25;
  return sprite;
}
