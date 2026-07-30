import { useState } from "react";

import type { Board } from "../state/useBoard";
import { EmptyState } from "./EmptyState";
import { IconFolder } from "./icons";
import { Legend } from "./Legend";
import { collectParentIds, countNodes, Tree } from "./Tree";

/** The whole hierarchy; selecting a project scopes the To do panel. */
export function ProjectsPanel({
  board,
  selected,
  onSelectProject,
  onEdit,
  onDeleteRequest,
  onAdd,
  onImport,
}: {
  board: Board;
  selected: number | null;
  onSelectProject: (id: number | null) => void;
  onEdit: (id: number) => void;
  onDeleteRequest: (id: number) => void;
  onAdd: () => void;
  onImport: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const toggle = (id: number) => {
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setCollapsed((old) =>
      old.size ? new Set<number>() : new Set(collectParentIds(board.tree)),
    );
  };

  return (
    <section className="panel p-tree">
      <h2>
        Projects <span className="spacer" />
        <button
          type="button"
          className="tiny"
          data-testid="tree-toggle-all"
          onClick={toggleAll}
        >
          {collapsed.size ? "Expand all" : "Collapse all"}
        </button>
        <span className="chip" data-testid="tree-count">
          {countNodes(board.tree)} nodes
        </span>
      </h2>
      <div className="panel-body">
        {board.tree.length ? (
          <Tree
            tree={board.tree}
            projects={board.projects}
            collapsed={collapsed}
            onToggle={toggle}
            selected={selected}
            onSelectProject={(id) =>
              onSelectProject(selected === id ? null : id)
            }
            onEdit={onEdit}
            onDeleteProject={onDeleteRequest}
          />
        ) : (
          <EmptyState
            icon={<IconFolder size={28} />}
            text={
              board.loaded
                ? "Nothing here yet — import a workbook or add a project."
                : "Loading…"
            }
            action={
              board.loaded ? (
                <>
                  <button type="button" className="primary" onClick={onAdd}>
                    Add a project
                  </button>{" "}
                  <button type="button" onClick={onImport}>
                    Import…
                  </button>
                </>
              ) : undefined
            }
          />
        )}
      </div>
      <Legend />
    </section>
  );
}
