# Scan webapp: Bun + React UI, page pipeline (ImageMagick, Tesseract), destinations (smbclient).
# `docker build .` runs the test suite (stage "test"); the runtime image is only produced if it passes.

# Only colord's sRGB profile is needed; the colord package itself pulls in glib, polkit and more.
FROM alpine:3.24 AS srgb
RUN apk add --no-cache colord

FROM oven/bun:1.4-alpine AS base
# ImageMagick 7 (`magick`) with the PNG/JPEG/TIFF coders; Tesseract only for orientation (osd); smbclient for SMB.
RUN apk add --no-cache \
      imagemagick imagemagick-jpeg imagemagick-tiff tesseract-ocr tesseract-ocr-data-osd samba-client tzdata \
      ca-certificates
COPY --from=srgb /usr/share/color/icc/colord/sRGB.icc /usr/share/color/icc/colord/sRGB.icc
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# sharp, a native addon with its own libvips, is the one package the bundle can't contain: the locked copy, its
# dependencies and only the musl build of its binaries.
RUN mkdir -p /sharp/@img \
 && cp -r node_modules/sharp node_modules/detect-libc node_modules/semver /sharp/ \
 && cp -r node_modules/@img/colour node_modules/@img/sharp-linuxmusl-* node_modules/@img/sharp-libvips-linuxmusl-* /sharp/@img/

FROM deps AS test
COPY . .
RUN bun test

# The server and its UI bundled into dist/ (build.ts), after the tests: the image needs no source or node_modules ...
FROM test AS build
RUN bun build.ts

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
# ... except sharp (see the deps stage).
COPY --from=deps /sharp ./node_modules
COPY --from=build /app/dist ./dist
COPY assets ./assets
# Smoke test against exactly this node_modules (the tests ran against the full one): the bundle must start and serve.
RUN set -e; \
    (SERVICE_URL=http://127.0.0.1:9 PRINTER_URI=off DATA_DIR=/tmp/smoke bun dist/start.js &); \
    up=; for i in $(seq 1 50); do if wget -qO /dev/null http://localhost:8080/api/status; then up=1; break; fi; sleep 0.2; done; \
    test -n "$up"; \
    wget -qO /dev/null http://localhost:8080/; \
    wget -qO /dev/null http://localhost:8080/api/docs/scalar.js; \
    pkill -f dist/start.js; rm -rf /tmp/smoke; \
    mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO /dev/null "http://localhost:${PORT:-8080}/api/status" || exit 1
CMD ["bun", "/app/dist/start.js"]
