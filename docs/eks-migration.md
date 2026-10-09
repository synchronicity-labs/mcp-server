# MCP migration to Product EKS

Status: preparation only. Porter serves production. No EKS deployment, real ALB
acceptance, soak, public cutover or Porter retirement has been completed by this PR.

Use account `428519446578`, region `us-east-1`, clusters `sync-eks-dev-blue` and
`sync-eks-prod`, namespace `sync-mcp`. Never use the Studios cluster. This is an
independent MCP deployment, not an API/worker release or database migration.

## Platform handoff

Provision through the existing infrastructure repository/review process:

| Deliverable | Exact requirement |
| --- | --- |
| Namespace | Apply `infra/k8s/bootstrap/namespace.yaml` to the Product dev cluster first, then production after readiness. Do not grant this application cluster-admin. |
| Registry | `428519446578.dkr.ecr.us-east-1.amazonaws.com/sync-product/mcp-server`, immutable tags without exclusions. Node pull access and scoped GitHub OIDC publish/read roles. |
| GitHub environments | `eks-dev` and `eks-production`, main-only branch policies and required reviewers (no self-review for production). The repository currently has neither. Do not run unprotected deployments. |
| GitHub variables | Per environment: `EKS_PUBLISH_ROLE_ARN` (dev/image workflow), `EKS_READ_ROLE_ARN` (deployment/ECR read), `EKS_TEST_HOSTNAME`, `EKS_READINESS_RECORD` (dated HTTPS readiness evidence). Trust only this repository and the matching environment OIDC subject. |
| Argo | Repository access and `default` project destination permission limited to the intended clusters/namespace. Scoped `ARGOCD_AUTH_TOKEN` in each GitHub environment for read/create/update/sync of only the corresponding `sync-mcp-dev` or `sync-mcp-production` application. Valid TLS for `argocd.sync-internal.com`; the workflow does not disable certificate validation or use admin credentials. |
| Staging hosts | Approve one host under `dev.sync-internal.com` and one under `prod.sync-internal.com`, with matching HTTPS certificates and existing external-dns/ALB controllers. Suggested names: `eks-dev-mcp.dev.sync-internal.com`, `eks-prod-mcp.prod.sync-internal.com`. These are proposals, not provisioned endpoints. |
| Runtime secrets | Materialize `sync-mcp-runtime` in each namespace using the existing approved secrets process. Reconcile required Porter configuration privately; no values in Git or release artifacts. The MCP service talks to the API and signed storage URLs; do not copy the API/worker IAM role or database credentials. |
| Capacity/network | Capacity for three pods plus one surge; separate nodes and zone spread. Initial experimental requests 250m CPU/1Gi memory, memory limit 2Gi, no CPU limit. Review these after load/soak data. Permit ALB-to-pod TCP3002, DNS and required HTTPS API/storage/provider egress. For owner routing also permit same-app TCP3002. Confirm inherited NetworkPolicies/security groups. |
| Observability | Ingest structured stdout/stderr into existing logs; provision memory/RSS, CPU, restarts/OOM, readiness, latency and HTTP-status alerts. Verify evidence and dashboard links in readiness record. |

Observed October 9: dev namespace absent; current ProductEng role cannot create
namespaces or list nodes; ECR repository absent. Production access is not established.
This is a provisioning/access blocker, not a failed replica experiment.

Run read-only discovery (explicit context protects the Studios cluster):

```sh
python3 scripts/eks/preflight.py --environment dev --kubeconfig /path/to/kubeconfig
```

