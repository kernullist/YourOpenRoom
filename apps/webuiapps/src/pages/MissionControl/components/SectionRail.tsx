import { Activity, BarChart3, Inbox, PlaneTakeoff, Radio } from 'lucide-react';
import type { MissionControlViewId } from '../types';
import styles from './SectionRail.module.scss';

interface RailItem {
  id: MissionControlViewId;
  label: string;
  Icon: typeof Activity;
}

const ITEMS: RailItem[] = [
  { id: 'runtime', label: 'Runtime', Icon: Activity },
  { id: 'queue', label: 'Queue', Icon: Inbox },
  { id: 'timeline', label: 'Timeline', Icon: Radio },
  { id: 'flight', label: 'Flight Recorder', Icon: PlaneTakeoff },
  { id: 'metrics', label: 'Metrics', Icon: BarChart3 },
];

interface SectionRailProps {
  activeView: MissionControlViewId;
  pendingProposalCount: number | null;
  onSelect: (view: MissionControlViewId) => void;
}

export function SectionRail({
  activeView,
  pendingProposalCount,
  onSelect,
}: SectionRailProps): JSX.Element {
  return (
    <nav className={styles.rail} aria-label="Mission Control 섹션">
      {ITEMS.map(({ id, label, Icon }) => {
        // null means we have not read the queue yet -- distinct from a known
        // zero, so no badge is drawn rather than a confident "0".
        const badge = id === 'queue' && pendingProposalCount ? pendingProposalCount : null;
        return (
          <button
            key={id}
            type="button"
            className={styles.item}
            data-active={id === activeView ? 'true' : undefined}
            data-testid={`mission-control-rail-${id}`}
            onClick={() => onSelect(id)}
            title={label}
            aria-current={id === activeView ? 'page' : undefined}
          >
            <Icon size={15} className={styles.itemIcon} />
            <span className={styles.itemLabel}>{label}</span>
            {badge !== null ? <span className={styles.badge}>{badge}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}

export default SectionRail;
