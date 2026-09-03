#!/usr/bin/env bash
# Local PostgreSQL 16 for development and tests (no docker needed).
#   scripts/pg.sh start   - init (first time) and start on port 5433
#   scripts/pg.sh stop
#   scripts/pg.sh reset   - stop, wipe the data dir, start fresh
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PGDATA="${PGDATA:-$ROOT/.pgdata}"
PGPORT="${PGPORT:-5433}"
PGLOG="$PGDATA/postgres.log"

# initdb refuses to run as root; fall back to the postgres user when needed.
run_as_pg() {
  if [ "$(id -u)" = "0" ]; then
    su postgres -s /bin/bash -c "$*"
  else
    bash -c "$*"
  fi
}

init() {
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    mkdir -p "$PGDATA"
    if [ "$(id -u)" = "0" ]; then chown postgres "$PGDATA"; fi
    run_as_pg "$PGBIN/initdb -D '$PGDATA' -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null"
  fi
}

start() {
  init
  if run_as_pg "$PGBIN/pg_ctl -D '$PGDATA' status >/dev/null 2>&1"; then
    echo "postgres already running on port $PGPORT"
  else
    run_as_pg "$PGBIN/pg_ctl -D '$PGDATA' -l '$PGLOG' -o '-p $PGPORT -k /tmp -c listen_addresses=localhost' -w start >/dev/null"
    echo "postgres started on port $PGPORT (data: $PGDATA)"
  fi
  for db in tsaimind tsaimind_test; do
    if ! "$PGBIN/psql" -h localhost -p "$PGPORT" -U postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1; then
      "$PGBIN/createdb" -h localhost -p "$PGPORT" -U postgres "$db"
      echo "created database $db"
    fi
  done
}

stop() {
  if run_as_pg "$PGBIN/pg_ctl -D '$PGDATA' status >/dev/null 2>&1"; then
    run_as_pg "$PGBIN/pg_ctl -D '$PGDATA' -m fast -w stop >/dev/null"
    echo "postgres stopped"
  else
    echo "postgres not running"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  reset) stop; rm -rf "$PGDATA"; start ;;
  *) echo "usage: $0 start|stop|reset" >&2; exit 1 ;;
esac
