from pydantic import BaseModel


class PurgeResult(BaseModel):
    """Counts reclaimed by a manual/scheduled purge run."""
    retention_days: int
    projects: int
    folders: int
    assets: int
    versions: int
    media_files: int
    comments: int
    share_links: int
    share_links_expired: int
    s3_deletes: int
