export interface ViewerState {
  revision: number | null;
  pinned: boolean;
  mode: "preview" | "source";
  source: string | null;
  newer: boolean;
  connection: "connected" | "reconnecting";
  sourceChanged: boolean;
}
export function reconcile(
  state: ViewerState,
  latest: number,
  files: string[],
  entrypoint: string,
): ViewerState {
  const revision = state.pinned ? state.revision : latest;
  const changed = revision !== state.revision;
  const missing = changed && state.source !== null && !files.includes(state.source);
  return {
    ...state,
    revision,
    newer: state.pinned && latest > (state.revision ?? 0),
    source: missing ? entrypoint : (state.source ?? entrypoint),
    sourceChanged: missing,
    connection: "connected",
  };
}
