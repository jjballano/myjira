import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api } from '../api';
import { useApp, useIssueActions, useLocalStorage } from '../hooks';
import type { Issue, Sprint } from '../types';
import { fmtRange } from '../util';
import { applyFilters, emptyFilters, FilterBar, type Filters } from './FilterBar';
import { Icon } from './icons';
import { BacklogMenu, rankMoves, type MenuState } from './CardMenu';
import { IssueRow } from './IssueRow';
import { SprintFilter } from './SprintFilter';
import { Progress } from './Progress';
import { useSlashFocus } from './useSlashFocus';

type DropPos = 'before' | 'after';

interface DragInfo {
  issue: Issue;
  sectionId: string;
  queryKey: QueryKey;
}

/** No key means "the end of that section" (dropped on its header or empty space). */
interface DropAt {
  sectionId: string;
  key?: string;
  pos?: DropPos;
}

interface Dnd {
  drag: MutableRefObject<DragInfo | null>;
  dropAt: DropAt | null;
  setDropAt: (d: DropAt | null) => void;
  end: () => void;
}

const isSub = (i: Issue) => !!i.issuetype?.subtask;

function Section({ sprint, open, onToggle, filters, dnd }: { sprint: Sprint | null; open: boolean; onToggle: () => void; filters: Filters; dnd: Dnd }) {
  const { board } = useApp();
  const qc = useQueryClient();
  const { rank, moveToSprint } = useIssueActions();
  const id = sprint?.id ?? 'backlog';
  const sectionId = String(id);
  const queryKey: QueryKey = sprint ? ['issues', 'sprint', board.id, sprint.id] : ['issues', 'backlog', board.id];
  const { data: count } = useQuery({
    queryKey: ['count', board.id, id],
    queryFn: () => (sprint ? api.sprintCount(board.id, sprint.id) : api.backlogCount(board.id)),
  });
  const { data: issues, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => (sprint ? api.sprintIssues(board.id, sprint.id) : api.backlog(board.id)),
    enabled: open,
  });
  const visible = issues ? applyFilters(issues, filters) : [];
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // Stories/tasks rank among the section's stories/tasks; subtasks only among their siblings.
  const openMenu = (e: React.MouseEvent, issue: Issue) => {
    e.preventDefault();
    const peers = (issues ?? [])
      .filter((i) => (issue.issuetype?.subtask ? i.issuetype?.subtask && i.parent?.key === issue.parent?.key : !i.issuetype?.subtask))
      .map((i) => i.key);
    setMenu({ x: e.clientX, y: e.clientY, issue, moves: rankMoves(issue.key, peers) });
  };
  const filtering = filters.q || filters.assignees.length;

  /*
   * Drag & drop. Within a section: stories/tasks reorder among stories/tasks, subtasks only among
   * their siblings. Across sections: stories/tasks move to that sprint (at the row they're dropped
   * on, or at the end); subtasks always follow their story, so they can't change sprint.
   */
  const { drag, dropAt, setDropAt, end } = dnd;
  const rowDragOver = (e: React.DragEvent, row: Issue) => {
    const d = drag.current;
    if (!d) return;
    const allowed =
      d.sectionId === sectionId
        ? isSub(d.issue)
          ? isSub(row) && row.parent?.key === d.issue.parent?.key
          : !isSub(row)
        : !isSub(d.issue) && !isSub(row);
    if (!allowed) return;
    e.preventDefault();
    e.stopPropagation();
    if (row.key === d.issue.key) return setDropAt(null);
    const r = e.currentTarget.getBoundingClientRect();
    setDropAt({ sectionId, key: row.key, pos: e.clientY < r.top + r.height / 2 ? 'before' : 'after' });
  };
  const sectionDragOver = (e: React.DragEvent) => {
    const d = drag.current;
    if (!d || d.sectionId === sectionId || isSub(d.issue)) return;
    e.preventDefault();
    if (dropAt?.sectionId !== sectionId || dropAt.key) setDropAt({ sectionId });
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const d = drag.current;
    const at = dropAt;
    end();
    if (!d || !at || at.sectionId !== sectionId) return;
    const target = at.key && at.pos ? { pos: at.pos, target: at.key } : undefined;
    if (d.sectionId === sectionId) {
      if (target) rank(d.issue.key, target.pos, target.target);
      return;
    }
    // Optimistically take it out of its section and drop it where it landed here.
    const local = () => {
      qc.setQueryData<Issue[]>(d.queryKey, (old) => old?.filter((i) => i.key !== d.issue.key && i.parent?.key !== d.issue.key));
      qc.setQueryData<Issue[]>(queryKey, (old) => {
        if (!old) return old;
        const idx = target ? old.findIndex((i) => i.key === target.target) + (target.pos === 'after' ? 1 : 0) : old.length;
        return [...old.slice(0, idx), d.issue, ...old.slice(idx)];
      });
    };
    moveToSprint(d.issue.key, sprint, { at: target, local });
  };
  const isTarget = dropAt?.sectionId === sectionId && !dropAt.key;

  return (
    <section
      className={`sprint-section${isTarget ? ' drop-target' : ''}`}
      onDragOver={sectionDragOver}
      onDragLeave={(e) => isTarget && !e.currentTarget.contains(e.relatedTarget as Node) && setDropAt(null)}
      onDrop={onDrop}
    >
      <div className="sprint-header" onClick={onToggle}>
        <Icon.Chevron open={open} />
        {sprint ? <Icon.Sprint size={14} /> : <Icon.Backlog size={14} />}
        <span className="sprint-name">{sprint?.name ?? 'Backlog'}</span>
        {sprint?.state === 'active' && <span className="badge badge-active">Activo</span>}
        {sprint && <span className="muted">{fmtRange(sprint.startDate, sprint.endDate)}</span>}
        <span className="muted">
          {count ? `${filtering && issues ? `${visible.length} de ` : ''}${count.total} issues` : ''}
        </span>
        <span className="spacer" />
        {issues && issues.length > 0 && <Progress issues={issues} />}
      </div>
      {open && (
        <div className="sprint-body">
          {sprint?.goal && <div className="sprint-goal">{sprint.goal}</div>}
          {isLoading && <div className="empty">Cargando…</div>}
          {error && <div className="empty error">{(error as Error).message}</div>}
          {issues && !visible.length && <div className="empty">{issues.length ? 'Nada coincide con el filtro.' : 'Vacío.'}</div>}
          {visible.map((i) => (
            <IssueRow
              key={i.key}
              issue={i}
              onContextMenu={(e) => openMenu(e, i)}
              drag={{
                onDragStart: () => {
                  drag.current = { issue: i, sectionId, queryKey };
                },
                onDragEnd: end,
                onDragOver: (e) => rowDragOver(e, i),
                dropPos: dropAt?.sectionId === sectionId && dropAt.key === i.key ? dropAt.pos ?? null : null,
              }}
            />
          ))}
          {menu && <BacklogMenu state={menu} sprintId={sprint?.id ?? null} onClose={closeMenu} />}
        </div>
      )}
    </section>
  );
}

