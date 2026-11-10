import { type ArtifactRevision, fileUrl, isText } from "../shared/contracts";
import { reconcile, type ViewerState } from "./state";

const app = document.querySelector<HTMLDivElement>("#app")!;
const base = new URL(".", import.meta.url).href;
const id = location.pathname.match(/\/a\/([^/]+)$/)?.[1];
const initial = new URL(location.href).searchParams.get("revision");
let state: ViewerState = {
  revision: initial ? Number(initial) : null,
  pinned: !!initial,
  mode: "preview",
  source: null,
  newer: false,
  connection: "reconnecting",
  sourceChanged: false,
};
let current: ArtifactRevision | undefined;
let revisions: ArtifactRevision[] = [];
let generation = 0;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label: string, action: () => void) {
  const node = el("button", label);
  node.onclick = action;
  return node;
}
const header = el("header"),
  home = el("a", "Artifacts");
home.href = base;
header.append(home);
const connection = el("div");
connection.id = "connection";
connection.setAttribute("role", "status");
const notice = el("div");
notice.id = "notice";
notice.setAttribute("role", "status");
const main = el("main");
app.append(header, connection, notice, main);

// Keep interactive nodes mounted while metadata/SSE requests finish between keypresses.
const title = el("h1"),
  kind = el("span"),
  label = el("label", "Revision"),
  select = el("select");
select.setAttribute("aria-label", "Revision");
const latest = el("option", "Latest");
latest.value = "latest";
select.append(latest);
const revisionOptions = new Map<number, HTMLOptionElement>();
select.onchange = () => {
  state.pinned = select.value !== "latest";
  state.revision = state.pinned ? Number(select.value) : null;
  const u = new URL(location.href);
  if (state.pinned) u.searchParams.set("revision", String(state.revision));
  else u.searchParams.delete("revision");
  history.replaceState(null, "", u);
  void refresh();
};
label.append(select);
const modes = (["preview", "source"] as const).map((mode) => ({
  mode,
  node: button(mode === "preview" ? "Preview" : "Source", () => {
    state.mode = mode;
    render(false);
  }),
}));
const reload = button("Reload", () => {
  if (state.mode === "source") sourceView(true);
  else main.querySelector("iframe")?.contentWindow?.location.reload();
});
const open = el("a", "Open preview");
open.target = "_blank";
open.rel = "noopener";
const newerText = el("span", "New revision available ");
const viewLatest = button("View latest", () => {
  state.pinned = false;
  history.replaceState(null, "", location.pathname);
  void refresh();
});
const sourceArea = el("section"),
  sourceFiles = el("nav"),
  sourceContent = el("div"),
  download = el("a", "Download original"),
  binary = el("p"),
  pre = el("pre");
sourceArea.id = "source";
sourceFiles.id = "files";
sourceFiles.setAttribute("aria-label", "Source files");
sourceContent.id = "source-content";
sourceContent.append(binary, download, pre);
sourceArea.append(sourceFiles, sourceContent);
const fileButtons = new Map<string, HTMLButtonElement>();
let sourceKey = "",
  sourceGeneration = 0;
