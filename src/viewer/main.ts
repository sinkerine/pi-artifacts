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
function sourceView() {
  main.querySelector("#source")?.remove();
  main.querySelector("iframe")?.setAttribute("hidden", "");
  const area = el("section");
  area.id = "source";
  const list = el("nav");
  list.id = "files";
  list.setAttribute("aria-label", "Source files");
  const content = el("div");
  content.id = "source-content";
  area.append(list, content);
  main.append(area);
  for (const info of current!.files) {
    const b = button(info.path, () => {
      state.source = info.path;
      sourceView();
    });
    b.setAttribute("aria-pressed", String(state.source === info.path));
    list.append(b);
  }
  const info = current!.files.find((f) => f.path === state.source) ?? current!.files[0];
  if (!info) return;
  const url = fileUrl(base, current!.id, current!.revision, info.path);
  const download = el("a", "Download original");
  download.href = `${url}?download=1`;
  content.append(download);
  if (!isText(info.mediaType)) {
    content.prepend(el("p", `${info.mediaType} · ${info.bytes} bytes`));
    return;
  }
  const pre = el("pre", "Loading source…");
  content.append(pre);
  const rev = current!.revision;
  fetch(url)
    .then(async (response) => {
      if (!response.ok) throw Error("Source unavailable.");
      return response.text();
    })
    .then((text) => {
      if (current?.revision === rev && state.source === info.path) pre.textContent = text;
    })
    .catch((e) => {
      pre.textContent = e.message;
    });
}
function render(changed: boolean) {
  header.replaceChildren(home);
  if (!current) return;
  const title = el("h1", current.title);
  header.append(title, el("span", current.kind));
  const label = el("label", "Revision");
  const select = el("select");
  select.setAttribute("aria-label", "Revision");
  const latest = el("option", "Latest");
  latest.value = "latest";
  select.append(latest);
  for (const revision of revisions) {
    const option = el("option", `Revision ${revision.revision}`);
    option.value = String(revision.revision);
    select.append(option);
  }
  select.value = state.pinned ? String(state.revision) : "latest";
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
  header.append(label);
  for (const mode of ["preview", "source"] as const) {
    const b = button(mode === "preview" ? "Preview" : "Source", () => {
      state.mode = mode;
      render(false);
    });
    b.setAttribute("aria-pressed", String(state.mode === mode));
    header.append(b);
  }
  header.append(
    button("Reload", () => {
      if (state.mode === "source") sourceView();
      else main.querySelector("iframe")?.contentWindow?.location.reload();
    }),
  );
  const open = el("a", "Open preview");
  open.href = fileUrl(base, current.id, current.revision, current.entrypoint, true);
  open.target = "_blank";
  open.rel = "noopener";
  header.append(open);
  notice.replaceChildren();
  if (state.newer) {
    notice.append(
      el("span", "New revision available "),
      button("View latest", () => {
        state.pinned = false;
        history.replaceState(null, "", location.pathname);
        void refresh();
      }),
    );
  } else if (state.sourceChanged)
    notice.textContent = "Selected source no longer exists; showing entrypoint.";
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
    main.querySelector("#source")?.remove();
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
