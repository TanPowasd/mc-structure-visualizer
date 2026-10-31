import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  type BlockEntityData,
  type BlockStateEntry,
  type StructureRegion,
  type UniversalStructureIR,
  type Vec3,
  getRegionBlock,
  isAirBlock,
  mergeRegionsToSingle,
  posKey
} from '@mcvis/core';
import type { NamespaceVirtualFS, UniversalModelCompiler } from '@mcvis/mod-loader';
import { DynamicTextureAtlas } from './texture-atlas.js';
import {
  type SliceConfig,
  buildRegionMeshes,
  collectRequiredTextures,
  isCoordInActiveSlice
} from './chunk-mesher.js';
import { buildTechnicalOverlaysGroup } from './redstone-overlay.js';

export type ViewportProjectionMode = '3d_perspective' | '2d_blueprint';

export interface PickedVoxelInfo {
  blockPos: Vec3;
  adjacentPos: Vec3;
  state: BlockStateEntry;
  blockEntity?: BlockEntityData;
}

export class StructureViewportController {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private perspCamera: THREE.PerspectiveCamera;
  private orthoCamera: THREE.OrthographicCamera;
  private controls: OrbitControls;
  private atlas = new DynamicTextureAtlas();

  private structureGroup = new THREE.Group();
  private gridGroup = new THREE.Group();
  private overlayGroup: THREE.Group | null = null;
  private hoverOutline: THREE.LineSegments;

  private activeMode: ViewportProjectionMode = '3d_perspective';
  private showTechnicalOverlay = true;
  private showChunkGrid = true;
  private currentRegion: StructureRegion | null = null;
  private currentIr: UniversalStructureIR | null = null;
  private currentSlice: SliceConfig = {
    axis: 'y',
    mode: 'all',
    layer: 0,
    maxLayer: 0,
    ghostBelowLayer: true
  };

  private animFrameId = 0;
  private resizeObserver: ResizeObserver;
  public triangleCount = 0;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x222222, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    const ambient = new THREE.AmbientLight(0xffffff, 1.0);
    this.scene.add(ambient);

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    this.perspCamera = new THREE.PerspectiveCamera(50, w / h, 0.1, 2500);
    this.orthoCamera = new THREE.OrthographicCamera(-16, 16, 16, -16, -500, 2500);

