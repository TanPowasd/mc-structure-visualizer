/**
 * Block catalogue for the manual block picker.
 *
 * The vanilla registry (when the asset bundle is extracted) gives the full list with
 * localized names; this built-in list keeps the picker useful before `pnpm mc:assets`
 * has been run, and seeds the default hotbar.
 */
export interface CatalogBlock {
  id: string;
  nameZh: string;
  nameEn: string;
}

const C = (id: string, nameZh: string, nameEn: string): CatalogBlock => ({
  id: `minecraft:${id}`,
  nameZh,
  nameEn
});

export const COMMON_BLOCKS: CatalogBlock[] = [
  C('stone', '石头', 'Stone'),
  C('cobblestone', '圆石', 'Cobblestone'),
  C('stone_bricks', '石砖', 'Stone Bricks'),
  C('smooth_stone', '平滑石头', 'Smooth Stone'),
  C('andesite', '安山岩', 'Andesite'),
  C('polished_andesite', '磨制安山岩', 'Polished Andesite'),
  C('deepslate_bricks', '深板岩砖', 'Deepslate Bricks'),
  C('polished_deepslate', '磨制深板岩', 'Polished Deepslate'),
  C('cobbled_deepslate', '深板岩圆石', 'Cobbled Deepslate'),
  C('bricks', '红砖块', 'Bricks'),
  C('sandstone', '砂岩', 'Sandstone'),
  C('cut_sandstone', '切制砂岩', 'Cut Sandstone'),
  C('smooth_sandstone', '平滑砂岩', 'Smooth Sandstone'),
  C('quartz_block', '石英块', 'Block of Quartz'),
  C('quartz_bricks', '石英砖', 'Quartz Bricks'),
  C('quartz_pillar', '石英柱', 'Quartz Pillar'),
  C('oak_planks', '橡木木板', 'Oak Planks'),
  C('spruce_planks', '云杉木板', 'Spruce Planks'),
  C('birch_planks', '白桦木板', 'Birch Planks'),
  C('dark_oak_planks', '深色橡木木板', 'Dark Oak Planks'),
  C('oak_log', '橡木原木', 'Oak Log'),
  C('spruce_log', '云杉原木', 'Spruce Log'),
  C('stripped_oak_log', '去皮橡木原木', 'Stripped Oak Log'),
  C('oak_stairs', '橡木楼梯', 'Oak Stairs'),
  C('stone_brick_stairs', '石砖楼梯', 'Stone Brick Stairs'),
  C('oak_slab', '橡木台阶', 'Oak Slab'),
  C('stone_brick_slab', '石砖台阶', 'Stone Brick Slab'),
  C('smooth_stone_slab', '平滑石台阶', 'Smooth Stone Slab'),
  C('cobblestone_wall', '圆石墙', 'Cobblestone Wall'),
  C('oak_fence', '橡木栅栏', 'Oak Fence'),
  C('oak_door', '橡木门', 'Oak Door'),
  C('oak_trapdoor', '橡木活板门', 'Oak Trapdoor'),
  C('glass', '玻璃', 'Glass'),
  C('glass_pane', '玻璃板', 'Glass Pane'),
  C('white_stained_glass', '白色染色玻璃', 'White Stained Glass'),
  C('white_concrete', '白色混凝土', 'White Concrete'),
  C('gray_concrete', '灰色混凝土', 'Gray Concrete'),
  C('black_concrete', '黑色混凝土', 'Black Concrete'),
  C('white_wool', '白色羊毛', 'White Wool'),
  C('terracotta', '陶瓦', 'Terracotta'),
  C('dirt', '泥土', 'Dirt'),
  C('grass_block', '草方块', 'Grass Block'),
  C('sand', '沙子', 'Sand'),
  C('gravel', '沙砾', 'Gravel'),
  C('water', '水', 'Water'),
  C('lantern', '灯笼', 'Lantern'),
  C('torch', '火把', 'Torch'),
  C('sea_lantern', '海晶灯', 'Sea Lantern'),
  C('glowstone', '荧石', 'Glowstone'),
  C('dark_prismarine', '暗海晶石', 'Dark Prismarine'),
  C('copper_block', '铜块', 'Block of Copper'),
  C('copper_bulb', '铜灯', 'Copper Bulb'),
  C('iron_block', '铁块', 'Block of Iron'),
  C('redstone_block', '红石块', 'Block of Redstone'),
  C('redstone_wire', '红石线', 'Redstone Wire'),
  C('repeater', '红石中继器', 'Redstone Repeater'),
  C('comparator', '红石比较器', 'Redstone Comparator'),
  C('observer', '侦测器', 'Observer'),
  C('piston', '活塞', 'Piston'),
  C('sticky_piston', '黏性活塞', 'Sticky Piston'),
  C('hopper', '漏斗', 'Hopper'),
  C('chest', '箱子', 'Chest'),
  C('barrel', '木桶', 'Barrel'),
  C('crafter', '合成器', 'Crafter'),
  C('dropper', '投掷器', 'Dropper'),
  C('dispenser', '发射器', 'Dispenser'),
  C('slime_block', '黏液块', 'Slime Block'),
  C('honey_block', '蜂蜜块', 'Honey Block'),
  C('target', '标靶', 'Target'),
  C('lever', '拉杆', 'Lever'),
  C('structure_void', '结构空位', 'Structure Void'),
  C('air', '空气', 'Air')
];

export const DEFAULT_HOTBAR: string[] = [
  'minecraft:stone_bricks',
  'minecraft:oak_planks',
  'minecraft:glass',
  'minecraft:oak_stairs',
  'minecraft:oak_slab',
  'minecraft:oak_log',
  'minecraft:white_concrete',
  'minecraft:lantern',
  'minecraft:redstone_wire'
];

/** Ranks catalogue entries for a query; matches id, English and Chinese names. */
export function searchBlocks(catalog: CatalogBlock[], query: string, limit = 40): CatalogBlock[] {
  const q = query.trim().toLowerCase().replace(/^minecraft:/, '');
  if (!q) return catalog.slice(0, limit);
  const scored: Array<{ b: CatalogBlock; s: number }> = [];
  for (const b of catalog) {
    const short = b.id.replace(/^minecraft:/, '').toLowerCase();
    const en = b.nameEn.toLowerCase();
    let s = -1;
    if (short === q || b.nameZh === query.trim()) s = 0;
    else if (short.startsWith(q)) s = 1;
    else if (b.nameZh.includes(query.trim())) s = 2;
    else if (short.includes(q)) s = 3;
    else if (en.includes(q)) s = 4;
    else if (b.id.toLowerCase().includes(q)) s = 5;
    if (s >= 0) scored.push({ b, s });
  }
  scored.sort((a, b) => a.s - b.s || a.b.id.length - b.b.id.length);
  return scored.slice(0, limit).map((x) => x.b);
}

/** Merges catalogues, first occurrence of an id wins (registry names beat the built-in list). */
export function mergeCatalogs(...lists: CatalogBlock[][]): CatalogBlock[] {
  const seen = new Map<string, CatalogBlock>();
  for (const list of lists) {
    for (const b of list) {
      if (!seen.has(b.id)) seen.set(b.id, b);
    }
  }
  return [...seen.values()];
}
