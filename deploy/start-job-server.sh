#!/bin/sh

if [ "$ENABLE_API_PROXY" = "true" ]; then
  node /app/job-server.mjs &
fi
