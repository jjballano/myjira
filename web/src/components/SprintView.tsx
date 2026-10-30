import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useApp, useLocalStorage } from '../hooks';
import type { Column, Issue, ParentRef, User } from '../types';
import { colorFor, daysLeft, fmtRange } from '../util';
import { EpicFilter, NO_EPIC, type EpicOption } from './EpicFilter';
import { applyFilters, assigneesOf, emptyFilters, FilterBar, type Filters } from './FilterBar';
import { Avatar, Icon, StatusIcon } from './icons';
import { IssueRow } from './IssueRow';
import { AssigneePicker, StatusPicker } from './Pickers';
import { SprintFilter } from './SprintFilter';
import { StatusFilter, statusesOf } from './StatusFilter';
import { Progress } from './Progress';
import { SprintBoard } from './SprintBoard';
import { useSlashFocus } from './useSlashFocus';

const REFRESH_MS = 30_000;

type GroupBy = 'epic' | 'status' | 'assignee' | 'none';

export interface Group {
  id: string;
  header: ReactNode;
  issues: Issue[];
}

const GROUP_LABELS: Record<GroupBy, string> = { epic: 'Épica', status: 'Estado', assignee: 'Responsable', none: 'Ninguno' };

function epicOf(issue: Issue, byKey: Map<string, Issue>): ParentRef | null {
  if (!issue.parent) return null;
  if (issue.issuetype?.subtask) return byKey.get(issue.parent.key)?.parent ?? issue.parent;
  return issue.parent;
}


