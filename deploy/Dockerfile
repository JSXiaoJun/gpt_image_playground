# ---- Build stage ----
FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

ENV VITE_DEFAULT_API_URL=__VITE_DEFAULT_API_URL_PLACEHOLDER__
ENV VITE_API_PROXY_AVAILABLE=__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__
ENV VITE_API_PROXY_LOCKED=__VITE_API_PROXY_LOCKED_PLACEHOLDER__
ENV VITE_DOCKER_DEPLOYMENT=__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__
ENV VITE_DOCKER_LEGACY_API_URL_USED=__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__
ENV VITE_SHOW_DEFAULT_CONFIG_ONLY=__VITE_SHOW_DEFAULT_CONFIG_ONLY_PLACEHOLDER__

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ----
FROM nginx:alpine

RUN apk add --no-cache nodejs

ENV HOST=0.0.0.0
ENV PORT=80
ENV DEFAULT_API_URL=
ENV API_PROXY_URL=
ENV ENABLE_API_PROXY=false
ENV LOCK_API_PROXY=false
ENV SHOW_DEFAULT_CONFIG_ONLY=false

COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template
COPY deploy/job-server.mjs /app/job-server.mjs
COPY --chmod=755 deploy/migrate-api-env.envsh /docker-entrypoint.d/05-migrate-api-env.envsh
COPY --chmod=755 deploy/inject-api-url.sh /docker-entrypoint.d/40-inject-api-url.sh
COPY --chmod=755 deploy/start-job-server.sh /docker-entrypoint.d/45-start-job-server.sh

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
