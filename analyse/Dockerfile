# Analyse service: finds and decodes yellow printer tracking dots with DEDA (GPL-3.0-or-later).
# `docker build .` runs the test suite (stage "test"); the runtime image is only produced if it passes.

FROM alpine:3.22 AS base
# Alpine's packaged numpy/scipy/OpenCV (headless) instead of pip wheels: one OpenCV, no compiler needed.
RUN apk add --no-cache python3 py3-pip py3-numpy py3-scipy py3-opencv py3-pillow py3-reportlab
# --no-deps: deda declares opencv-python (the non-headless build) and eel, neither of which is wanted.
# libdeda imports PyPDF2 and reportlab; reportlab comes from apk above.
# --target keeps pip away from the system site-packages: it lists them after installing, and some Alpine package
# metadata (OpenCV's) makes it fail with "Invalid version: 'python-4.11.0'".
RUN pip install --no-cache-dir --no-deps --target /opt/deda deda==2.0b4 PyPDF2==3.0.1
ENV PYTHONPATH=/opt/deda
WORKDIR /app

FROM base AS test
RUN apk add --no-cache py3-pytest
COPY pyproject.toml ./
COPY deda_svc ./deda_svc
COPY tests ./tests
RUN python3 -m pytest -q && touch /tmp/tests-passed

FROM base AS runtime
LABEL org.opencontainers.image.licenses="GPL-3.0-or-later"
ENV PORT=8770 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
COPY deda_svc ./deda_svc
# Make the runtime image depend on the test stage, so a failing suite fails the build.
COPY --from=test /tmp/tests-passed /tmp/tests-passed
RUN adduser -D -H -u 10001 analyse
USER analyse
EXPOSE 8770
# 127.0.0.1, not localhost: busybox wget tries ::1 first and the service listens on IPv4 only.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["python3", "-m", "deda_svc"]