Runtime secret inventory: `OAUTH_REGISTRATION_SECRET`, the existing challenge-token
override if any, `SYNC_CHATGPT_APP_DOMAIN`, `SYNC_CHATGPT_APP_CONNECT_DOMAINS`,
`SYNC_CHATGPT_APP_RESOURCE_DOMAINS`, `SYNC_APP_UPLOAD_STORAGE_ORIGIN`,
`SYNC_APP_UPLOAD_ORIGINS`, and applicable existing session/telemetry settings.
Do not supply a shared `SYNC_API_KEY` for an OAuth multi-user server. The image
selects its checked-in UI release catalog. Do not override it with a stale path.
Deployment explicitly sets `SYNC_BASE_URL`, `MCP_ISSUER_URL`, revision and routing
settings. Dev connects to `dev-api.sync.so`; production stays on `api.sync.so` and
keeps issuer `https://mcp.sync.so`. Configure dev widget/upload origins for the
actual private connector; do not broaden production CORS as part of this migration.

## Build and deploy the experiment

1. Merge reviewed migration delivery changes through normal PR gates. All EKS
   workflows are manual and main-only. Merging still invokes the existing Porter
   workflow; this PR leaves its production behavior unchanged.
2. Provision the Platform prerequisites and record actual identifiers and access
   evidence. Namespace/registry presence alone is not sufficient readiness.
3. Run **MCP EKS image**, selecting the full approved source SHA on main. It builds
   native amd64/arm64, reads all packaged UI resources in the restricted final
   container, pushes immutable architecture tags and publishes one index/receipt.
   Keep the exact source SHA and index digest. Application CI must pass separately.
4. Run **MCP EKS deployment**, environment `dev`, routing `alb`, with that source
   SHA/digest and the reviewed manifest SHA. Argo deploys the image to three pods;
   manual sync only. The workflow saves rendered manifests, previous application
   configuration and a receipt including the delivery fingerprint.
5. Verify actual pod images, three ready replicas, scheduling, TLS, dependencies,
   runtime secret bindings, logs and alert delivery. Create/connect a private
   ChatGPT plugin for `https://<dev-host>/mcp`. Test actual ChatGPT, not only curl.

ALB mode uses the current server unchanged with one-day ALB cookie stickiness.
The `lb_cookie` experiment is explicitly unproven: ChatGPT's server requests and
credentialless browser uploads may not return the required cookies. Do not infer
success from a healthy load balancer, three ready pods or a cookie-enabled probe.

### Acceptance matrix

Record image/source, delivery fingerprint, environment, private connector, client,
model, timestamps, request IDs, receiving pod and result for every case. Existing
`http_request` logs include pod, revision and request ID; no extra secret logging
is needed. Never record authorization headers, cookies, raw session IDs, upload
tickets or signed URLs. Session affinity can be examined in a controlled client
without logging its value. For ChatGPT match request timing and operation to pod
logs; if evidence cannot establish the owner, mark the test inconclusive.

- Initialize; read tools and each active/retained UI resource repeatedly. Close and
  reopen the UI, use fresh conversations and renew the token in the same session.
- Upload a controlled fixture using the actual widget. Verify exactly one asset,
  correct size/type, expired-ticket rejection and concurrent ticket replay refusal.
- Use two independently authenticated test users and verify session isolation.
- Scale 3 -> 5 -> 3, repeat both paths, then perform a rolling update. Exercise
  request cancellation and client disconnect. Observe no unexplained owner misses.
- Delete an owner pod in dev. Confirm session reinitialization and fresh upload
  tickets; recover any existing operation by ID, never automatically replay a
  paid request. Owner loss is expected to invalidate its in-memory session.
- Run a 24-hour dev soak with representative concurrency and bounded fixture
  uploads, not paid jobs. Record request volume, error causes, latency, peak RSS,
  memory headroom and restarts. Zero OOMs and no unexplained cross-replica errors.
- Inspect startup and shutdown logs. The ALB deregisters for 60s; preStop is 20s,
  MCP shutdown grace 45s, pod grace 90s. Long uploads can still be interrupted;
  verify safe recovery rather than claiming sessions survive termination.

Optional diagnostic (read-only MCP methods, bounded below the 120/min limiter):

```sh
python3 scripts/eks/probe.py --url https://<dev-host>/mcp --token-file /private/token --cookies
python3 scripts/eks/probe.py --url https://<dev-host>/mcp --token-file /private/token
```

