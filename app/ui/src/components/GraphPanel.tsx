/**
 * The native graph editor (spec §11.5). Everything drawn here comes from one
 * `graph-data` call: node states, wait gates, impact numbers and — the point
 * of the panel — edge provenance. Solid blue is an explicit dependency,
 * solid grey a rank the user chose, dashed a guess the graph made from entry
 * order, and ghosted a guess it is deliberately ignoring because an explicit
 * edge overruled it. Every mutation is a command verb (dep add/rm, seq set,
 * start/pause/done); the layout below is presentation only — the panel never
 * decides what blocks what.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { announceDone, verbs } from "../api/pt";
import type { GraphData, GraphEdge, GraphNode } from "../api/types";
import { EmptyState } from "./EmptyState";
import { IconCheck, IconGraph, IconPause, IconPencil, IconPlay, IconX } from "./icons";
import { toast } from "../state/toasts";

const W = 188;
const H = 56;
const XGAP = 76;
const YGAP = 16;
const BAND_LABEL = 26;
const BAND_GAP = 30;
const PAD = 20;

interface Placed {
  n: GraphNode;
  x: number;
  y: number;
}

interface Layout {
  placed: Map<number, Placed>;
  width: number;
  height: number;
  bands: { label: string; y: number }[];
}

const OPEN_STATES = new Set(["ready", "in_progress", "blocked", "waiting"]);

function isOpenTask(n: GraphNode): boolean {
  return n.kind === "task" && OPEN_STATES.has(n.state ?? "");
}

/** Longest-path layering over the in-force edges, then project bands. */
function layoutGraph(data: GraphData, showDone: boolean): Layout {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const visible = new Set<number>();
  for (const n of data.nodes) {
    if (n.kind === "task" && (isOpenTask(n) || showDone)) visible.add(n.id);
  }
  // goals participate when they anchor an explicit dependency
  for (const e of data.edges) {
    if (e.kind !== "dep") continue;
    for (const id of [e.from_id, e.to_id]) {
      if (byId.get(id)?.kind === "goal") visible.add(id);
    }
  }

  const forward = new Map<number, number[]>();
  for (const e of data.edges) {
    if (e.kind === "seq-suppressed") continue;
    if (!visible.has(e.from_id) || !visible.has(e.to_id)) continue;
    forward.set(e.from_id, [...(forward.get(e.from_id) ?? []), e.to_id]);
  }
  const layer = new Map<number, number>();
  const layerOf = (id: number, trail: Set<number>): number => {
    // the core guarantees a DAG; the trail guard just keeps a bad payload
    // from hanging the renderer
    if (layer.has(id)) return layer.get(id)!;
    if (trail.has(id)) return 0;
    trail.add(id);
    let l = 0;
    for (const [from, tos] of forward) {
      if (tos.includes(id)) l = Math.max(l, layerOf(from, trail) + 1);
    }
    layer.set(id, l);
    return l;
  };
  for (const id of visible) layerOf(id, new Set());

  // group into project bands (planner tasks last)
  const bandsMap = new Map<string, GraphNode[]>();
  const bandOrder: string[] = [];
  const sorted = [...visible]
    .map((id) => byId.get(id)!)
    .sort((a, b) => (a.project_id ?? 1e9) - (b.project_id ?? 1e9) || a.id - b.id);
  for (const n of sorted) {
    const key =
      n.project_id != null
        ? byId.get(n.project_id)?.name ?? `project ${n.project_id}`
        : "planner";
    if (!bandsMap.has(key)) {
      bandsMap.set(key, []);
      bandOrder.push(key);
    }
    bandsMap.get(key)!.push(n);
  }

  const placed = new Map<number, Placed>();
  const bands: { label: string; y: number }[] = [];
  let y0 = PAD;
  let maxLayer = 0;
  for (const label of bandOrder) {
    const members = bandsMap.get(label)!;
    bands.push({ label, y: y0 });
    const slots = new Map<number, number>();
    let deepest = 0;
    for (const n of members) {
      const l = layer.get(n.id) ?? 0;
      maxLayer = Math.max(maxLayer, l);
      const slot = slots.get(l) ?? 0;
      slots.set(l, slot + 1);
      deepest = Math.max(deepest, slot + 1);
      placed.set(n.id, {
        n,
        x: PAD + l * (W + XGAP),
        y: y0 + BAND_LABEL + slot * (H + YGAP),
      });
    }
    y0 += BAND_LABEL + deepest * (H + YGAP) + BAND_GAP;
  }
  return {
    placed,
    width: PAD * 2 + (maxLayer + 1) * (W + XGAP) - XGAP,
    height: Math.max(y0 - BAND_GAP + PAD, 200),
    bands,
  };
}

/** Ranks produce every lower->higher pair; drawing the transitive closure is
 * noise, so keep only edges no chain already implies (display-only). */
