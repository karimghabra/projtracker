import { useState } from "react";

import type { Board } from "../state/useBoard";
import { EmptyState } from "../components/EmptyState";
import { IconFolder } from "../components/icons";
import { Legend } from "../components/Legend";
import { ReadyList } from "../components/ReadyList";
import { StatTiles } from "../components/StatTiles";
import { collectParentIds, countNodes, Tree } from "../components/Tree";

export function BoardScreen({
  board,
  onEdit,
  onDeleteRequest,
  onAdd,
  onImport,
}: {
  board: Board;
  onEdit: (id: number) => void;
  onDeleteRequest: (id: number) => void;
  onAdd: () => void;
  onImport: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);

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

  const shown =
    selected === null
      ? board.ready
      : board.ready.filter((t) => t.project_id === selected);
  const scopeLabel =
    selected === null
      ? "all projects"
      : board.projects.find((p) => p.project_id === selected)?.project_name ||
        "planner";

  return (
    <div className="screen board-screen">
      <StatTiles projects={board.projects} ready={board.ready} />
      <div className="board-grid">
        <section>
          <h2>
            All tasks <span className="spacer" />
            <button type="button" className="tiny" data-testid="tree-toggle-all" onClick={toggleAll}>
              {collapsed.size ? "Expand all" : "Collapse all"}
            </button>
            <span className="chip" data-testid="tree-count">
              {countNodes(board.tree)} nodes
            </span>
          </h2>
          {board.tree.length ? (
            <Tree
              tree={board.tree}
              projects={board.projects}
              collapsed={collapsed}
              onToggle={toggle}
              selected={selected}
              onSelectProject={(id) =>
                setSelected((cur) => (cur === id ? null : id))
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
          <Legend />
        </section>
        <section>
          <h2>
            To do <span className="spacer" />
            <span className="chip" data-testid="ready-scope">
              {scopeLabel}
            </span>
            <span className="chip" data-testid="ready-count">
              {shown.length}
            </span>
          </h2>
          <ReadyList
            ready={shown}
            onDone={board.refresh}
            emptyText={
              selected === null
                ? "Nothing ready — everything is blocked, waiting, or done."
                : "Nothing ready in this project."
            }
          />
        </section>
      </div>
    </div>
  );
}