Treat successful probes as diagnostic evidence only. Neither proves how ChatGPT
handles cookies, browser upload ownership or refresh. No generation tools run.
Token files must be outside the repository and readable only by their owner.

**Routing decision:** retain ALB mode only if all actual-client cases pass. On an
owner-routing failure, record the evidence, finish review/merge of PR #81, build
that source, then deploy `routing=owner` and repeat the entire matrix/soak. The
workflow refuses owner mode unless the selected source contains its implementation.
Owner mode creates a private headless service and injects `MCP_REPLICA_IP` from
`status.podIP`; ALB stickiness is disabled to prove routing independently. Both
modes share the same namespace, ingress and public service. IPv4 is required.
The optional owner manifests alone do not make a pre-router image compatible.

## Production staging and acceptance record

Only after successful dev validation, commit `deploy/eks-dev-acceptance.json`
through review. Do not copy synthetic fixtures from the automated tests. Shape:

```json
{
  "source_sha": "FULL_TESTED_SOURCE_SHA",
  "image_digest": "sha256:TESTED_INDEX_DIGEST",
  "delivery_sha256": "FINGERPRINT_FROM_DEV_RECEIPT",
  "routing": "alb",
  "checks": {
    "chatgpt": "passed", "refresh": "passed", "uploads": "passed",
    "isolation": "passed", "scale": "passed", "rollout": "passed",
    "pod_loss": "passed", "no_paid_replay": "passed",
    "resources": "passed", "memory": "passed"
  },
  "soak_started_at": "UTC_ISO_TIMESTAMP",
  "soak_finished_at": "UTC_ISO_TIMESTAMP",
  "reviewed_by": "ACTUAL_REVIEWER",
  "evidence_url": "https://LINK_TO_RECORDED_RESULTS"
}
```

The protected production workflow requires this reviewed record, the same image
and routing mode, unchanged delivery configuration and >=24 completed soak hours.
It checks consistency, not the truth of human acceptance evidence. A changed
image or delivery configuration requires refreshed dev acceptance. The record
itself can be committed without changing the delivery fingerprint.

Run production staging using the accepted digest and manifest revision containing
that record. The public issuer remains `mcp.sync.so`; test the staged target using
an approved hostname/Host-routing test path without rewriting production OAuth
identity. Verify the certificate used for public origin TLS supports `mcp.sync.so`
and Cloudflare's configured TLS mode before cutover. Do not disable TLS checks.
The ingress includes the public host rule, but external-dns owns only the staging
hostname. No workflow edits Cloudflare or switches normal production traffic.

## Cutover, rollback and retirement

A separate release decision is required after staging and Noah's walkthrough.
Platform freezes MCP releases, captures current DNS/Cloudflare record/proxy/TLS/TTL,
Porter image/config/replica count, EKS receipt and dashboards, and identifies the
on-call owner. Retain the current single-replica Porter image and credentials.
Pause automatic Porter deployments through the normal release controls so future
main merges cannot replace the rollback target during the observation window.

Platform switches only the existing `mcp.sync.so` origin to the verified ALB.
Avoid weighted splitting between Porter and EKS: they do not share session state.
Immediately verify the published plugin, auth/refresh, UI, uploads and read-only
tools; monitor 404/403/429/502/503 separately, alongside latency, memory and restarts.
Authentication probes returning 401 are not automatically outages. No schema or
listing change is included; a publisher rescan is needed only if definitions
actually differ, not as a substitute for runtime validation.

Rollback immediately on failed critical user flows or unexplained recurring
session/authentication errors: restore the recorded Porter origin at one replica.
Allow DNS/connection drain; reopen clients and renew tickets as necessary. Existing
sessions need not survive either direction. Never replay an uncertain paid call.

After 48 hours healthy on EKS, Platform may retire Porter and remove its workflow
in a separate reviewed change. Record final origin, image, replica readiness and
published ChatGPT acceptance. Do not retire Porter during this preparation PR.
