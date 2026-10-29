import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useApp, useIssueActions } from '../hooks';
import { toast } from '../toast';
import type { Issue, Sprint } from '../types';
import { ContextMenu, type ContextEntry, type ContextItem } from './ContextMenu';
import { Avatar, Icon, PriorityIcon, StatusIcon } from './icons';
import { Menu, type MenuItem } from './Menu';
import { AssigneeMenu, LabelsMenu, ParentMenu, StatusMenu } from './Pickers';

export interface RankMove {
  pos: 'before' | 'after';
  target: string;
}

/** Where the issue can be ranked among its peers; a move is absent when it would be a no-op. */
export interface RankMoves {
  top?: RankMove;
  up?: RankMove;
  down?: RankMove;
  bottom?: RankMove;
}

/** `peers` are the keys it can be ranked among, in rank order (and including itself). */
export function rankMoves(key: string, peers: string[]): RankMoves {
  const idx = peers.indexOf(key);
  const first = peers[0];
  const last = peers[peers.length - 1];
  return {
    top: first && first !== key ? { pos: 'before', target: first } : undefined,
    up: idx > 0 ? { pos: 'before', target: peers[idx - 1]! } : undefined,
    down: idx >= 0 && idx < peers.length - 1 ? { pos: 'after', target: peers[idx + 1]! } : undefined,
    bottom: last && last !== key ? { pos: 'after', target: last } : undefined,
  };
}

export interface MenuState {
  x: number;
  y: number;
  issue: Issue;
  moves: RankMoves;
}

const copy = (text: string, msg: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast(msg),
    () => toast('No se pudo copiar', 'error'),
  );

/* ---------- shared entries ---------- */

function useEntries(issue: Issue) {
  const { me, sprints, hiddenSprintIds } = useApp();
  const actions = useIssueActions();
  const subtask = !!issue.issuetype?.subtask;

  const rankItems = (moves: RankMoves, labels: Record<keyof RankMoves, string>): MenuItem[] =>
    (Object.keys(labels) as (keyof RankMoves)[])
      .filter((k) => moves[k])
      .map((k) => ({
        id: k,
        label: labels[k],
        icon: k === 'top' || k === 'up' ? <Icon.ArrowUp size={13} /> : <Icon.ArrowDown size={13} />,
      }));

  // Subtasks always live in their story's sprint.
  const sprintItems = (currentSprintId: number | null): MenuItem[] =>
    subtask
      ? []
      : [
          ...sprints
            .filter((s) => s.id !== currentSprintId && !hiddenSprintIds.includes(s.id))
            .map((s) => ({ id: `s:${s.id}`, label: s.name, icon: <Icon.Sprint size={13} />, hint: s.state === 'active' ? 'Activo' : undefined })),
          ...(currentSprintId !== null ? [{ id: 'backlog', label: 'Backlog', icon: <Icon.Backlog size={13} /> }] : []),
        ];

  const onMoveSelect = (moves: RankMoves) => (item: MenuItem) => {
    const move = moves[item.id as keyof RankMoves];
    if (move) return actions.rank(issue.key, move.pos, move.target);
    if (item.id === 'backlog') return actions.moveToSprint(issue.key, null);
    const sprint: Sprint | undefined = sprints.find((s) => `s:${s.id}` === item.id);
    if (sprint) actions.moveToSprint(issue.key, sprint);
  };

  const copyLink: ContextItem = {
    label: 'Copiar enlace',
    icon: <Icon.Link />,
    onSelect: () => copy(`${me.baseUrl}/browse/${issue.key}`, 'Enlace copiado'),
  };
  const assign: ContextItem = {
    label: 'Asignar',
    icon: <Avatar user={issue.assignee} size={14} />,
    submenu: (close) => <AssigneeMenu issueKey={issue.key} assignee={issue.assignee} close={close} />,
  };
  const status: ContextItem = {
    label: 'Cambiar estado',
    icon: <StatusIcon status={issue.status} />,
    submenu: (close) => <StatusMenu issueKey={issue.key} status={issue.status} close={close} />,
  };
  const labels: ContextItem = {
    label: 'Editar etiquetas',
    icon: <Icon.Tag />,
    submenu: () => <LabelsMenu issueKey={issue.key} labels={issue.labels} />,
  };
  const priority: ContextItem = {
    label: 'Cambiar prioridad',
    icon: <PriorityIcon name={issue.priority?.name} />,
    submenu: (close) => <PriorityMenu issue={issue} close={close} />,
  };
  const parent: ContextItem = {
    label: 'Cambiar padre',
    icon: <Icon.Epic color="var(--muted)" size={12} />,
    submenu: (close) => <ParentMenu issueKey={issue.key} project={issue.key.split('-')[0]!} parent={issue.parent} close={close} />,
  };
  const remove: ContextItem = {
    label: 'Eliminar',
    icon: <Icon.Trash />,
    danger: true,
    onSelect: () => {
      const extra = subtask ? '' : '\nSi tiene subtareas, también se eliminarán.';
      if (window.confirm(`¿Eliminar ${issue.key} «${issue.summary}»?${extra}\nNo se puede deshacer.`)) actions.deleteIssue(issue.key);
    },
  };

  return { rankItems, sprintItems, onMoveSelect, copyLink, assign, status, labels, priority, parent, remove };
}

