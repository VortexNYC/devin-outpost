import { DurableObject } from "cloudflare:workers";
import type { SessionSpec } from "./devin-api";
import type { Env } from "./env";
import {
  chooseStartSource,
  decideRestoreFallback,
  type RestoreFallbackDecision,
  type StartSourceDecision,
} from "./start-source";

// The reconciler renews this on every poll, so it only matters after polling stops.
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000;
// start-devin-worker writes the Devin CLI's exit status here when it exits
// and then keeps the Container running so it can be snapshotted.
const EXIT_MARKER = "/var/lib/devin-outpost/exited";
const SNAPSHOT_KEY = "snapshotId";
const SESSION_META_KEY = "sessionMeta";
// A session snapshot id whose restore already failed once; the record stays,
// but ensureRunning skips it until a fresh snapshot replaces it.
const FAILED_SNAPSHOT_KEY = "failedSnapshotId";
// container.start() only validates options — a missing or expired snapshot
// surfaces when the container fails during boot. The entrypoint sleeps
// forever after the CLI exits, so a container that exits or errors this soon
// after start() is a failed restore, not a finished session.
const RESTORE_GRACE_MS = 120_000;

// Removed before an environment snapshot is taken. The snapshot is shared by
// every new session on the pool, so it must not carry credentials or
// per-session state: DEVIN_API_TOKEN itself only ever lives in the process
// environment (start-devin-worker never writes it), but the Devin CLI and
// blueprints can persist secrets under HOME, and worker/session state lives
// under /root/.devin-worker (the worker's cache dir and per-session state
// dir, see WORKER_DATA_SUBDIR in the k8s operator's pod contract).
const ENVIRONMENT_SCRUB_COMMAND = [
  "rm -rf",
  "/root/.devin-worker",
  "/root/.devin",
  "/root/.config/devin",
  "/root/.config/gcloud",
  "/root/.cache",
  "/root/.ssh",
  "/root/.aws",
  "/root/.azure",
  "/root/.kube",
  "/root/.docker",
  "/root/.gnupg",
  "/root/.npmrc",
  "/root/.netrc",
  "/root/.git-credentials",
  "/root/.bash_history",
  "/root/.python_history",
  "/root/.wget-hsts",
  "/var/lib/devin",
  "/var/lib/devin-outpost/exited",
  "&& find /tmp -mindepth 1 -delete",
].join(" ");

export type SuspendResult = "saved" | "waiting" | "stopped";

interface SessionMeta {
  kind: string | null;
  imageBuild: boolean;
}

