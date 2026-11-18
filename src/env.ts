import type { DevinSession } from "./session";
import type { EnvironmentImage } from "./environment";

export interface Env {
  DEVIN_SESSION: DurableObjectNamespace<DevinSession>;
  ENVIRONMENT_IMAGE: DurableObjectNamespace<EnvironmentImage>;
  DEVIN_OUTPOST_ID: string;
  DEVIN_API_TOKEN: string;
  DEVIN_API_URL: string;
  WORKER_ID_PREFIX: string;
  DEVIN_RECONCILE_INTERVAL_MS: string;
}