function reduceSeq(edges: GraphEdge[]): GraphEdge[] {
  const has = new Set(edges.map((e) => `${e.from_id}>${e.to_id}`));
  return edges.filter(
    (e) =>
      !edges.some(
        (m) =>
          m.from_id === e.from_id &&
          m.to_id !== e.to_id &&
          has.has(`${m.to_id}>${e.to_id}`),
      ),
  );
}

const STATE_LABEL: Record<string, string> = {
  ready: "ready",
  in_progress: "in progress",
  blocked: "blocked",
  waiting: "waiting",
  done: "done",
  dropped: "dropped",
};

export function GraphPanel({
  reloadKey,
  onEdit,
  onMutated,
}: {
  reloadKey: number;
  onEdit: (id: number) => void;
  onMutated: () => void | Promise<void>;
}) {
  const [data, setData] = useState<GraphData | null>(null);
  const [showGuessed, setShowGuessed] = useState(true);
  const [showDone, setShowDone] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [selEdge, setSelEdge] = useState<GraphEdge | null>(null);
  const [busy, setBusy] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const [vb, setVb] = useState({ x: 0, y: 0, w: 1000, h: 520 });
  const [fitKey, setFitKey] = useState(0);
  const [connect, setConnect] = useState<{
    from: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } | null>(null);
  const pan = useRef<{
    px: number;
    py: number;
    vx: number;
    vy: number;
    sx: number;
    sy: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void verbs
      .graphData()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const lay = useMemo(
    () => (data ? layoutGraph(data, showDone) : null),
    [data, showDone],
  );

  // fit the viewBox to content on first data and on demand
  useEffect(() => {
    if (!lay) return;
    setVb({ x: 0, y: 0, w: Math.max(lay.width, 600), h: Math.max(lay.height, 300) });
  }, [lay === null, fitKey, showDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const drawEdges = useMemo(() => {
    if (!data || !lay) return [];
    const usable = data.edges.filter(
      (e) => lay.placed.has(e.from_id) && lay.placed.has(e.to_id),
    );
    const dep = usable.filter((e) => e.kind === "dep");
    const seq = reduceSeq(
      usable.filter((e) => e.kind === "seq-user" || e.kind === "seq-assumed"),
    );
    const ghost = reduceSeq(usable.filter((e) => e.kind === "seq-suppressed"));
    return [
      ...(showGuessed ? ghost : []),
      ...seq.filter((e) => showGuessed || e.kind === "seq-user"),
      ...dep,
    ];
  }, [data, lay, showGuessed]);

  // client -> svg user space through the real CTM (the viewBox is letterboxed
  // by preserveAspectRatio, so dividing by the rect is subtly wrong)
  const svgPoint = useCallback((clientX: number, clientY: number) => {
    const el = svgRef.current;
    const ctm = el?.getScreenCTM();
    if (!el || !ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);

  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const p = svgPoint(e.clientX, e.clientY);
    setVb((old) => {
      const w = Math.min(Math.max(old.w * factor, 300), 12000);
      const h = (w / old.w) * old.h;
      return {
        x: p.x - ((p.x - old.x) / old.w) * w,
        y: p.y - ((p.y - old.y) / old.h) * h,
        w,
        h,
      };
    });
  };

  const onBgPointerDown = (e: React.PointerEvent) => {
    setSelected(null);
    setSelEdge(null);
    const ctm = svgRef.current?.getScreenCTM();
    pan.current = {
      px: e.clientX,
      py: e.clientY,
      vx: vb.x,
      vy: vb.y,
      sx: ctm?.a || 1,
      sy: ctm?.d || 1,
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onBgPointerMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (!p) return;
    setVb((old) => ({
      ...old,
      x: p.vx - (e.clientX - p.px) / p.sx,
      y: p.vy - (e.clientY - p.py) / p.sy,
    }));
  };
  const onBgPointerUp = () => {
    pan.current = null;
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onMutated();
    } catch {
      /* pt() toasted (for a cycle, the toast carries the path) */
    } finally {
      setBusy(false);
    }
  };

  // --- draw-a-dependency drag -------------------------------------------
  const startConnect = (e: React.PointerEvent, from: Placed) => {
    e.stopPropagation();
    e.preventDefault();
    const p = svgPoint(e.clientX, e.clientY);
    setConnect({ from: from.n.id, x1: from.x + W, y1: from.y + H / 2, x2: p.x, y2: p.y });
  };

  useEffect(() => {
    if (!connect) return;
    const move = (e: PointerEvent) => {
      const p = svgPoint(e.clientX, e.clientY);
      setConnect((c) => (c ? { ...c, x2: p.x, y2: p.y } : c));
    };
    const up = (e: PointerEvent) => {
      const hit = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest("[data-nid]");
      const target = hit ? Number((hit as HTMLElement).dataset.nid) : null;
      const from = connect.from;
      setConnect(null);
      if (target && target !== from) {
        void run(async () => {
          await verbs.depAdd(from, target);
          toast("Dependency added.");
        });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect?.from, svgPoint]);

  const sel = selected != null && data
    ? data.nodes.find((n) => n.id === selected) ?? null
    : null;
  const selIsTask = sel?.kind === "task";
  const selGoalChild =
    selIsTask &&
    sel!.parent_id != null &&
    data!.nodes.find((n) => n.id === sel!.parent_id)?.kind === "goal";

  const edgePath = (e: GraphEdge) => {
    const a = lay!.placed.get(e.from_id)!;
    const b = lay!.placed.get(e.to_id)!;
    const x1 = a.x + W;
    const y1 = a.y + H / 2;
    const x2 = b.x;
    const y2 = b.y + H / 2;
    const dx = Math.max((x2 - x1) / 2, 30);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };

  const anyNodes = lay ? lay.placed.size > 0 : false;

  return (
    <section className="panel graph-panel" data-testid="graph-panel">
      <h2>
        Graph <span className="spacer" />
        <label className="check mini-check">
          <input
            type="checkbox"
            data-testid="graph-show-guessed"
            checked={showGuessed}
            onChange={(e) => setShowGuessed(e.target.checked)}
          />
          <span>guessed order</span>
        </label>
        <label className="check mini-check">
          <input
            type="checkbox"
            data-testid="graph-show-done"
            checked={showDone}
            onChange={(e) => setShowDone(e.target.checked)}
          />
          <span>done</span>
        </label>
        <button
          type="button"
          className="tiny"
          data-testid="graph-fit"
          onClick={() => setFitKey((k) => k + 1)}
        >
          Fit
        </button>
      </h2>

      {(sel || selEdge) && (
        <div className="graph-toolbar" data-testid="graph-toolbar">
          {sel && (
            <>
              <span className="name">{sel.name}</span>
              <span className="chip mini">{STATE_LABEL[sel.state ?? ""] ?? sel.kind}</span>
              {selGoalChild && (
                <span className="rank-ctl">
                  rank {sel.seq_index ?? "—"}
                  {sel.seq_source === "assumed" && (
                    <span className="dim" title="an entry-order guess, not something you set"> (guessed)</span>
                  )}
                  <button
                    type="button"
                    className="tiny"
                    data-testid="graph-rank-down"
                    disabled={busy || (sel.seq_index ?? 1) <= 1}
                    title="Move one rank earlier"
                    onClick={() =>
                      void run(() => verbs.seqSet([sel.id], (sel.seq_index ?? 2) - 1))
                    }
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className="tiny"
                    data-testid="graph-rank-up"
                    disabled={busy}
                    title="Move one rank later"
                    onClick={() =>
                      void run(() => verbs.seqSet([sel.id], (sel.seq_index ?? 0) + 1))
                    }
                  >
                    +
                  </button>
                </span>
              )}
              <span className="spacer" />
              {selIsTask && sel.state === "ready" && (
                <button
                  type="button"
                  className="tiny"
                  data-testid="graph-node-start"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const r = await verbs.start(sel.id);
                      toast(`Started “${r.started.name}”.`);
                    })
                  }
                >
                  <IconPlay size={12} /> Start
                </button>
              )}
              {selIsTask && sel.state === "in_progress" && (
                <button
                  type="button"
                  className="tiny"
                  data-testid="graph-node-pause"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const r = await verbs.pause(sel.id);
                      toast(`Paused “${r.paused.name}”.`);
                    })
                  }
                >
                  <IconPause size={12} /> Pause
                </button>
              )}
              {selIsTask && (sel.state === "ready" || sel.state === "in_progress") && (
                <button
                  type="button"
                  className="tiny"
                  data-testid="graph-node-done"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const r = await verbs.done(sel.id);
                      announceDone(r);
                      setSelected(null);
                    })
                  }
                >
                  <IconCheck size={12} /> Done
                </button>
              )}
              <button
                type="button"
                className="tiny"
                data-testid="graph-node-edit"
                onClick={() => onEdit(sel.id)}
              >
                <IconPencil size={12} /> Edit
              </button>
            </>
          )}
          {selEdge && !sel && (
            <>
              <span className="name">
                dependency #{selEdge.from_id} → #{selEdge.to_id}
              </span>
              {selEdge.note && <span className="dim">{selEdge.note}</span>}
              <span className="spacer" />
              <button
                type="button"
                className="tiny"
                data-testid="graph-edge-rm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await verbs.depRm(selEdge.from_id, selEdge.to_id);
                    toast("Dependency removed.");
                    setSelEdge(null);
                  })
                }
              >
                <IconX size={12} /> Remove
              </button>
            </>
          )}
        </div>
      )}

      <div className="graph-canvas">
        {!anyNodes ? (
          <EmptyState
            icon={<IconGraph size={28} />}
            text={
              data
                ? "Nothing to draw yet — add tasks and the graph appears here."
                : "Loading…"
            }
          />
        ) : (
          <svg
            ref={svgRef}
            data-testid="graph-svg"
            viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
            onWheel={onWheel}
            role="application"
            aria-label="Dependency graph editor"
          >
            <defs>
              <marker
                id="arr-dep"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0 0 8 4 0 8 Z" className="arr-dep" />
              </marker>
              <marker
                id="arr-seq"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M0 0 8 4 0 8 Z" className="arr-seq" />
              </marker>
            </defs>

            <rect
              x={vb.x - 5000}
              y={vb.y - 5000}
              width={vb.w + 10000}
              height={vb.h + 10000}
              fill="transparent"
              onPointerDown={onBgPointerDown}
              onPointerMove={onBgPointerMove}
              onPointerUp={onBgPointerUp}
            />

            {lay!.bands.map((b) => (
              <g key={b.label} className="g-band">
                <text x={PAD} y={b.y + 14}>
                  {b.label}
                </text>
              </g>
            ))}

            {drawEdges.map((e) => (
              <g
                key={`${e.kind}:${e.from_id}>${e.to_id}`}
                className={`g-edge g-edge-${e.kind}`}
                data-testid="graph-edge"
                data-kind={e.kind}
                data-from={e.from_id}
                data-to={e.to_id}
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (e.kind === "dep") {
                    setSelected(null);
                    setSelEdge(e);
                  }
                }}
              >
                <path className="hit" d={edgePath(e)} />
                <path
                  className="line"
                  d={edgePath(e)}
                  markerEnd={e.kind === "dep" ? "url(#arr-dep)" : "url(#arr-seq)"}
                />
              </g>
            ))}

            {connect && (
              <path
                className="g-connect"
                d={`M ${connect.x1} ${connect.y1} L ${connect.x2} ${connect.y2}`}
              />
            )}

            {[...lay!.placed.values()].map((p) => {
              const n = p.n;
              const state = n.kind === "task" ? (n.state ?? "") : n.kind;
              const wait = n.wait;
              const meta: string[] = [];
              if (n.kind === "task") meta.push(STATE_LABEL[state] ?? state);
              if (wait?.until) {
                meta.push(`⏳ ${wait.until}${wait.reason ? ` · ${wait.reason}` : ""}`);
              }
              if (n.repeat) meta.push("↻");
              if (n.state === "ready" && n.unlocks_now != null && n.unlocks_now > 0) {
                meta.push(`unlocks ${n.unlocks_now}`);
              }
              return (
                <g
                  key={n.id}
                  className={
                    `g-node g-state-${state}` +
                    (selected === n.id ? " is-selected" : "") +
                    (n.kind === "goal" ? " g-goal" : "")
                  }
                  transform={`translate(${p.x} ${p.y})`}
                  data-testid="graph-node"
                  data-nid={n.id}
                  data-state={state}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setSelEdge(null);
                    setSelected(n.id);
                  }}
                  onDoubleClick={() => onEdit(n.id)}
                >
                  <title>
                    {`#${n.id} ${n.name}` +
                      (wait?.until
                        ? `\nwaiting until ${wait.until}` +
                          (wait.reason ? ` — ${wait.reason}` : "")
                        : "")}
                  </title>
                  <rect className="card" width={W} height={H} rx={9} />
                  <rect className="state-bar" width={4} height={H} rx={2} />
                  <text className="t-name" x={14} y={22}>
                    {n.name.length > 24 ? n.name.slice(0, 23) + "…" : n.name}
                  </text>
                  <text className="t-meta" x={14} y={41}>
                    {meta.join("  ·  ").slice(0, 34)}
                  </text>
                  {n.kind === "task" && isOpenTask(n) && (
                    <circle
                      className="port"
                      data-testid="graph-port"
                      cx={W}
                      cy={H / 2}
                      r={7}
                      onPointerDown={(ev) => startConnect(ev, p)}
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      <title>Drag onto another task: it will depend on this one</title>
                    </circle>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>

      <div className="legend">
        <span className="k">
          <span className="lg-line lg-dep" /> explicit dependency
        </span>
        <span className="k">
          <span className="lg-line lg-user" /> chosen order
        </span>
        <span className="k">
          <span className="lg-line lg-assumed" /> guessed order
        </span>
        <span className="k">
          <span className="lg-line lg-suppressed" /> overruled guess
        </span>
        <span className="k">⏳ waiting on a date</span>
        <span className="k">drag the ○ port to draw a dependency</span>
      </div>
    </section>
  );
}
