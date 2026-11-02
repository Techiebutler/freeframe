"""Every published bucket-CORS `AllowedHeaders` list is lowercase.

Browsers lowercase every name in `Access-Control-Request-Headers` (Fetch
spec), and Garage compares `AllowedHeaders` by plain string equality, so an
entry spelled `Content-Type` never matches the `content-type` a presigned-PUT
preflight asks for: the upload fails CORS. AWS S3 and MinIO match
case-insensitively, so lowercase names behave identically there.

The list is published in three places that must not drift apart: the rule the
app writes at startup, the JSON people paste into their own bucket in
`docs/deployment.md`, and the printout `deploy/freeframe` shows for an own AWS
bucket.
"""
import json
import re
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from apps.api.services import s3_service

REPO_ROOT = Path(__file__).resolve().parents[3]

# The two names that are not already lowercase in the wire protocol's own
# spelling, i.e. the ones a mixed-case list gets wrong.
CASE_SENSITIVE_NAMES = ("content-type", "content-md5")


def _headers_written_at_startup(monkeypatch) -> list[list[str]]:
    """`AllowedHeaders` of every rule `ensure_bucket_exists()` writes."""
    client = MagicMock()
    monkeypatch.setattr(s3_service, "_build_s3_client", lambda config=None: client)
    monkeypatch.setattr(s3_service, "_is_aws_s3", lambda: False)

    s3_service.ensure_bucket_exists()

    call = client.put_bucket_cors.call_args
    assert call is not None, "no bucket CORS was written"
    rules = call.kwargs["CORSConfiguration"]["CORSRules"]
    return [rule["AllowedHeaders"] for rule in rules]


def _headers_in_deployment_docs(monkeypatch) -> list[list[str]]:
    """`AllowedHeaders` of the CORS JSON block in docs/deployment.md."""
    text = (REPO_ROOT / "docs" / "deployment.md").read_text()
    blocks = [
        block
        for block in re.findall(r"```json\n(.*?)```", text, re.DOTALL)
        if "CORSRules" in block
    ]
    return [
        rule["AllowedHeaders"]
        for block in blocks
        for rule in json.loads(block)["CORSRules"]
    ]


def _headers_in_deploy_script(monkeypatch) -> list[list[str]]:
    """`AllowedHeaders` of the CORS rules deploy/freeframe prints."""
    text = (REPO_ROOT / "deploy" / "freeframe").read_text()
    # The script prints the JSON through `say`, so every quote is backslashed.
    return [
        re.findall(r'\\"([^"\\]+)\\"', entries)
        for entries in re.findall(r'\\"AllowedHeaders\\":\s*\[([^]]*)\]', text)
    ]


@pytest.mark.parametrize(
    "collect",
    [
        _headers_written_at_startup,
        _headers_in_deployment_docs,
        _headers_in_deploy_script,
    ],
    ids=["startup_rule", "deployment_docs", "deploy_script"],
)
def test_allowed_headers_are_lowercase(collect, monkeypatch):
    header_lists = collect(monkeypatch)
    assert header_lists, "no AllowedHeaders list found"
    for headers in header_lists:
        assert headers == [name.lower() for name in headers], headers
        for name in CASE_SENSITIVE_NAMES:
            assert name in headers, (name, headers)
