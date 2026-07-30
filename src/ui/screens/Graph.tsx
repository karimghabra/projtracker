/**
 * The dependency graph.
 *
 * Project → milestone → goal, flowing left to right, one band per project.
 * Drag from a node's port onto another node to make that node wait for this
 * one; click an arrow to remove it. Links may cross projects freely — that is
 * the whole reason this screen exists.
 *
 * Provenance is in the line style and never only in colour:
 *   thin grey, no arrow   containment (this is inside that)
 *   solid accent + arrow  a link you drew
 *   solid grey + arrow    an order you set
 *   dashed                an order we guessed
 *   dotted, faded         a guess that was overruled, kept visible
 *
 * The panel does no reasoning. Columns, rows, edges and states all arrive from
 * the command layer already decided.
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
} from '../components/icons.tsx';

const NODE_W = 172;
const NODE_H = 54;
const COL_GAP = 84;
const ROW_H = 74;
const PAD_X = 150;
const PAD_Y = 40;

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
  const [zoom, setZoom] = useState(1);
  const svgRef = useRef<SVGSVGElement>(null);

  const graph = app.graph({ showGuessed });

  const { placed, width, height, bandBoxes } = useMemo(() => {
    const maxRank = graph.nodes.reduce((max, n) => Math.max(max, n.rank), 0);
    const out: Placed[] = graph.nodes.map((node) => ({
      ...node,
      x: PAD_X + node.rank * (NODE_W + COL_GAP),
      y: PAD_Y + node.lane * ROW_H,
    }));

    const boxes = graph.bands.map((band) => ({
      name: band.projectName,
      y: PAD_Y + band.firstLane * ROW_H - 22,
      h: band.laneCount * ROW_H + 12,
    }));

    return {
      placed: out,
      width: PAD_X + (maxRank + 1) * (NODE_W + COL_GAP) + 40,
      height: PAD_Y + graph.laneCount * ROW_H + 30,
      bandBoxes: boxes,
    };
  }, [graph]);

  const positions = useMemo(() => new Map(placed.map((n) => [n.id, n])), [placed]);

  const toSvgPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return { x: 0, y: 0 };
    // getScreenCTM is the only correct conversion; dividing by the bounding
    // rect is subtly wrong as soon as the view is scaled.
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

        <span className="faint nowrap">Drag the circle on a card onto whatever should wait for it.</span>
        <span className="spacer" />

        <button
          className="btn ghost icon"
          onClick={() => setZoom((z) => Math.min(1.8, +(z * 1.2).toFixed(3)))}
          aria-label="Zoom in"
        >
          <IconPlus size={14} />
        </button>
        <button
          className="btn ghost icon"
          onClick={() => setZoom((z) => Math.max(0.4, +(z / 1.2).toFixed(3)))}
          aria-label="Zoom out"
        >
          <IconMinus size={14} />
        </button>
        <button className="btn sm" onClick={() => setZoom(1)}>
          Reset view
        </button>
      </div>

      <div className="graph-canvas">
        <svg
          ref={svgRef}
          role="application"
          aria-label="Dependency graph"
          data-testid="graph-svg"
          width={width * zoom}
          height={height * zoom}
          viewBox={`0 0 ${width} ${height}`}
          onMouseMove={(event) => {
            if (dragFrom) setPointer(toSvgPoint(event.clientX, event.clientY));
          }}
          onMouseUp={() => {
            setDragFrom(null);
            setPointer(null);
          }}
          onMouseLeave={() => {
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

          {bandBoxes.map((band) => (
            <g key={band.name}>
              <rect
                x={12}
                y={band.y}
                width={width - 40}
                height={band.h}
                rx={12}
                fill="var(--bg-sunken)"
                stroke="var(--border)"
              />
              <text x={26} y={band.y + 18} className="graph-band-label">
                {band.name}
              </text>
            </g>
          ))}

          {graph.edges.map((edge) => (
            <Edge
              key={`${edge.via}-${edge.from}-${edge.to}`}
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
              isSource={dragFrom === node.id}
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

      {selected && app.state.nodes[selected] && (
        <GraphInspector id={selected} onClose={() => setSelected(null)} />
      )}

      <div className="graph-legend">
        <span><Sample stroke="var(--text-faint)" width={1.2} opacity={0.6} /> contains</span>
        <span><Sample stroke="var(--accent)" width={2} /> link you drew</span>
        <span><Sample stroke="var(--text-faint)" width={1.6} /> order you set</span>
        <span><Sample stroke="var(--text-faint)" width={1.6} dash="4 3" /> order we guessed</span>
        <span><Sample stroke="var(--text-faint)" width={1.4} dash="1 3" opacity={0.5} /> guess overruled</span>
      </div>
    </div>
  );
}

function Sample({ stroke, width, dash, opacity }: { stroke: string; width: number; dash?: string; opacity?: number }) {
  return (
    <svg width="26" height="8" aria-hidden="true">
      <line x1="0" y1="4" x2="26" y2="4" stroke={stroke} strokeWidth={width} strokeDasharray={dash} opacity={opacity} />
    </svg>
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

  const sameColumn = from.rank === to.rank;
  let path: string;
  let midX: number;
  let midY: number;

  if (sameColumn) {
    // Sibling ordering: bulge out to the left so it does not run through the
    // cards sitting between the two.
    const x = from.x - 14;
    const y1 = from.y + NODE_H / 2;
    const y2 = to.y + NODE_H / 2;
    const bulge = 34;
    path = `M ${from.x} ${y1} C ${x - bulge} ${y1}, ${x - bulge} ${y2}, ${to.x} ${y2}`;
    midX = x - bulge * 0.75;
    midY = (y1 + y2) / 2;
  } else {
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const dx = Math.max(28, Math.abs(x2 - x1) * 0.5);
    path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    midX = (x1 + x2) / 2;
    midY = (y1 + y2) / 2;
  }

  if (edge.via === 'child') {
    return (
      <path
        d={path}
        fill="none"
        stroke="var(--text-faint)"
        strokeWidth={1.2}
        opacity={0.55}
        data-testid={`edge-child-${edge.from}-${edge.to}`}
      />
    );
  }

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
        <g
          className="edge-remove"
          data-testid={`remove-${edge.from}-${edge.to}`}
          transform={`translate(${midX}, ${midY})`}
          onClick={onRemove}
          style={{ cursor: 'pointer' }}
        >
          <title>Remove this link</title>
          <circle r="10" fill="var(--bg-raised)" stroke="var(--danger)" strokeWidth="1.4" />
          <path d="M -4 -4 L 4 4 M 4 -4 L -4 4" stroke="var(--danger)" strokeWidth="1.8" strokeLinecap="round" />
        </g>
      )}
    </g>
  );
}

function GraphNode({
  node,
  selected,
  dragging,
  isSource,
  validTarget,
  onSelect,
  onStartLink,
  onDropLink,
}: {
  node: Placed;
  selected: boolean;
  dragging: boolean;
  isSource: boolean;
  validTarget: boolean;
  onSelect: () => void;
  onStartLink: () => void;
  onDropLink: () => void;
}) {
  const dim = dragging && !validTarget && !isSource;

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      data-testid={`gnode-${node.id}`}
      opacity={dim ? 0.3 : 1}
      onMouseUp={dragging && !isSource ? onDropLink : undefined}
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
      <text x={11} y={17} className="graph-node-kind" onClick={onSelect}>
        {node.kind}
        {node.progress ? ` · ${node.progress.done}/${node.progress.total}` : ''}
      </text>
      <text x={11} y={34} className="graph-node-name" onClick={onSelect}>
        {node.name.length > 21 ? `${node.name.slice(0, 20)}…` : node.name}
      </text>
      <text x={11} y={47} className="graph-node-status" onClick={onSelect}>
        {node.derived === 'waiting' && node.waitingOn
          ? `waiting: ${node.waitingOn.reason.slice(0, 16)}`
          : node.derived === 'blocked' && node.blockedBy.length
            ? `after ${node.blockedBy[0]!.slice(0, 16)}`
            : node.derived}
      </text>

      <circle
        cx={NODE_W}
        cy={NODE_H / 2}
        r={7}
        fill="var(--bg-raised)"
        stroke="var(--accent)"
        strokeWidth={1.6}
        className="graph-port"
        data-testid={`port-${node.id}`}
        onMouseDown={(event) => {
          event.stopPropagation();
          event.preventDefault();
          onStartLink();
        }}
      >
        <title>Drag onto whatever should wait for this</title>
      </circle>
    </g>
  );
}

function GraphInspector({ id, onClose }: { id: string; onClose: () => void }) {
  const { app, run } = useApp();
  const node = app.node(id);

  return (
    <div className="graph-inspector" data-testid="graph-inspector">
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
        <button className="btn sm" onClick={() => run((a) => a.start(id))} aria-label="Start">
          <IconPlay size={12} />
        </button>
        <button className="btn sm" onClick={() => run((a) => a.pause(id))} aria-label="Pause">
          <IconPause size={12} />
        </button>
        <button className="btn sm primary" onClick={() => run((a) => a.complete(id))} aria-label="Complete">
          <IconCheck size={12} />
        </button>
      </div>

      {node.blockers.length > 0 && (
        <div className="faint" style={{ marginTop: 8 }}>
          Waiting for: {node.blockers.map((b) => b.name).join(', ')}
        </div>
      )}
    </div>
  );
}
