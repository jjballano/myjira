import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useApp, useIssueActions, useLocalStorage } from '../hooks';
import { toast } from '../toast';
import type { Column, Issue, ParentRef } from '../types';
import { colorFor, typeColor } from '../util';
import { Icon, PriorityIcon, StatusIcon } from './icons';
import { CardMenu, rankMoves, type MenuState } from './CardMenu';
import { AssigneePicker, LabelChips } from './Pickers';
import { Progress } from './Progress';
import type { Group } from './SprintView';
import { statusesOf } from './StatusFilter';

/**
 * Board columns from the Jira board config, or one per status seen when that isn't loaded yet.
 * Columns named in `split` become one column per status.
 */
function useColumns(columns: Column[] | undefined, issues: Issue[], split: string[]): Column[] {
  return useMemo(() => {
    const mapped = columns
      ?.filter((c) => c.statusIds.length)
      .flatMap((c) =>
        c.statusIds.length > 1 && split.includes(c.name)
          ? c.statusIds.map((id, i) => ({ name: c.statusNames?.[i] ?? id, statusIds: [id], splitFrom: c.name }))
          : [c],
      );
    if (mapped?.length) return mapped;
    const seen = new Map<string, Column>();
    for (const i of issues) if (i.status && !seen.has(i.status.id)) seen.set(i.status.id, { name: i.status.name, statusIds: [i.status.id] });
    return [...seen.values()];
  }, [columns, issues, split]);
}

type DropPos = 'before' | 'after';

const colKey = (c: Column) => c.statusIds.join(',');

/**
 * Applies the user's saved column order. Columns it doesn't know (a column just split or joined,
 * or one added in Jira) go right after the column that precedes them in Jira's order.
 */
function applyOrder(cols: Column[], order: string[]): Column[] {
  if (!order.length) return cols;
  const out = order.map((k) => cols.find((c) => colKey(c) === k)).filter((c): c is Column => !!c);
  cols.forEach((c, i) => {
    if (out.includes(c)) return;
    const prev = cols[i - 1];
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, c);
  });
  return out;
}

/** Subtasks of the hovered story that are scrolled out of view, counted per column and direction. */
interface Offscreen {
  id: string;
  dir: 'up' | 'down';
  count: number;
  left: number;
  width: number;
  top: number;
  bottom: number;
}

/** What is being dragged. A "unit" is a story card or placeholder together with its subtasks. */
interface DragState {
  key: string;
  kind: 'card' | 'placeholder' | 'subtask';
  /** Issue whose rank changes: the card itself, or the story behind a placeholder. */
  rankKey: string;
  parentKey?: string;
  /** Cards never leave their swimlane. */
  laneId: string;
  cellId: string;
  colIdx: number;
}

interface DropAt {
  /** Unit id or subtask key the indicator is drawn on. */
  id: string;
  pos: DropPos;
  target: string;
  cellId: string;
}

/**
 * A cell is a list of units in rank order: each story/task card followed by its own subtasks,
 * and, for subtasks whose story sits in another column (or outside the sprint), a placeholder
 * for that story heading them, so they never look like children of an unrelated card.
 */
interface Unit {
  id: string;
  head: { kind: 'card'; issue: Issue } | { kind: 'placeholder'; parent: ParentRef };
  subs: Issue[];
}

function arrange(list: Issue[], rankOf: (key: string) => number): Unit[] {
  const inCell = new Set(list.map((i) => i.key));
  const subs = new Map<string, Issue[]>();
  for (const i of list) {
    if (i.issuetype?.subtask && i.parent) subs.set(i.parent.key, [...(subs.get(i.parent.key) ?? []), i]);
  }
  const units: (Unit & { rank: number })[] = [];
  for (const i of list) {
    if (i.issuetype?.subtask && i.parent) continue;
    units.push({ id: i.key, head: { kind: 'card', issue: i }, subs: subs.get(i.key) ?? [], rank: rankOf(i.key) });
  }
  for (const [parentKey, children] of subs) {
    if (inCell.has(parentKey)) continue;
    units.push({ id: `p:${parentKey}`, head: { kind: 'placeholder', parent: children[0]!.parent! }, subs: children, rank: rankOf(parentKey) });
  }
  return units.sort((a, b) => (a.rank === b.rank ? 0 : a.rank - b.rank));
}

