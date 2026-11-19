"""
Smoke tests: verify the app starts, /health works, and OpenAPI schema is populated.
These tests do not require a real database or S3.
"""


def test_app_starts(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_openapi_docs(client):
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    data = resp.json()
    assert "paths" in data
    # The API has many endpoints across auth, orgs, teams, projects, assets, etc.
    assert len(data["paths"]) > 20


def test_openapi_title(client):
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    data = resp.json()
    assert data["info"]["title"] == "FreeFrame API"


def test_openapi_contact(client):
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    data = resp.json()
    assert "contact" in data["info"]
    assert data["info"]["contact"]["name"] == "FreeFrame"


def test_openapi_license(client):
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    data = resp.json()
    assert "license" in data["info"]
    assert data["info"]["license"]["name"] == "MIT"


def test_docs_ui(client):
    """Swagger UI should be available."""
    resp = client.get("/docs")
    assert resp.status_code == 200


def test_redoc_ui(client):
    """ReDoc UI should be available."""
    resp = client.get("/redoc")
    assert resp.status_code == 200


def test_health_is_async_no_threadpool():
    import inspect
    from apps.api.main import health
    assert inspect.iscoroutinefunction(health)
