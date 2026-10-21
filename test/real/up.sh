#!/bin/sh
# Starts the disposable real stack for bipe#231 and writes test/real/.stack/env for `pnpm test:real`.
# Every secret is new on each run and stays in test/real/.stack/ (gitignored). Synthetic accounts only.
# Usage: test/real/up.sh        start a new stack (an old one is removed first)
#        test/real/up.sh down   remove the stack and its data
set -eu
cd "$(dirname "$0")"
compose() { docker compose -f compose.yml --env-file .stack/compose.env "$@"; }

if [ -f .stack/compose.env ]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
rm -rf .stack
[ "${1:-}" = down ] && exit 0

mkdir -p .stack/synapse .stack/mas
umask 077
rand() { openssl rand -hex 32; }
POSTGRES_PASSWORD=$(rand)
MAS_SYNAPSE_SECRET=$(rand)
MAS_API_CLIENT_SECRET=$(rand)
BIPE_TEST_PASSWORD=$(rand)
# ULID shape: 26 Crockford base32 characters; uppercase hex is a valid subset.
MAS_API_CLIENT_ID="01$(openssl rand -hex 12 | tr 'a-f' 'A-F')"
printf 'REAL_POSTGRES_PASSWORD=%s\nREAL_BIPE_TEST_PASSWORD=%s\n' "$POSTGRES_PASSWORD" "$BIPE_TEST_PASSWORD" > .stack/compose.env

render() {
  sed -e "s#__POSTGRES_PASSWORD__#${POSTGRES_PASSWORD}#g" \
      -e "s#__MAS_SYNAPSE_SECRET__#${MAS_SYNAPSE_SECRET}#g" \
      -e "s#__MAS_API_CLIENT_ID__#${MAS_API_CLIENT_ID}#g" \
      -e "s#__MAS_API_CLIENT_SECRET__#${MAS_API_CLIENT_SECRET}#g" "$1" > "$2"
}
render synapse.yaml .stack/synapse-bipe.yaml
render mas.yaml .stack/mas/bipe.yaml
umask 022
# The containers run as other users (Synapse 991, MAS 65532): they must read these files.
chmod 755 .stack .stack/synapse .stack/mas
chmod 644 .stack/synapse-bipe.yaml .stack/mas/bipe.yaml

echo "real stack: pulling images"
compose pull -q
echo "real stack: generating Synapse and MAS base configs"
compose run --rm --no-deps --entrypoint /start.py \
  -e SYNAPSE_SERVER_NAME=bipe.test -e SYNAPSE_REPORT_STATS=no synapse generate >/dev/null
compose run --rm --no-deps -T mas config generate > .stack/mas/generated.yaml 2>/dev/null
chmod 644 .stack/mas/generated.yaml

compose up -d postgres
compose run --rm -T mas database migrate --config /data/generated.yaml --config /data/bipe.yaml >/dev/null
compose run --rm -T mas config sync --config /data/generated.yaml --config /data/bipe.yaml >/dev/null
compose up -d synapse mas

wait_for() {
  i=0
  until curl -fsS -o /dev/null "$2"; do
    i=$((i + 1))
    if [ "$i" -ge 90 ]; then echo "real stack: $1 did not start"; compose logs --no-color --tail 50 "$1"; exit 1; fi
    sleep 2
  done
}
wait_for synapse http://127.0.0.1:58008/health
wait_for mas http://127.0.0.1:58080/.well-known/openid-configuration

umask 077
cat > .stack/env <<ENV
BIPE_TEST_DATABASE_URL=postgres://bipe_test:${BIPE_TEST_PASSWORD}@127.0.0.1:55432/bipe_test
BIPE_REAL_SERVER_NAME=bipe.test
BIPE_REAL_MAS_URL=http://127.0.0.1:58080
BIPE_REAL_MAS_ADMIN_URL=http://127.0.0.1:58082
BIPE_REAL_SYNAPSE_URL=http://127.0.0.1:58008
BIPE_REAL_MAS_CLIENT_ID=${MAS_API_CLIENT_ID}
BIPE_REAL_MAS_CLIENT_SECRET=${MAS_API_CLIENT_SECRET}
BIPE_REAL_COMPOSE=$(pwd)/compose.yml
BIPE_REAL_COMPOSE_ENV=$(pwd)/.stack/compose.env
ENV
echo "real stack: up. Run: pnpm test:real"
