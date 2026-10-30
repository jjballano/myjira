import { colorFor } from '../util';
import { Icon } from './icons';
import { Menu } from './Menu';
import { Popover } from './Popover';

export const NO_EPIC = 'none';

export interface EpicOption {
  key: string;
  summary: string;
}

/** Hides swimlanes by epic. Stores what's hidden, so epics new to the sprint show up by default. */
export function EpicFilter({ epics, hidden, onChange }: { epics: EpicOption[]; hidden: string[]; onChange: (keys: string[]) => void }) {
  const count = epics.filter((e) => hidden.includes(e.key)).length;
  return (
    <Popover
      width={320}
      renderTrigger={(p) => (
        <button className={`btn btn-ghost${count ? ' on' : ''}`} {...p}>
          <Icon.Epic color="var(--muted)" size={12} /> Épicas
          {count > 0 && (
            <span className="badge">
              {epics.length - count}/{epics.length}
            </span>
          )}
        </button>
      )}
    >
      {() => (
        <Menu
          placeholder="Buscar épica…"
          items={[
            { id: '*all', label: 'Todas', icon: <Icon.Check size={13} /> },
            { id: '*none', label: 'Ninguna', icon: <Icon.Close size={13} /> },
            ...epics.map((e) => ({
              id: e.key,
              label: e.key === NO_EPIC ? 'Sin épica' : e.summary,
              icon: e.key === NO_EPIC ? <Icon.Epic color="var(--muted)" size={12} /> : <Icon.Epic color={colorFor(e.key)} size={12} />,
              hint: e.key === NO_EPIC ? undefined : e.key,
              selected: !hidden.includes(e.key),
            })),
          ]}
          onSelect={(item) => {
            if (item.id === '*all') return onChange([]);
            if (item.id === '*none') return onChange(epics.map((e) => e.key));
            onChange(hidden.includes(item.id) ? hidden.filter((k) => k !== item.id) : [...hidden, item.id]);
          }}
        />
      )}
    </Popover>
  );
}
