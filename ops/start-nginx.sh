#!/bin/sh
set -eu

: "${SEARCH_RADIUS_KM:=10}"
: "${STEP_KM:=50}"
: "${MAINTENANCE_MODE:=0}"
: "${MAINTENANCE_KEY:=}"
: "${USE_ORS_REVERSE:=0}"

# shellcheck disable=SC2016
envsubst '${SEARCH_RADIUS_KM} ${STEP_KM} ${MAINTENANCE_MODE} ${MAINTENANCE_KEY} ${USE_ORS_REVERSE}' \
    < /usr/share/nginx/html/config.js.template \
    > /usr/share/nginx/html/config.js

exec /usr/sbin/nginx -g 'daemon off;'
