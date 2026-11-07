"""
gunicorn settings for the Buzzdrop image (ADR-0003).

One worker process with threads: the in-memory rate limits and the expiry
sweep thread live per process, so more workers would multiply the limits
and run a sweep each. ``workers`` is set here, which outranks a host's
WEB_CONCURRENCY; an operator who really wants more passes
``GUNICORN_CMD_ARGS=--workers N`` and accepts the multiplied limits.
"""
import os

bind = f"0.0.0.0:{os.environ.get('PORT', '5000')}"
workers = 1
worker_class = 'gthread'
threads = 8
# Heartbeat files on tmpfs: a container's disk can stall the heartbeat.
worker_tmp_dir = '/dev/shm'
# No preload: forking after import would leave the sweep thread in the
# master and hand the worker its SQLite connection.
preload_app = False
accesslog = '-'
