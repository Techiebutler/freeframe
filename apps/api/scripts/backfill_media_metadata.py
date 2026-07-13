"""Enqueue the one-off media-metadata backfill (#124).

Usage (inside the api container):
    docker exec freeframe-api-1 python -m apps.api.scripts.backfill_media_metadata
Then watch the worker: docker logs -f freeframe-worker-1
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from apps.api.tasks.transcode_tasks import backfill_media_metadata

if __name__ == "__main__":
    res = backfill_media_metadata.delay()
    print(f"Backfill enqueued on the 'transcoding' queue (task id {res.id}).")