function dropPos(e: React.DragEvent): DropPos {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
}

function FoldToggle({
  folded,
  onToggle,
  onHover,
  children,
}: {
  folded: boolean;
  onToggle: () => void;
  onHover: (on: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      className="card-subtasks"
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon.Chevron open={!folded} size={10} />
      {children}
    </button>
  );
}

/** "N pendientes · de M" over every subtask of the story, with a per-status breakdown on hover. */
function SubtaskStats({ subtasks, columns }: { subtasks: Issue[]; columns: Column[] }) {
  const { openIssue } = useApp();
  const pending = subtasks.filter((s) => s.status?.category !== 'done').length;
  return (
    <span className="subtask-stats">
      {pending} {pending === 1 ? 'pendiente' : 'pendientes'} <span className="muted">· de {subtasks.length}</span>
      <span className="tooltip">
        <span className="tooltip-row tooltip-total">
          <span>Total</span>
          <span>{subtasks.length}</span>
        </span>
        {statusesOf(subtasks, columns).map((s) => {
          const inStatus = subtasks.filter((x) => x.status?.id === s.id);
          return (
            <span key={s.id} className={`tooltip-row${s.category !== 'done' ? ' has-sub' : ''}`}>
              <span className="tooltip-status">
                <StatusIcon status={s} size={12} /> {s.name}
              </span>
              <span>{inStatus.length}</span>
              {/* Pending subtasks are listed on hover; spans, since this sits inside the fold button. */}
              {s.category !== 'done' && (
                <span className="tooltip tooltip-sub">
                  {inStatus.map((x) => (
                    <span
                      key={x.key}
                      role="link"
                      className="tooltip-row tooltip-link"
                      title={x.key}
                      onClick={(e) => {
                        e.stopPropagation();
                        openIssue(x.key);
                      }}
                    >
                      <span className="ellipsis">{x.summary}</span>
                    </span>
                  ))}
                </span>
              )}
            </span>
          );
        })}
      </span>
    </span>
  );
}

interface DragProps {
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  dropPos?: DropPos | null;
  onContextMenu?: (e: React.MouseEvent) => void;
}

function ParentPlaceholder({
  parent,
  allSubtasks,
  columns,
  folded,
  onToggle,
  onHover,
  onSubtasksHover,
  draggable,
  drag,
}: {
  parent: ParentRef;
  allSubtasks: Issue[];
  columns: Column[];
  folded: boolean;
  onToggle: () => void;
  onHover: (key: string | null) => void;
  onSubtasksHover: (on: boolean) => void;
  draggable: boolean;
  drag: DragProps;
}) {
  const { openIssue } = useApp();
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`cell-parent${dragging ? ' dragging' : ''}`}
      style={{ '--type': typeColor(parent.issuetype) } as CSSProperties}
      title={`${parent.key} · ${parent.summary}`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', parent.key);
        setDragging(true);
        drag.onDragStart();
      }}
      onDragEnd={() => {
        setDragging(false);
        drag.onDragEnd();
      }}
      onMouseEnter={() => onHover(parent.key)}
      onMouseLeave={() => onHover(null)}
      onClick={() => openIssue(parent.key)}
    >
      <div className="cell-parent-title">
        <span className="row-key">{parent.key}</span>
        <span className="ellipsis">{parent.summary}</span>
      </div>
      <FoldToggle folded={folded} onToggle={onToggle} onHover={onSubtasksHover}>
        <SubtaskStats subtasks={allSubtasks} columns={columns} />
      </FoldToggle>
    </div>
  );
}

