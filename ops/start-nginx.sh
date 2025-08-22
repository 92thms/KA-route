#!/bin/sh
set -eu

: "${ORS_API_KEY:?ORS_API_KEY not set}"
: "${SEARCH_RADIUS_KM:=10}"
: "${STEP_KM:=50}"

# shellcheck disable=SC2016
envsubst '${ORS_API_KEY} ${SEARCH_RADIUS_KM} ${STEP_KM}' \
    < /usr/share/nginx/html/config.js.template \
    > /usr/share/nginx/html/config.js

exec /usr/sbin/nginx -g 'daemon off;'