function PriorityMenu({ issue, close }: { issue: Issue; close: () => void }) {
  const { setPriority } = useIssueActions();
  const { data, isLoading } = useQuery({ queryKey: ['priorities'], queryFn: api.priorities, staleTime: Infinity });
  return (
    <Menu
      placeholder="Prioridad…"
      loading={isLoading}
      items={(data ?? []).map((p) => ({
        id: p.id,
        label: p.name,
        icon: <PriorityIcon name={p.name} />,
        selected: p.name === issue.priority?.name,
      }))}
      onSelect={(item) => {
        close();
        const p = data!.find((x) => x.id === item.id)!;
        if (p.name !== issue.priority?.name) setPriority(issue.key, p);
      }}
    />
  );
}

/* ---------- board card menu ---------- */

export function CardMenu({ state, currentSprintId, onClose }: { state: MenuState; currentSprintId?: number; onClose: () => void }) {
  const e = useEntries(state.issue);
  const moveItems = [
    ...e.rankItems(state.moves, { top: 'Arriba de la columna', bottom: 'Abajo de la columna' } as Record<keyof RankMoves, string>),
    ...e.sprintItems(currentSprintId ?? null),
  ];
  const items: ContextEntry[] = [
    {
      label: 'Mover',
      icon: <Icon.Move />,
      submenu: (close) => (
        <Menu
          placeholder="Mover a…"
          items={moveItems}
          onSelect={(item) => {
            close();
            e.onMoveSelect(state.moves)(item);
          }}
        />
      ),
    },
    e.status,
    'separator',
    e.copyLink,
    e.assign,
    'separator',
    e.labels,
    'separator',
    e.remove,
  ];
  return <ContextMenu x={state.x} y={state.y} items={items} onClose={onClose} />;
}

/* ---------- backlog row menu ---------- */

export function BacklogMenu({ state, sprintId, onClose }: { state: MenuState; sprintId: number | null; onClose: () => void }) {
  const e = useEntries(state.issue);
  const where = sprintId === null ? 'del backlog' : 'del sprint';
  const rankItems = e.rankItems(state.moves, {
    top: `Arriba ${where}`,
    up: 'Subir uno',
    down: 'Bajar uno',
    bottom: `Abajo ${where}`,
  });
  const sprintItems = e.sprintItems(sprintId);
  const items: ContextEntry[] = [
    ...(rankItems.length
      ? [
          {
            label: sprintId === null ? 'Mover en el backlog' : 'Mover en el sprint',
            icon: <Icon.Move />,
            submenu: (close: () => void) => (
              <Menu
                placeholder="Mover…"
                items={rankItems}
                onSelect={(item) => {
                  close();
                  e.onMoveSelect(state.moves)(item);
                }}
              />
            ),
          },
        ]
      : []),
    ...(sprintItems.length
      ? [
          {
            label: 'Mover a otro sprint',
            icon: <Icon.Sprint />,
            submenu: (close: () => void) => (
              <Menu
                placeholder="Sprint…"
                items={sprintItems}
                onSelect={(item) => {
                  close();
                  e.onMoveSelect({})(item);
                }}
              />
            ),
          },
        ]
      : []),
    'separator',
    e.copyLink,
    e.assign,
    e.priority,
    e.parent,
  ];
  return <ContextMenu x={state.x} y={state.y} items={items} onClose={onClose} />;
}
