import { afterEach, describe, expect, it, vi } from "vitest";
import { listOutpostSessions, OutpostSession } from "../src/devin-api";
import type { Env } from "../src/env";

describe("OutpostSession spec parsing", () => {
  it("parses a minimal spec with only kind, platform and remote_binary_sha", () => {
    const session = OutpostSession.parse({
      metadata: { session_id: "devin-1", outpost_id: "outpost-1" },
      spec: { kind: "new", platform: "linux", remote_binary_sha: null },
      status: { session_status: "running", phase: "claimed" },
    });
    expect(session.spec?.kind).toBe("new");
    expect(session.spec?.image_build).toBeUndefined();
    expect(session.spec?.image).toBeUndefined();
  });

  it("parses an image_build spec with image targets", () => {
    const session = OutpostSession.parse({
      metadata: { session_id: "devin-build-1", outpost_id: "outpost-1" },
      spec: {
        kind: "new",
        platform: "linux",
        remote_binary_sha: "abc123",
        image: "registry.example.com/devin/base@sha256:deadbeef",
        image_build: true,
        image_target: "registry.example.com/devin/drs/org-1:job-1",
        image_target_path: "org-1:job-1",
        network_policy: { enabled: true, allow: [{ hostname: "*.example.com" }] },
      },
      status: { session_status: "running", phase: "claimed" },
    });
    expect(session.spec?.image_build).toBe(true);
    expect(session.spec?.image_target).toBe("registry.example.com/devin/drs/org-1:job-1");
    expect(session.spec?.image_target_path).toBe("org-1:job-1");
    expect(session.spec?.image).toBe("registry.example.com/devin/base@sha256:deadbeef");
  });

  it("parses a resume spec", () => {
    const session = OutpostSession.parse({
      metadata: { session_id: "devin-2", outpost_id: "outpost-1" },
      spec: { kind: "resume", platform: "linux" },
      status: { session_status: "running" },
    });
    expect(session.spec?.kind).toBe("resume");
  });

  it("tolerates a missing spec and unknown spec keys", () => {
    const withoutSpec = OutpostSession.parse({
      metadata: { session_id: "devin-3", outpost_id: "outpost-1" },
      status: { session_status: "pending" },
    });
    expect(withoutSpec.spec).toBeUndefined();

    const withUnknown = OutpostSession.parse({
      metadata: { session_id: "devin-4", outpost_id: "outpost-1" },
      spec: { kind: "new", platform: "linux", future_field: { nested: true } },
      status: null,
    });
    expect(withUnknown.spec?.kind).toBe("new");
    expect(withUnknown.spec).toHaveProperty("future_field");
  });
});

const listEnv = {
  DEVIN_API_URL: "https://api.devin.test/opbeta/",
  DEVIN_OUTPOST_ID: "outpost-1",
  DEVIN_API_TOKEN: "token",
} as unknown as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listOutpostSessions failure context", () => {
  it("names the failing page and the sessions already listed", async () => {
    const page = (sessionId: string, cursor: string | null, hasNext: boolean) =>
      new Response(
        JSON.stringify({
          items: [
            {
              metadata: { session_id: sessionId, outpost_id: "outpost-1" },
              status: { session_status: "running" },
            },
          ],
          cursor,
          has_next_page: hasNext,
        }),
        { status: 200 },
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page("devin-1", "cursor-1", true))
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listOutpostSessions(listEnv)).rejects.toThrow(
      /Devin API returned 503 on page 2 after 1 sessions/,
    );
  });

  it("names the failing page when a page fails validation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ metadata: { session_id: "devin-1", outpost_id: "outpost-1" } }],
            cursor: "cursor-1",
            has_next_page: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ spec: null }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listOutpostSessions(listEnv)).rejects.toThrow(
      /Devin API page 2 failed validation after 1 sessions/,
    );
  });
});
