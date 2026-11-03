"""Every published bucket-CORS `AllowedHeaders` list is the same lowercase list.

Browsers lowercase every name in `Access-Control-Request-Headers` (Fetch
spec), and Garage compares `AllowedHeaders` by plain string equality, so an
entry spelled `Content-Type` never matches the `content-type` a presigned-PUT
preflight asks for: the upload fails CORS. A lowercase name matches what
browsers send whether a store compares exactly or ignoring case.

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

from apps.api.config import settings
from apps.api.services import s3_service

REPO_ROOT = Path(__file__).resolve().parents[3]

# The complete list, lowercase: every copy must name exactly these, so a copy
# that spells one with capitals or drops one fails. Order does not matter to
# any S3 implementation, so it is not pinned.
EXPECTED_HEADERS = sorted(
    (
        "content-type",
        "content-md5",
        "x-amz-content-sha256",
        "x-amz-date",
        "x-amz-decoded-content-length",
    )
)


def _headers_written_at_startup() -> list[list[str]]:
    """`AllowedHeaders` of every rule `ensure_bucket_exists()` writes."""
    client = MagicMock()
    # Patched through MonkeyPatch.context() rather than the fixture so that all
    # three collectors share the same no-argument signature.
    with pytest.MonkeyPatch.context() as patches:
        patches.setattr(s3_service, "_build_s3_client", lambda config=None: client)
        patches.setattr(s3_service, "_is_aws_s3", lambda: False)
        # One rule is written per allowed origin, so the origins are pinned too:
        # otherwise an empty CORS_ALLOW_ORIGINS/FRONTEND_URL in the environment
        # would leave no rule at all and fail this test for the wrong reason.
        patches.setattr(settings, "frontend_url", "https://freeframe.example.com")
        patches.setattr(settings, "cors_allow_origins", "")

        s3_service.ensure_bucket_exists()

    call = client.put_bucket_cors.call_args
    assert call is not None, "no bucket CORS was written"
    rules = call.kwargs["CORSConfiguration"]["CORSRules"]
    return [rule["AllowedHeaders"] for rule in rules]


def _headers_in_deployment_docs() -> list[list[str]]:
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


def _headers_in_deploy_script() -> list[list[str]]:
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
def test_allowed_headers_are_the_lowercase_list(collect):
    header_lists = collect()
    assert header_lists, "no AllowedHeaders list found"
    for headers in header_lists:
        assert sorted(headers) == EXPECTED_HEADERS, headers
