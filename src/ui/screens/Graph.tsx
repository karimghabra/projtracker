/**
 * The dependency graph.
 *
 * Project → milestone → goal, one band per project, laid out left to right by
 * longest path so every arrow points forward. Drag from a node's port to
 * another node to make it wait for this one; click an arrow to remove it.
 *
 * Provenance is in the line style and is never only in colour:
 *   solid + arrowhead  a link you drew
 *   solid grey         an order you set
 *   dashed             an order we guessed
 *   dotted, faded      a guess that was overruled (shown so it does not vanish)
 *
 * This panel does no reasoning. Positions, edges and states all arrive from the
 * command layer already decided.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { DerivedStatus } from '../../core/model.ts';
import type { GraphEdgeView, GraphNodeView } from '../../commands/views.ts';
import { useApp } from '../state/store.ts';
import { Empty } from '../components/ui.tsx';
import {
  IconCheck,
  IconGraph,
  IconMinus,
  IconPause,
  IconPlay,
  IconPlus,
  IconTrash,
} from '../components/icons.tsx';

const NODE_W = 176;
const NODE_H = 52;
const COL_GAP = 96;
const ROW_GAP = 18;
const BAND_GAP = 46;
const BAND_PAD = 34;

const STATUS_FILL: Record<DerivedStatus, string> = {
  ready: 'var(--accent-soft)',
  blocked: 'var(--bg-sunken)',
  in_progress: 'var(--info-soft)',
  waiting: 'var(--warn-soft)',
  done: 'var(--ok-soft)',
  dropped: 'var(--bg-sunken)',
};

const STATUS_STROKE: Record<DerivedStatus, string> = {
  ready: 'var(--accent)',
  blocked: 'var(--border-strong)',
  in_progress: 'var(--info)',
  waiting: 'var(--warn)',
  done: 'var(--ok)',
  dropped: 'var(--border)',
};

interface Placed extends GraphNodeView {
  x: number;
  y: number;
}

export function GraphScreen() {
  const { app, run } = useApp();
  const [showGuessed, setShowGuessed] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const panning = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const graph = app.graph({ showGuessed });

  const { placed, bands, width, height } = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const out: Placed[] = [];
    const bandBoxes: { name: string; x: number; y: number; w: number; h: number }[] = [];
    let cursorY = BAND_PAD;
    let maxX = 0;

    for (const band of graph.bands) {
      const members = band.nodeIds.map((id) => byId.get(id)).filter(Boolean) as GraphNodeView[];
      if (!members.length) continue;

      const lanesByRank = new Map<number, number>();
      let bandHeight = 0;
      for (const node of members) {
        const lane = lanesByRank.get(node.rank) ?? 0;
        lanesByRank.set(node.rank, lane + 1);
        const x = BAND_PAD + node.rank * (NODE_W + COL_GAP);
        const y = cursorY + 26 + lane * (NODE_H + ROW_GAP);
        out.push({ ...node, x, y });
        maxX = Math.max(maxX, x + NODE_W);
        bandHeight = Math.max(bandHeight, 26 + (lane + 1) * (NODE_H + ROW_GAP));
      }

      bandBoxes.push({
        name: band.projectName,
        x: BAND_PAD - 16,
        y: cursorY - 8,
        w: 0,
        h: bandHeight + 8,
      });
      cursorY += bandHeight + BAND_GAP;
    }

    const totalWidth = maxX + BAND_PAD;
    for (const box of bandBoxes) box.w = totalWidth - box.x - BAND_PAD + 32;

    return { placed: out, bands: bandBoxes, width: totalWidth, height: cursorY };
  }, [graph]);

  const positions = useMemo(() => new Map(placed.map((n) => [n.id, n])), [placed]);

  const toSvgPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    // getScreenCTM is the only correct conversion under preserveAspectRatio;
    // dividing by the bounding rect is subtly wrong when the view letterboxes.
    const matrix = svg.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  }, []);

  if (graph.nodes.length === 0) {
    return (
      <Empty title="Nothing to draw yet" icon={<IconGraph size={20} />}>
        Add a project and its milestones, then come back to link work across projects.
      </Empty>
    );
  }

  const selectedNode = selected ? app.state.nodes[selected] : null;
  const dropTargetValid = (id: string) => !dragFrom || app.checkDep(dragFrom, id).ok;

  return (
    <div className="graph-screen">
      <div className="graph-toolbar">
        <label className="inline nowrap" style={{ gap: 6 }}>
          <input
            type="checkbox"
            className="check"
            checked={showGuessed}
            onChange={(event) => setShowGuessed(event.target.checked)}
          />
          Show guessed order
        </label>

        <span className="spacer" />

        {selectedNode && (
          <>
            <strong className="nowrap">{selectedNode.name}</strong>
            {selectedNode.kind === 'goal' || selectedNode.kind === 'milestone' ? null : null}
            <button className="btn sm ghost" onClick={() => setSelected(null)}>
              Deselect
            </button>
          </>
        )}

        <button className="btn ghost icon" onClick={() => setView({ ...view, scale: Math.min(2, view.scale * 1.2) })} aria-label="Zoom in">
          <IconPlus size={14} />
        </button>
        <button className="btn ghost icon" onClick={() => setView({ ...view, scale: Math.max(0.3, view.scale / 1.2) })} aria-label="Zoom out">
          <IconMinus size={14} />
        </button>
        <button className="btn sm" onClick={() => setView({ x: 0, y: 0, scale: 1 })}>
          Reset view
        </button>
      </div>

      <div className="graph-canvas">
        <svg
          ref={svgRef}
          role="application"
          aria-label="Dependency graph"
          data-testid="graph-svg"
          viewBox={`${-view.x} ${-view.y} ${width / view.scale} ${height / view.scale}`}
          preserveAspectRatio="xMinYMin meet"
          onMouseMove={(event) => {
            if (dragFrom) setPointer(toSvgPoint(event.clientX, event.clientY));
            const pan = panning.current;
            if (pan) {
              setView((v) => ({
                ...v,
                x: pan.ox + (event.clientX - pan.x) / v.scale,
                y: pan.oy + (event.clientY - pan.y) / v.scale,
              }));
            }
          }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              panning.current = { x: event.clientX, y: event.clientY, ox: view.x, oy: view.y };
            }
          }}
          onMouseUp={() => {
            panning.current = null;
            setDragFrom(null);
            setPointer(null);
          }}
          onMouseLeave={() => {
            panning.current = null;
            setDragFrom(null);
            setPointer(null);
          }}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
            </marker>
            <marker id="arrow-grey" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-faint)" />
            </marker>
          </defs>

          {bands.map((band) => (
            <g key={band.name}>
              <rect
                x={band.x}
                y={band.y}
                width={band.w}
                height={band.h}
                rx={12}
                fill="var(--bg-sunken)"
                stroke="var(--border)"
              />
              <text x={band.x + 14} y={band.y + 18} className="graph-band-label">
                {band.name}
              </text>
            </g>
          ))}

          {graph.edges.map((edge) => (
            <Edge
              key={`${edge.from}-${edge.to}-${edge.via}`}
              edge={edge}
              positions={positions}
              onRemove={edge.depId ? () => run((a) => a.removeDep(edge.depId!)) : undefined}
            />
          ))}

          {dragFrom && pointer && positions.get(dragFrom) && (
            <line
              x1={positions.get(dragFrom)!.x + NODE_W}
              y1={positions.get(dragFrom)!.y + NODE_H / 2}
              x2={pointer.x}
              y2={pointer.y}
              stroke="var(--accent)"
              strokeWidth={2}
              strokeDasharray="5 4"
              pointerEvents="none"
            />
          )}

          {placed.map((node) => (
            <GraphNode
              key={node.id}
              node={node}
              selected={selected === node.id}
              dragging={!!dragFrom}
              validTarget={dropTargetValid(node.id)}
              onSelect={() => setSelected(node.id)}
              onStartLink={() => setDragFrom(node.id)}
              onDropLink={() => {
                if (dragFrom && dragFrom !== node.id) run((a) => a.addDep(dragFrom, node.id));
                setDragFrom(null);
                setPointer(null);
              }}
            />
          ))}
        </svg>
      </div>

      {selectedNode && <GraphInspector id={selectedNode.id} onClose={() => setSelected(null)} />}

      <div className="graph-legend">
        <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--accent)" strokeWidth="2" /></svg> link you drew</span>
        <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--text-faint)" strokeWidth="1.6" /></svg> order you set</span>
        <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--text-faint)" strokeWidth="1.6" strokeDasharray="4 3" /></svg> order we guessed</span>
        <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--text-faint)" strokeWidth="1.4" strokeDasharray="1 3" opacity="0.5" /></svg> guess overruled</span>
      </div>
    </div>
  );
}

function Edge({
  edge,
  positions,
  onRemove,
}: {
  edge: GraphEdgeView;
  positions: Map<string, Placed>;
  onRemove?: () => void;
}) {
  const from = positions.get(edge.from);
  const to = positions.get(edge.to);
  if (!from || !to) return null;

  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const dx = Math.max(30, Math.abs(x2 - x1) * 0.45);
  const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

  const isDep = edge.via === 'dep';
  const guessed = edge.seqSource === 'assumed';

  return (
    <g className="graph-edge" data-testid={`edge-${edge.from}-${edge.to}`}>
      <path
        d={path}
        fill="none"
        stroke={isDep ? 'var(--accent)' : 'var(--text-faint)'}
        strokeWidth={isDep ? 2 : 1.6}
        strokeDasharray={edge.suppressed ? '1 3' : guessed ? '4 3' : undefined}
        opacity={edge.suppressed ? 0.45 : 1}
        markerEnd={isDep ? 'url(#arrow)' : 'url(#arrow-grey)'}
      />
      {onRemove && (
        <>
          {/* A wide invisible path: horizontal edges have zero-height boxes. */}
          <path d={path} fill="none" stroke="transparent" strokeWidth={14} style={{ cursor: 'pointer' }} onClick={onRemove}>
            <title>Click to remove this link</title>
          </path>
          <g
            className="edge-remove"
            transform={`translate(${(x1 + x2) / 2 - 8}, ${(y1 + y2) / 2 - 8})`}
            onClick={onRemove}
            style={{ cursor: 'pointer' }}
          >
            <circle cx="8" cy="8" r="9" fill="var(--bg-raised)" stroke="var(--danger)" />
            <g transform="translate(2,2)" stroke="var(--danger)" strokeWidth="1.6" fill="none">
              <IconTrash size={12} />
            </g>
          </g>
        </>
      )}
    </g>
  );
}