    this.controls = new OrbitControls(this.perspCamera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(this.gridGroup);
    this.scene.add(this.structureGroup);

    const boxGeom = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.015, 1.015, 1.015));
    this.hoverOutline = new THREE.LineSegments(
      boxGeom,
      new THREE.LineBasicMaterial({ color: 0xe0b060 })
    );
    this.hoverOutline.visible = false;
    this.scene.add(this.hoverOutline);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);
    this.handleResize();
    this.startLoop();
  }

  private get activeCamera(): THREE.Camera {
    return this.activeMode === '3d_perspective' ? this.perspCamera : this.orthoCamera;
  }

  private handleResize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);

    this.perspCamera.aspect = w / h;
    this.perspCamera.updateProjectionMatrix();

    const halfH = Math.max(8, (this.currentRegion?.size.z ?? 16) * 0.75);
    const halfW = halfH * (w / h);
    this.orthoCamera.left = -halfW;
    this.orthoCamera.right = halfW;
    this.orthoCamera.top = halfH;
    this.orthoCamera.bottom = -halfH;
    this.orthoCamera.updateProjectionMatrix();
  }

  private startLoop(): void {
    const tick = () => {
      this.animFrameId = requestAnimationFrame(tick);
      this.controls.update();
      this.renderer.render(this.scene, this.activeCamera);
    };
    tick();
  }

  setProjectionMode(mode: ViewportProjectionMode): void {
    if (this.activeMode === mode) return;
    this.activeMode = mode;
    const reg = this.currentRegion;
    const cx = (reg?.size.x ?? 8) / 2;
    const cy = (reg?.size.y ?? 4) / 2;
    const cz = (reg?.size.z ?? 8) / 2;

    if (mode === '2d_blueprint') {
      this.orthoCamera.position.set(cx, Math.max(64, (reg?.size.y ?? 16) + 32), cz);
      this.orthoCamera.up.set(0, 0, -1);
      this.orthoCamera.lookAt(cx, 0, cz);
      this.controls.object = this.orthoCamera;
      this.controls.target.set(cx, 0, cz);
      this.controls.enableRotate = false;
      this.handleResize();
    } else {
      this.perspCamera.up.set(0, 1, 0);
      this.controls.object = this.perspCamera;
      this.controls.target.set(cx, cy, cz);
      this.controls.enableRotate = true;
    }
    this.controls.update();
  }

  resetCameraToFit(): void {
    const reg = this.currentRegion;
    if (!reg) return;
    const cx = reg.size.x / 2;
    const cy = reg.size.y / 2;
    const cz = reg.size.z / 2;
    const maxDim = Math.max(reg.size.x, reg.size.y, reg.size.z, 6);

    this.perspCamera.position.set(
      cx + maxDim * 1.15,
      cy + maxDim * 0.9,
      cz + maxDim * 1.15
    );
    this.controls.target.set(cx, cy, cz);
    this.controls.update();
    this.handleResize();
  }

  setTechnicalOverlayVisible(visible: boolean): void {
    this.showTechnicalOverlay = visible;
    if (this.overlayGroup) {
      this.overlayGroup.visible = visible;
    }
  }

  setChunkGridVisible(visible: boolean): void {
    this.showChunkGrid = visible;
    this.gridGroup.visible = visible;
  }

  setHighlightedVoxel(pos: Vec3 | null): void {
    if (!pos) {
      this.hoverOutline.visible = false;
      return;
    }
    this.hoverOutline.position.set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
    this.hoverOutline.visible = true;
  }

  async loadAndRender(
    ir: UniversalStructureIR,
    vfs: NamespaceVirtualFS,
    compiler: UniversalModelCompiler,
    slice: SliceConfig,
    fitCamera = true
  ): Promise<{ triangleCount: number }> {
    this.currentIr = ir;
    this.currentRegion = mergeRegionsToSingle(ir);
    this.currentSlice = slice;

    const reqTextures = collectRequiredTextures(this.currentRegion, compiler);
    await this.atlas.buildForTextures(reqTextures, vfs);

    this.rebuildGrid(this.currentRegion.size);
    const stats = this.rebuildMeshesOnly(compiler, slice);
    if (fitCamera) {
      this.resetCameraToFit();
    }
    return stats;
  }

  rebuildMeshesOnly(
    compiler: UniversalModelCompiler,
    slice: SliceConfig
  ): { triangleCount: number } {
    this.currentSlice = slice;
    this.clearGroup(this.structureGroup);
    if (!this.currentRegion || !this.atlas.texture) {
      return { triangleCount: 0 };
    }

    const buffers = buildRegionMeshes(this.currentRegion, compiler, this.atlas, slice);
    this.triangleCount = buffers.triangleCount;

    const solidMat = new THREE.MeshBasicMaterial({
      map: this.atlas.texture,
      vertexColors: true,
      alphaTest: 0.15,
      side: THREE.DoubleSide
    });
    const transMat = new THREE.MeshBasicMaterial({
      map: this.atlas.texture,
      vertexColors: true,
      transparent: true,
      opacity: 0.76,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const ghostMat = new THREE.MeshBasicMaterial({
      map: this.atlas.texture,
      vertexColors: true,
      transparent: true,
      opacity: 0.22,
      depthWrite: false
    });

    if (buffers.solidCutout.index && buffers.solidCutout.index.count > 0) {
      this.structureGroup.add(new THREE.Mesh(buffers.solidCutout, solidMat));
    }
    if (buffers.translucent.index && buffers.translucent.index.count > 0) {
      const m = new THREE.Mesh(buffers.translucent, transMat);
      m.renderOrder = 5;
      this.structureGroup.add(m);
    }
    if (buffers.ghost.index && buffers.ghost.index.count > 0) {
      const g = new THREE.Mesh(buffers.ghost, ghostMat);
      g.renderOrder = 2;
      this.structureGroup.add(g);
    }

    if (this.overlayGroup) {
      this.clearGroup(this.overlayGroup);
      this.scene.remove(this.overlayGroup);
    }
    this.overlayGroup = buildTechnicalOverlaysGroup(
      this.currentRegion,
      slice,
      this.currentIr?.metadata.superGlue
    );
    this.overlayGroup.visible = this.showTechnicalOverlay;
    this.scene.add(this.overlayGroup);

    return { triangleCount: buffers.triangleCount };
  }

  /**
   * Fast 3D Amanatides-Woo Voxel DDA Raycast against active slice voxels!
   * Works accurately even for fallback/custom/transparent blocks without Three.js triangle Soup overhead!
   */
  pickVoxel(clientX: number, clientY: number): PickedVoxelInfo | null {
    const reg = this.currentRegion;
    if (!reg) return null;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.activeCamera);

    const boxMin = new THREE.Vector3(0, 0, 0);
    const boxMax = new THREE.Vector3(reg.size.x, reg.size.y, reg.size.z);
    const aabb = new THREE.Box3(boxMin, boxMax);

    const entryPt = new THREE.Vector3();
    if (!aabb.containsPoint(raycaster.ray.origin)) {
      const hit = raycaster.ray.intersectBox(aabb, entryPt);
      if (!hit) return null;
    } else {
      entryPt.copy(raycaster.ray.origin);
    }

    const dir = raycaster.ray.direction;
    let x = Math.min(reg.size.x - 1, Math.max(0, Math.floor(entryPt.x + dir.x * 1e-4)));
    let y = Math.min(reg.size.y - 1, Math.max(0, Math.floor(entryPt.y + dir.y * 1e-4)));
    let z = Math.min(reg.size.z - 1, Math.max(0, Math.floor(entryPt.z + dir.z * 1e-4)));

    const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
    const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
    const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;

    const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity;

    let tMaxX =
      stepX > 0
        ? (x + 1 - entryPt.x) * tDeltaX
        : stepX < 0
          ? (entryPt.x - x) * tDeltaX
          : Infinity;
    let tMaxY =
      stepY > 0
        ? (y + 1 - entryPt.y) * tDeltaY
        : stepY < 0
          ? (entryPt.y - y) * tDeltaY
          : Infinity;
    let tMaxZ =
      stepZ > 0
        ? (z + 1 - entryPt.z) * tDeltaZ
        : stepZ < 0
          ? (entryPt.z - z) * tDeltaZ
          : Infinity;

    let prevPos: Vec3 = {
      x: x - stepX,
      y: y - stepY,
      z: z - stepZ
    };

    const maxSteps = (reg.size.x + reg.size.y + reg.size.z) * 2 + 8;
    for (let i = 0; i < maxSteps; i++) {
      if (x < 0 || y < 0 || z < 0 || x >= reg.size.x || y >= reg.size.y || z >= reg.size.z) {
        break;
      }

      if (isCoordInActiveSlice(x, y, z, this.currentSlice) === 'active') {
        const st = getRegionBlock(reg, x, y, z);
        if (!isAirBlock(st.name)) {
          return {
            blockPos: { x, y, z },
            adjacentPos: prevPos,
            state: st,
            blockEntity: reg.blockEntities.get(posKey(x, y, z))
          };
        }
      }

      prevPos = { x, y, z };
      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          x += stepX;
          tMaxX += tDeltaX;
        } else {
          z += stepZ;
          tMaxZ += tDeltaZ;
        }
      } else {
        if (tMaxY < tMaxZ) {
          y += stepY;
          tMaxY += tDeltaY;
        } else {
          z += stepZ;
          tMaxZ += tDeltaZ;
        }
      }
    }

    return null;
  }

  async captureThumbnailPng(): Promise<Uint8Array> {
    this.renderer.render(this.scene, this.activeCamera);
    return new Promise((resolve, reject) => {
      this.renderer.domElement.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Failed to capture WebGL canvas blob'));
          return;
        }
        blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject);
      }, 'image/png');
    });
  }

  private rebuildGrid(size: Vec3): void {
    this.clearGroup(this.gridGroup);
    const maxHoriz = Math.ceil(Math.max(size.x, size.z, 16) / 16) * 16;

    // 1x1 block grid
    const blockGrid = new THREE.GridHelper(maxHoriz, maxHoriz, 0x333333, 0x2a2a2a);
    blockGrid.position.set(maxHoriz / 2, -0.005, maxHoriz / 2);
    this.gridGroup.add(blockGrid);

    // 16x16 Minecraft Chunk Boundary grid (muted brass lines)
    const chunkDivs = Math.max(1, maxHoriz / 16);
    const chunkGrid = new THREE.GridHelper(maxHoriz, chunkDivs, 0x5c5c5c, 0x6e5734);
    chunkGrid.position.set(maxHoriz / 2, 0.002, maxHoriz / 2);
    this.gridGroup.add(chunkGrid);

    // Bounding Box wireframe of structure size
    const boundsBox = new THREE.BoxGeometry(size.x, size.y, size.z);
    const boundsEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(boundsBox),
      new THREE.LineBasicMaterial({ color: 0x5a5a5a, transparent: true, opacity: 0.7 })
    );
    boundsEdges.position.set(size.x / 2, size.y / 2, size.z / 2);
    this.gridGroup.add(boundsEdges);

    // Axis Compass at (0, 0, 0): Red = +X (East), Green = +Y (Up), Blue = +Z (South)
    const axes = new THREE.AxesHelper(Math.min(8, Math.max(3, maxHoriz * 0.2)));
    axes.position.set(-0.02, 0.01, -0.02);
    this.gridGroup.add(axes);

    this.gridGroup.visible = this.showChunkGrid;
  }

  private clearGroup(grp: THREE.Group): void {
    while (grp.children.length > 0) {
      const child = grp.children.pop()!;
      if ((child as THREE.Mesh).geometry) {
        (child as THREE.Mesh).geometry.dispose();
      }
      const mat = (child as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.animFrameId);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.atlas.dispose();
    this.clearGroup(this.structureGroup);
    this.clearGroup(this.gridGroup);
    if (this.overlayGroup) this.clearGroup(this.overlayGroup);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
