import {
  type BlockEntityData,
  type BlockFaceName,
  type BlockRenderType,
  type BlockStateEntry,
  type CustomBlockArchetype,
  type CustomBlockRegistry,
  type CustomModelElement,
  NbtTagType,
  deterministicNamespaceColor,
  formatBlockState,
  getNbtCompound,
  getNbtString,
  inferHeuristicArchetype,
  isAirBlock,
  normalizeNamespace
} from '@mcvis/core';
import {
  NamespaceVirtualFS,
  normalizeModelRef,
  normalizeTextureRef
} from './namespace-vfs.js';
import { type ObjTriangle, parseWavefrontMtl, parseWavefrontObj } from './obj-parser.js';

export interface CompiledBoxElement {
  from: [number, number, number];
  to: [number, number, number];
  rotation?: {
    origin: [number, number, number];
    axis: 'x' | 'y' | 'z';
    angle: number;
  };
  /** State-level rotation applied from Blockstate variant { x, y, uvlock } */
  variantRotationX: number;
  variantRotationY: number;
  uvlock: boolean;
  faces: Partial<
    Record<
      BlockFaceName,
      {
        textureRef?: string;
        uv?: [number, number, number, number];
        rotation?: number;
        tintIndex?: number;
        cullface?: BlockFaceName;
      }
    >
  >;
}

export interface CompiledBlockModel {
  stateKey: string;
  sourceTier: 'custom' | 'dynamic_nbt' | 'asset_json' | 'forge_obj' | 'fallback_semantic';
  renderType: BlockRenderType;
  isFullOpaqueCube: boolean;
  fallbackColorHex: string;
  boxes: CompiledBoxElement[];
  objTriangles?: Array<ObjTriangle & { textureRef?: string; rotX: number; rotY: number }>;
}

const ALL_FACES: BlockFaceName[] = ['up', 'down', 'north', 'south', 'east', 'west'];

export class UniversalModelCompiler {
  private cache = new Map<string, CompiledBlockModel>();

  constructor(
    private vfs: NamespaceVirtualFS,
    private customBlocks: CustomBlockRegistry
  ) {}

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Resolves any BlockStateEntry (+ optional BlockEntity NBT for Domum Ornamentum / FramedBlocks!)
   * into ready-to-mesh 3D geometry across Vanilla, Forge, NeoForge, Fabric, Custom Blocks, and Zero-Jar Fallback!
   */
  compileBlockState(
    state: BlockStateEntry,
    blockEntity?: BlockEntityData
  ): CompiledBlockModel {
    const normName = normalizeNamespace(state.name);
    if (isAirBlock(normName)) {
      return {
        stateKey: 'minecraft:air',
        sourceTier: 'asset_json',
        renderType: 'solid',
        isFullOpaqueCube: false,
        fallbackColorHex: '#000000',
        boxes: []
      };
    }

    // 1. Check Dynamic NBT Camo Blocks FIRST (FramedBlocks & Domum Ornamentum!)
    const dynamicCamoTarget = blockEntity
      ? extractDynamicCamoBlockId(normName, blockEntity)
      : undefined;
    const cacheKey = dynamicCamoTarget
      ? `${formatBlockState(state)}@@camo=${dynamicCamoTarget}`
      : formatBlockState(state);

    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    // 2. Priority 0: Custom Block Studio Registry
    const customDef = this.customBlocks.get(normName);
    if (customDef) {
      const compiled = this.compileFromArchetype(
        cacheKey,
        customDef.archetype,
        state.properties,
        customDef.colorHex,
        customDef.renderType,
        customDef.textures,
        customDef.elements,
        'custom'
      );
      this.cache.set(cacheKey, compiled);
      return compiled;
    }

    // 3. Priority 1: Dynamic NBT Camo (FramedBlocks / Domum Ornamentum)
    if (dynamicCamoTarget) {
      const camoModel = this.compileBlockState({ name: dynamicCamoTarget, properties: {} });
      const camoTex = extractPrimaryTextureFromModel(camoModel);
      const arch = inferHeuristicArchetype(normName, state.properties);
      const compiled = this.compileFromArchetype(
        cacheKey,
        arch,
        state.properties,
        camoModel.fallbackColorHex,
        camoModel.renderType,
        camoTex ? { all: camoTex } : {},
        undefined,
        'dynamic_nbt'
      );
      this.cache.set(cacheKey, compiled);
      return compiled;
    }

    // 4. Priority 2: Official Vanilla or Mounted Mod Blockstate + Model JSON / OBJ / Composite
    const bsJson = this.vfs.getBlockstateJson(normName);
    if (bsJson) {
      const applied = this.evaluateBlockstateJson(bsJson, state.properties);
      if (applied.length > 0) {
        const compiled = this.compileAppliedModels(cacheKey, normName, state.properties, applied);
        if (compiled.boxes.length > 0 || (compiled.objTriangles && compiled.objTriangles.length > 0)) {
          this.cache.set(cacheKey, compiled);
          return compiled;
        }
      }
    }

    // 5. Priority 3: Built-in Vanilla Special BlockEntities (Chest, Shulker, Bed, Sign, Banner)
    if (normName.startsWith('minecraft:')) {
      const special = this.tryCompileBuiltinVanillaBlockEntity(cacheKey, normName, state.properties);
      if (special) {
        this.cache.set(cacheKey, special);
        return special;
      }
    }

    // 6. Priority 4: Zero-Jar Smart Semantic Fallback (Never ugly magenta-black cubes!)
    const fallbackArch = inferHeuristicArchetype(normName, state.properties);
    const fallbackColor = deterministicNamespaceColor(normName);
    const fallbackRenderType: BlockRenderType =
      fallbackArch === 'glass' ? 'translucent' : fallbackArch === 'cross' ? 'cutout' : 'solid';

    const fallbackCompiled = this.compileFromArchetype(
      cacheKey,
      fallbackArch,
      state.properties,
      fallbackColor,
      fallbackRenderType,
      {},
      undefined,
      'fallback_semantic'
    );
    this.cache.set(cacheKey, fallbackCompiled);
    return fallbackCompiled;
  }