function GraphNode({
  node,
  selected,
  dragging,
  validTarget,
  onSelect,
  onStartLink,
  onDropLink,
}: {
  node: Placed;
  selected: boolean;
  dragging: boolean;
  validTarget: boolean;
  onSelect: () => void;
  onStartLink: () => void;
  onDropLink: () => void;
}) {
  const dim = dragging && !validTarget;

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      data-testid={`gnode-${node.id}`}
      opacity={dim ? 0.35 : 1}
      onMouseUp={dragging ? onDropLink : undefined}
      style={{ cursor: 'pointer' }}
    >
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={9}
        fill={STATUS_FILL[node.derived]}
        stroke={selected ? 'var(--accent)' : STATUS_STROKE[node.derived]}
        strokeWidth={selected ? 2.5 : 1.4}
        onClick={onSelect}
      />
      <text x={11} y={19} className="graph-node-kind">
        {node.kind}
        {node.progress ? `  ${node.progress.done}/${node.progress.total}` : ''}
      </text>
      <text x={11} y={36} className="graph-node-name" onClick={onSelect}>
        {node.name.length > 22 ? `${node.name.slice(0, 21)}…` : node.name}
      </text>
      <text x={11} y={47} className="graph-node-status">
        {node.derived === 'waiting' && node.waitingOn ? `waiting: ${node.waitingOn.reason.slice(0, 18)}` : node.derived}
      </text>

      {/* The port you drag from. */}
      <circle
        cx={NODE_W}
        cy={NODE_H / 2}
        r={6}
        fill="var(--bg-raised)"
        stroke="var(--accent)"
        strokeWidth={1.6}
        className="graph-port"
        data-testid={`port-${node.id}`}
        onMouseDown={(event) => {
          event.stopPropagation();
          onStartLink();
        }}
      >
        <title>Drag to something this should block</title>
      </circle>
    </g>
  );
}