function groupIssues(issues: Issue[], all: Issue[], by: GroupBy, columns: Column[] | undefined, epics: Map<string, Issue>): Group[] {
  if (by === 'none') return [{ id: 'all', header: null, issues }];
  const groups = new Map<string, Group & { order: number; label: string }>();
  const add = (id: string, order: number, label: string, header: () => ReactNode, issue: Issue) => {
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, order, label, header: header(), issues: [] }));
    g.issues.push(issue);
  };

  if (by === 'epic') {
    const byKey = new Map(all.map((i) => [i.key, i]));
    issues.forEach((i, idx) => {
      const epic = epicOf(i, byKey);
      if (!epic) return add('none', 1e9, '', () => <span className="group-title muted">Sin épica</span>, i);
      const full = epics.get(epic.key);
      add(epic.key, idx, epic.key, () => <EpicHeader epic={epic} full={full} />, i);
    });
  } else if (by === 'status') {
    const colIdx = new Map<string, number>();
    columns?.forEach((c, idx) => c.statusIds.forEach((s) => colIdx.set(s, idx)));
    const catOrder = { new: 0, indeterminate: 100, done: 200 };
    issues.forEach((i) => {
      const s = i.status;
      const order = colIdx.get(s?.id ?? '') ?? catOrder[s?.category ?? 'new'];
      add(s?.id ?? '?', order, s?.name ?? '', () => (
        <span className="group-title">
          <StatusIcon status={s} /> {s?.name}
        </span>
      ), i);
    });
  } else {
    issues.forEach((i) => {
      const u: User | null = i.assignee;
      add(u?.accountId ?? '', u ? 0 : 1, u?.displayName ?? '', () => (
        <span className="group-title">
          <Avatar user={u} size={18} /> {u?.displayName ?? 'Sin asignar'}
        </span>
      ), i);
    });
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

function EpicHeader({ epic, full }: { epic: ParentRef; full?: Issue }) {
  const { openIssue } = useApp();
  return (
    <span className="group-title">
      <Icon.Epic color={colorFor(epic.key)} size={13} />
      <span className="row-key">{epic.key}</span>
      <span className="group-link" onClick={(e) => (e.stopPropagation(), openIssue(epic.key))}>
        {epic.summary}
      </span>
      <StatusPicker issueKey={epic.key} status={full?.status ?? epic.status} variant="pill" />
      {full && <AssigneePicker issueKey={epic.key} assignee={full.assignee} />}
    </span>
  );
}

export function SprintView() {
  const { board, sprints, hiddenSprintIds } = useApp();
  const active = sprints.filter((s) => s.state === 'active' && !hiddenSprintIds.includes(s.id));
  const [selectedId, setSelectedId] = useLocalStorage<number | null>('selectedSprintId', null);
  const sprint = active.find((s) => s.id === selectedId) ?? active[0];
  const [groupBy, setGroupBy] = useLocalStorage<GroupBy>('groupBy', 'epic');
  const [layout, setLayout] = useLocalStorage<'list' | 'board'>('layout', 'list');
  // In the board, status is already the column axis.
  const laneBy: GroupBy = layout === 'board' && groupBy === 'status' ? 'none' : groupBy;
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hiddenStatusStore, setHiddenStatusStore] = useLocalStorage<Record<string, string[]>>('hiddenStatusIds', {});
  const hiddenStatusIds = hiddenStatusStore[board.id] ?? [];
  const [collapsedStories, setCollapsedStories] = useLocalStorage<string[]>('collapsedStories', []);
  const [hiddenEpicStore, setHiddenEpicStore] = useLocalStorage<Record<string, string[]>>('hiddenEpics', {});
  const hiddenEpics = hiddenEpicStore[board.id] ?? [];
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: ['issues', 'sprint', board.id, sprint?.id],
    queryFn: () => api.sprintIssues(board.id, sprint!.id),
    enabled: !!sprint,
    // Keep the sprint in sync with changes made elsewhere (paused while the tab is hidden).
    refetchInterval: REFRESH_MS,
  });
  const { data: columns } = useQuery({ queryKey: ['columns', board.id], queryFn: () => api.columns(board.id), staleTime: Infinity });

  const epicKeys = useMemo(() => {
    const byKey = new Map((issues ?? []).map((i) => [i.key, i]));
    return [...new Set((issues ?? []).map((i) => epicOf(i, byKey)?.key).filter(Boolean) as string[])].sort();
  }, [issues]);
  const { data: epicIssues } = useQuery({
    queryKey: ['issues', 'keys', epicKeys],
    queryFn: () => api.issuesByKeys(epicKeys),
    enabled: laneBy === 'epic' && epicKeys.length > 0,
    refetchInterval: REFRESH_MS,
  });
  const epics = useMemo(() => new Map((epicIssues ?? []).map((e) => [e.key, e])), [epicIssues]);

  const all = issues ?? [];
  const byKey = useMemo(() => new Map(all.map((i) => [i.key, i])), [all]);
  const epicKeyOf = (i: Issue) => epicOf(i, byKey)?.key ?? NO_EPIC;
  // Epics in the sprint, in swimlane order, plus "no epic" at the end when some issue has none.
  const epicOptions = useMemo<EpicOption[]>(() => {
    const seen = new Map<string, EpicOption>();
    for (const i of all) {
      const e = epicOf(i, byKey);
      if (e && !seen.has(e.key)) seen.set(e.key, { key: e.key, summary: epics.get(e.key)?.summary ?? e.summary });
    }
    const out = [...seen.values()];
    if (all.some((i) => !epicOf(i, byKey))) out.push({ key: NO_EPIC, summary: '' });
    return out;
  }, [all, byKey, epics]);
  const epicFiltered = laneBy === 'epic' && hiddenEpics.length > 0;
  const visible = applyFilters(
    all.filter((i) => !hiddenStatusIds.includes(i.status?.id ?? '') && (!epicFiltered || !hiddenEpics.includes(epicKeyOf(i)))),
    filters,
  );
  // Stories with subtasks in view (on the board or as a placeholder): the ones the board can fold.
  const storiesWithSubtasks = useMemo(
    () => [...new Set(visible.filter((i) => i.issuetype?.subtask && i.parent).map((i) => i.parent!.key))],
    [visible],
  );
  const allStoriesFolded = storiesWithSubtasks.length > 0 && storiesWithSubtasks.every((k) => collapsedStories.includes(k));
  const toggleStory = (key: string) =>
    setCollapsedStories(collapsedStories.includes(key) ? collapsedStories.filter((k) => k !== key) : [...collapsedStories, key]);
  const groups = groupIssues(visible, all, laneBy, columns, epics);
  const left = daysLeft(sprint?.endDate);

  const allGroupsFolded = groups.length > 0 && groups.every((g) => collapsed.has(g.id));
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className={`view${layout === 'board' ? ' view-board' : ''}`}>
      <header className="view-header">
        <div className="view-title">
          {active.length > 1 ? (
            <div className="tabs">
              {active.map((s) => (
                <button key={s.id} className={`tab${s.id === sprint?.id ? ' on' : ''}`} onClick={() => setSelectedId(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>
          ) : (
            <h1>{sprint?.name ?? 'Sin sprint activo'}</h1>
          )}
          {sprint && (
            <span className="muted">
              {fmtRange(sprint.startDate, sprint.endDate)}
              {left !== null && ` · ${left >= 0 ? `quedan ${left} días` : `terminó hace ${-left} días`}`}
            </span>
          )}
          {issues && <Progress issues={all} />}
        </div>
        <div className="view-actions">
          <SprintFilter />
        </div>
      </header>
      {sprint?.goal && <div className="sprint-goal">{sprint.goal}</div>}
      <div className="toolbar">
        <FilterBar filters={filters} onChange={setFilters} users={assigneesOf(all)} searchRef={searchRef} />
        <StatusFilter
          statuses={statusesOf(all, columns)}
          hidden={hiddenStatusIds}
          onChange={(ids) => setHiddenStatusStore({ ...hiddenStatusStore, [board.id]: ids })}
        />
        {laneBy === 'epic' && epicOptions.length > 0 && (
          <EpicFilter
            epics={epicOptions}
            hidden={hiddenEpics}
            onChange={(keys) => setHiddenEpicStore({ ...hiddenEpicStore, [board.id]: keys })}
          />
        )}
        {laneBy !== 'none' && groups.length > 0 && (
          <button className="btn btn-ghost" onClick={() => setCollapsed(allGroupsFolded ? new Set() : new Set(groups.map((g) => g.id)))}>
            <Icon.Chevron open={!allGroupsFolded} />{' '}
            {allGroupsFolded
              ? layout === 'board' ? 'Desplegar swimlanes' : 'Desplegar grupos'
              : layout === 'board' ? 'Plegar swimlanes' : 'Plegar grupos'}
          </button>
        )}
        {layout === 'board' && storiesWithSubtasks.length > 0 && (
          <button
            className="btn btn-ghost"
            onClick={() =>
              setCollapsedStories(
                allStoriesFolded
                  ? collapsedStories.filter((k) => !storiesWithSubtasks.includes(k))
                  : [...new Set([...collapsedStories, ...storiesWithSubtasks])],
              )
            }
          >
            <Icon.Chevron open={!allStoriesFolded} /> {allStoriesFolded ? 'Desplegar subtareas' : 'Plegar subtareas'}
          </button>
        )}
        <div className="tabs">
          <button className={`tab${layout === 'list' ? ' on' : ''}`} onClick={() => setLayout('list')}>
            Lista
          </button>
          <button className={`tab${layout === 'board' ? ' on' : ''}`} onClick={() => setLayout('board')}>
            Tablero
          </button>
        </div>
        <label className="select">
          <span className="muted">{layout === 'board' ? 'Swimlanes' : 'Agrupar'}</span>
          <select value={laneBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            {Object.entries(GROUP_LABELS)
              .filter(([v]) => layout === 'list' || v !== 'status')
              .map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!sprint && <div className="empty">No hay sprints activos visibles. Revisa el filtro de sprints.</div>}
      {isLoading && <div className="empty">Cargando…</div>}
      {error && <div className="empty error">{(error as Error).message}</div>}
      {issues && !visible.length && <div className="empty">Nada que mostrar con estos filtros.</div>}
      {layout === 'board' ? (
        issues && visible.length > 0 && (
          <SprintBoard
            groups={groups}
            columns={columns}
            issues={visible}
            allIssues={all}
            currentSprintId={sprint?.id}
            collapsed={collapsed}
            onToggle={toggle}
            showParent={laneBy !== 'epic'}
            hiddenStatusIds={hiddenStatusIds}
            collapsedStories={collapsedStories}
            onToggleStory={toggleStory}
          />
        )
      ) : (
      <div className="list">
        {groups.map((g) =>
          g.header === null ? (
            g.issues.map((i) => <IssueRow key={i.key} issue={i} />)
          ) : (
            <section key={g.id} className="group">
              <div className="group-header" onClick={() => toggle(g.id)}>
                <Icon.Chevron open={!collapsed.has(g.id)} />
                {g.header}
                <span className="group-count">
                  <Progress issues={g.issues} />
                </span>
              </div>
              {!collapsed.has(g.id) && g.issues.map((i) => <IssueRow key={i.key} issue={i} showParent={groupBy !== 'epic'} />)}
            </section>
          ),
        )}
      </div>
      )}
    </div>
  );
}