  private evaluateBlockstateJson(
    bs: Record<string, unknown>,
    props: Record<string, string>
  ): Array<{ model: string; x: number; y: number; uvlock: boolean }> {
    const out: Array<{ model: string; x: number; y: number; uvlock: boolean }> = [];

    // Forge Blockstate V1 (forge_marker: 1) support!
    const forgeDefaults =
      bs.forge_marker === 1 && typeof bs.defaults === 'object' && bs.defaults !== null
        ? (bs.defaults as Record<string, unknown>)
        : undefined;

    if (bs.variants && typeof bs.variants === 'object') {
      const variants = bs.variants as Record<string, unknown>;
      for (const [selector, val] of Object.entries(variants)) {
        if (matchesVariantSelector(selector, props)) {
          const picked = pickFirstModelEntry(val, forgeDefaults);
          if (picked) out.push(picked);
          break;
        }
      }
      // Forge V1 independent property sub-dicts fallback
      if (out.length === 0 && forgeDefaults?.model && typeof forgeDefaults.model === 'string') {
        out.push({
          model: forgeDefaults.model,
          x: Number(forgeDefaults.x ?? 0),
          y: Number(forgeDefaults.y ?? 0),
          uvlock: Boolean(forgeDefaults.uvlock)
        });
      }
    }

    if (Array.isArray(bs.multipart)) {
      for (const rule of bs.multipart) {
        if (!rule || typeof rule !== 'object') continue;
        const r = rule as { when?: unknown; apply?: unknown };
        if (!r.when || matchesMultipartCondition(r.when, props)) {
          const picked = pickFirstModelEntry(r.apply, forgeDefaults);
          if (picked) out.push(picked);
        }
      }
    }

    return out;
  }

