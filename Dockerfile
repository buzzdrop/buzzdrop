# Buzzdrop image (#386). Stages:
#   runtime  what is published and deployed: gunicorn, non-root, allowlisted files
#   test     runtime plus the test deps and tests/, for CI's pytest and fixtures
# A plain `docker build .` builds runtime (the last stage below).
FROM python:3.15-alpine3.24 AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FLASK_ENV=production \
    PORT=5000 \
    DATABASE_URL=sqlite:///data/buzzdrop.db \
    HOME=/home/app

WORKDIR /app

# The base image already carries the system zone data, so TZ works.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# An explicit allowlist: anything not named here (tests, docs, the CLI,
# dev configs, untracked files) stays out of the published image.
COPY app.py auth.py config.py i18n.py migrate_db.py models.py storage.py \
     proxy.py timestamps.py tokens.py utils.py website.py gunicorn.conf.py ./
COPY db/ db/
COPY templates/ templates/
COPY static/ static/
COPY translations/ translations/
COPY LICENSE ./

# Non-root, with the state directories owned by it. Volumes mounted on
# these paths (compose's named volumes) inherit the ownership. HOME is
# writable for gunicorn's control socket.
RUN adduser -D -u 10001 -h /home/app app \
    && mkdir -p data uploads \
    && chown app:app data uploads
USER app

# The version this image is: X.Y.Z for a published version, main+<sha>
# for a main build (set by the publish workflow), dev for a local build.
ARG BUZZDROP_VERSION=dev
ENV BUZZDROP_VERSION=$BUZZDROP_VERSION

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:$PORT/healthz" || exit 1

# Exec form, so gunicorn is PID 1 and handles SIGTERM itself.
CMD ["gunicorn", "--config", "gunicorn.conf.py", "app:app"]


# CI runs pytest, the DOM fixtures and the protocol contract here. Root,
# because CI mounts the workspace (owned by the runner's uid) and writes
# the fixtures into it.
FROM runtime AS test
USER root
# Not the runtime's production config. Empty reads as unset, which is how
# pytest has always run; the fixture scripts pick testing themselves.
ENV FLASK_ENV=
COPY requirements-dev.txt .
RUN pip install --no-cache-dir -r requirements-dev.txt
COPY tests/ tests/
COPY cli/ cli/
COPY docs/how-it-works.md docs/
COPY .env.example babel.cfg ./


# Keeps runtime the default target.
FROM runtime
