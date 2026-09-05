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

`:name` must be one of `vault`, `pulse`, `scope`, `circle`, `spark`,
`media`, `hub` -- see `lib/ops-vm.js`'s `MANAGED_SERVICES`. ops does not
manage itself.

## Local dev

```
OPS_TOKEN=dev OPS_COMPOSE_FILE=/path/to/docker-compose.vm.yml OPS_REPOS_DIR=/path/to/isconl-docker node src/server.js
```

## Deploy

Same mechanism as every other engine: push to `staging`, `.github/
workflows/deploy-staging.yml` rebuilds and restarts just the `ops`
container on the OCI VM.