async function json<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, base));
  if (!response.ok) {
    const body = await response.json();
    throw Error(body.error?.message ?? "Unable to load artifacts.");
  }
  return response.json();
}
function error(e: unknown) {
  notice.textContent = (e as Error).message;
  notice.append(
    " ",
    button("Retry", () => void refresh()),
  );
}
function sourceView(force = false) {
  if (!current) return;
  main.querySelector("iframe")?.setAttribute("hidden", "");
  if (!sourceArea.isConnected) main.append(sourceArea);
  const info = current.files.find((f) => f.path === state.source) ?? current.files[0];
  state.source = info?.path ?? null;
  let removedFocus = false;
  for (const [path, node] of fileButtons) {
    if (current.files.some((f) => f.path === path)) continue;
    removedFocus ||= document.activeElement === node;
    node.remove();
    fileButtons.delete(path);
  }
  for (const file of current.files) {
    let node = fileButtons.get(file.path);
    if (!node) {
      node = button(file.path, () => {
        state.source = file.path;
        sourceView();
      });
      fileButtons.set(file.path, node);
      sourceFiles.append(node);
    }
    node.setAttribute("aria-pressed", String(state.source === file.path));
  }
  if (removedFocus && state.source) fileButtons.get(state.source)?.focus();
  if (!info) return;
  const url = fileUrl(base, current.id, current.revision, info.path);
  download.href = `${url}?download=1`;
  const key = `${current.revision}/${info.path}`;
  if (key === sourceKey && !force) return;
  sourceKey = key;
  const call = ++sourceGeneration;
  const text = isText(info.mediaType);
  binary.hidden = text;
  pre.hidden = !text;
  if (!text) {
    binary.textContent = `${info.mediaType} · ${info.bytes} bytes`;
    return;
  }
  pre.textContent = "Loading source…";
  fetch(url)
    .then(async (response) => {
      if (!response.ok) throw Error("Source unavailable.");
      return response.text();
    })
    .then((text) => {
      if (call === sourceGeneration) pre.textContent = text;
    })
    .catch((e) => {
      if (call === sourceGeneration) pre.textContent = e.message;
    });
}
function render(changed: boolean) {
  if (!current) return;
  if (!title.isConnected) header.append(title, kind, label, ...modes.map(({ node }) => node), reload, open);
  title.textContent = current.title;
  kind.textContent = current.kind;
  for (const revision of revisions) {
    if (revisionOptions.has(revision.revision)) continue;
    const option = el("option", `Revision ${revision.revision}`);
    option.value = String(revision.revision);
    revisionOptions.set(revision.revision, option);
    select.append(option);
  }
  const selected = state.pinned ? String(state.revision) : "latest";
  if (select.value !== selected) select.value = selected;
  for (const { mode, node } of modes) node.setAttribute("aria-pressed", String(state.mode === mode));
  open.href = fileUrl(base, current.id, current.revision, current.entrypoint, true);
  if (state.newer) {
    if (!viewLatest.isConnected) notice.replaceChildren(newerText, viewLatest);
  } else if (state.sourceChanged)
    notice.textContent = "Selected source no longer exists; showing entrypoint.";
  else notice.replaceChildren();
  let frame = main.querySelector("iframe");
  if (!frame || changed) {
    frame?.remove();
    frame = el("iframe");
    frame.title = `${current.title} preview`;
    frame.src = fileUrl(base, current.id, current.revision, current.entrypoint, true);
    main.prepend(frame);
  }
  if (state.mode === "source") sourceView();
  else {
    sourceArea.remove();
    frame.removeAttribute("hidden");
  }
}
async function refresh() {
  const call = ++generation;
  try {
    if (!id) {
      const { artifacts } = await json<{ artifacts: ArtifactRevision[] }>("api/artifacts");
      if (call !== generation) return;
      main.replaceChildren();
      if (!header.querySelector("h1")) header.append(el("h1", "Artifact gallery"));
      if (!artifacts.length)
        main.append(el("p", "No artifacts yet. Publish an artifact from Pi to get started."));
      const grid = el("div");
      grid.className = "gallery";
      for (const a of artifacts) {
        const card = el("article");
        card.className = "card";
        const link = el("a", a.title);
        link.href = a.previewUrl;
        card.append(link, el("p", `${a.kind} · Latest revision ${a.revision}`));
        grid.append(card);
      }
      main.append(grid);
      notice.replaceChildren();
      return;
    }
    const data = await json<{ revisions: ArtifactRevision[] }>(`api/artifacts/${id}`);
    if (call !== generation) return;
    revisions = data.revisions;
    const selected = state.pinned ? revisions.find((r) => r.revision === state.revision) : revisions.at(-1);
    if (!selected) throw Error("Artifact revision not found.");
    const changed = current?.revision !== selected.revision;
    state = reconcile(
      state,
      revisions.at(-1)!.revision,
      selected.files.map((f) => f.path),
      selected.entrypoint,
    );
    current = selected;
    render(changed);
  } catch (e) {
    if (call === generation) error(e);
  }
}
connection.textContent = "Loading…";
void refresh();
const events = new EventSource(new URL("api/events", base));
events.addEventListener("ready", () => {
  connection.textContent = "";
  void refresh();
});
events.addEventListener("published", () => void refresh());
events.onerror = () => {
  state.connection = "reconnecting";
  connection.textContent = "Disconnected — reconnecting. Your last preview remains available.";
};
window.addEventListener("online", () => void refresh());
window.addEventListener("pagehide", () => events.close());
