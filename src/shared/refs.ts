import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { type ArtifactRef, Ref } from "./contracts";
export function branchReferences(entries: readonly SessionEntry[]): ArtifactRef[] {
  const refs = new Map<string, ArtifactRef>();
  for (const entry of entries) {
    let data: unknown;
    if (entry.type === "custom" && entry.customType === "pi-artifacts.ref.v1") data = entry.data;
    if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolName === "artifact_publish" &&
      !entry.message.isError
    )
      data = entry.message.details;
    if (Value.Check(Ref, data)) {
      const ref = data as ArtifactRef;
      const existing = refs.get(ref.id);
      if (existing?.revision === ref.revision) continue;
      refs.delete(ref.id);
      refs.set(ref.id, { id: ref.id, revision: ref.revision });
    }
  }
  return [...refs.values()].reverse();
}
