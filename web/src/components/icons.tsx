import { useContext } from 'react';
import { AppContext } from '../hooks';
import type { Status, User } from '../types';
import { colorFor, initials, statusStyle } from '../util';

export function StatusIcon({ status, size = 14 }: { status: Status | null | undefined; size?: number }) {
  const columns = useContext(AppContext)?.columns;
  const { color, fill, kind } = statusStyle(status, columns);
  const r = 6;
  if (kind === 'done') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-label={status?.name}>
        <circle cx="7" cy="7" r={r} fill={color} stroke={color} strokeWidth="1.5" />
        <path d="M4.3 7.2 6.1 9l3.6-3.8" fill="none" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  const angle = fill * 2 * Math.PI;
  const ir = 3.2;
  const x = 7 + ir * Math.sin(angle);
  const y = 7 - ir * Math.cos(angle);
  const large = fill > 0.5 ? 1 : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-label={status?.name}>
      <circle cx="7" cy="7" r={r} fill="none" stroke={color} strokeWidth="1.5" />
      {fill > 0 && fill < 1 && <path d={`M7 7V${7 - ir}A${ir} ${ir} 0 ${large} 1 ${x} ${y}Z`} fill={color} />}
    </svg>
  );
}

export function PriorityIcon({ name, size = 14 }: { name?: string; size?: number }) {
  const n = (name ?? '').toLowerCase();
  if (/highest|urgent|critical|blocker|crít|urgente/.test(n)) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-label={name}>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="#f76b15" />
        <path d="M7 3.8v4M7 10.2v.01" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  const level = /high|alta/.test(n) ? 3 : /medium|media/.test(n) ? 2 : /low|baja/.test(n) ? 1 : 0;
  if (!name || (level === 0 && !/lowest/.test(n))) {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-label="Sin prioridad">
        {[3, 7, 11].map((x) => (
          <rect key={x} x={x - 1} y="6.25" width="2" height="1.5" rx=".5" fill="var(--muted)" />
        ))}
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-label={name}>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 4}
          y={9 - i * 3}
          width="3"
          height={3 + i * 3}
          rx="1"
          fill={i < level ? 'var(--text-2)' : 'var(--faint)'}
        />
      ))}
    </svg>
  );
}

export function Avatar({ user, size = 18 }: { user: User | null | undefined; size?: number }) {
  if (!user) {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" aria-label="Sin asignar" className="avatar">
        <circle cx="9" cy="9" r="8" fill="none" stroke="var(--muted)" strokeWidth="1.2" strokeDasharray="2 2" />
        <circle cx="9" cy="7.2" r="2.4" fill="var(--muted)" />
        <path d="M4.8 13.6c.8-1.9 2.4-2.8 4.2-2.8s3.4.9 4.2 2.8" fill="var(--muted)" />
      </svg>
    );
  }
  if (user.avatar) {
    return <img className="avatar" src={user.avatar} width={size} height={size} alt={user.displayName} title={user.displayName} />;
  }
  return (
    <span
      className="avatar avatar-initials"
      title={user.displayName}
      style={{ width: size, height: size, background: colorFor(user.accountId), fontSize: size * 0.45 }}
    >
      {initials(user.displayName)}
    </span>
  );
}

type IconProps = { size?: number };
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const Icon = {
  Chevron: ({ size = 12, open }: IconProps & { open?: boolean }) => (
    <svg width={size} height={size} viewBox="0 0 12 12" style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .12s' }}>
      <path d="M4.5 2.5 8 6l-3.5 3.5" {...stroke} />
    </svg>
  ),
  Search: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <circle cx="7" cy="7" r="4.5" {...stroke} />
      <path d="m10.5 10.5 3 3" {...stroke} />
    </svg>
  ),
  Sprint: ({ size = 16 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" {...stroke} />
      <path d="M8 2.5h3.5V6" {...stroke} />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
    </svg>
  ),
  Backlog: ({ size = 16 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <rect x="2.5" y="2.5" width="11" height="3" rx="1" {...stroke} />
      <rect x="2.5" y="7" width="11" height="3" rx="1" {...stroke} />
      <path d="M3.5 13h9" {...stroke} />
    </svg>
  ),
  Filter: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M2.5 4h11M4.5 8h7M6.5 12h3" {...stroke} />
    </svg>
  ),
  External: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" {...stroke} />
    </svg>
  ),
  Close: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="m4 4 8 8M12 4l-8 8" {...stroke} />
    </svg>
  ),
  Check: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="m3.5 8.5 3 3 6-7" {...stroke} />
    </svg>
  ),
  Plus: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M8 3.5v9M3.5 8h9" {...stroke} />
    </svg>
  ),
  Clock: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="5.5" {...stroke} />
      <path d="M8 5v3.2l2 1.3" {...stroke} />
    </svg>
  ),
  Tag: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M2.5 2.5h5l6 6-5 5-6-6z" {...stroke} />
      <circle cx="5.5" cy="5.5" r="1" fill="currentColor" />
    </svg>
  ),
  Copy: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" {...stroke} />
      <path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" {...stroke} />
    </svg>
  ),
  Epic: ({ size = 14, color }: IconProps & { color: string }) => (
    <svg width={size} height={size} viewBox="0 0 14 14">
      <rect x="1" y="1" width="12" height="12" rx="3.5" fill={color} />
    </svg>
  ),
  Link: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.9.9M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.9-.9" {...stroke} />
    </svg>
  ),
  Trash: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" {...stroke} />
    </svg>
  ),
  Move: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M8 2.5v11M5.5 5 8 2.5 10.5 5M5.5 11 8 13.5l2.5-2.5" {...stroke} />
    </svg>
  ),
  ArrowUp: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M8 13V3M4 7l4-4 4 4" {...stroke} />
    </svg>
  ),
  ArrowDown: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M8 3v10M4 9l4 4 4-4" {...stroke} />
    </svg>
  ),
  Logout: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M6 2.5H3.5v11H6M10 5l3 3-3 3M13 8H6" {...stroke} />
    </svg>
  ),
  Split: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M8 2.5v11M2.5 3.5h11v9h-11z" {...stroke} />
    </svg>
  ),
  Merge: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M2.5 3.5h11v9h-11zM5 8h6M9.5 6.5 11 8l-1.5 1.5" {...stroke} />
    </svg>
  ),
  Refresh: ({ size = 14 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" {...stroke} />
    </svg>
  ),
};