  private compileAppliedModels(
    stateKey: string,
    blockId: string,
    props: Record<string, string>,
    applied: Array<{ model: string; x: number; y: number; uvlock: boolean }>
  ): CompiledBlockModel {
    const boxes: CompiledBoxElement[] = [];
    const objTriangles: Array<ObjTriangle & { textureRef?: string; rotX: number; rotY: number }> = [];
    let renderType: BlockRenderType = inferRenderTypeFromName(blockId);

    for (const app of applied) {
      this.collectResolvedModelParts(app.model, app.x, app.y, app.uvlock, boxes, objTriangles, (rt) => {
        if (rt === 'translucent') renderType = 'translucent';
        else if (rt === 'cutout' && renderType === 'solid') renderType = 'cutout';
      });
    }

    // If pure builtin/entity model (e.g. chest, shulker_box, banner), try vanilla BE geometry
    if (boxes.length === 0 && objTriangles.length === 0 && blockId.startsWith('minecraft:')) {
      const special = this.tryCompileBuiltinVanillaBlockEntity(stateKey, blockId, props);
      if (special) return special;
    }

    const isFullOpaqueCube =
      renderType === 'solid' &&
      objTriangles.length === 0 &&
      boxes.length === 1 &&
      boxes[0]!.from[0] === 0 &&
      boxes[0]!.from[1] === 0 &&
      boxes[0]!.from[2] === 0 &&
      boxes[0]!.to[0] === 16 &&
      boxes[0]!.to[1] === 16 &&
      boxes[0]!.to[2] === 16 &&
      !boxes[0]!.rotation;

    return {
      stateKey,
      sourceTier: objTriangles.length > 0 ? 'forge_obj' : 'asset_json',
      renderType,
      isFullOpaqueCube,
      fallbackColorHex: deterministicNamespaceColor(blockId),
      boxes,
      objTriangles: objTriangles.length > 0 ? objTriangles : undefined
    };
  }

  private collectResolvedModelParts(
    modelRef: string,
    rotX: number,
    rotY: number,
    uvlock: boolean,
    boxesOut: CompiledBoxElement[],
    objOut: Array<ObjTriangle & { textureRef?: string; rotX: number; rotY: number }>,
    onRenderType: (rt: BlockRenderType) => void,
    depth = 0
  ): void {
    if (depth > 12) return;
    const resolved = this.resolveModelHierarchy(modelRef);
    if (!resolved) return;

    if (resolved.renderType) onRenderType(resolved.renderType);

    // Tier 2A: Forge / NeoForge Composite Model Loader (`forge:composite` / `neoforge:composite`)
    if (
      (resolved.loader === 'forge:composite' || resolved.loader === 'neoforge:composite') &&
      resolved.children
    ) {
      for (const childModel of Object.values(resolved.children)) {
        if (childModel && typeof childModel === 'object') {
          this.collectInlineModelObject(
            childModel as Record<string, unknown>,
            resolved.textures,
            rotX,
            rotY,
            uvlock,
            boxesOut,
            objOut,
            onRenderType,
            depth + 1
          );
        }
      }
      return;
    }

    // Tier 2B: Forge / NeoForge Separate Transforms (`forge:separate_transforms` / `neoforge:separate_transforms`)
    if (
      (resolved.loader === 'forge:separate_transforms' ||
        resolved.loader === 'neoforge:separate_transforms') &&
      resolved.base
    ) {
      this.collectInlineModelObject(
        resolved.base,
        resolved.textures,
        rotX,
        rotY,
        uvlock,
        boxesOut,
        objOut,
        onRenderType,
        depth + 1
      );
      return;
    }

    // Tier 2C: Forge / NeoForge Wavefront OBJ Loader (`forge:obj` / `neoforge:obj`)
    if (
      (resolved.loader === 'forge:obj' || resolved.loader === 'neoforge:obj') &&
      resolved.objModelPath
    ) {
      const objAssetKey = normalizeNamespace(resolved.objModelPath);
      const objTxt = this.vfs.getTextAsset(objAssetKey);
      if (objTxt) {
        const parsedObj = parseWavefrontObj(objTxt);
        let mtlTextures: Record<string, string> = {};
        if (parsedObj.mtllib) {
          const baseDir = objAssetKey.slice(0, objAssetKey.lastIndexOf('/') + 1);
          const mtlTxt = this.vfs.getTextAsset(`${baseDir}${parsedObj.mtllib}`);
          if (mtlTxt) mtlTextures = parseWavefrontMtl(mtlTxt);
        }
        const primaryTex = resolveTextureVar(
          resolved.textures.particle ?? Object.values(resolved.textures)[0],
          resolved.textures
        );

        for (const tri of parsedObj.triangles) {
          const rawMtlTex = mtlTextures[tri.materialName];
          const texRef = rawMtlTex
            ? resolveTextureVar(rawMtlTex, resolved.textures)
            : primaryTex;
          objOut.push({
            ...tri,
            textureRef: texRef ? normalizeTextureRef(texRef) : undefined,
            rotX,
            rotY
          });
        }
        return;
      }
    }

    // Standard Vanilla / Modded JSON Elements
    for (const el of resolved.elements) {
      boxesOut.push(compileJsonElement(el, resolved.textures, rotX, rotY, uvlock));
    }
  }

