import type { ReactNode } from "react";

import {
  IconBell,
  IconBoard,
  IconCalendar,
  IconInbox,
} from "./icons";

export type View = "board" | "today" | "upcoming" | "journal";

const ITEMS: { view: View; label: string; icon: ReactNode }[] = [
  { view: "board", label: "Board", icon: <IconBoard /> },
  { view: "today", label: "Today", icon: <IconCalendar /> },
  { view: "upcoming", label: "Upcoming", icon: <IconBell /> },
  { view: "journal", label: "Journal", icon: <IconInbox /> },
];

export function Sidebar({
  view,
  onNav,
}: {
  view: View;
  onNav: (v: View) => void;
}) {
  return (
    <aside className="sidebar">
      <nav aria-label="Main">
        {ITEMS.map((it) => (
          <button
            key={it.view}
            type="button"
            className={"nav-item" + (view === it.view ? " active" : "")}
            aria-current={view === it.view ? "page" : undefined}
            data-testid={`sidebar-${it.view}`}
            title={it.label}
            onClick={() => onNav(it.view)}
          >
            <span className="nav-icon">{it.icon}</span>
            <span className="nav-label">{it.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
