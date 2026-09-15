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

## Local dev

```
OPS_TOKEN=dev OPS_COMPOSE_FILE=/path/to/docker-compose.vm.yml OPS_REPOS_DIR=/path/to/isconl-docker node src/server.js
```

## Deploy

Same mechanism as every other engine: push to `staging`, `.github/
workflows/deploy-staging.yml` rebuilds and restarts just the `ops`
container on the OCI VM.