  private collectInlineModelObject(
    inlineJson: Record<string, unknown>,
    inheritedTextures: Record<string, string>,
    rotX: number,
    rotY: number,
    uvlock: boolean,
    boxesOut: CompiledBoxElement[],
    objOut: Array<ObjTriangle & { textureRef?: string; rotX: number; rotY: number }>,
    onRenderType: (rt: BlockRenderType) => void,
    depth: number
  ): void {
    const mergedTextures = {
      ...inheritedTextures,
      ...((inlineJson.textures as Record<string, string> | undefined) ?? {})
    };
    if (typeof inlineJson.parent === 'string') {
      const parentRes = this.resolveModelHierarchy(inlineJson.parent);
      if (parentRes) {
        const allTex = { ...parentRes.textures, ...mergedTextures };
        const elems = Array.isArray(inlineJson.elements)
          ? (inlineJson.elements as Array<Record<string, unknown>>)
          : parentRes.elements;
        for (const el of elems) {
          boxesOut.push(compileJsonElement(el, allTex, rotX, rotY, uvlock));
        }
        return;
      }
    }
    if (typeof inlineJson.loader === 'string' && typeof inlineJson.model === 'string') {
      const objTxt = this.vfs.getTextAsset(normalizeNamespace(inlineJson.model));
      if (objTxt) {
        const parsedObj = parseWavefrontObj(objTxt);
        const primaryTex = resolveTextureVar(
          mergedTextures.particle ?? Object.values(mergedTextures)[0],
          mergedTextures
        );
        for (const tri of parsedObj.triangles) {
          objOut.push({
            ...tri,
            textureRef: primaryTex ? normalizeTextureRef(primaryTex) : undefined,
            rotX,
            rotY
          });
        }
      }
      return;
    }
    if (Array.isArray(inlineJson.elements)) {
      for (const el of inlineJson.elements as Array<Record<string, unknown>>) {
        boxesOut.push(compileJsonElement(el, mergedTextures, rotX, rotY, uvlock));
      }
    }
  }

  private resolveModelHierarchy(modelRef: string): {
    textures: Record<string, string>;
    elements: Array<Record<string, unknown>>;
    loader?: string;
    objModelPath?: string;
    children?: Record<string, unknown>;
    base?: Record<string, unknown>;
    renderType?: BlockRenderType;
  } | null {
    const chain: Array<Record<string, unknown>> = [];
    let currentRef: string | undefined = normalizeModelRef(modelRef);
    const visited = new Set<string>();

    while (currentRef && !visited.has(currentRef) && chain.length < 16) {
      visited.add(currentRef);
      const json = this.vfs.getModelJson(currentRef);
      if (!json) break;
      chain.push(json);
      currentRef = typeof json.parent === 'string' ? normalizeModelRef(json.parent) : undefined;
    }

    if (chain.length === 0) return null;

    // Merge from root parent down to leaf child
    const textures: Record<string, string> = {};
    let elements: Array<Record<string, unknown>> = [];
    let loader: string | undefined;
    let objModelPath: string | undefined;
    let children: Record<string, unknown> | undefined;
    let base: Record<string, unknown> | undefined;
    let renderType: BlockRenderType | undefined;

    for (let i = chain.length - 1; i >= 0; i--) {
      const m = chain[i]!;
      if (m.textures && typeof m.textures === 'object') {
        Object.assign(textures, m.textures);
      }
      if (Array.isArray(m.elements)) {
        elements = m.elements as Array<Record<string, unknown>>;
      }
      if (typeof m.loader === 'string') {
        loader = m.loader;
      }
      if (typeof m.model === 'string') {
        objModelPath = m.model;
      }
      if (m.children && typeof m.children === 'object') {
        children = m.children as Record<string, unknown>;
      }
      if (m.base && typeof m.base === 'object') {
        base = m.base as Record<string, unknown>;
      }
      if (typeof m.render_type === 'string') {
        const rt = m.render_type.replace(/^minecraft:/, '');
        if (rt.includes('translucent')) renderType = 'translucent';
        else if (rt.includes('cutout')) renderType = 'cutout';
      }
    }

    return { textures, elements, loader, objModelPath, children, base, renderType };
  }

