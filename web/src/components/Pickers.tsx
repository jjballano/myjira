import { useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useApp, useDebounced, useIssueActions } from '../hooks';
import type { Issue, ParentRef, Sprint, Status, User } from '../types';
import { colorFor, fmtRange } from '../util';
import { Avatar, Icon, StatusIcon } from './icons';
import { Menu, type MenuItem } from './Menu';
import { Popover } from './Popover';

type Variant = 'icon' | 'pill' | 'field';

function Trigger({ variant, title, children, ...rest }: { variant: Variant; title?: string; children: ReactNode } & Record<string, unknown>) {
  return (
    <button type="button" className={`trigger trigger-${variant}`} title={title} {...rest}>
      {children}
    </button>
  );
}

/* ---------- Status ---------- */

export function StatusMenu({ issueKey, status, close }: { issueKey: string; status: Status | null; close: () => void }) {
  const { transition } = useIssueActions();
  const { data, isLoading } = useQuery({ queryKey: ['transitions', issueKey], queryFn: () => api.transitions(issueKey) });
  const items: MenuItem[] = (data ?? []).map((t) => ({
    id: t.id,
    label: t.to.name,
    icon: <StatusIcon status={t.to} />,
    hint: t.name !== t.to.name ? t.name : undefined,
    selected: t.to.id === status?.id,
  }));
  return (
    <Menu
      items={items}
      loading={isLoading}
      placeholder="Cambiar estado…"
      onSelect={(item) => {
        const t = data!.find((x) => x.id === item.id)!;
        close();
        if (t.to.id !== status?.id) transition(issueKey, t);
      }}
    />
  );
}

export function StatusPicker({ issueKey, status, variant = 'icon' }: { issueKey: string; status: Status | null; variant?: Variant }) {
  return (
    <Popover
      width={240}
      renderTrigger={(p) => (
        <Trigger variant={variant} title={status?.name} {...p}>
          <StatusIcon status={status} />
          {variant !== 'icon' && <span>{status?.name ?? '—'}</span>}
        </Trigger>
      )}
    >
      {(close) => <StatusMenu issueKey={issueKey} status={status} close={close} />}
    </Popover>
  );
}

/* ---------- Assignee ---------- */

export function AssigneeMenu({ issueKey, assignee, close }: { issueKey: string; assignee: User | null; close: () => void }) {
  const { me } = useApp();
  const { assign } = useIssueActions();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, isFetching } = useQuery({
    queryKey: ['assignable', issueKey, dq],
    queryFn: () => api.assignable(issueKey, dq),
    placeholderData: keepPreviousData,
  });
  const users = useMemo(() => {
    const list = data ?? [];
    if (q) return list;
    return [me, ...list.filter((u) => u.accountId !== me.accountId)];
  }, [data, me, q]);
  const items: MenuItem[] = [
    ...(q ? [] : [{ id: '', label: 'Sin asignar', icon: <Avatar user={null} size={16} />, selected: !assignee }]),
    ...users.map((u) => ({
      id: u.accountId,
      label: u.displayName,
      icon: <Avatar user={u} size={16} />,
      hint: u.accountId === me.accountId ? 'Yo' : undefined,
      selected: u.accountId === assignee?.accountId,
    })),
  ];
  return (
    <Menu
      items={items}
      query={q}
      onQuery={setQ}
      loading={isFetching}
      placeholder="Asignar a…"
      onSelect={(item) => {
        close();
        if (item.id === (assignee?.accountId ?? '')) return;
        assign(issueKey, item.id ? users.find((u) => u.accountId === item.id)! : null);
      }}
    />
  );
}

export function AssigneePicker({ issueKey, assignee, variant = 'icon' }: { issueKey: string; assignee: User | null; variant?: Variant }) {
  return (
    <Popover
      width={260}
      align={variant === 'icon' ? 'end' : 'start'}
      renderTrigger={(p) => (
        <Trigger variant={variant} title={assignee?.displayName ?? 'Sin asignar'} {...p}>
          <Avatar user={assignee} size={variant === 'icon' ? 18 : 16} />
          {variant !== 'icon' && <span className={assignee ? '' : 'muted'}>{assignee?.displayName ?? 'Sin asignar'}</span>}
        </Trigger>
      )}
    >
      {(close) => <AssigneeMenu issueKey={issueKey} assignee={assignee} close={close} />}
    </Popover>
  );
}

/* ---------- Labels ---------- */