interface CardProps extends DragProps {
  issue: Issue;
  showParent: boolean;
  subtaskCount: number;
  /** Every subtask of this story in the sprint, ignoring filters, for the breakdown tooltip. */
  allSubtasks: Issue[];
  columns: Column[];
  folded: boolean;
  onToggleSubtasks: () => void;
  /** 'flash' after unfolding its story, 'hover' while its placeholder is hovered */
  highlight: 'flash' | 'hover' | null;
  onSubtasksHover?: (on: boolean) => void;
}

function Card({ issue, showParent, subtaskCount, allSubtasks, columns, folded, onToggleSubtasks, highlight, onDragStart, onDragEnd, onDragOver, dropPos, onContextMenu, onSubtasksHover }: CardProps) {
  const { openIssue } = useApp();
  const [dragging, setDragging] = useState(false);
  const subtask = !!issue.issuetype?.subtask;
  return (
    <div
      className={`card${subtask ? ' card-sub' : ''}${dragging ? ' dragging' : ''}${highlight ? ` card-${highlight}` : ''}${dropPos ? ` drop-${dropPos}` : ''}`}
      style={{ '--type': typeColor(issue.issuetype) } as CSSProperties}
      data-key={issue.key}
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', issue.key);
        setDragging(true);
        onDragStart();
      }}
      onDragEnd={() => {
        setDragging(false);
        onDragEnd();
      }}
      onDragOver={onDragOver}
      onContextMenu={onContextMenu}
      onClick={() => openIssue(issue.key)}
    >
      <div className="card-title">{issue.summary}</div>
      {(issue.labels.length > 0 || (showParent && issue.parent && !subtask)) && (
        <div className="card-chips">
          {showParent && issue.parent && !subtask && (
            <span className="chip chip-parent" title={issue.parent.summary}>
              <Icon.Epic color={colorFor(issue.parent.key)} size={10} />
              <span className="ellipsis">{issue.parent.summary}</span>
            </span>
          )}
          <LabelChips labels={issue.labels.slice(0, 2)} />
          {issue.labels.length > 2 && <span className="chip">+{issue.labels.length - 2}</span>}
        </div>
      )}
      <div className="card-foot">
        <span title={issue.status?.name} className="card-status">
          <StatusIcon status={issue.status} size={12} />
        </span>
        <PriorityIcon name={issue.priority?.name} size={12} />
        <span className="row-key">{issue.key}</span>
        <span className="spacer" />
        <AssigneePicker issueKey={issue.key} assignee={issue.assignee} />
      </div>
      {subtaskCount > 0 && (
        <FoldToggle folded={folded} onToggle={onToggleSubtasks} onHover={(on) => onSubtasksHover?.(on)}>
          <SubtaskStats subtasks={allSubtasks} columns={columns} />
        </FoldToggle>
      )}
    </div>
  );
}