  private tryCompileBuiltinVanillaBlockEntity(
    stateKey: string,
    blockId: string,
    props: Record<string, string>
  ): CompiledBlockModel | null {
    const short = blockId.slice('minecraft:'.length);
    if (short.includes('chest')) {
      const tex =
        short === 'ender_chest'
          ? 'minecraft:block/obsidian'
          : 'minecraft:block/oak_planks';
      return {
        stateKey,
        sourceTier: 'asset_json',
        renderType: 'solid',
        isFullOpaqueCube: false,
        fallbackColorHex: '#b3833e',
        boxes: [
          makeUniformBox([1, 0, 1], [15, 14, 15], tex),
          makeUniformBox([7, 7, 0], [9, 11, 1], 'minecraft:block/iron_block')
        ]
      };
    }
    if (short.endsWith('shulker_box')) {
      const colorPrefix = short.replace(/_?shulker_box$/, '');
      const tex = colorPrefix
        ? `minecraft:block/${colorPrefix}_shulker_box`
        : 'minecraft:block/shulker_box';
      return {
        stateKey,
        sourceTier: 'asset_json',
        renderType: 'solid',
        isFullOpaqueCube: true,
        fallbackColorHex: '#976797',
        boxes: [makeUniformBox([0, 0, 0], [16, 16, 16], tex)]
      };
    }
    if (short.endsWith('_bed')) {
      const color = short.replace(/_bed$/, '');
      return {
        stateKey,
        sourceTier: 'asset_json',
        renderType: 'solid',
        isFullOpaqueCube: false,
        fallbackColorHex: '#c83c3c',
        boxes: [
          makeUniformBox(
            [0, 3, 0],
            [16, 9, 16],
            props.part === 'head' ? 'minecraft:block/white_wool' : `minecraft:block/${color}_wool`
          )
        ]
      };
    }
    if (short.includes('sign')) {
      const wood = short.split('_')[0] || 'oak';
      return {
        stateKey,
        sourceTier: 'asset_json',
        renderType: 'solid',
        isFullOpaqueCube: false,
        fallbackColorHex: '#a88754',
        boxes: [makeUniformBox([0, 4, 7], [16, 12, 9], `minecraft:block/${wood}_planks`)]
      };
    }
    return null;
  }

