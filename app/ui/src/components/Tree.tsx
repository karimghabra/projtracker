import { Fragment, type KeyboardEvent } from "react";

import type { ProgressRow, TreeEntry } from "../api/types";
import { STATE_GLYPH, TASK_STATE } from "../status";
import { Breakdown, HealthBar } from "./HealthBar";
import { IconPencil, IconX } from "./icons";

export interface TreeProps {
  tree: TreeEntry[];
  projects: ProgressRow[];
  collapsed: Set<number>;
  onToggle: (id: number) => void;
  selected: number | null;
  onSelectProject: (id: number) => void;
  onEdit: (id: number) => void;
  onDeleteProject: (id: number) => void;
}

export function countNodes(entries: TreeEntry[]): number {
  return entries.reduce((a, e) => a + 1 + countNodes(e.children || []), 0);
}

export function Tree(props: TreeProps) {
  return (
    <div className="rows" data-testid="tree">
      {props.tree.map((entry) => (
        <TreeNode key={entry.node.id} entry={entry} depth={0} {...props} />
      ))}
    </div>
  );
}

function TreeNode({
  entry,
  depth,
  ...props
}: TreeProps & { entry: TreeEntry; depth: number }) {
  const n = entry.node;
  const kids = entry.children || [];
  const open = !props.collapsed.has(n.id);
  const isProject = n.kind === "project";
  const progress = isProject
    ? props.projects.find((r) => r.project_id === n.id)
    : undefined;

  let dot = null;
  let stateCls = "";
  if (n.kind === "task") {
    const st = TASK_STATE[n.state ?? "blocked"] ?? TASK_STATE.blocked;
    dot = (
      <span
        className={"dot" + (st.cls ? ` ${st.cls}` : st.hollow ? " hollow" : "")}
        style={st.hollow || st.cls ? undefined : { background: st.css }}
        title={st.label}
        aria-label={st.label}
      />
    );
    if (n.state === "done") stateCls = " is-done";
    if (n.state === "dropped") stateCls = " is-dropped";
  }

  const rowKey = (ev: KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      props.onSelectProject(n.id);
    }
  };

  return (
    <Fragment>
      <div
        className={
          `node kind-${n.kind}${stateCls}` +
          (isProject && props.selected === n.id ? " selected" : "")
        }
        style={{ paddingLeft: 16 + depth * 18 }}
        data-testid="tree-node"
        data-nid={n.id}
        data-kind={n.kind}
        role={isProject ? "button" : undefined}
        tabIndex={isProject ? 0 : undefined}
        onClick={isProject ? () => props.onSelectProject(n.id) : undefined}
        onKeyDown={isProject ? rowKey : undefined}
      >
        {kids.length ? (
          <button
            type="button"
            className="twisty"
            aria-label={(open ? "Collapse " : "Expand ") + n.name}
            aria-expanded={open}
            onClick={(ev) => {
              ev.stopPropagation();
              props.onToggle(n.id);
            }}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="twisty leaf">·</span>
        )}
        {dot}
        <span className="label" title={n.name}>
          {n.name}
        </span>
        {progress && (
          <span className={`status ${progress.state}`}>
            <span className="glyph">{STATE_GLYPH[progress.state] || "•"}</span>
            {progress.state}
          </span>
        )}
        <button
          type="button"
          className="rowbtn edit"
          data-testid="tree-edit"
          title="Edit"
          aria-label={`Edit ${n.name}`}
          onClick={(ev) => {
            ev.stopPropagation();
            props.onEdit(n.id);
          }}
        >
          <IconPencil size={13} />
        </button>
        {isProject && (
          <button
            type="button"
            className="rowbtn danger"
            data-testid="tree-delete"
            title="Delete project"
            aria-label={`Delete ${n.name}`}
            onClick={(ev) => {
              ev.stopPropagation();
              props.onDeleteProject(n.id);
            }}
          >
            <IconX size={13} />
          </button>
        )}
      </div>
      {isProject && open && progress && (
        <div className="node-extra">
          <HealthBar health={progress.health} total={progress.tasks_open} />
          <Breakdown health={progress.health} />
        </div>
      )}
      {open &&
        kids.map((c) => (
          <TreeNode key={c.node.id} entry={c} depth={depth + 1} {...props} />
        ))}
    </Fragment>
  );
}

export function collectParentIds(entries: TreeEntry[], out: number[] = []): number[] {
  for (const e of entries) {
    if ((e.children || []).length) out.push(e.node.id);
    collectParentIds(e.children || [], out);
  }
  return out;
}
