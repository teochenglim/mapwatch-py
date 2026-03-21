#!/bin/sh
# Substitute BASE_URL and ROOT_PATH into nginx config at container start.
# Defaults match docker-compose local dev.
: "${BASE_URL:=*}"
: "${ROOT_PATH:=/department/tilemap-server}"
export BASE_URL ROOT_PATH

envsubst '${BASE_URL} ${ROOT_PATH}' \
    < /etc/nginx/nginx.conf.template \
    > /etc/nginx/nginx.conf

exec nginx -g 'daemon off;'
