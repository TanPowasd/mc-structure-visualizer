import React, { useMemo, useState } from 'react';
import { ArrowDownUp, BoxSelect, Crop, Eraser, Expand, PaintBucket, Square, Wind } from 'lucide-react';
import {
  type BoxRange,
  type Vec3,
  VoxelEditorSession,
  computeSolidBounds,
  countBlockUsage,
  formatBlockState,
  normalizeNamespace
} from '@mcvis/core';
import type { PickedVoxelInfo } from '@mcvis/renderer';
import { BlockPicker } from './BlockPicker.js';
import type { CatalogBlock } from './block-catalog.js';

export type ReplaceToolMode = 'single' | 'connected' | 'all';

export interface EditPanelProps {
  session: VoxelEditorSession | null;
  /** Bumped after every edit so derived numbers refresh */
  version: number;
  catalog: CatalogBlock[];
  displayName: (id: string) => string;

  brush: string;
  setBrush: (s: string) => void;
  hotbar: string[];
  activeSlot: number;
  onSelectSlot: (i: number) => void;
  onAssignSlot: (i: number, state: string) => void;

  picked: PickedVoxelInfo | null;
  selection: BoxRange | null;
  setSelection: (b: BoxRange | null) => void;

  replaceMode: ReplaceToolMode;
  setReplaceMode: (m: ReplaceToolMode) => void;
  keepProps: boolean;
  setKeepProps: (v: boolean) => void;

  exportSkipAir: boolean;
  setExportSkipAir: (v: boolean) => void;

  /** Called after the session changed. `shift` is non-zero when the canvas grew on -x/-y/-z. */
  onEdited: (message: string | null, shift?: Vec3) => void;
}

const boxVolume = (b: BoxRange) =>
  (b.max.x - b.min.x + 1) * (b.max.y - b.min.y + 1) * (b.max.z - b.min.z + 1);