function GraphInspector({ id, onClose }: { id: string; onClose: () => void }) {
  const { app, run } = useApp();
  const node = app.node(id);
  const isLeaf = node.kind === 'task' || node.kind === 'experiment';

  return (
    <div className="graph-inspector">
      <div className="inline">
        <span className="chip kind-chip">{node.kind}</span>
        <strong className="grow">{node.name}</strong>
        <button className="btn ghost sm" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="inline wrap" style={{ marginTop: 8 }}>
        <input
          className="input"
          style={{ width: 70, flex: 'none' }}
          type="number"
          min={1}
          value={node.seq}
          aria-label="Sequence number"
          onChange={(event) => {
            const next = Number(event.target.value);
            if (next >= 1) run((a) => a.setSeq(id, next), { silent: true });
          }}
        />
        <input
          className="input grow"
          value={node.name}
          aria-label="Name"
          onChange={(event) => run((a) => a.updateNode(id, { name: event.target.value }), { silent: true })}
        />
        {isLeaf && (
          <>
            <button className="btn sm" onClick={() => run((a) => a.start(id))} aria-label="Start">
              <IconPlay size={12} />
            </button>
            <button className="btn sm" onClick={() => run((a) => a.pause(id))} aria-label="Pause">
              <IconPause size={12} />
            </button>
            <button className="btn sm primary" onClick={() => run((a) => a.complete(id))} aria-label="Complete">
              <IconCheck size={12} />
            </button>
          </>
        )}
      </div>

      {node.blockers.length > 0 && (
        <div className="faint" style={{ marginTop: 8 }}>
          Waiting for: {node.blockers.map((b) => b.name).join(', ')}
        </div>
      )}
    </div>
  );
}
