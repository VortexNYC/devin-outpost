// Where a session's Container filesystem comes from. Pure so the reconcile
// decision is unit-testable without a Container or Durable Object.
export type StartSource = "base" | "environment" | "session";

export interface StartSourceInput {
  // spec.kind: "new" | "resume" | anything the server adds later.
  kind: string | null | undefined;
  // spec.image_build: the session builds the pool's next environment image.
  imageBuild: boolean;
  // This session's own snapshot, saved on suspend (resumes only).
  sessionSnapshotId: string | undefined;
  // The shared environment snapshot from the latest successful image build.
  environmentSnapshotId: string | undefined;
}

export type StartSourceDecision =
  | { source: "base" }
  | { source: "environment" | "session"; snapshotId: string };

// An image build always starts from the base image — a build must run the
// blueprint on a clean box, never on a previous environment (mirrors the k8s
// operator, which runs image-build pods from the pool's image_build.base_image).
// A resume keeps its own per-session snapshot exactly as before; only "new"
// sessions (and unknown future kinds) may boot the shared environment snapshot.
export function chooseStartSource(input: StartSourceInput): StartSourceDecision {
  if (input.imageBuild) return { source: "base" };
  if (input.kind === "resume") {
    return input.sessionSnapshotId === undefined
      ? { source: "base" }
      : { source: "session", snapshotId: input.sessionSnapshotId };
  }
  if (input.environmentSnapshotId !== undefined) {
    return { source: "environment", snapshotId: input.environmentSnapshotId };
  }
  return { source: "base" };
}

// What to do when a snapshot-based container dies or errors during its boot
// window (container.start() only validates options; a missing or expired
// snapshot surfaces later through monitor()). Cloudflare expires snapshots
// after 30 days, so this is expected, not exceptional.
export interface RestoreFallbackDecision {
  // False means the start was already from the base image: the caller must
  // rethrow — there is nothing to fall back to.
  restartFromBase: boolean;
  // Environment snapshots are shared, so a proven-bad id is cleared from
  // EnvironmentImage (compare-and-clear on this exact id).
  clearEnvironmentSnapshotId?: string;
  // The session's own snapshot record is kept, but this id is skipped so the
  // next ensureRunning boots base instead of retrying a dead snapshot.
  skipSessionSnapshotId?: string;
}

export function decideRestoreFallback(
  source: StartSource,
  snapshotId: string | undefined,
): RestoreFallbackDecision {
  if (source === "environment") {
    return { restartFromBase: true, clearEnvironmentSnapshotId: snapshotId };
  }
  if (source === "session") {
    return { restartFromBase: true, skipSessionSnapshotId: snapshotId };
  }
  return { restartFromBase: false };
}
