import { Icon, type IconName } from './Icon';

/**
 * The summary of a city menu (ADR-053). Where the city column is narrow, the label is kept
 * for assistive technology and the tooltip, and a short badge shows the count instead, so
 * the toolbar keeps its rows (ADR-047 first-screen budget).
 */
export function MenuSummary({ icon, label, badge }: { icon: IconName; label: string; badge?: string | null }) {
  return (
    <summary title={label}>
      <Icon name={icon} />
      <span className="menu-label">{label}</span>
      {badge ? (
        <span className="menu-badge" aria-hidden="true">
          {badge}
        </span>
      ) : null}
    </summary>
  );
}
