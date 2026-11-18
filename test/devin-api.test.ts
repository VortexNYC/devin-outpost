import { describe, expect, it } from "vitest";
import { OutpostSession } from "../src/devin-api";

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
