import React, { useEffect, useMemo, useRef, useState } from 'react';
import { type CatalogBlock, searchBlocks } from './block-catalog.js';

export interface BlockPickerProps {
  value: string;
  onChange: (state: string) => void;
  catalog: CatalogBlock[];
  placeholder?: string;
  /** Display name for the current value (shown under the field). */
  displayName?: string;
  autoFocus?: boolean;
}

/**
 * Searchable block field: type an id, an English or a Chinese name, pick with arrows + Enter.
 * A full block state such as `oak_stairs[facing=east]` can still be typed by hand.
 */
export function BlockPicker({ value, onChange, catalog, placeholder, displayName, autoFocus }: BlockPickerProps) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setDraft(value), [value]);

  const results = useMemo(() => {
    const q = draft.includes('[') ? draft.slice(0, draft.indexOf('[')) : draft;
    return searchBlocks(catalog, q === value ? '' : q, 30);
  }, [catalog, draft, value]);

  useEffect(() => setHi(0), [draft]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setDraft(value);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [value]);

  const commit = (state: string) => {
    const v = state.trim();
    if (!v) return;
    onChange(v.includes(':') || v.includes('[') ? v : `minecraft:${v}`);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="mcvis-picker">
      <input
        className="mcvis-input mcvis-mono"
        style={{ width: '100%' }}
        value={draft}
        autoFocus={autoFocus}
        placeholder={placeholder ?? '搜索方块：ID、中文或英文名'}
        onFocus={(e) => {
          setOpen(true);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHi((h) => Math.min(results.length - 1, h + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi((h) => Math.max(0, h - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            // A hand-typed state with properties wins over the suggestion list
            if (draft.includes('[') || results.length === 0) commit(draft);
            else commit(results[hi]!.id);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(value);
            setOpen(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {displayName && !open && <div className="mcvis-picker-caption">{displayName}</div>}
      {open && results.length > 0 && (
        <div className="mcvis-picker-list" role="listbox">
          {results.map((b, i) => (
            <div
              key={b.id}
              role="option"
              aria-selected={i === hi}
              className={`mcvis-picker-item ${i === hi ? 'hi' : ''}`}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(b.id);
              }}
            >
              <span>{b.nameZh || b.nameEn}</span>
              <span className="mcvis-mono">{b.id.replace(/^minecraft:/, '')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
