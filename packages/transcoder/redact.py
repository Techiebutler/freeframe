"""Keep presigned S3 URLs out of error text.

The transcoder hands ffmpeg and ffprobe a presigned GET for the raw upload, and
both print it back: `<url>: Server returned 403 Forbidden`, `Error opening
input file <url>.`, `Input #0, ... from '<url>':`, and at trace level a
`request: GET /<path>?<query> HTTP/1.1` line with no host at all. A timeout
quotes it as well, inside the argv `subprocess.TimeoutExpired` prints. That
text ends up in exceptions, the `transcode_failed` event every project member
receives, Celery's result backend and the worker log.

What makes such a URL usable is its query string: the signature, plus the
access key id in X-Amz-Credential. So that is what goes. The scheme, host and
path stay, because the object key is what an operator needs to find the file.
One pattern covers every form above, including the host-less one, which a
plain `.replace(url, ...)` would miss.
"""
import re
import subprocess

# A `?` and the rest of its token. The token ends at whitespace or a quote, so a
# `.` inside a query value doesn't cut it short: stopping at the first `.` would
# leave whatever follows it, the signature included. The token is matched first
# and checked for a SigV4 or SigV2 signing parameter in a callback. Testing for
# the parameter in a lookahead instead rescans the token at every `?`, which
# makes the scrub quadratic in a long `?`-laden metadata line that ffmpeg echoes.
_QUERY = re.compile(r"\?[^\s'\"<>]*")
_SIGNING_PARAM = re.compile(
    r"(?:X-Amz-(?:Signature|Credential|Security-Token)|Signature|AWSAccessKeyId)=",
    re.IGNORECASE,
)
# Handed back after the redaction, so `<url>.` and `<url>:` keep their `.` and `:`.
_TRAILING_PUNCTUATION = re.compile(r"[.,:;)\]]*$")


def _redact_query(match: re.Match) -> str:
    query = match.group(0)
    if not _SIGNING_PARAM.search(query):
        return query
    return "?<redacted>" + _TRAILING_PUNCTUATION.search(query).group(0)


def redact_presigned_urls(text: str) -> str:
    """`text` with the signed query string of every presigned URL replaced."""
    if not text:
        return text
    return _QUERY.sub(_redact_query, text)


def redacted_timeout(exc: subprocess.TimeoutExpired) -> subprocess.TimeoutExpired:
    """The same timeout, with the argv it quotes scrubbed.

    The partial output it may hold is dropped rather than scrubbed: nothing
    reads it, and stderr is exactly where ffmpeg prints the URL.
    """
    cmd = exc.cmd
    if isinstance(cmd, (list, tuple)):
        cmd = [redact_presigned_urls(str(arg)) for arg in cmd]
    else:
        cmd = redact_presigned_urls(str(cmd))
    return subprocess.TimeoutExpired(cmd, exc.timeout)
