import { z } from "zod";
import type { Env } from "./env";

const REQUEST_TIMEOUT_MS = 30_000;

// Mirrors `Spec` in CognitionAI/devin-outpost-k8s src/api/types.rs. Unknown
// keys are kept (looseObject) so a server-side addition never breaks parsing;
// `kind` stays a plain string because the server may add variants.
const SessionSpec = z.looseObject({
  kind: z.string().nullish(),
  platform: z.string().nullish(),
  remote_binary_sha: z.string().nullish(),
  // Container image digest the session must run; the pool's worker image when unset.
  image: z.string().nullish(),
  // True when the session exists to build the pool's next environment image.
  image_build: z.boolean().nullish(),
  // `repository/path:tag` the built image is pushed to (k8s registry flow).
  image_target: z.string().nullish(),
  // `path:tag` under the pool's image repository for the built image.
  image_target_path: z.string().nullish(),
  network_policy: z
    .looseObject({
      enabled: z.boolean().nullish(),
      allow: z.array(z.unknown()).nullish(),
    })
    .nullish(),
});

const OutpostSession = z.object({
  metadata: z.object({
    session_id: z.string().min(1),
    outpost_id: z.string(),
  }),
  spec: SessionSpec.nullish(),
  status: z
    .object({
      session_status: z.string().nullish(),
      phase: z.string().nullish(),
    })
    .nullish(),
});

const OutpostSessionPage = z.object({
  items: z.array(OutpostSession),
  cursor: z.string().nullish(),
  has_next_page: z.boolean().nullish(),
});

export { OutpostSession };
export type OutpostSession = z.infer<typeof OutpostSession>;
export type SessionSpec = z.infer<typeof SessionSpec>;

// Lists every session for the configured outpost, following Devin's pagination cursor.
export async function listOutpostSessions(env: Env): Promise<OutpostSession[]> {
  const apiUrl = env.DEVIN_API_URL.replace(/\/$/, "");
  const outpost = encodeURIComponent(env.DEVIN_OUTPOST_ID);
  const sessions: OutpostSession[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageNumber = 1;

  for (;;) {
    const cursorQuery = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const response = await fetch(`${apiUrl}/outposts/devins?outpost=${outpost}${cursorQuery}`, {
      headers: { Authorization: `Bearer ${env.DEVIN_API_TOKEN}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // The page and running total tell an operator whether the API itself is
      // down or one late page of a long listing failed.
      throw new Error(
        `Devin API returned ${response.status} on page ${pageNumber} ` +
          `after ${sessions.length} sessions: ${await response.text()}`,
      );
    }

    let page: z.infer<typeof OutpostSessionPage>;
    try {
      page = OutpostSessionPage.parse(await response.json());
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `Devin API page ${pageNumber} failed validation after ${sessions.length} sessions: ${detail}`,
      );
    }
    sessions.push(...page.items);
    if (page.has_next_page !== true) return sessions;

    if (page.cursor === undefined || page.cursor === null) {
      throw new Error("Devin API omitted the next-page cursor");
    }
    if (seenCursors.has(page.cursor)) {
      throw new Error("Devin API repeated a pagination cursor");
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
    pageNumber++;
  }
}
