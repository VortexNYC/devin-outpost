import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

const STATE_KEY = "current";

// The environment snapshot shared by every new session: the filesystem a
// successful image-build session produced after running the org's blueprint.
// Only the latest is kept; Cloudflare expires container snapshots after 30
// days, so a stale entry self-heals on the next build.
export interface EnvironmentImageState {
  snapshotId: string;
  buildSessionId: string;
  createdAt: number;
}

/** Singleton (`getByName("current")`) record of the pool's environment snapshot. */
export class EnvironmentImage extends DurableObject<Env> {
  async current(): Promise<EnvironmentImageState | null> {
    return (await this.ctx.storage.get<EnvironmentImageState>(STATE_KEY)) ?? null;
  }

  async record(state: EnvironmentImageState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
    console.log({
      event: "devin.environment_image.recorded",
      snapshotId: state.snapshotId,
      buildSessionId: state.buildSessionId,
    });
  }
}
