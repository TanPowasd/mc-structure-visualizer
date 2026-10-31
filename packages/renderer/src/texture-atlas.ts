import * as THREE from 'three';
import { type NamespaceVirtualFS, normalizeTextureRef } from '@mcvis/mod-loader';

export interface AtlasUvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const TILE_SIZE = 16;

export class DynamicTextureAtlas {
  private uvMap = new Map<string, AtlasUvRect>();
  public texture: THREE.CanvasTexture | null = null;
  private whiteRect: AtlasUvRect = { u0: 0, v0: 0, u1: 1, v1: 1 };

  getWhiteUv(): AtlasUvRect {
    return this.whiteRect;
  }

  getUv(texRef?: string): AtlasUvRect | undefined {
    if (!texRef) return undefined;
    if (texRef.startsWith('data:image/')) {
      return this.uvMap.get(texRef);
    }
    return this.uvMap.get(normalizeTextureRef(texRef));
  }

  async buildForTextures(
    textureRefs: Iterable<string>,
    vfs: NamespaceVirtualFS
  ): Promise<THREE.CanvasTexture> {
    const uniqueRefs: string[] = [];
    const seen = new Set<string>();
    for (const raw of textureRefs) {
      if (!raw) continue;
      const key = raw.startsWith('data:image/') ? raw : normalizeTextureRef(raw);
      if (!seen.has(key)) {
        seen.add(key);
        uniqueRefs.push(key);
      }
    }

    // Slot 0 is reserved for pure white (for untextured custom/fallback vertex-colored faces)
    const totalSlots = uniqueRefs.length + 1;
    const cols = Math.max(4, Math.ceil(Math.sqrt(totalSlots)));
    const rows = Math.max(4, Math.ceil(totalSlots / cols));

    const atlasW = nextPowerOfTwo(cols * TILE_SIZE);
    const atlasH = nextPowerOfTwo(rows * TILE_SIZE);

    const canvas = document.createElement('canvas');
    canvas.width = atlasW;
    canvas.height = atlasH;
    const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, atlasW, atlasH);

    // Slot 0: pure white tile at (0, 0)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
    // Inset by 0.15px to eliminate nearest-neighbor atlas bleeding at grazing angles
    const epsU = 0.12 / atlasW;
    const epsV = 0.12 / atlasH;
    this.whiteRect = {
      u0: epsU,
      v0: 1 - TILE_SIZE / atlasH + epsV,
      u1: TILE_SIZE / atlasW - epsU,
      v1: 1 - epsV
    };

    this.uvMap.clear();

    await Promise.all(
      uniqueRefs.map(async (key, idx) => {
        const slot = idx + 1;
        const col = slot % cols;
        const row = Math.floor(slot / cols);
        const px = col * TILE_SIZE;
        const py = row * TILE_SIZE;

        const img = await loadTextureImage(key, vfs);
        if (img) {
          // Animated MC textures have height = N * width; crop top square frame!
          const frameSize = Math.min(img.width, img.height);
          ctx.drawImage(img, 0, 0, frameSize, frameSize, px, py, TILE_SIZE, TILE_SIZE);

          const u0 = px / atlasW + epsU;
          const u1 = (px + TILE_SIZE) / atlasW - epsU;
          // Three.js CanvasTexture flipY=true maps canvas top (py=0) -> v=1
          const v1 = 1 - py / atlasH - epsV;
          const v0 = 1 - (py + TILE_SIZE) / atlasH + epsV;
          this.uvMap.set(key, { u0, v0, u1, v1 });
        }
      })
    );

    if (this.texture) {
      this.texture.dispose();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texture = tex;
    return tex;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
  }
}

function nextPowerOfTwo(n: number): number {
  let p = 16;
  while (p < n) p *= 2;
  return p;
}

async function loadTextureImage(
  key: string,
  vfs: NamespaceVirtualFS
): Promise<HTMLImageElement | ImageBitmap | null> {
  try {
    if (key.startsWith('data:image/')) {
      return await loadHtmlImage(key);
    }

    const modBytes = vfs.getModTextureBytes(key);
    if (modBytes) {
      const blob = new Blob([modBytes as BlobPart], { type: 'image/png' });
      if (typeof createImageBitmap === 'function') {
        return await createImageBitmap(blob);
      }
      const url = URL.createObjectURL(blob);
      try {
        return await loadHtmlImage(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    const vanillaUrl = vfs.getVanillaTextureUrl(key);
    if (vanillaUrl) {
      return await loadHtmlImage(vanillaUrl);
    }
  } catch {
    // Missing texture falls back cleanly to semantic vertex color
  }
  return null;
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}
