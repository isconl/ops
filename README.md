# ops

The 8th isconl-agent fleet engine: a live control surface for every fleet
service and the OCI VM. Scoped and built per `BI26090502` (`build.md`).

Token-gated (`OPS_TOKEN`), same pattern as every other engine. Every
state-changing call (`restart`/`start`/`stop`/`destroy`) writes a before/
after entry to its own hash-chained audit log before executing.

## Endpoints

- `GET /status` -- up/down + health state for every managed service
- `GET /vm/stats` -- VM CPU load, memory, disk
- `GET /logs/:name?lines=N` -- tail a service's container logs
- `POST /service/:name/restart` / `/start` / `/stop`
- `POST /service/:name/destroy` -- body must be `{"confirm":"<name>"}`
- `GET /deploy/status` -- per-service running commit + last-deployed time

`:name` must be a service `docker compose config` reports for the live
compose file (see `OPS_COMPOSE_FILE` below) -- discovered live, not a
fixed list (BI26091501). Each service optionally declares its own group
via an `ops.group` compose label, e.g.:

```yaml
services:
  vault:
    labels:
      - "ops.group=iSconl"
```

A service with no `ops.group` label still appears (grouped as
"ungrouped" in `GET /status`'s response), never silently. ops does not
manage itself.

**Observable by default, controllable by opt-in.** Appearing in
`GET /status` never implies `restart`/`start`/`stop`/`destroy` is
allowed -- a service must separately declare `ops.control: "true"` to
accept those. Anything else (no label, a different value, a real
boolean instead of the string `"true"`) fails closed to read-only:

```yaml
services:
  vault:
    labels:
      - "ops.group=iSconl"
      - "ops.control=true"
```

`iSconl` is the one group that opts in; anything newer (qpress/qpages/
aquifer/aria) stays observe-only until someone deliberately turns it on
for that group's services. `GET /status` reports each service's
`controllable` flag alongside its group.

## Multi-machine (BI26091506)

Every endpoint above is scoped to whichever single machine ops itself
runs on -- unchanged, for backward compatibility with the existing web
console. The multi-machine surface is additive:

- `GET /machines` -- every known machine: declared config
  (`config/machines.tsv`, or `OPS_MACHINES_FILE`) merged with a live OCI
  Compute API poll, so an instance nobody declared still shows up rather
  than being invisible. A machine's `controllable` flag is `true` only
  when it's declared **and** carries both a `COMPOSE_FILE` and
  `REPOS_DIR` -- an undeclared or connection-info-less machine is visible
  but never controllable, the multi-machine version of the same
  fail-closed property `ops.control` already enforces per-service.
- `GET /machines/:id/status`, `GET /machines/:id/logs/:name`,
  `POST /machines/:id/service/:name/(restart|start|stop|destroy)`,
  `GET /machines/:id/deploy/status` -- the same five endpoints above, but
  targeting a named machine instead of ops's own host. A machine with no
  declared connection info returns a clear "no connection info" error
  rather than silently defaulting to ops's own machine.

`config/machines.tsv` columns: `ID`, `NAME`, `PROVIDER`, `OCI_INSTANCE_ID`
(optional -- links a declared row to a live OCI instance for merging),
`COMPOSE_FILE`, `REPOS_DIR` (both support a leading `~/` for the running
user's home directory). OCI credentials
(`OCI_TENANCY_OCID`/`OCI_USER_OCID`/`OCI_FINGERPRINT`/`OCI_REGION`/
`OCI_PRIVATE_KEY`) are read key-only via `secretStore`, same as every
other secret this engine touches -- if any is missing, `/machines`
reports `discoveryOk: false` and falls back to declared-machines-only
rather than throwing.

**No UI renders any of this yet.** The multi-machine dashboard is
`PI26091504`'s job (`plan.md`), sequenced after this row specifically so
the design isn't done against a data model that doesn't exist yet.

## Local dev

```
OPS_TOKEN=dev OPS_COMPOSE_FILE=/path/to/docker-compose.vm.yml OPS_REPOS_DIR=/path/to/isconl-docker node src/server.js
```

## Deploy

Same mechanism as every other engine: push to `staging`, `.github/
workflows/deploy-staging.yml` rebuilds and restarts just the `ops`
container on the OCI VM.
