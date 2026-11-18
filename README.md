# Devin Outposts on Cloudflare

Run each [Devin Outposts](https://docs.devin.ai/cloud/outposts/overview) session in its own Container. A Worker polls Devin for the outpost's sessions and gives each session a Durable Object, which starts that session's Container, snapshots it when Devin suspends the session, and restores it when the session resumes.

Done when `curl https://<your-worker>.workers.dev/` returns `{"service":"devin-outpost","status":"ok"}` and a new Devin session on your outpost starts working.

## Deploy

You need a Devin outpost ID and a Devin service user token with the **Run outpost workers** permission.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/sandbox-sdk/tree/main/templates/devin)

The Deploy flow asks for `DEVIN_OUTPOST_ID` and `DEVIN_API_TOKEN`, then creates the Worker, its cron trigger, the Durable Object namespace, and the Container image.

To deploy from your machine instead, you need Node.js 24, pnpm, and a running Docker daemon:

```sh
pnpm create cloudflare@latest -- devin-outpost --template=cloudflare/sandbox-sdk/templates/devin
cd devin-outpost
```

Set `DEVIN_OUTPOST_ID` in `wrangler.jsonc`, then add the token and deploy:

```sh
pnpm exec wrangler secret put DEVIN_API_TOKEN
pnpm run deploy
```

## How it works

A cron trigger runs the Worker every minute. Each run polls the Devin API every `DEVIN_RECONCILE_INTERVAL_MS` (10 seconds by default) and stops before the next run starts. Each poll lists the configured outpost's sessions and skips any session whose `metadata.outpost_id` does not match.

The Worker maps each session status to a call on that session's Durable Object:

| Devin status         | Durable Object action                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pending`, `running` | Start the Container if it is not running: environment snapshot for new sessions, session snapshot for resumes.     |
| `suspended`          | Wait for the Devin CLI to exit, snapshot the Container, then destroy it.                                           |
| `terminated`         | Destroy the Container and forget the snapshot.                                                                     |
| Anything else        | Log the status and do nothing.                                                                                     |

Inside the Container, `devin worker start` claims the session and runs it. The Durable Object never calls Devin.

Each reconcile also logs the queue entry's `spec` (`kind`, `image_build`, whether `image`/`image_target` are set) as `devin.session.spec`, and `devin.container.started` records which filesystem source booted the session (`base`, `environment`, or `session`).

## Environment snapshots

When Devin's environment feature is on, it enqueues a session with `spec.image_build: true` after each environment build. That session exists to run the org's blueprint (repo clone, initialize, maintenance) rather than an agent, so this Worker treats it specially:

- It always boots the **base** Container image — a build must run on a clean box, never on a previous environment snapshot (mirroring the k8s operator, which runs image-build pods from the pool's `image_build.base_image`).
- When the Devin CLI exits with status 0, the Durable Object scrubs credential and per-session state (see Security), snapshots the Container, and stores the snapshot ID in the `EnvironmentImage` singleton Durable Object (`getByName("current")`). A nonzero exit destroys the Container without promoting a snapshot; both outcomes are logged (`devin.environment_image.saved` / `.failed`).
- Every later session with `spec.kind === "new"` boots that snapshot instead of the base image. Resumed sessions (`spec.kind === "resume"`) keep using their own per-session snapshot. Only the latest environment snapshot is kept; Cloudflare expires container snapshots after 30 days, so a stale entry is replaced by the next successful build.

`spec.image` (a registry digest the session must run) and `spec.image_target`/`image_target_path` (where the k8s operator would push a built image) are parsed and logged, but this template cannot pull arbitrary registry images or push to a registry — image builds here produce a Cloudflare snapshot instead. A session carrying `spec.image` logs `devin.session.image_unsupported` and still runs on the pool's image.

## Snapshots

When Devin suspends a session, the Devin CLI exits. The entrypoint then writes an exit marker and keeps the Container running, because `snapshotContainer()` needs a running Container. On its next poll, the Durable Object finds the marker, saves a snapshot of the Container's root filesystem, stores the snapshot ID, and destroys the Container. When the session resumes, the Container starts from that snapshot and the entrypoint runs `devin worker start` again.

If the Devin CLI exits while the session is still `running`, the Durable Object snapshots the Container and starts a new one from the snapshot.

A snapshot keeps files, installed packages, and Devin's state on disk. It does not keep running processes or memory. If a Container stops before its snapshot is saved, the session resumes from its previous snapshot or from the image.

Terminating a session removes the snapshot ID from the Durable Object. The Worker API has no method to delete the snapshot itself.

## Configuration

| Setting                       | Description                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `DEVIN_OUTPOST_ID`            | Required. The ID of your Devin outpost.                                               |
| `DEVIN_API_TOKEN`             | Required secret. A service user token with the **Run outpost workers** permission.    |
| `DEVIN_API_URL`               | The Outposts API prefix. Defaults to `https://api.devin.ai/opbeta`.                   |
| `WORKER_ID_PREFIX`            | The prefix for the acceptor ID that each Container reports. Defaults to `cf-outpost`. |
| `DEVIN_RECONCILE_INTERVAL_MS` | The time between polls within each cron run. Defaults to `10000`.                     |

## Security

- Each Container receives `DEVIN_API_TOKEN`, because the Devin CLI needs it to claim the session. Code that Devin runs in the Container can read it. The token is passed through the process environment only; `start-devin-worker` never writes it to disk.
- The environment snapshot is shared by every new session, so before it is taken the Container is scrubbed of credential and per-session state: `/root/.devin-worker` (the worker's cache and per-session state dir, including the downloaded `devin-remote` binary), `/root/.devin`, `/root/.config/devin` and `/root/.config/gcloud`, cloud and registry credential directories (`.ssh`, `.aws`, `.azure`, `.kube`, `.docker`, `.gnupg`), credential files (`.npmrc`, `.netrc`, `.git-credentials`), shell and Python history files, `/var/lib/devin`, the exit marker, and everything under `/tmp`. Repositories, installed packages, and toolchains the blueprint produced are kept.
- Devin runs as root with passwordless `sudo` and Internet access. Use separate deployments for work that must not share a token or an account.
- The Worker answers only `GET /`, for health checks.

## Local development

```sh
cp .dev.vars.example .dev.vars
# Set DEVIN_API_TOKEN in .dev.vars and DEVIN_OUTPOST_ID in wrangler.jsonc.
pnpm install
pnpm run dev
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

## Development

```sh
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest unit tests
pnpm run deploy      # wrangler deploy (builds the Container image with Docker)
```
