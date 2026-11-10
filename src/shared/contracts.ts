import { type Static, Type } from "typebox";
export const Id = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });
export const RevisionNumber = Type.Integer({ minimum: 1 });
export const Kind = Type.Union([Type.Literal("html"), Type.Literal("react"), Type.Literal("markdown")]);
export type ArtifactKind = Static<typeof Kind>;
export const Ref = Type.Object({ id: Id, revision: RevisionNumber });
export type ArtifactRef = Static<typeof Ref>;
export const SourceInfo = Type.Object({
  path: Type.String(),
  bytes: Type.Integer({ minimum: 0 }),
  sha256: Type.String(),
  mediaType: Type.String(),
});
export type SourceFileInfo = Static<typeof SourceInfo>;
export const Revision = Type.Object({
  ...Ref.properties,
  schemaVersion: Type.Literal(1),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  kind: Kind,
  parentRevision: Type.Union([RevisionNumber, Type.Null()]),
  createdAt: Type.String(),
  entrypoint: Type.String(),
  files: Type.Array(SourceInfo),
  previewUrl: Type.String(),
  revisionUrl: Type.String(),
});
export type ArtifactRevision = Static<typeof Revision>;
export const Publish = Type.Object(
  {
    id: Type.Optional(Id),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Kind,
    entrypoint: Type.String(),
    files: Type.Array(Type.String(), { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type PublishInput = Static<typeof Publish>;
export const ListResult = Type.Object({ artifacts: Type.Array(Revision) });
export const Get = Type.Object(
  {
    id: Id,
    revision: Type.Optional(RevisionNumber),
    restoreTo: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export const GetResult = Type.Object({
  artifact: Revision,
  sources: Type.Array(Type.Object({ ...SourceInfo.properties, text: Type.Optional(Type.String()) })),
  sourceTextTruncated: Type.Boolean(),
  restoredTo: Type.Optional(Type.String()),
});
export type GetOutput = Static<typeof GetResult>;
export const PublishBody = Type.Object(
  {
    requestId: Id,
    id: Type.Optional(Id),
    title: Publish.properties.title,
    kind: Kind,
    entrypoint: Type.String(),
    files: Type.Array(
      Type.Object({ path: Type.String(), base64: Type.String() }, { additionalProperties: false }),
      { minItems: 1 },
    ),
    parentRevision: Type.Union([RevisionNumber, Type.Null()]),
  },
  { additionalProperties: false },
);
export type PublishRequest = Static<typeof PublishBody>;
export type CapturedSource = PublishRequest["files"][number];
export class ArtifactError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string, message: string): never {
  throw new ArtifactError(status, code, message);
}
export function sourcePath(path: string, allowReserved = false): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    fail(400, "INVALID_PATH", "Use ordinary relative source paths without dot segments.");
  if (!allowReserved && (path === "manifest.json" || path.startsWith(".pi-artifacts-")))
    fail(400, "INVALID_PATH", "Reserved publication path.");
  return path;
}
export function mediaType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return (
    (
      {
        html: "text/html",
        htm: "text/html",
        css: "text/css",
        js: "text/javascript",
        mjs: "text/javascript",
        ts: "text/plain",
        tsx: "text/plain",
        jsx: "text/plain",
        md: "text/markdown",
        json: "application/json",
        txt: "text/plain",
        svg: "image/svg+xml",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        ico: "image/x-icon",
        woff2: "font/woff2",
      } as Record<string, string>
    )[ext ?? ""] ?? "application/octet-stream"
  );
}
export function isText(type: string) {
  return type.startsWith("text/") || type === "application/json" || type === "image/svg+xml";
}
export function fileUrl(base: string, id: string, n: number, path: string, preview = false) {
  return `${base}${preview ? "preview" : "api/artifacts"}/${id}/${preview ? `${n}/` : `revisions/${n}/source/`}${path.split("/").map(encodeURIComponent).join("/")}`;
}
