import { HEALTH } from "../status";

/**
 * Stacked health bar: segments separated by a 2px gap in the surface colour,
 * never a stroke — flex-grow carries the proportion so the gaps subtract
 * cleanly. Always paired with the Breakdown counts and the legend, so the
 * colour never carries the meaning alone.
 */
export function HealthBar({
  health,
  total,
}: {
  health: Record<string, number> | undefined;
  total: number;
}) {
  if (!total) {
    return <div className="bar is-empty" role="img" aria-label="no open tasks" />;
  }
  return (
    <div className="bar">
      {HEALTH.filter((h) => health?.[h.key]).map((h) => (
        <span
          key={h.key}
          style={{ flex: `${health![h.key]} 1 0`, background: h.css }}
          title={`${h.label}: ${health![h.key]}`}
        />
      ))}
    </div>
  );
}

export function Breakdown({ health }: { health: Record<string, number> | undefined }) {
  const parts = HEALTH.filter((h) => health?.[h.key]);
  if (!parts.length) return null;
  return (
    <div className="breakdown">
      {parts.map((h) => (
        <span className="k" key={h.key}>
          <span className="swatch" style={{ background: h.css }} />
          <span className="n">{health![h.key]}</span> {h.label}
        </span>
      ))}
    </div>
  );
}