export function SprintBoard({
  groups,
  columns: rawColumns,
  issues,
  allIssues,
  collapsed,
  onToggle,
  showParent,
  hiddenStatusIds,
  collapsedStories,
  onToggleStory,
  currentSprintId,
}: {
  groups: Group[];
  columns: Column[] | undefined;
  issues: Issue[];
  allIssues: Issue[];
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  showParent: boolean;
  hiddenStatusIds: string[];
  collapsedStories: string[];
  onToggleStory: (key: string) => void;
  currentSprintId?: number;
}) {
  const qc = useQueryClient();
  const { transition, rank } = useIssueActions();
  const { board } = useApp();
  const [splitStore, setSplitStore] = useLocalStorage<Record<string, string[]>>('splitColumns', {});
  const split = useMemo(() => splitStore[board.id] ?? [], [splitStore, board.id]);
  const toggleSplit = (name: string) =>
    setSplitStore({ ...splitStore, [board.id]: split.includes(name) ? split.filter((n) => n !== name) : [...split, name] });
  const [orderStore, setOrderStore] = useLocalStorage<Record<string, string[]>>('columnOrder', {});
  const order = useMemo(() => orderStore[board.id] ?? [], [orderStore, board.id]);
  const jiraColumns = useColumns(rawColumns, issues, split);
  const allColumns = useMemo(() => applyOrder(jiraColumns, order), [jiraColumns, order]);
  // A column disappears only when every status mapped to it is hidden.
  const columns = useMemo(
    () => allColumns.filter((c) => c.statusIds.some((s) => !hiddenStatusIds.includes(s))),
    [allColumns, hiddenStatusIds],
  );
  const customOrder = order.length > 0 && allColumns.some((c, i) => c !== jiraColumns[i]);

  // Column reordering by dragging headers; independent from card drag & drop.
  const colDrag = useRef<string | null>(null);
  const [colDrop, setColDrop] = useState<{ key: string; pos: DropPos } | null>(null);
  const moveColumn = (from: string, to: string, pos: DropPos) => {
    if (from === to) return;
    const keys = allColumns.map(colKey).filter((k) => k !== from);
    keys.splice(keys.indexOf(to) + (pos === 'after' ? 1 : 0), 0, from);
    setOrderStore({ ...orderStore, [board.id]: keys });
  };
  const resetOrder = () => {
    const { [board.id]: _, ...rest } = orderStore;
    setOrderStore(rest);
  };
  const colOf = useMemo(() => {
    const m = new Map<string, number>();
    columns.forEach((c, idx) => c.statusIds.forEach((s) => m.set(s, idx)));
    return m;
  }, [columns]);
  const byKey = useMemo(() => new Map(issues.map((i) => [i.key, i])), [issues]);
  // Sprint issues arrive in rank order, so their index is their rank.
  const rankIndex = useMemo(() => new Map(allIssues.map((i, idx) => [i.key, idx])), [allIssues]);
  const rankOf = (key: string) => rankIndex.get(key) ?? Number.MAX_SAFE_INTEGER;

  const subtasksOf = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const i of issues) if (i.issuetype?.subtask && i.parent) m.set(i.parent.key, [...(m.get(i.parent.key) ?? []), i]);
    return m;
  }, [issues]);
  const allSubtasksOf = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const i of allIssues) if (i.issuetype?.subtask && i.parent) m.set(i.parent.key, [...(m.get(i.parent.key) ?? []), i]);
    return m;
  }, [allIssues]);

  const [flash, setFlash] = useState<Set<string>>(new Set());
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const [hoverParent, setHoverParent] = useState<string | null>(null);

  // Unfolding a single story flashes its subtasks for a few seconds so they're easy to spot.
  const toggleStory = (key: string) => {
    const unfolding = collapsedStories.includes(key);
    onToggleStory(key);
    if (!unfolding) return;
    setFlash(new Set((subtasksOf.get(key) ?? []).map((s) => s.key)));
    clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(new Set()), 5000);
  };

  const isFolded = (i: Issue) => !!i.issuetype?.subtask && !!i.parent && collapsedStories.includes(i.parent.key);
  const grid: CSSProperties = { gridTemplateColumns: `repeat(${columns.length}, minmax(260px, 1fr))` };

  /* ---------- drag & drop ---------- */

  /* ---------- hovering "N subtareas": highlight them and point at the ones scrolled out of view ---------- */

  const boardRef = useRef<HTMLDivElement>(null);
  const [hoverStory, setHoverStory] = useState<string | null>(null);
  const [offscreen, setOffscreen] = useState<Offscreen[]>([]);
  useEffect(() => {
    const board = boardRef.current;
    if (!hoverStory || !board) return setOffscreen([]);
    const compute = () => {
      const br = board.getBoundingClientRect();
      // Sticky column header plus the sticky swimlane header hide the top of the scroll area.
      const visibleTop = br.top + (board.querySelector<HTMLElement>('.board-cols')?.offsetHeight ?? 0) + 36;
      const heads = board.querySelectorAll<HTMLElement>('.board-col-head');
      const found = new Map<string, Offscreen>();
      for (const s of subtasksOf.get(hoverStory) ?? []) {
        const el = board.querySelector<HTMLElement>(`[data-key="${CSS.escape(s.key)}"]`);
        const col = colOf.get(s.status?.id ?? '');
        if (!el || col === undefined) continue;
        const r = el.getBoundingClientRect();
        const dir = r.top >= br.bottom - 4 ? 'down' : r.bottom <= visibleTop ? 'up' : null;
        if (!dir) continue;
        const id = `${col}:${dir}`;
        const prev = found.get(id);
        if (prev) {
          prev.count++;
          continue;
        }
        const hr = heads[col]?.getBoundingClientRect();
        const left = Math.max(br.left + 8, Math.min(hr?.left ?? br.left, br.right - 200));
        found.set(id, { id, dir, count: 1, left, width: Math.min(hr?.width ?? 240, br.right - left - 8), top: visibleTop + 6, bottom: innerHeight - br.bottom + 10 });
      }
      setOffscreen([...found.values()]);
    };
    compute();
    board.addEventListener('scroll', compute);
    return () => board.removeEventListener('scroll', compute);
  }, [hoverStory, subtasksOf, colOf]);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  /** `peers` are the keys it can be ranked among (units of its cell, or its sibling subtasks), in order. */
  const openMenu = (e: React.MouseEvent, issue: Issue, peers: string[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, issue, moves: rankMoves(issue.key, peers.filter((k) => rankIndex.has(k))) });
  };

  const drag = useRef<DragState | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  const [overCell, setOverCell] = useState<string | null>(null);
  const endDrag = () => {
    drag.current = null;
    setDropAt(null);
    setOverCell(null);
  };

  const transitionTo = async (key: string, colIdx: number) => {
    const issue = byKey.get(key);
    if (!issue || colOf.get(issue.status?.id ?? '') === colIdx) return;
    const col = columns[colIdx]!;
    try {
      const ts = await qc.fetchQuery({ queryKey: ['transitions', key], queryFn: () => api.transitions(key), staleTime: 30_000 });
      const t = ts.find((x) => col.statusIds.includes(x.to.id));
      if (!t) return toast(`${key} no puede pasar a «${col.name}» desde «${issue.status?.name}»`, 'error');
      transition(key, t);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  /** Over a unit: stories, tasks and placeholders reorder among the units of their own cell. */
  const unitDragOver = (e: React.DragEvent, unit: Unit, target: string, cellId: string) => {
    const d = drag.current;
    if (!d || d.kind === 'subtask' || d.cellId !== cellId) return;
    e.preventDefault();
    e.stopPropagation();
    if (target === d.rankKey || !rankIndex.has(target)) return setDropAt(null);
    setDropAt({ id: unit.id, pos: dropPos(e), target, cellId });
  };

  /** Over a subtask: only its siblings (same story, same cell) can be dropped around it. */
  const subtaskDragOver = (e: React.DragEvent, sub: Issue, cellId: string) => {
    const d = drag.current;
    if (!d || d.kind !== 'subtask' || d.cellId !== cellId || d.parentKey !== sub.parent?.key) return;
    e.preventDefault();
    e.stopPropagation();
    if (sub.key === d.key) return setDropAt(null);
    setDropAt({ id: sub.key, pos: dropPos(e), target: sub.key, cellId });
  };

  const cells = (group: Group) => {
    const perCol: Issue[][] = columns.map(() => []);
    for (const i of group.issues) {
      const idx = colOf.get(i.status?.id ?? '');
      if (idx !== undefined) perCol[idx]!.push(i);
    }
    return perCol;
  };

  return (
    <div className="board" ref={boardRef}>
      <div className="board-inner" style={{ minWidth: columns.length * 268 + 24 }}>
        <div className="board-cols" style={grid}>
          {columns.map((c, idx) => {
            const n = issues.filter((i) => !isFolded(i) && c.statusIds.includes(i.status?.id ?? '')).length;
            const splittable = !c.splitFrom && c.statusIds.length > 1;
            // Only the first of a split group offers to join it back.
            const firstOfSplit = c.splitFrom && columns[idx - 1]?.splitFrom !== c.splitFrom;
            const key = colKey(c);
            return (
              <div
                key={key}
                className={`board-col-head${colDrop?.key === key ? ` drop-${colDrop.pos}` : ''}`}
                draggable
                title="Arrastra para reordenar"
                onDragStart={(e) => {
                  colDrag.current = key;
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', c.name);
                }}
                onDragEnd={() => {
                  colDrag.current = null;
                  setColDrop(null);
                }}
                onDragOver={(e) => {
                  if (!colDrag.current) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  const pos: DropPos = e.clientX < r.left + r.width / 2 ? 'before' : 'after';
                  if (colDrop?.key !== key || colDrop.pos !== pos) setColDrop({ key, pos });
                }}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setColDrop(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = colDrag.current;
                  colDrag.current = null;
                  setColDrop(null);
                  if (from) moveColumn(from, key, e.clientX < e.currentTarget.getBoundingClientRect().left + e.currentTarget.offsetWidth / 2 ? 'before' : 'after');
                }}
              >
                <span className="ellipsis" title={c.splitFrom ? `${c.name} (de ${c.splitFrom})` : undefined}>
                  {c.name}
                </span>
                <span className="muted">{n}</span>
                {customOrder && idx === columns.length - 1 && (
                  <button className="icon-btn" title="Restablecer el orden de columnas de Jira" onClick={resetOrder}>
                    <Icon.Refresh size={13} />
                  </button>
                )}
                {(splittable || firstOfSplit) && (
                  <button
                    className="icon-btn col-split"
                    title={splittable ? `Separar por estado (${c.statusNames?.join(', ') ?? c.statusIds.length})` : `Juntar en «${c.splitFrom}»`}
                    onClick={() => toggleSplit(c.splitFrom ?? c.name)}
                  >
                    {splittable ? <Icon.Split size={13} /> : <Icon.Merge size={13} />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {groups.map((g) => {
          const open = !collapsed.has(g.id);
          return (
            <section key={g.id} className="lane">
              {g.header !== null && (
                <div className="lane-head" onClick={() => onToggle(g.id)}>
                  <div className="lane-title">
                    <Icon.Chevron open={open} />
                    {g.header}
                    <Progress issues={g.issues} />
                  </div>
                </div>
              )}
              {open && (
                <div className="lane-cells" style={grid}>
                  {cells(g).map((list, colIdx) => {
                    const cellId = `${g.id}:${colIdx}`;
                    return (
                      <div
                        key={cellId}
                        className={`cell${overCell === cellId ? ' over' : ''}`}
                        onDragOver={(e) => {
                          const d = drag.current;
                          // Other columns of the same swimlane accept cards and subtasks as a status change.
                          if (!d || d.kind === 'placeholder' || d.colIdx === colIdx || d.laneId !== g.id) return;
                          e.preventDefault();
                          setOverCell(cellId);
                        }}
                        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOverCell(null)}
                        onDrop={(e) => {
                          e.preventDefault();
                          const d = drag.current;
                          const at = dropAt;
                          endDrag();
                          if (!d) return;
                          if (at && at.cellId === cellId) rank(d.rankKey, at.pos, at.target);
                          else if (d.colIdx !== colIdx && d.kind !== 'placeholder' && d.laneId === g.id) transitionTo(d.key, colIdx);
                        }}
                      >
                        {(() => {
                          const units = arrange(list, rankOf);
                          const unitKeys = units.map((u) => (u.head.kind === 'card' ? u.head.issue.key : u.head.parent.key));
                          return units.map((unit) => {
                          const head = unit.head;
                          const storyKey = head.kind === 'card' ? head.issue.key : head.parent.key;
                          const folded = collapsedStories.includes(storyKey);
                          const startDrag = (kind: DragState['kind']) => () => {
                            drag.current = { key: storyKey, kind, rankKey: storyKey, laneId: g.id, cellId, colIdx };
                          };
                          return (
                            <div
                              key={unit.id}
                              className={`unit${dropAt?.id === unit.id ? ` drop-${dropAt.pos}` : ''}`}
                              onDragOver={(e) => unitDragOver(e, unit, storyKey, cellId)}
                            >
                              {head.kind === 'placeholder' ? (
                                <ParentPlaceholder
                                  parent={head.parent}
                                  allSubtasks={allSubtasksOf.get(storyKey) ?? []}
                                  columns={allColumns}
                                  folded={folded}
                                  onToggle={() => toggleStory(storyKey)}
                                  onSubtasksHover={(on) => setHoverStory(on ? storyKey : null)}
                                  onHover={setHoverParent}
                                  // Its position comes from the story's rank, which only exists if the story is in the sprint.
                                  draggable={rankIndex.has(storyKey)}
                                  drag={{ onDragStart: startDrag('placeholder'), onDragEnd: endDrag }}
                                />
                              ) : (
                                <Card
                                  issue={head.issue}
                                  showParent={showParent}
                                  subtaskCount={(subtasksOf.get(storyKey) ?? []).length}
                                  allSubtasks={allSubtasksOf.get(storyKey) ?? []}
                                  columns={allColumns}
                                  folded={folded}
                                  onToggleSubtasks={() => toggleStory(storyKey)}
                                  onSubtasksHover={(on) => setHoverStory(on ? storyKey : null)}
                                  highlight={hoverParent === storyKey ? 'hover' : flash.has(storyKey) ? 'flash' : null}
                                  onDragStart={startDrag('card')}
                                  onDragEnd={endDrag}
                                  onContextMenu={(e) => openMenu(e, head.issue, unitKeys)}
                                />
                              )}
                              {!folded &&
                                unit.subs.map((s) => (
                                  <Card
                                    key={s.key}
                                    issue={s}
                                    showParent={false}
                                    subtaskCount={0}
                                    allSubtasks={[]}
                                    columns={allColumns}
                                    folded={false}
                                    onToggleSubtasks={() => {}}
                                    highlight={hoverStory === storyKey ? 'hover' : flash.has(s.key) ? 'flash' : null}
                                    onDragStart={() => {
                                      drag.current = { key: s.key, kind: 'subtask', rankKey: s.key, parentKey: s.parent?.key, laneId: g.id, cellId, colIdx };
                                    }}
                                    onDragEnd={endDrag}
                                    onDragOver={(e) => subtaskDragOver(e, s, cellId)}
                                    dropPos={dropAt?.id === s.key ? dropAt.pos : null}
                                    onContextMenu={(e) =>
                                      openMenu(
                                        e,
                                        s,
                                        unit.subs.map((x) => x.key),
                                      )
                                    }
                                  />
                                ))}
                            </div>
                          );
                          });
                        })()}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {offscreen.map((o) => (
        <div
          key={o.id}
          className="offscreen-hint"
          style={{ left: o.left, width: o.width, ...(o.dir === 'down' ? { bottom: o.bottom } : { top: o.top }) }}
        >
          {o.dir === 'down' ? <Icon.ArrowDown size={13} /> : <Icon.ArrowUp size={13} />}
          {o.count} {o.count === 1 ? 'subtarea' : 'subtareas'} {o.dir === 'down' ? 'más abajo' : 'más arriba'}
        </div>
      ))}
      {menu && <CardMenu state={menu} currentSprintId={currentSprintId} onClose={closeMenu} />}
    </div>
  );
}
