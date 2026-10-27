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

# The API reference page's script is a dev dependency (it pulls in Vue and more); only its one bundle goes in the image.
FROM deps AS vendor
RUN mkdir /vendor && cp node_modules/@scalar/api-reference/dist/browser/standalone.js /vendor/scalar.js

FROM deps AS test
COPY . .
RUN bun test && touch /tmp/tests-passed

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY bunfig.toml tsconfig.json ./
COPY assets ./assets
COPY src ./src
COPY --from=vendor /vendor ./vendor
# Make the runtime image depend on the test stage, so a failing suite fails the build.
COPY --from=test /tmp/tests-passed /tmp/tests-passed
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/server/index.ts"]