export function EditPanel(p: EditPanelProps) {
  const { session } = p;
  // null = default to the most used block in the build
  const [replaceFromRaw, setReplaceFrom] = useState<string | null>(null);
  const [replaceTo, setReplaceTo] = useState<string | null>(null); // null = follow brush
  const [exactState, setExactState] = useState(false);
  const [onlySelection, setOnlySelection] = useState(false);
  const [showAllUsage, setShowAllUsage] = useState(false);
  const [padAmount, setPadAmount] = useState(4);

  const target = replaceTo ?? p.brush;
  const region = session?.getPrimaryRegion() ?? null;

  const usage = useMemo(() => (region ? countBlockUsage(region) : []), [region, p.version]);
  const replaceFrom = replaceFromRaw ?? usage[0]?.name ?? 'minecraft:stone';

  const airInfo = useMemo(() => {
    if (!region) return null;
    const perIdx = new Uint32Array(region.palette.length);
    for (let i = 0; i < region.blocks.length; i++) perIdx[region.blocks[i]!]!++;
    let air = 0,
      variants = 0,
      voids = 0;
    region.palette.forEach((st, i) => {
      const n = normalizeNamespace(st.name);
      if (n === 'minecraft:air') air += perIdx[i]!;
      else if (n === 'minecraft:cave_air' || n === 'minecraft:void_air') variants += perIdx[i]!;
      else if (n === 'minecraft:structure_void') voids += perIdx[i]!;
    });
    const total = region.blocks.length;
    return { total, air, variants, voids, solid: computeSolidBounds(region), size: region.size };
  }, [region, p.version]);

  const matchCount = useMemo(() => {
    if (!region) return 0;
    const name = normalizeNamespace(replaceFrom.split('[')[0]!);
    if (exactState) {
      const u = usage.find((x) => x.name === name);
      if (!u) return 0;
      // exact count needs a scan; cheap enough for previews
      let n = 0;
      const full = formatBlockState({
        name,
        properties: Object.fromEntries(
          (replaceFrom.match(/\[(.*)\]/)?.[1] ?? '')
            .split(',')
            .filter(Boolean)
            .map((kv) => kv.split('=').map((s) => s.trim()) as [string, string])
        )
      });
      const hit = new Set<number>();
      region.palette.forEach((st, i) => {
        if (formatBlockState(st) === full) hit.add(i);
      });
      for (let i = 0; i < region.blocks.length; i++) if (hit.has(region.blocks[i]!)) n++;
      return n;
    }
    return usage.find((x) => x.name === name)?.count ?? 0;
  }, [region, usage, replaceFrom, exactState]);

  if (!session || !region || !airInfo) return null;

  const run = (fn: () => number | Vec3 | null, msg: (n: number) => string, emptyMsg: string) => {
    const r = fn();
    const n = typeof r === 'number' ? r : r ? 1 : 0;
    p.onEdited(n > 0 ? msg(n) : emptyMsg);
  };

  const sel = p.selection;
  const solid = airInfo.solid;
  const airPct = Math.round(((airInfo.air + airInfo.variants + airInfo.voids) / airInfo.total) * 100);
  const trimmable =
    !!solid &&
    (solid.min.x > 0 ||
      solid.min.y > 0 ||
      solid.min.z > 0 ||
      solid.max.x < region.size.x - 1 ||
      solid.max.y < region.size.y - 1 ||
      solid.max.z < region.size.z - 1);

  return (
    <>
      {/* ── Brush & hotbar ─────────────────────────── */}
      <div className="mcvis-card">
        <div className="mcvis-card-title">
          <span>画笔</span>
          <span className="mcvis-hint">1–9 切换 · 视口 Alt+点击吸取</span>
        </div>
        <BlockPicker
          value={p.brush}
          onChange={(v) => {
            p.setBrush(v);
            p.onAssignSlot(p.activeSlot, v);
          }}
          catalog={p.catalog}
          displayName={p.displayName(p.brush)}
        />
        <div className="mcvis-hotbar">
          {p.hotbar.map((st, i) => (
            <button
              key={i}
              type="button"
              className={`mcvis-hotbar-slot ${i === p.activeSlot ? 'active' : ''}`}
              title={`${i + 1}: ${st}`}
              onClick={() => p.onSelectSlot(i)}
            >
              <span className="mcvis-hotbar-key">{i + 1}</span>
              <span className="mcvis-hotbar-name">{shortName(p.displayName(st), st)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Selection ──────────────────────────────── */}
      <div className="mcvis-card">
        <div className="mcvis-card-title">
          <span>选区</span>
          <span className="mcvis-hint">S 框选：点两个角 · Esc 取消</span>
        </div>
        {sel ? (
          <>
            <div className="mcvis-kv-row">
              <span>范围</span>
              <span className="mcvis-mono">
                [{sel.min.x},{sel.min.y},{sel.min.z}] → [{sel.max.x},{sel.max.y},{sel.max.z}]
              </span>
            </div>
            <div className="mcvis-kv-row" style={{ marginBottom: 8 }}>
              <span>尺寸</span>
              <span className="mcvis-mono">
                {sel.max.x - sel.min.x + 1} × {sel.max.y - sel.min.y + 1} × {sel.max.z - sel.min.z + 1} ·{' '}
                {boxVolume(sel).toLocaleString()} 格
              </span>
            </div>
            <div className="mcvis-btn-grid">
              <button
                className="mcvis-btn"
                title="用画笔填满选区 (F)"
                onClick={() =>
                  run(() => session.fillBox(sel.min, sel.max, p.brush, `Fill ${p.brush}`), (n) => `已填充 ${n} 格`, '选区已经是这个方块')
                }
              >
                <PaintBucket size={13} />
                填充
              </button>
              <button
                className="mcvis-btn"
                title="只铺选区的六个面，内部保持不变"
                onClick={() =>
                  run(() => session.outlineBox(sel.min, sel.max, p.brush), (n) => `已铺 ${n} 格外壳`, '外壳已经是这个方块')
                }
              >
                <Square size={13} />
                外壳
              </button>
              <button
                className="mcvis-btn"
                title="把选区清成空气 (Delete)"
                onClick={() => run(() => session.clearBox(sel.min, sel.max), (n) => `已清空 ${n} 格`, '选区里没有方块')}
              >
                <Eraser size={13} />
                清空
              </button>
              <button className="mcvis-btn" onClick={() => p.setSelection(null)}>
                取消选区
              </button>
            </div>
          </>
        ) : (
          <div className="mcvis-btn-grid">
            <button
              className="mcvis-btn"
              onClick={() =>
                p.setSelection({
                  min: { x: 0, y: 0, z: 0 },
                  max: { x: region.size.x - 1, y: region.size.y - 1, z: region.size.z - 1 }
                })
              }
            >
              <BoxSelect size={13} />
              全选画布
            </button>
            {solid && (
              <button className="mcvis-btn" onClick={() => p.setSelection(solid)}>
                选中建筑包围盒
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Quick replace ──────────────────────────── */}
      <div className="mcvis-card">
        <div className="mcvis-card-title">
          <span>快速替换</span>
          <span className="mcvis-hint">R 替换工具：点哪换哪</span>
        </div>

        <div className="mcvis-seg" style={{ marginBottom: 8 }}>
          {(
            [
              ['single', '单个'],
              ['connected', '相连同类'],
              ['all', '全部同类']
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              className={`mcvis-btn ${p.replaceMode === m ? 'active' : ''}`}
              onClick={() => p.setReplaceMode(m)}
              title="替换工具在视口点击时的作用范围"
            >
              {label}
            </button>
          ))}
        </div>

        {p.picked && (
          <div className="mcvis-picked-actions">
            <div className="mcvis-hint" style={{ marginBottom: 6 }}>
              选中的 <b>{p.displayName(p.picked.state.name)}</b> 换成画笔 <b>{p.displayName(p.brush)}</b>
            </div>
            <div className="mcvis-btn-grid three">
              <button
                className="mcvis-btn"
                onClick={() => {
                  const pos = p.picked!.blockPos;
                  run(
                    () => session.replaceConnected(pos, p.brush, p.keepProps, 1),
                    () => '已替换这一块',
                    '没有变化'
                  );
                }}
              >
                这一块
              </button>
              <button
                className="mcvis-btn"
                onClick={() =>
                  run(
                    () => session.replaceConnected(p.picked!.blockPos, p.brush, p.keepProps),
                    (n) => `已替换相连的 ${n} 块`,
                    '没有变化'
                  )
                }
              >
                相连同类
              </button>
              <button
                className="mcvis-btn"
                onClick={() =>
                  run(
                    () =>
                      session.replaceBlock(p.picked!.state.name, p.brush, {
                        keepProperties: p.keepProps,
                        box: onlySelection && sel ? sel : undefined
                      }),
                    (n) => `已替换 ${n} 块`,
                    '没有变化'
                  )
                }
              >
                全部同类
              </button>
            </div>
          </div>
        )}

        <div className="mcvis-field-label">源方块</div>
        <BlockPicker
          value={replaceFrom}
          onChange={setReplaceFrom}
          catalog={p.catalog}
          displayName={`${p.displayName(replaceFrom.split('[')[0]!)} · 结构中 ${matchCount.toLocaleString()} 块`}
        />
        <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0' }}>
          <button
            className="mcvis-btn mcvis-icon-btn"
            title="交换源和目标"
            onClick={() => {
              const a = replaceFrom;
              setReplaceFrom(target);
              setReplaceTo(a);
            }}
          >
            <ArrowDownUp size={13} />
          </button>
        </div>
        <div className="mcvis-field-label">
          替换为
          {replaceTo !== null && (
            <button className="mcvis-link" onClick={() => setReplaceTo(null)}>
              跟随画笔
            </button>
          )}
        </div>
        <BlockPicker
          value={target}
          onChange={setReplaceTo}
          catalog={p.catalog}
          displayName={replaceTo === null ? `${p.displayName(target)} · 跟随画笔` : p.displayName(target)}
        />

        <div className="mcvis-checks">
          <label title="楼梯换楼梯、台阶换台阶时保留朝向、上下半等属性">
            <input type="checkbox" checked={p.keepProps} onChange={(e) => p.setKeepProps(e.target.checked)} />
            保留朝向等属性
          </label>
          <label title="只替换方块状态完全一致的方块，例如只换朝东的楼梯">
            <input type="checkbox" checked={exactState} onChange={(e) => setExactState(e.target.checked)} />
            精确匹配状态
          </label>
          <label title={sel ? '' : '先用 S 框选一个区域'} style={{ opacity: sel ? 1 : 0.5 }}>
            <input
              type="checkbox"
              disabled={!sel}
              checked={onlySelection && !!sel}
              onChange={(e) => setOnlySelection(e.target.checked)}
            />
            仅选区内
          </label>
        </div>

        <button
          className="mcvis-btn primary"
          style={{ width: '100%' }}
          disabled={matchCount === 0}
          onClick={() =>
            run(
              () =>
                session.replaceBlock(replaceFrom, target, {
                  matchProperties: exactState,
                  keepProperties: p.keepProps,
                  box: onlySelection && sel ? sel : undefined
                }),
              (n) => `已替换 ${n} 块`,
              '没有可替换的方块'
            )
          }
        >
          替换{matchCount > 0 ? ` ${matchCount.toLocaleString()} 块` : ''}
        </button>

        <div className="mcvis-field-label" style={{ marginTop: 12 }}>
          结构中的方块 · 点一行设为源方块
        </div>
        <div className="mcvis-usage">
          {(showAllUsage ? usage : usage.slice(0, 10)).map((u) => (
            <div
              key={u.name}
              className={`mcvis-usage-row ${normalizeNamespace(replaceFrom.split('[')[0]!) === u.name ? 'on' : ''}`}
              onClick={() => setReplaceFrom(u.name)}
              title={u.states.join('\n')}
            >
              <span className="mcvis-usage-name">{p.displayName(u.name)}</span>
              <span className="mcvis-mono mcvis-usage-id">{u.name.replace(/^minecraft:/, '')}</span>
              <span className="mcvis-mono">{u.count.toLocaleString()}</span>
              <button
                className="mcvis-link"
                title="设为画笔"
                onClick={(e) => {
                  e.stopPropagation();
                  p.setBrush(u.states[0]!);
                  p.onAssignSlot(p.activeSlot, u.states[0]!);
                }}
              >
                画笔
              </button>
            </div>
          ))}
          {usage.length > 10 && (
            <button className="mcvis-link" style={{ padding: '6px 0' }} onClick={() => setShowAllUsage((v) => !v)}>
              {showAllUsage ? '收起' : `显示全部 ${usage.length} 种`}
            </button>
          )}
        </div>
      </div>

      {/* ── Air culling ────────────────────────────── */}
      <div className="mcvis-card">
        <div className="mcvis-card-title">
          <span>空气剔除</span>
          <span className="mcvis-hint">空气占画布 {airPct}%</span>
        </div>
        <div className="mcvis-kv-row">
          <span>画布</span>
          <span className="mcvis-mono">
            {region.size.x} × {region.size.y} × {region.size.z}
          </span>
        </div>
        <div className="mcvis-kv-row">
          <span>建筑实际包围盒</span>
          <span className="mcvis-mono">
            {solid
              ? `${solid.max.x - solid.min.x + 1} × ${solid.max.y - solid.min.y + 1} × ${solid.max.z - solid.min.z + 1}`
              : '空'}
          </span>
        </div>
        <div className="mcvis-kv-row">
          <span>空气 / 洞穴虚空空气 / 结构空位</span>
          <span className="mcvis-mono">
            {airInfo.air.toLocaleString()} / {airInfo.variants.toLocaleString()} / {airInfo.voids.toLocaleString()}
          </span>
        </div>

        <div className="mcvis-btn-grid" style={{ marginTop: 8 }}>
          <button
            className="mcvis-btn"
            disabled={!trimmable}
            title="去掉建筑四周整层都是空气的部分，画布收紧到实际包围盒"
            onClick={() => {
              const before = { ...region.size };
              const solidMin = solid ? { ...solid.min } : { x: 0, y: 0, z: 0 };
              const size = session.trimAir();
              p.onEdited(
                size
                  ? `已裁掉四周空气：${before.x}×${before.y}×${before.z} → ${size.x}×${size.y}×${size.z}`
                  : '四周没有可裁的空气',
                size ? { x: -solidMin.x, y: -solidMin.y, z: -solidMin.z } : undefined
              );
            }}
          >
            <Crop size={13} />
            裁掉四周空气
          </button>
          <button
            className="mcvis-btn"
            disabled={airInfo.variants === 0}
            title="把 cave_air / void_air 统一成普通空气"
            onClick={() =>
              run(
                () => session.convertAir(['minecraft:cave_air', 'minecraft:void_air'], 'minecraft:air', 'Normalize Air'),
                (n) => `已统一 ${n} 格空气`,
                '没有洞穴/虚空空气'
              )
            }
          >
            <Wind size={13} />
            统一空气变体
          </button>
          <button
            className="mcvis-btn"
            disabled={airInfo.air + airInfo.variants === 0}
            title="空气变成结构空位：用结构方块粘贴时不会挖掉原有地形"
            onClick={() =>
              run(
                () =>
                  session.convertAir(
                    ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'],
                    'minecraft:structure_void',
                    'Air -> Structure Void'
                  ),
                (n) => `已把 ${n} 格空气转成结构空位`,
                '没有空气'
              )
            }
          >
            空气 → 结构空位
          </button>
          <button
            className="mcvis-btn"
            disabled={airInfo.voids === 0}
            onClick={() =>
              run(
                () => session.convertAir(['minecraft:structure_void'], 'minecraft:air', 'Structure Void -> Air'),
                (n) => `已把 ${n} 格结构空位还原成空气`,
                '没有结构空位'
              )
            }
          >
            结构空位 → 空气
          </button>
        </div>

        <div className="mcvis-inline" style={{ marginTop: 8 }}>
          <span>四周扩展</span>
          <input
            className="mcvis-input mcvis-mono"
            type="number"
            min={1}
            max={64}
            value={padAmount}
            style={{ width: 56 }}
            onChange={(e) => setPadAmount(Math.max(1, Math.min(64, Number(e.target.value) || 1)))}
          />
          <span>格</span>
          <button
            className="mcvis-btn"
            style={{ marginLeft: 'auto' }}
            title="水平四周和上方各加空白，方便继续往外搭"
            onClick={() => {
              const n = padAmount;
              const size = session.expandCanvas({ x: n, y: 0, z: n }, { x: n, y: n, z: n });
              p.onEdited(size ? `画布扩展到 ${size.x}×${size.y}×${size.z}` : null, { x: n, y: 0, z: n });
            }}
          >
            <Expand size={13} />
            扩展画布
          </button>
        </div>

        <label className="mcvis-checks" style={{ marginTop: 8, display: 'flex' }}>
          <input type="checkbox" checked={p.exportSkipAir} onChange={(e) => p.setExportSkipAir(e.target.checked)} />
          <span>
            导出时剔除空气
            <span className="mcvis-hint" style={{ display: 'block' }}>
              .nbt 与 F3+I 指令不写入空气，粘贴时不覆盖原地形；其它格式统一空气变体
            </span>
          </span>
        </label>
      </div>
    </>
  );
}

function shortName(display: string, id: string): string {
  if (display && display !== id && !display.includes(':')) return display.length > 4 ? display.slice(0, 4) : display;
  const short = id.replace(/^minecraft:/, '').split('[')[0]!;
  return short.length > 7 ? short.slice(0, 7) : short;
}