export function BacklogView() {
  const { board, sprints, hiddenSprintIds } = useApp();
  const visible = sprints.filter((s) => !hiddenSprintIds.includes(s.id));
  const [expanded, setExpanded] = useLocalStorage<(number | 'backlog')[]>(`expanded:${board.id}`, []);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  const drag = useRef<DragInfo | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  const end = useCallback(() => {
    drag.current = null;
    setDropAt(null);
  }, []);
  const dnd: Dnd = { drag, dropAt, setDropAt, end };

  const toggle = (id: number | 'backlog') =>
    setExpanded(expanded.includes(id) ? expanded.filter((x) => x !== id) : [...expanded, id]);

  return (
    <div className="view">
      <header className="view-header">
        <div className="view-title">
          <h1>Backlog</h1>
          <span className="muted">{visible.length} sprints</span>
        </div>
        <div className="view-actions">
          <button className="btn btn-ghost" onClick={() => setExpanded(expanded.length ? [] : [...visible.map((s) => s.id), 'backlog'])}>
            {expanded.length ? 'Plegar todo' : 'Desplegar todo'}
          </button>
          <SprintFilter />
        </div>
      </header>
      <div className="toolbar">
        <FilterBar filters={filters} onChange={setFilters} searchRef={searchRef} />
      </div>
      <div className="list">
        {visible.map((s) => (
          <Section key={s.id} sprint={s} open={expanded.includes(s.id)} onToggle={() => toggle(s.id)} filters={filters} dnd={dnd} />
        ))}
        <Section sprint={null} open={expanded.includes('backlog')} onToggle={() => toggle('backlog')} filters={filters} dnd={dnd} />
      </div>
    </div>
  );
}
