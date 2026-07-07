from pydantic import BaseModel


class PurgeStartResponse(BaseModel):
    """Response for the async manual purge trigger."""
    status: str
    detail: str
