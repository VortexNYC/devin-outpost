import { listOutpostSessions, type OutpostSession } from "./devin-api";
import type { Env } from "./env";
import { describeError, type SuspendResult } from "./session";

export { DevinSession } from "./session";
export { EnvironmentImage } from "./environment";

// Matches the cron trigger in wrangler.jsonc. Polls stay inside this window so runs never overlap.
const SCHEDULE_INTERVAL_MS = 60_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 10_000;

type SessionCommand = "ensureRunning" | "suspend" | "terminate";

// What one reconcile pass did with a session. Every session lands in exactly one
// bucket, so the per-poll summary answers "did anything actually run, or was
// every session skipped?" without reading the per-session lines.
type SessionOutcome =
  | "foreign"
  | "unknownStatus"
  | "ensureRunning"
  | "terminate"
  | `suspend_${SuspendResult}`;

// Devin's documented session statuses. Anything else is logged and left alone.
const SESSION_COMMANDS = new Map<string, SessionCommand>([
  ["pending", "ensureRunning"],
  ["running", "ensureRunning"],
  ["suspended", "suspend"],
  ["terminated", "terminate"],
]);

export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }
    return Response.json({ service: "devin-outpost", status: "ok" });
  },

  async scheduled(_controller, env): Promise<void> {
    const intervalMs = reconcileIntervalMs(env);
    const deadline = Date.now() + SCHEDULE_INTERVAL_MS;

    await reconcile(env);
    // Start another poll only if it can finish before the next cron run.
    while (Date.now() + intervalMs < deadline) {
      await scheduler.wait(intervalMs);
      await reconcile(env);
    }
  },
} satisfies ExportedHandler<Env>;

async function reconcile(env: Env): Promise<void> {
  const required = {
    DEVIN_OUTPOST_ID: env.DEVIN_OUTPOST_ID,
    DEVIN_API_TOKEN: env.DEVIN_API_TOKEN,
    DEVIN_API_URL: env.DEVIN_API_URL,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => value === "" || value === undefined)
    .map(([name]) => name);
  if (missing.length > 0) {
    console.error({ event: "devin.reconcile.misconfigured", missing });
    return;
  }

  let sessions: OutpostSession[];
  try {
    sessions = await listOutpostSessions(env);
  } catch (cause) {
    console.error({ event: "devin.reconcile.failed", error: describeError(cause) });
    return;
  }

  const outcomes: Record<SessionOutcome, number> = {
    foreign: 0,
    unknownStatus: 0,
    ensureRunning: 0,
    terminate: 0,
    suspend_saved: 0,
    suspend_waiting: 0,
    suspend_stopped: 0,
  };
  let failed = 0;
  for (const session of sessions) {
    const sessionId = session.metadata.session_id;
    const status = session.status?.session_status ?? undefined;
    try {
      outcomes[await reconcileSession(env, session, sessionId, status)]++;
    } catch (cause) {
      failed++;
      // Name the Durable Object call that threw: a failing start, suspend and
      // terminate all report the same session and status otherwise.
      console.error({
        event: "devin.session.failed",
        sessionId,
        status,
        command: status === undefined ? undefined : SESSION_COMMANDS.get(status),
        error: describeError(cause),
      });
    }
  }
  console.log({
    event: "devin.reconcile",
    scanned: sessions.length,
    // Sessions this outpost did not act on: assigned elsewhere, or a status Devin
    // added that this Worker does not map yet.
    ignored: outcomes.foreign + outcomes.unknownStatus,
    failed,
    ...outcomes,
  });
}

async function reconcileSession(
  env: Env,
  session: OutpostSession,
  sessionId: string,
  status: string | undefined,
): Promise<SessionOutcome> {
  // Only act on sessions that Devin assigned to this outpost.
  if (session.metadata.outpost_id !== env.DEVIN_OUTPOST_ID) {
    console.warn({
      event: "devin.session.foreign",
      sessionId,
      outpostId: session.metadata.outpost_id,
    });
    return "foreign";
  }
  // Structured record of the queue spec on every reconcile: confirms whether
  // Devin enqueues image_build sessions for this pool and whether spec.image
  // pins are in use. No secrets are logged.
  console.log({
    event: "devin.session.spec",
    sessionId,
    // Paired with the status so the rollup's counts can be traced back to the
    // sessions behind them, such as the ones stuck reporting "suspended".
    status,
    kind: session.spec?.kind ?? null,
    imageBuild: session.spec?.image_build === true,
    imageSet: session.spec?.image != null,
    imageTargetSet:
      session.spec?.image_target != null || session.spec?.image_target_path != null,
  });

  const command = status === undefined ? undefined : SESSION_COMMANDS.get(status);
  if (command === undefined) {
    console.warn({
      event: "devin.session.unknown_status",
      sessionId,
      status,
      phase: session.status?.phase,
    });
    return "unknownStatus";
  }

  const stub = env.DEVIN_SESSION.getByName(sessionId, { locationHint: "enam" });
  if (command === "ensureRunning") {
    await stub.ensureRunning(
      sessionId,
      `${env.WORKER_ID_PREFIX || "cf-outpost"}-${sessionId}`,
      session.spec ?? null,
    );
    return "ensureRunning";
  }
  if (command === "suspend") {
    // "waiting" means the Devin CLI has not exited yet, so this session's disk is
    // not saved; a run that stays here loses the workspace on the next resume.
    return `suspend_${await stub.suspend(sessionId)}`;
  }
  await stub.terminate(sessionId);
  return "terminate";
}

function reconcileIntervalMs(env: Env): number {
  const parsed = Number(env.DEVIN_RECONCILE_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RECONCILE_INTERVAL_MS;
}