/** One Durable Object per Devin session. It controls that session's Container and never calls Devin. */
export class DevinSession extends DurableObject<Env> {
  async ensureRunning(
    sessionId: string,
    acceptorId: string,
    spec?: SessionSpec | null,
  ): Promise<void> {
    const container = this.requireContainer();
    if (container.running) {
      // A running session whose CLI exited needs a new Container. Keep its disk first.
      if (!(await this.saveIfExited(container, sessionId))) {
        await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
        return;
      }
    }

    const meta: SessionMeta = {
      kind: spec?.kind ?? null,
      imageBuild: spec?.image_build === true,
    };
    await this.ctx.storage.put(SESSION_META_KEY, meta);
    if (spec?.image != null) {
      // spec.image pins a registry digest this template cannot pull; the
      // session still runs on the pool's image and the build logs show it.
      console.warn({
        event: "devin.session.image_unsupported",
        sessionId,
        image: spec.image,
      });
    }

    const sessionSnapshotId = await this.effectiveSessionSnapshotId();
    const environment = meta.imageBuild
      ? null
      : await this.env.ENVIRONMENT_IMAGE.getByName("current").current();
    let decision = chooseStartSource({
      kind: meta.kind,
      imageBuild: meta.imageBuild,
      sessionSnapshotId,
      environmentSnapshotId: environment?.snapshotId,
    });

    const env = {
      DEVIN_OUTPOST_SESSION_ID: sessionId,
      DEVIN_OUTPOST_ID: this.env.DEVIN_OUTPOST_ID,
      DEVIN_WORKER_ACCEPTOR_ID: acceptorId,
      DEVIN_API_TOKEN: this.env.DEVIN_API_TOKEN,
      // The CLI expects an origin and appends its own Outposts API path.
      DEVIN_API_URL: new URL(this.env.DEVIN_API_URL).origin,
      DEVIN_OUTPOST_DESKTOP: "true",
      DEVIN_CHROME_PATH: "/usr/bin/chromium",
      HOME: "/root",
      USER: "root",
      LOGNAME: "root",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
    };
    const options = {
      instance: "standard-2",
      enableInternet: true,
      env,
    } satisfies ContainerStartupOptions;
    const baseOptions = { ...options, image: container.images.devin };
    const snapshotOptions = (snapshotId: string) => ({
      ...options,
      containerSnapshot: { id: snapshotId },
    });
    const startOptions = (d: StartSourceDecision) =>
      d.source === "base" ? baseOptions : snapshotOptions(d.snapshotId);

    try {
      container.start(startOptions(decision));
    } catch (cause) {
      const fallback = decideRestoreFallback(
        decision.source,
        decision.source === "base" ? undefined : decision.snapshotId,
      );
      if (!fallback.restartFromBase) throw cause;
      await this.applyRestoreFallback(fallback, sessionId, describeError(cause));
      decision = { source: "base" };
      // A base-image start that also throws propagates — nothing left to try.
      container.start(baseOptions);
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    console.log({
      event: "devin.container.started",
      sessionId,
      source: decision.source,
      kind: meta.kind,
      imageBuild: meta.imageBuild,
      snapshotId: decision.source === "base" ? undefined : decision.snapshotId,
    });
    this.ctx.waitUntil(this.watchContainer(container, sessionId, decision, baseOptions));
  }

  // The session's snapshot id unless a previous restore of it already failed.
  private async effectiveSessionSnapshotId(): Promise<string | undefined> {
    const stored = await this.ctx.storage.get<string>(SNAPSHOT_KEY);
    if (stored === undefined) return undefined;
    const failed = await this.ctx.storage.get<string>(FAILED_SNAPSHOT_KEY);
    return stored === failed ? undefined : stored;
  }

  private async applyRestoreFallback(
    fallback: RestoreFallbackDecision,
    sessionId: string,
    error: string,
  ): Promise<void> {
    if (fallback.clearEnvironmentSnapshotId !== undefined) {
      await this.env
        .ENVIRONMENT_IMAGE.getByName("current")
        .clear(fallback.clearEnvironmentSnapshotId);
      console.warn({
        event: "devin.environment_image.restore_failed",
        sessionId,
        snapshotId: fallback.clearEnvironmentSnapshotId,
        error,
      });
    }
    if (fallback.skipSessionSnapshotId !== undefined) {
      await this.ctx.storage.put(FAILED_SNAPSHOT_KEY, fallback.skipSessionSnapshotId);
      console.warn({
        event: "devin.session.restore_failed",
        sessionId,
        snapshotId: fallback.skipSessionSnapshotId,
        error,
      });
    }
  }

  // A snapshot restore that cannot work fails while the container boots:
  // monitor() settles (exit or error) inside RESTORE_GRACE_MS. In that case
  // fall back to the base image once; a surviving container is healthy.
  private async watchContainer(
    container: Container,
    sessionId: string,
    decision: StartSourceDecision,
    baseOptions: ContainerStartupOptions,
  ): Promise<void> {
    const monitor = container.monitor();
    const settled = await Promise.race([
      monitor.then(
        () => ({ kind: "exited" as const }),
        (cause: unknown) => ({ kind: "error" as const, cause }),
      ),
      new Promise<{ kind: "alive" }>((resolve) =>
        setTimeout(() => resolve({ kind: "alive" }), RESTORE_GRACE_MS),
      ),
    ]);

    if (settled.kind !== "alive") {
      const snapshotId = decision.source === "base" ? undefined : decision.snapshotId;
      const fallback = decideRestoreFallback(decision.source, snapshotId);
      if (fallback.restartFromBase) {
        const error =
          settled.kind === "error" ? describeError(settled.cause) : "container exited during boot";
        await this.applyRestoreFallback(fallback, sessionId, error);
        try {
          container.start(baseOptions);
        } catch {
          // Another reconcile may already have restarted the container.
        }
        this.ctx.waitUntil(
          container.monitor().then(
            () => console.log({ event: "devin.container.exited", sessionId }),
            (cause: unknown) =>
              console.warn({
                event: "devin.container.exited",
                sessionId,
                error: describeError(cause),
              }),
          ),
        );
        return;
      }
      if (settled.kind === "exited") {
        console.log({ event: "devin.container.exited", sessionId });
      } else {
        console.warn({
          event: "devin.container.exited",
          sessionId,
          error: describeError(settled.cause),
        });
      }
      return;
    }

    monitor.then(
      () => console.log({ event: "devin.container.exited", sessionId }),
      (cause: unknown) =>
        console.warn({ event: "devin.container.exited", sessionId, error: describeError(cause) }),
    );
  }

  // Devin suspends a session by letting its CLI exit. Save the disk once it has.
  async suspend(sessionId: string): Promise<SuspendResult> {
    const container = this.requireContainer();
    if (!container.running) return "stopped";
    if (await this.saveIfExited(container, sessionId)) return "saved";
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    return "waiting";
  }

  async terminate(sessionId: string): Promise<void> {
    const container = this.requireContainer();
    if (container.running) await container.destroy();
    // The Worker API cannot delete the snapshot itself; forgetting its ID stops any restore.
    await this.ctx.storage.deleteAll();
    console.log({ event: "devin.session.terminated", sessionId });
  }

  // Returns the CLI's exit status once the exit marker exists, undefined while the CLI still runs.
  private async exitedStatus(container: Container): Promise<number | undefined> {
    const probe = await container.exec(["cat", EXIT_MARKER]);
    const { exitCode, stdout } = await probe.output();
    if (exitCode !== 0) return undefined;
    const status = Number(new TextDecoder().decode(stdout).trim());
    return Number.isInteger(status) ? status : -1;
  }

  private async saveIfExited(container: Container, sessionId: string): Promise<boolean> {
    const exitStatus = await this.exitedStatus(container);
    if (exitStatus === undefined) return false;

    const meta = await this.ctx.storage.get<SessionMeta>(SESSION_META_KEY);
    if (meta?.imageBuild === true) {
      await this.captureEnvironmentImage(container, sessionId, exitStatus);
    } else {
      const snapshot = await container.snapshotContainer({ name: `devin-${sessionId}` });
      await this.ctx.storage.put(SNAPSHOT_KEY, snapshot.id);
      await this.ctx.storage.delete(FAILED_SNAPSHOT_KEY);
      await container.destroy();
      console.log({
        event: "devin.snapshot.saved",
        sessionId,
        snapshotId: snapshot.id,
        bytes: snapshot.size,
      });
    }
    return true;
  }

  // An image-build session's disk becomes the pool's environment snapshot.
  // Success is the Devin CLI exiting 0 — the same signal the k8s operator gets
  // from the worker container's exit status driving the pod to Succeeded.
  private async captureEnvironmentImage(
    container: Container,
    sessionId: string,
    exitStatus: number,
  ): Promise<void> {
    if (exitStatus !== 0) {
      await container.destroy();
      console.warn({
        event: "devin.environment_image.failed",
        sessionId,
        exitStatus,
      });
      return;
    }

    const scrub = await container.exec(["sh", "-c", ENVIRONMENT_SCRUB_COMMAND]);
    const scrubResult = await scrub.output();
    if (scrubResult.exitCode !== 0) {
      console.warn({
        event: "devin.environment_image.scrub_failed",
        sessionId,
        exitCode: scrubResult.exitCode,
      });
    }

    const snapshot = await container.snapshotContainer({ name: `devin-env-${sessionId}` });
    await this.env.ENVIRONMENT_IMAGE.getByName("current").record({
      snapshotId: snapshot.id,
      buildSessionId: sessionId,
      createdAt: Date.now(),
    });
    await container.destroy();
    console.log({
      event: "devin.environment_image.saved",
      sessionId,
      snapshotId: snapshot.id,
      bytes: snapshot.size,
    });
  }

  private requireContainer(): Container {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("Container attachment is unavailable");
    }
    return container;
  }
}

// Structured logs drop an Error's message and stack because they are not enumerable.
export function describeError(cause: unknown): string {
  return cause instanceof Error && cause.stack !== undefined ? cause.stack : String(cause);
}