export function LabelsMenu({ issueKey, labels }: { issueKey: string; labels: string[] }) {
  const { setLabels } = useIssueActions();
  const [current, setCurrent] = useState(labels);
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['labels'], queryFn: api.labels, staleTime: 5 * 60_000 });

  const needle = q.trim().toLowerCase();
  const all = useMemo(() => Array.from(new Set([...current, ...(data ?? [])])), [current, data]);
  const filtered = needle ? all.filter((l) => l.toLowerCase().includes(needle)) : all;
  const candidate = q.trim().replace(/\s+/g, '-');
  const items: MenuItem[] = [
    ...filtered
      .sort((a, b) => Number(current.includes(b)) - Number(current.includes(a)))
      .map((l) => ({ id: l, label: l, icon: <span className="dot" style={{ background: colorFor(l) }} />, selected: current.includes(l) })),
    ...(candidate && !all.some((l) => l.toLowerCase() === candidate.toLowerCase())
      ? [{ id: `new:${candidate}`, label: `Crear «${candidate}»`, icon: <Icon.Plus size={13} /> }]
      : []),
  ];

  return (
    <Menu
      items={items}
      query={q}
      onQuery={setQ}
      loading={isLoading}
      placeholder="Añadir etiquetas…"
      onSelect={(item) => {
        const label = item.id.startsWith('new:') ? item.id.slice(4) : item.id;
        const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
        setCurrent(next);
        setQ('');
        setLabels(issueKey, next);
      }}
    />
  );
}

export function LabelChips({ labels }: { labels: string[] }) {
  return (
    <>
      {labels.map((l) => (
        <span key={l} className="chip">
          <span className="dot" style={{ background: colorFor(l) }} />
          {l}
        </span>
      ))}
    </>
  );
}

export function LabelsPicker({ issueKey, labels }: { issueKey: string; labels: string[] }) {
  return (
    <Popover
      width={260}
      renderTrigger={(p) => (
        <Trigger variant="field" {...p}>
          {labels.length ? (
            <span className="chips">
              <LabelChips labels={labels} />
            </span>
          ) : (
            <>
              <Icon.Tag size={14} />
              <span className="muted">Añadir etiqueta</span>
            </>
          )}
        </Trigger>
      )}
    >
      {() => <LabelsMenu issueKey={issueKey} labels={labels} />}
    </Popover>
  );
}

/* ---------- Sprint ---------- */

export function SprintPicker({ issueKey, sprint }: { issueKey: string; sprint: Sprint | null }) {
  const { sprints, hiddenSprintIds } = useApp();
  const { moveToSprint } = useIssueActions();
  const items: MenuItem[] = [
    ...sprints.map((s) => ({
      id: String(s.id),
      label: s.name,
      icon: <Icon.Sprint size={14} />,
      hint: s.state === 'active' ? 'Activo' : hiddenSprintIds.includes(s.id) ? 'Oculto' : fmtRange(s.startDate, s.endDate),
      selected: s.id === sprint?.id,
    })),
    { id: 'backlog', label: 'Backlog', icon: <Icon.Backlog size={14} />, selected: !sprint },
  ];
  return (
    <Popover
      width={300}
      renderTrigger={(p) => (
        <Trigger variant="field" {...p}>
          <Icon.Sprint size={14} />
          <span className={sprint ? '' : 'muted'}>{sprint?.name ?? 'Backlog'}</span>
        </Trigger>
      )}
    >
      {(close) => (
        <Menu
          items={items}
          placeholder="Mover a sprint…"
          onSelect={(item) => {
            close();
            const target = item.id === 'backlog' ? null : sprints.find((s) => String(s.id) === item.id)!;
            if ((target?.id ?? null) !== (sprint?.id ?? null)) moveToSprint(issueKey, target);
          }}
        />
      )}
    </Popover>
  );
}

/* ---------- Parent ---------- */

export function ParentMenu({ issueKey, project, parent, close }: { issueKey: string; project: string; parent: ParentRef | null; close: () => void }) {
  const { setParent } = useIssueActions();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, isFetching } = useQuery({
    queryKey: ['parents', project, dq],
    queryFn: () => api.parents(project, dq),
    placeholderData: keepPreviousData,
  });
  const epics: Issue[] = data ?? [];
  const items: MenuItem[] = [
    ...(q ? [] : [{ id: '', label: 'Sin padre', icon: <Icon.Close size={13} />, selected: !parent }]),
    ...epics.map((e) => ({
      id: e.key,
      label: e.summary,
      icon: <Icon.Epic color={colorFor(e.key)} size={12} />,
      hint: e.key,
      selected: e.key === parent?.key,
    })),
  ];
  return (
    <Menu
      items={items}
      query={q}
      onQuery={setQ}
      loading={isFetching}
      placeholder="Buscar épica o clave…"
      onSelect={(item) => {
        close();
        if (item.id === (parent?.key ?? '')) return;
        setParent(issueKey, item.id ? epics.find((e) => e.key === item.id)! : null);
      }}
    />
  );
}

export function ParentPicker({ issueKey, project, parent }: { issueKey: string; project: string; parent: ParentRef | null }) {
  return (
    <Popover
      width={340}
      renderTrigger={(p) => (
        <Trigger variant="field" {...p}>
          {parent ? (
            <>
              <Icon.Epic color={colorFor(parent.key)} size={12} />
              <span className="ellipsis">{parent.summary}</span>
            </>
          ) : (
            <span className="muted">Sin padre</span>
          )}
        </Trigger>
      )}
    >
      {(close) => <ParentMenu issueKey={issueKey} project={project} parent={parent} close={close} />}
    </Popover>
  );
}
