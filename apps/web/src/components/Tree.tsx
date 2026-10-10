import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { GraphNode } from '@atlas/schema';
import { useViewer } from '../app/context';
import { ROLE_LABEL } from '../app/model';

/**
 * Repository tree (plan §12.4): one tab stop with roving focus, arrow-key navigation,
 * expand/collapse, Enter to select, and ARIA level/position so screen readers announce
 * structure. Only expanded branches are rendered.
 */
interface Row {
  node: GraphNode;
  level: number;
  setSize: number;
  position: number;
  parentId: string | null;
  container: boolean;
}

const ROLE_GLYPH: Record<string, string> = { source: '◼', test: '◆', config: '⚙', declaration: '◇', asset: '◎', opaque: '▫' };

export function Tree() {
  const { model, state, dispatch, select } = useViewer();
  const [focusedId, setFocusedId] = useState<string | null>(state.selectedId);
  const refs = useRef(new Map<string, HTMLLIElement>());

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (parentId: string, level: number) => {
      const children = (model.index.children.get(parentId) ?? []).filter((n) => n.kind === 'package' || n.kind === 'directory' || n.kind === 'file');
      // The root package (the repository's own files) leads; workspace packages follow.
      if (level === 1) children.sort((a, b) => Number(a.kind === 'package' && a.path !== '') - Number(b.kind === 'package' && b.path !== ''));
      children.forEach((node, i) => {
        const container = node.kind !== 'file';
        out.push({ node, level, setSize: children.length, position: i + 1, parentId: level === 1 ? null : parentId, container });
        if (container && state.expanded.has(node.id)) walk(node.id, level + 1);
      });
    };
    walk(model.index.root.id, 1);
    return out;
  }, [model, state.expanded]);

  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.node.id, i])), [rows]);
  const activeId = focusedId && rowIndex.has(focusedId) ? focusedId : (state.selectedId && rowIndex.has(state.selectedId) ? state.selectedId : rows[0]?.node.id) ?? null;

  // Selection made elsewhere (search, links) moves the tree's focus target and scrolls to it.
  useEffect(() => {
    if (state.selectedId && rowIndex.has(state.selectedId)) {
      setFocusedId(state.selectedId);
      refs.current.get(state.selectedId)?.scrollIntoView({ block: 'nearest' });
    }
  }, [state.selectedId, rowIndex]);

  const focus = (id: string | undefined) => {
    if (!id) return;
    setFocusedId(id);
    const element = refs.current.get(id);
    element?.focus();
    element?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!activeId) return;
    const index = rowIndex.get(activeId)!;
    const row = rows[index]!;
    const expanded = state.expanded.has(row.node.id);
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        focus(rows[Math.min(rows.length - 1, index + 1)]?.node.id);
        break;
      case 'ArrowUp':
        focus(rows[Math.max(0, index - 1)]?.node.id);
        break;
      case 'Home':
        focus(rows[0]?.node.id);
        break;
      case 'End':
        focus(rows.at(-1)?.node.id);
        break;
      case 'ArrowRight':
        if (row.container && !expanded) dispatch({ type: 'toggle', id: row.node.id, open: true });
        else if (row.container) focus(rows[index + 1]?.level === row.level + 1 ? rows[index + 1]!.node.id : undefined);
        break;
      case 'ArrowLeft':
        if (row.container && expanded) dispatch({ type: 'toggle', id: row.node.id, open: false });
        else if (row.parentId) focus(row.parentId);
        break;
      case 'Enter':
      case ' ':
        select(row.node.id);
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  return (
    <ul className="tree" role="tree" aria-label="Repository files" onKeyDown={onKeyDown}>
      {rows.map((row) => {
        const { node } = row;
        const selected = node.id === state.selectedId;
        const findings = model.diagnosticCount(node.id);
        const expanded = row.container ? state.expanded.has(node.id) : undefined;
        const name = node.kind === 'package' ? (node.packageName ?? (node.path || model.manifest.repo.displayName)) : node.label;
        return (
          <li
            key={node.id}
            ref={(el) => {
              if (el) refs.current.set(node.id, el);
              else refs.current.delete(node.id);
            }}
            role="treeitem"
            aria-level={row.level}
            aria-setsize={row.setSize}
            aria-posinset={row.position}
            aria-selected={selected}
            {...(expanded !== undefined ? { 'aria-expanded': expanded } : {})}
            tabIndex={node.id === activeId ? 0 : -1}
            className={`tree-row${selected ? ' selected' : ''} kind-${node.kind}`}
            style={{ paddingInlineStart: `${(row.level - 1) * 14 + 8}px` }}
            onClick={() => {
              setFocusedId(node.id);
              if (row.container && !selected) dispatch({ type: 'toggle', id: node.id, open: true });
              select(node.id);
            }}
            onFocus={() => setFocusedId(node.id)}
          >
            <span
              className={`twisty${row.container ? '' : ' leaf'}`}
              aria-hidden="true"
              onClick={(e) => {
                if (!row.container) return;
                e.stopPropagation();
                dispatch({ type: 'toggle', id: node.id });
              }}
            >
              {row.container ? (expanded ? '▾' : '▸') : ''}
            </span>
            <span className={`glyph role-${node.kind === 'file' ? node.role : node.kind}`} aria-hidden="true">
              {node.kind === 'file' ? ROLE_GLYPH[node.role] : node.kind === 'package' ? '▣' : '▤'}
            </span>
            <span className="tree-name">{name}</span>
            {node.kind === 'file' && node.role !== 'source' && <span className="sr-only">, {ROLE_LABEL[node.role]}</span>}
            {findings > 0 && (
              <span className="tree-findings" title={`${findings} finding${findings === 1 ? '' : 's'}`}>
                <span aria-hidden="true">{findings}</span>
                <span className="sr-only">
                  , {findings} finding{findings === 1 ? '' : 's'}
                </span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
