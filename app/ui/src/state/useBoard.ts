/**
 * One refresh hook: the parallel pt calls every screen shares, exposed as
 * slices plus refresh(). All slices are rendered as returned — the UI owns no
 * logic about readiness, impact or health.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { verbs } from "../api/pt";
import type {
  JournalDay,
  NodeRec,
  ProgressRow,
  ReadyTask,
  TodayResult,
  TreeEntry,
  UpcomingRow,
} from "../api/types";
import { getConfig } from "./config";

export interface BoardData {
  projects: ProgressRow[];
  ready: ReadyTask[];
  nodes: NodeRec[];
  tree: TreeEntry[];
  journal: JournalDay[];
  today: TodayResult | null;
  upcoming: UpcomingRow[];
}

const EMPTY: BoardData = {
  projects: [],
  ready: [],
  nodes: [],
  tree: [],
  journal: [],
  today: null,
  upcoming: [],
};

export interface Board extends BoardData {
  loading: boolean;
  loaded: boolean;
  refresh: () => Promise<void>;
}

export function useBoard(enabled: boolean): Board {
  const [data, setData] = useState<BoardData>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const [projects, ready, nodes, tree, journal, today, upcoming] =
        await Promise.all([
          verbs.progress(getConfig().days),
          verbs.readyImpact(),
          verbs.ls(),
          verbs.tree(),
          verbs.journal(7),
          verbs.today(),
          verbs.upcoming(),
        ]);
      setData({ projects, ready, nodes, tree, journal, today, upcoming });
      setLoaded(true);
    } catch {
      // pt() already toasted the failure; keep the last good slices
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...data, loading, loaded, refresh };
}