  private compileFromArchetype(
    stateKey: string,
    archetype: CustomBlockArchetype,
    props: Record<string, string>,
    colorHex: string,
    renderType: BlockRenderType,
    textures: Partial<Record<BlockFaceName | 'all', string>>,
    customElements: CustomModelElement[] | undefined,
    tier: CompiledBlockModel['sourceTier']
  ): CompiledBlockModel {
    const faceMap = (overrideFront?: string) => {
      const res: CompiledBoxElement['faces'] = {};
      for (const f of ALL_FACES) {
        const t =
          f === 'north' && overrideFront
            ? overrideFront
            : textures[f] ?? textures.all;
        res[f] = { textureRef: t };
      }
      return res;
    };

    const facingRotY =
      props.facing === 'east'
        ? 90
        : props.facing === 'south'
          ? 180
          : props.facing === 'west'
            ? 270
            : 0;

    if (archetype === 'custom_elements' && customElements && customElements.length > 0) {
      const boxes: CompiledBoxElement[] = customElements.map((el) => {
        const faces: CompiledBoxElement['faces'] = {};
        for (const f of ALL_FACES) {
          const ef = el.faces[f];
          if (ef) {
            faces[f] = {
              textureRef: ef.texture ?? textures[f] ?? textures.all,
              uv: ef.uv,
              rotation: ef.rotation
            };
          } else {
            faces[f] = { textureRef: textures[f] ?? textures.all };
          }
        }
        return {
          from: el.from,
          to: el.to,
          rotation: el.rotation,
          variantRotationX: 0,
          variantRotationY: facingRotY,
          uvlock: false,
          faces
        };
      });
      return {
        stateKey,
        sourceTier: tier,
        renderType,
        isFullOpaqueCube: false,
        fallbackColorHex: colorHex,
        boxes
      };
    }

    let boxes: CompiledBoxElement[] = [];
    let isFullOpaqueCube = false;

    switch (archetype) {
      case 'slab': {
        const type = props.type ?? 'bottom';
        if (type === 'double') {
          isFullOpaqueCube = renderType === 'solid';
          boxes = [{ from: [0, 0, 0], to: [16, 16, 16], variantRotationX: 0, variantRotationY: 0, uvlock: false, faces: faceMap() }];
        } else if (type === 'top') {
          boxes = [{ from: [0, 8, 0], to: [16, 16, 16], variantRotationX: 0, variantRotationY: 0, uvlock: false, faces: faceMap() }];
        } else {
          boxes = [{ from: [0, 0, 0], to: [16, 8, 16], variantRotationX: 0, variantRotationY: 0, uvlock: false, faces: faceMap() }];
        }
        break;
      }
      case 'stairs': {
        const topHalf = props.half === 'top';
        boxes = [
          {
            from: [0, topHalf ? 8 : 0, 0],
            to: [16, topHalf ? 16 : 8, 16],
            variantRotationX: 0,
            variantRotationY: facingRotY,
            uvlock: true,
            faces: faceMap()
          },
          {
            from: [0, topHalf ? 0 : 8, 0],
            to: [16, topHalf ? 8 : 16, 8],
            variantRotationX: 0,
            variantRotationY: facingRotY,
            uvlock: true,
            faces: faceMap()
          }
        ];
        break;
      }
      case 'pipe': {
        boxes = [
          {
            from: [5, 5, 5],
            to: [11, 11, 11],
            variantRotationX: 0,
            variantRotationY: 0,
            uvlock: false,
            faces: faceMap()
          }
        ];
        const armDefs: Array<[string, [number, number, number], [number, number, number]]> = [
          ['north', [6, 6, 0], [10, 10, 5]],
          ['south', [6, 6, 11], [10, 10, 16]],
          ['west', [0, 6, 6], [5, 10, 10]],
          ['east', [11, 6, 6], [16, 10, 10]],
          ['up', [6, 11, 6], [10, 16, 10]],
          ['down', [6, 0, 6], [10, 5, 10]]
        ];
        for (const [dir, from, to] of armDefs) {
          const val = props[dir];
          if (val && val !== 'false' && val !== 'none') {
            boxes.push({
              from,
              to,
              variantRotationX: 0,
              variantRotationY: 0,
              uvlock: false,
              faces: faceMap()
            });
          }
        }
        break;
      }
      case 'wall': {
        boxes = [
          {
            from: [4, 0, 4],
            to: [12, 16, 12],
            variantRotationX: 0,
            variantRotationY: 0,
            uvlock: false,
            faces: faceMap()
          }
        ];
        break;
      }
      case 'cross': {
        boxes = [
          {
            from: [2, 0, 7.5],
            to: [14, 15, 8.5],
            rotation: { origin: [8, 8, 8], axis: 'y', angle: 45 },
            variantRotationX: 0,
            variantRotationY: 0,
            uvlock: false,
            faces: faceMap()
          },
          {
            from: [2, 0, 7.5],
            to: [14, 15, 8.5],
            rotation: { origin: [8, 8, 8], axis: 'y', angle: -45 },
            variantRotationX: 0,
            variantRotationY: 0,
            uvlock: false,
            faces: faceMap()
          }
        ];
        break;
      }
      default: {
        isFullOpaqueCube = renderType === 'solid' && archetype !== 'glass';
        boxes = [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            variantRotationX: 0,
            variantRotationY: facingRotY,
            uvlock: false,
            faces: faceMap()
          }
        ];
        break;
      }
    }

    return {
      stateKey,
      sourceTier: tier,
      renderType,
      isFullOpaqueCube,
      fallbackColorHex: colorHex,
      boxes
    };
  }
}

