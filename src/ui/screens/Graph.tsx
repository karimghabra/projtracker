/**
 * The dependency graph.
 *
 * Project → milestone → goal, flowing left to right, one band per project.
 * Drag from a card's port onto another card to make it wait; click an arrow to
 * remove it. Links may cross projects freely — that is the reason this screen
 * exists.
 *
 * A board is only useful while it stays readable, and a real lab has a dozen
 * projects rather than two. So the toolbar is mostly about seeing less: filter
 * to the projects you care about, collapse a band to its title, hide what is
 * finished, or focus a single node and see only what it touches. Search dims
 * everything that does not match rather than removing it, so you keep your
 * bearings.
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
import type { GraphDetail, GraphEdgeView, GraphNodeView } from '../../commands/views.ts';
import { useApp } from '../state/store.ts';
import { Empty } from '../components/ui.tsx';
import {
  IconCheck,
  IconGraph,
  IconMinus,
  IconPause,
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
  const [showGuessed, setShowGuessed] = useState(false);
  const [hideDone, setHideDone] = useState(false);
  const [projectIds, setProjectIds] = useState<string[] | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GraphDetail | 'auto'>('auto');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const graph = app.graph({
    showGuessed,
    hideDone,
    projectIds: projectIds ?? undefined,
    collapsed,
    focusId: focusId ?? undefined,
    detail: detail === 'auto' ? undefined : detail,
    zoom,
  });

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? new Set(graph.nodes.filter((n) => n.name.toLowerCase().includes(needle)).map((n) => n.id))
    : null;

  const { placed, width, height, bandBoxes } = useMemo(() => {
    const maxRank = graph.nodes.reduce((max, n) => Math.max(max, n.rank), 0);
    const out: Placed[] = graph.nodes.map((node) => ({
      ...node,
      x: PAD_X + node.rank * (NODE_W + COL_GAP),
      y: PAD_Y + node.lane * ROW_H,
    }));

    const boxes = graph.bands.map((band) => ({
      id: band.projectId,
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

  const clearFilters = () => {
    setFocusId(null);
    setProjectIds(null);
    setCollapsed([]);
    setHideDone(false);
  };

  if (graph.projects.length === 0) {
    return (
      <Empty title="Nothing to draw yet" icon={<IconGraph size={20} />}>
        Add a project and its milestones, then come back to link work across projects.
      </Empty>
    );
  }

  const dropTargetValid = (id: string) => !dragFrom || app.checkDep(dragFrom, id).ok;

  const toggleProject = (id: string) => {
    const current = projectIds ?? graph.projects.map((p) => p.id);
    const next = current.includes(id) ? current.filter((p) => p !== id) : [...current, id];
    setProjectIds(next.length === graph.projects.length ? null : next);
  };

  const toggleBand = (id: string) =>
    setCollapsed(collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id]);

  /**
   * Fit the whole board, both ways.
   *
   * Fitting the width alone still left five projects stacked four screens deep,
   * which is the complaint: you cannot keep track of a hierarchy you can only
   * ever see a fifth of. Whichever axis is tighter wins.
   */
  const fitToWidth = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || height === 0) return;
    const byWidth = (canvas.clientWidth - 24) / width;
    const byHeight = (canvas.clientHeight - 24) / height;
    setZoom(Math.min(1.8, Math.max(0.25, +Math.min(byWidth, byHeight).toFixed(3))));
  }, [width, height]);

  /*
    Deliberately not fitting on arrival.

    It seemed obvious — a board five times the height of the window should open
    showing all of it — and it is wrong here, because zoom is already the
    control that drives Auto detail: zooming out folds the hierarchy up. An
    automatic fit would silently pick a detail level on the user's behalf and
    make "how much of my board is shown" depend on the size of their window.
    Fit stays a button, and now fits both axes when pressed.
  */

  /*
    Tracing: hovering a card lifts it and everything it connects to, and pushes
    the rest back. With a hundred cards the lines genuinely do knit together
    into a mesh, and no amount of routing fixes that — what fixes it is being
    able to ask "this one, and what touches it" without losing the board.
  */
  const [traced, setTraced] = useState<string | null>(null);
  const lit = useMemo(() => {
    if (!traced) return null;
    const on = new Set<string>([traced]);
    for (const edge of graph.edges) {
      if (edge.from === traced) on.add(edge.to);
      if (edge.to === traced) on.add(edge.from);
    }
    return on;
  }, [traced, graph.edges]);

  const filtering = focusId !== null || projectIds !== null || hideDone || collapsed.length > 0;
  const folded = graph.levelCounts.goal - graph.nodes.length;

  return (
    <div className="graph-screen">
      <div className="graph-toolbar">
        <input
          className="input"
          style={{ width: 180, flex: 'none' }}
          value={query}
          placeholder="Find on the board"
          aria-label="Find on the board"
          data-testid="graph-search"
          onChange={(event) => setQuery(event.target.value)}
        />

        <div className="inline wrap" data-testid="graph-projects">
          {graph.projects.map((project) => {
            const on = !projectIds || projectIds.includes(project.id);
            return (
              <button
                key={project.id}
                className={on ? 'chip accent chip-button' : 'chip chip-button'}
                aria-pressed={on}
                title={`${project.nodes} items — click to show or hide`}
                data-testid={`filter-${project.id}`}
                onClick={() => toggleProject(project.id)}
              >
                {project.name}
              </button>
            );
          })}
        </div>

        <span className="spacer" />

        <label className="inline nowrap" style={{ gap: 6 }}>
          <span className="faint">Detail</span>
          <select
            className="select sm-select"
            style={{ width: 132 }}
            value={detail}
            aria-label="Level of detail"
            data-testid="detail-level"
            onChange={(event) => setDetail(event.target.value as GraphDetail | 'auto')}
          >
            <option value="auto">Auto ({graph.detail}s)</option>
            <option value="project">Projects ({graph.levelCounts.project})</option>
            <option value="milestone">Milestones ({graph.levelCounts.milestone})</option>
            <option value="goal">Goals ({graph.levelCounts.goal})</option>
          </select>
        </label>

        <label className="inline nowrap" style={{ gap: 6 }}>
          <input
            type="checkbox"
            className="check"
            checked={hideDone}
            data-testid="hide-done"
            onChange={(event) => setHideDone(event.target.checked)}
          />
          Hide finished
        </label>
        <label className="inline nowrap" style={{ gap: 6 }}>
          <input
            type="checkbox"
            className="check"
            checked={showGuessed}
            data-testid="show-guessed"
            onChange={(event) => setShowGuessed(event.target.checked)}
          />
          Guessed order
        </label>

        <button
          className="btn ghost icon"
          onClick={() => setZoom((z) => Math.min(2.6, +(z * 1.25).toFixed(3)))}
          aria-label="Zoom in"
          title="Zoom in — on Auto detail this also reveals more of the hierarchy"
        >
          <IconPlus size={14} />
        </button>
        <button
          className="btn ghost icon"
          onClick={() => setZoom((z) => Math.max(0.3, +(z / 1.25).toFixed(3)))}
          aria-label="Zoom out"
          title="Zoom out — on Auto detail this folds the hierarchy up"
        >
          <IconMinus size={14} />
        </button>
        <button className="btn sm" onClick={fitToWidth} data-testid="fit-width">
          Fit
        </button>
        <button
          className="btn sm"
          data-testid="reset-view"
          disabled={!filtering && zoom === 1}
          onClick={() => {
            setZoom(1);
            setDetail('auto');
            clearFilters();
          }}
        >
          Show everything
        </button>
      </div>

      {filtering && (
        <div className="graph-notice" data-testid="graph-filter-notice">
          <span className="grow">
            {focusId && app.state.nodes[focusId]
              ? `Focused on ${app.node(focusId).name} — showing what it contains and what it is linked to.`
              : `${graph.hiddenCount} item(s) hidden.`}
          </span>
          <button className="btn ghost sm" onClick={clearFilters} data-testid="clear-filters">
            Clear
          </button>
        </div>
      )}

      {!filtering && detail === 'auto' && folded > 0 && (
        <div className="graph-notice subtle" data-testid="graph-detail-notice">
          <span className="grow">
            Showing {graph.detail}s — {folded} more inside. Zoom in, or double-click a card, to
            open it up. Links between what is folded away are still drawn.
          </span>
        </div>
      )}

      <div className="graph-canvas" ref={canvasRef}>
        {graph.nodes.length === 0 ? (
          <Empty title="Everything is hidden" icon={<IconGraph size={20} />}>
            The current filters leave nothing to draw. Clear them to see the board again.
          </Empty>
        ) : (
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
              <g key={band.id} data-testid={`band-${band.id}`}>
                <rect
                  x={12}
                  y={band.y}
                  width={Math.max(200, width - 40)}
                  height={band.h}
                  rx={12}
                  fill="var(--bg-sunken)"
                  stroke="var(--border)"
                />
                <g
                  className="band-toggle"
                  onClick={() => toggleBand(band.id)}
                  style={{ cursor: 'pointer' }}
                  data-testid={`collapse-${band.id}`}
                >
                  <title>
                    {collapsed.includes(band.id) ? 'Expand this project' : 'Collapse this project'}
                  </title>
                  <rect x={16} y={band.y + 3} width={Math.max(180, width - 48)} height={20} fill="transparent" />
                  <text x={26} y={band.y + 18} className="graph-band-label">
                    {collapsed.includes(band.id) ? '▸' : '▾'} {band.name}
                  </text>
                </g>
              </g>
            ))}

            {graph.edges.map((edge) => (
              <g
                key={`${edge.via}-${edge.from}-${edge.to}`}
                className={
                  lit ? (lit.has(edge.from) && lit.has(edge.to) ? 'traced' : 'untraced') : undefined
                }
              >
                <Edge
                  edge={edge}
                  positions={positions}
                  onRemove={edge.depId ? () => run((a) => a.removeDep(edge.depId!)) : undefined}
                />
              </g>
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
              <g
                key={node.id}
                className={lit ? (lit.has(node.id) ? 'traced' : 'untraced') : undefined}
                onPointerEnter={() => setTraced(node.id)}
                onPointerLeave={() => setTraced((at) => (at === node.id ? null : at))}
              >
              <GraphNode
                node={node}
                selected={selected === node.id}
                matched={matches ? matches.has(node.id) : null}
                dragging={!!dragFrom}
                isSource={dragFrom === node.id}
                validTarget={dropTargetValid(node.id)}
                onSelect={() => setSelected(node.id)}
                onOpen={() => {
                  // Straight to this one thing, at full detail.
                  setFocusId(node.id);
                  setDetail('goal');
                }}
                onStartLink={() => setDragFrom(node.id)}
                onDropLink={() => {
                  if (dragFrom && dragFrom !== node.id) run((a) => a.addDep(dragFrom, node.id));
                  setDragFrom(null);
                  setPointer(null);
                }}
              />
              </g>
            ))}
          </svg>
        )}
      </div>

      {selected && app.state.nodes[selected] && (
        <GraphInspector
          id={selected}
          focused={focusId === selected}
          onFocus={() => setFocusId(focusId === selected ? null : selected)}
          onClose={() => setSelected(null)}
        />
      )}

      <div className="graph-legend">
        <span><Sample stroke="var(--text-faint)" width={1.2} opacity={0.6} /> contains</span>
        <span><Sample stroke="var(--accent)" width={2} /> link you drew</span>
        <span><Sample stroke="var(--text-faint)" width={1.6} /> order you set</span>
        <span><Sample stroke="var(--text-faint)" width={1.6} dash="4 3" /> order we guessed</span>
        <span className="spacer" />
        <span className="faint">Drag the circle on a card onto whatever should wait for it.</span>
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
      {(edge.count ?? 1) > 1 && (
        <g transform={`translate(${midX}, ${midY})`} pointerEvents="none">
          <title>{edge.count} links folded together</title>
          <circle r="9" fill="var(--bg-raised)" stroke="var(--accent)" strokeWidth="1.2" />
          <text className="graph-edge-count" y="3.5">
            {edge.count}
          </text>
        </g>
      )}
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
  matched,
  dragging,
  isSource,
  validTarget,
  onSelect,
  onOpen,
  onStartLink,
  onDropLink,
}: {
  node: Placed;
  selected: boolean;
  /** null when nothing is being searched for. */
  matched: boolean | null;
  dragging: boolean;
  isSource: boolean;
  validTarget: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onStartLink: () => void;
  onDropLink: () => void;
}) {
  // Search dims the misses rather than removing them, so the board keeps its
  // shape and you keep your bearings.
  const dim = (dragging && !validTarget && !isSource) || matched === false;

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      data-testid={`gnode-${node.id}`}
      data-matched={matched === true ? 'true' : undefined}
      opacity={dim ? 0.22 : 1}
      onMouseUp={dragging && !isSource ? onDropLink : undefined}
      onDoubleClick={node.contains > 0 ? onOpen : undefined}
      style={{ cursor: 'pointer' }}
    >
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={9}
        fill={STATUS_FILL[node.derived]}
        stroke={selected || matched === true ? 'var(--accent)' : STATUS_STROKE[node.derived]}
        strokeWidth={selected ? 2.5 : matched === true ? 2 : 1.4}
        onClick={onSelect}
      />
      <text x={11} y={17} className="graph-node-kind">
        {node.kind}
        {node.progress ? ` · ${node.progress.done}/${node.progress.total}` : ''}
      </text>
      {node.contains > 0 && (
        <>
          <title>Double-click to open — {node.contains} inside</title>
          <rect x={NODE_W - 34} y={7} width={27} height={14} rx={7} fill="var(--bg-raised)" stroke="var(--border-strong)" />
          <text x={NODE_W - 20.5} y={17.5} className="graph-node-count">
            {node.contains}
          </text>
        </>
      )}
      <text x={11} y={34} className="graph-node-name">
        {node.name.length > 21 ? `${node.name.slice(0, 20)}…` : node.name}
      </text>
      <text x={11} y={47} className="graph-node-status">
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

function GraphInspector({
  id,
  focused,
  onFocus,
  onClose,
}: {
  id: string;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  const { app, run } = useApp();
  const [linking, setLinking] = useState(false);
  const [query, setQuery] = useState('');
  const node = app.node(id);

  // Dragging works for two cards you can see at once. On a board with eight
  // projects the other end is usually off-screen, so there has to be a way to
  // link by name — which is also the only way that works from a keyboard.
  const candidates = app
    .flat()
    .filter((other) => other.kind === 'project' || other.kind === 'milestone' || other.kind === 'goal')
    .filter((other) => other.id !== id)
    .filter((other) => (query ? other.path.toLowerCase().includes(query.toLowerCase()) : true))
    .filter((other) => app.checkDep(id, other.id).ok)
    .slice(0, 8);

  return (
    <div className="graph-inspector" data-testid="graph-inspector">
      <div className="inline">
        <span className="chip kind-chip">{node.kind}</span>
        <strong className="grow">{node.name}</strong>
        <button
          className={focused ? 'btn sm primary' : 'btn sm'}
          onClick={onFocus}
          data-testid="focus-node"
          title="Show only this and what it touches"
        >
          {focused ? 'Unfocus' : 'Focus'}
        </button>
        <button
          className="btn sm"
          onClick={() => setLinking(!linking)}
          data-testid="link-from-node"
          title="Make something else wait for this"
        >
          Link to…
        </button>
        <button className="btn ghost sm" onClick={onClose}>
          Close
        </button>
      </div>

      {linking && (
        <div className="stack tight" style={{ marginTop: 8 }}>
          <input
            className="input"
            autoFocus
            value={query}
            placeholder="What should wait for this?"
            aria-label="What should wait for this?"
            data-testid="link-search"
            onChange={(event) => setQuery(event.target.value)}
          />
          {candidates.length === 0 && (
            <span className="faint">Nothing here can wait for it without making a loop.</span>
          )}
          {candidates.map((other) => (
            <button
              key={other.id}
              className="row"
              style={{ border: 0, background: 'var(--bg-sunken)', textAlign: 'left', cursor: 'pointer' }}
              data-testid={`link-to-${other.id}`}
              onClick={() => {
                run((a) => a.addDep(id, other.id));
                setLinking(false);
                setQuery('');
              }}
            >
              <span className="chip kind-chip">{other.kind}</span>
              <span className="grow row-title">{other.name}</span>
              <span className="faint">{other.projectName}</span>
            </button>
          ))}
        </div>
      )}

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
        {/*
          The graph draws only containers, and a container cannot be started or
          completed in its own right. Start would throw every time it was
          pressed, so it is not offered; Complete finishes the work inside,
          which is the only sense in which a milestone is ever "done".
        */}
        <button className="btn sm" onClick={() => run((a) => a.pause(id))} aria-label="Pause">
          <IconPause size={12} />
        </button>
        <button
          className="btn sm primary"
          onClick={() => run((a) => a.completeSubtree(id))}
          aria-label="Complete"
          title={`Complete everything still open in ${node.name}`}
        >
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
