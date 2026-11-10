import type { ArtifactRevision, GetOutput } from "../../src/shared/contracts";

export type ToolName = "write" | "artifact_publish" | "artifact_list" | "artifact_get";
export interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
}
export interface PiOptions {
  session?: string;
  provider?: string;
  project?: string;
  fork?: string;
  prompt?: string;
}
export interface PiRecord {
  type: string;
  toolName?: string;
  isError?: boolean;
  entry?: { customType?: string };
  result?: { details: unknown; content: { type: string; text?: string }[] };
}
export type ToolEvent<N extends ToolName> = PiRecord & {
  toolName: N;
  result: {
    details: N extends "artifact_publish"
      ? ArtifactRevision
      : N extends "artifact_get"
        ? GetOutput
        : N extends "artifact_list"
          ? { artifacts: ArtifactRevision[] }
          : unknown;
  };
};