function makeUniformBox(
  from: [number, number, number],
  to: [number, number, number],
  texRef: string
): CompiledBoxElement {
  const faces: CompiledBoxElement['faces'] = {};
  for (const f of ALL_FACES) {
    faces[f] = { textureRef: texRef };
  }
  return {
    from,
    to,
    variantRotationX: 0,
    variantRotationY: 0,
    uvlock: false,
    faces
  };
}

function compileJsonElement(
  el: Record<string, unknown>,
  textures: Record<string, string>,
  rotX: number,
  rotY: number,
  uvlock: boolean
): CompiledBoxElement {
  const fromArr = Array.isArray(el.from) ? el.from : [0, 0, 0];
  const toArr = Array.isArray(el.to) ? el.to : [16, 16, 16];
  const from: [number, number, number] = [
    Number(fromArr[0] ?? 0),
    Number(fromArr[1] ?? 0),
    Number(fromArr[2] ?? 0)
  ];
  const to: [number, number, number] = [
    Number(toArr[0] ?? 16),
    Number(toArr[1] ?? 16),
    Number(toArr[2] ?? 16)
  ];

  let rotation: CompiledBoxElement['rotation'];
  if (el.rotation && typeof el.rotation === 'object') {
    const r = el.rotation as Record<string, unknown>;
    const orig = Array.isArray(r.origin) ? r.origin : [8, 8, 8];
    const axis = r.axis === 'x' || r.axis === 'y' || r.axis === 'z' ? r.axis : 'y';
    rotation = {
      origin: [Number(orig[0] ?? 8), Number(orig[1] ?? 8), Number(orig[2] ?? 8)],
      axis,
      angle: Number(r.angle ?? 0)
    };
  }

  const faces: CompiledBoxElement['faces'] = {};
  if (el.faces && typeof el.faces === 'object') {
    for (const [fName, fVal] of Object.entries(el.faces as Record<string, unknown>)) {
      if (!ALL_FACES.includes(fName as BlockFaceName) || !fVal || typeof fVal !== 'object') {
        continue;
      }
      const fv = fVal as Record<string, unknown>;
      const rawTex = typeof fv.texture === 'string' ? fv.texture : undefined;
      const resolvedTex = resolveTextureVar(rawTex, textures);
      const uv = Array.isArray(fv.uv) && fv.uv.length >= 4
        ? ([Number(fv.uv[0]), Number(fv.uv[1]), Number(fv.uv[2]), Number(fv.uv[3])] as [
            number,
            number,
            number,
            number
          ])
        : undefined;
      faces[fName as BlockFaceName] = {
        textureRef: resolvedTex ? normalizeTextureRef(resolvedTex) : undefined,
        uv,
        rotation: typeof fv.rotation === 'number' ? fv.rotation : undefined,
        tintIndex: typeof fv.tintindex === 'number' ? fv.tintindex : undefined,
        cullface:
          typeof fv.cullface === 'string' && ALL_FACES.includes(fv.cullface as BlockFaceName)
            ? (fv.cullface as BlockFaceName)
            : undefined
      };
    }
  }

  return {
    from,
    to,
    rotation,
    variantRotationX: rotX,
    variantRotationY: rotY,
    uvlock,
    faces
  };
}

function resolveTextureVar(
  raw: string | undefined,
  textures: Record<string, string>
): string | undefined {
  if (!raw) return undefined;
  let cur = raw;
  let guard = 0;
  while (cur.startsWith('#') && guard++ < 10) {
    const next = textures[cur.slice(1)];
    if (!next) return undefined;
    cur = next;
  }
  return cur.startsWith('#') ? undefined : cur;
}

function matchesVariantSelector(selector: string, props: Record<string, string>): boolean {
  if (selector === '' || selector === 'normal') return true;
  const pairs = selector.split(',');
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const expected = pair.slice(eq + 1).trim();
    const actual = props[k];
    if (actual !== undefined && actual !== expected) {
      return false;
    }
  }
  return true;
}

function matchesMultipartCondition(when: unknown, props: Record<string, string>): boolean {
  if (!when || typeof when !== 'object') return true;
  const w = when as Record<string, unknown>;
  if (Array.isArray(w.OR)) {
    return w.OR.some((sub) => matchesMultipartCondition(sub, props));
  }
  if (Array.isArray(w.AND)) {
    return w.AND.every((sub) => matchesMultipartCondition(sub, props));
  }
  for (const [k, v] of Object.entries(w)) {
    const actual = props[k];
    if (actual === undefined) continue;
    const allowed = String(v).split('|');
    if (!allowed.includes(actual)) return false;
  }
  return true;
}

