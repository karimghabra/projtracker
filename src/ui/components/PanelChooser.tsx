/**
 * Choosing what is on the dashboard, without a mouse.
 *
 * The screen was a fixed list of ten panels in a fixed order, which is fine
 * until somebody has five projects and eighteen cultures — then the column is
 * two and a half screens and the answer depends entirely on which of those ten
 * that person actually reads. So they choose: show, hide, width, and order.
 *
 * Everything here can also be done by dragging a card, and that is the way most
 * people will do it. This exists because a drag is not a keyboard, a width you
 * can read as "7 of 12" is not a guess, and a card dragged somewhere silly
 * needs a way back.
 */

import { Modal } from './ui.tsx';
import {
  COLUMNS,
  MIN_SPAN,
  PANELS,
  heightOf,
  isHidden,
  moveCard,
  panelOrderIds,
  placeOf,
  setHeight,
  toggleHidden,
  type Layout,
  type PanelId,
} from '../state/dashboard.ts';

export function PanelChooser({
  layout,
  onChange,
  onReset,
  onClose,
}: {
  layout: Layout;
  onChange: (next: Layout) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const order = panelOrderIds(layout);
  const spec = (id: PanelId) => PANELS.find((p) => p.id === id)!;

  const nudge = (id: PanelId, by: number) =>
    onChange(moveCard(layout, id, { index: order.indexOf(id) + by }));

  return (
    <Modal
      title="What is on the dashboard"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" data-testid="panels-reset" onClick={onReset}>
            Put it back how it was
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="stack tight" data-testid="panel-chooser">
        {order.map((id, at) => {
          const panel = spec(id);
          const hidden = isHidden(layout, id);
          const { x, w } = placeOf(layout, id);
          const height = heightOf(layout, id);
          return (
            <div className="row" key={id} data-testid={`chooser-${id}`}>
              <input
                type="checkbox"
                className="check"
                checked={!hidden}
                disabled={panel.required}
                aria-label={`Show ${panel.title}`}
                data-testid={`show-panel-${id}`}
                onChange={() => onChange(toggleHidden(layout, id))}
              />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row-title">{panel.title}</div>
                <div className="row-sub">
                  {panel.required
                    ? 'Always on — the day is what the screen is for'
                    : `${w} of ${COLUMNS} wide, from column ${x + 1}${height ? `, ${height}px tall` : ''}`}
                </div>
              </div>

              {height !== undefined && (
                <button
                  className="btn ghost sm"
                  data-testid={`fit-${id}`}
                  onClick={() => onChange(setHeight(layout, id, null))}
                >
                  Fit contents
                </button>
              )}

              <div className="segmented" role="group" aria-label={`How wide ${panel.title} is`}>
                <button
                  className="seg"
                  disabled={hidden || w <= MIN_SPAN}
                  aria-label={`Make ${panel.title} narrower`}
                  data-testid={`narrower-${id}`}
                  onClick={() => onChange(moveCard(layout, id, { w: w - 1 }))}
                >
                  −
                </button>
                <button
                  className="seg"
                  disabled={hidden || w >= COLUMNS}
                  aria-label={`Make ${panel.title} wider`}
                  data-testid={`wider-${id}`}
                  onClick={() => onChange(moveCard(layout, id, { w: w + 1 }))}
                >
                  +
                </button>
              </div>

              <div className="segmented" role="group" aria-label={`Where ${panel.title} is`}>
                <button
                  className="seg"
                  disabled={at === 0}
                  aria-label={`Move ${panel.title} earlier`}
                  data-testid={`earlier-${id}`}
                  onClick={() => nudge(id, -1)}
                >
                  ↑
                </button>
                <button
                  className="seg"
                  disabled={at === order.length - 1}
                  aria-label={`Move ${panel.title} later`}
                  data-testid={`later-${id}`}
                  onClick={() => nudge(id, 1)}
                >
                  ↓
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
