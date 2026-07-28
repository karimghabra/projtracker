import { HEALTH } from "../status";

const DOTS: [string, string, boolean][] = [
  ["ready", "var(--good)", false],
  ["waiting", "var(--warning)", true],
  ["blocked", "var(--neutral)", true],
  ["in progress", "var(--accent)", false],
];

/** Identity is never colour-alone: the legend names every state. */
export function Legend() {
  return (
    <div className="legend" data-testid="legend">
      {DOTS.map(([label, css, hollow]) => (
        <span className="k" key={label}>
          <span
            className={"dot" + (hollow ? " hollow" : "")}
            style={hollow ? { borderColor: css } : { background: css }}
          />
          {label}
        </span>
      ))}
      {HEALTH.map((h) => (
        <span className="k" key={h.key}>
          <span className="swatch" style={{ background: h.css }} />
          {h.label}
        </span>
      ))}
    </div>
  );
}