function pickFirstModelEntry(
  val: unknown,
  forgeDefaults?: Record<string, unknown>
): { model: string; x: number; y: number; uvlock: boolean } | null {
  const entry = Array.isArray(val) ? val[0] : val;
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const model =
    typeof e.model === 'string'
      ? e.model
      : typeof forgeDefaults?.model === 'string'
        ? forgeDefaults.model
        : null;
  if (!model) return null;
  return {
    model,
    x: Number(e.x ?? forgeDefaults?.x ?? 0),
    y: Number(e.y ?? forgeDefaults?.y ?? 0),
    uvlock: Boolean(e.uvlock ?? forgeDefaults?.uvlock ?? false)
  };
}

function inferRenderTypeFromName(blockId: string): BlockRenderType {
  const lower = blockId.toLowerCase();
  if (
    lower.includes('stained_glass') ||
    lower === 'minecraft:water' ||
    lower === 'minecraft:ice' ||
    lower === 'minecraft:frosted_ice' ||
    lower === 'minecraft:slime_block' ||
    lower === 'minecraft:honey_block' ||
    lower.includes('tinted_glass') ||
    lower.includes('portal')
  ) {
    return 'translucent';
  }
  if (
    lower.includes('glass') ||
    lower.includes('leaves') ||
    lower.includes('torch') ||
    lower.includes('lantern') ||
    lower.includes('redstone_wire') ||
    lower.includes('repeater') ||
    lower.includes('comparator') ||
    lower.includes('lever') ||
    lower.includes('rail') ||
    lower.includes('door') ||
    lower.includes('trapdoor') ||
    lower.includes('flower') ||
    lower.includes('grass') ||
    lower.includes('fern') ||
    lower.includes('sapling') ||
    lower.includes('vine') ||
    lower.includes('ladder') ||
    lower.includes('chain') ||
    lower.includes('bars') ||
    lower.includes('grate') ||
    lower.includes('hopper') ||
    lower.includes('cauldron')
  ) {
    return 'cutout';
  }
  return 'solid';
}

/**
 * Extracts dynamic material block ID from BlockEntity NBT for:
 * 1) FramedBlocks (`camo.state.Name` or `camo_two.state.Name`)
 * 2) Domum Ornamentum (`textureData` compound mapping material slots -> block IDs, used heavily in MineColonies / Structurize!)
 */
function extractDynamicCamoBlockId(blockId: string, be: BlockEntityData): string | undefined {
  const nv = be.nbt.value;

  // FramedBlocks
  if (blockId.startsWith('framedblocks:') || nv.camo) {
    const camo = getNbtCompound(nv, 'camo');
    const camoState = getNbtCompound(camo, 'state');
    const camoName = getNbtString(camoState, 'Name') ?? getNbtString(camo, 'block');
    if (camoName && !isAirBlock(camoName)) return normalizeNamespace(camoName);
  }

  // Domum Ornamentum (Structurize / MineColonies companion mod!)
  if (blockId.startsWith('domum_ornamentum:') || nv.textureData) {
    const texData = getNbtCompound(nv, 'textureData');
    if (texData) {
      for (const v of Object.values(texData)) {
        if (v.type === NbtTagType.String && v.value.includes(':') && !isAirBlock(v.value)) {
          return normalizeNamespace(v.value);
        }
        if (v.type === NbtTagType.Compound) {
          for (const inner of Object.values(v.value)) {
            if (
              inner.type === NbtTagType.String &&
              inner.value.includes(':') &&
              !isAirBlock(inner.value)
            ) {
              return normalizeNamespace(inner.value);
            }
          }
        }
      }
    }
  }

  return undefined;
}

function extractPrimaryTextureFromModel(model: CompiledBlockModel): string | undefined {
  for (const b of model.boxes) {
    for (const f of ALL_FACES) {
      const ref = b.faces[f]?.textureRef;
      if (ref) return ref;
    }
  }
  return undefined;
}
