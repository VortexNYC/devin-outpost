import { describe, expect, it } from "vitest";
import {
  chooseStartSource,
  decideRestoreFallback,
  type StartSourceInput,
} from "../src/start-source";

const base: StartSourceInput = {
  kind: "new",
  imageBuild: false,
  sessionSnapshotId: undefined,
  environmentSnapshotId: undefined,
};

describe("chooseStartSource", () => {
  it("image builds always start from the base image, even with snapshots available", () => {
    expect(
      chooseStartSource({
        ...base,
        imageBuild: true,
        kind: "new",
        sessionSnapshotId: "sess-1",
        environmentSnapshotId: "env-1",
      }),
    ).toEqual({ source: "base" });
  });

  it("new sessions boot the environment snapshot when one exists", () => {
    expect(chooseStartSource({ ...base, environmentSnapshotId: "env-1" })).toEqual({
      source: "environment",
      snapshotId: "env-1",
    });
  });

  it("new sessions fall back to the base image without an environment snapshot", () => {
    expect(chooseStartSource(base)).toEqual({ source: "base" });
  });

  it("resumed sessions boot their own snapshot, ignoring the environment snapshot", () => {
    expect(
      chooseStartSource({
        ...base,
        kind: "resume",
        sessionSnapshotId: "sess-1",
        environmentSnapshotId: "env-1",
      }),
    ).toEqual({ source: "session", snapshotId: "sess-1" });
  });

  it("resumed sessions without a snapshot fall back to the base image", () => {
    expect(chooseStartSource({ ...base, kind: "resume" })).toEqual({ source: "base" });
  });

  it("a missing kind behaves like a new session", () => {
    expect(
      chooseStartSource({ ...base, kind: null, environmentSnapshotId: "env-1" }),
    ).toEqual({ source: "environment", snapshotId: "env-1" });
    expect(chooseStartSource({ ...base, kind: undefined })).toEqual({ source: "base" });
  });

  it("an unknown future kind may use the environment snapshot", () => {
    expect(
      chooseStartSource({ ...base, kind: "fork", environmentSnapshotId: "env-1" }),
    ).toEqual({ source: "environment", snapshotId: "env-1" });
  });
});

describe("decideRestoreFallback", () => {
  it("a failed environment restore restarts from base and clears that snapshot id", () => {
    expect(decideRestoreFallback("environment", "env-1")).toEqual({
      restartFromBase: true,
      clearEnvironmentSnapshotId: "env-1",
    });
  });

  it("a failed session restore restarts from base but keeps the snapshot record", () => {
    const decision = decideRestoreFallback("session", "sess-1");
    expect(decision.restartFromBase).toBe(true);
    expect(decision.skipSessionSnapshotId).toBe("sess-1");
    // No clearEnvironmentSnapshotId: only the session's own id is skipped.
    expect(decision.clearEnvironmentSnapshotId).toBeUndefined();
  });

  it("a failed base start has no fallback and must be rethrown", () => {
    expect(decideRestoreFallback("base", undefined)).toEqual({ restartFromBase: false });
  });
});
