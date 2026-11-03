"""PostgreSQL owns immutable submission provenance; KV never grants natural traffic."""
import hashlib
import json
import secrets
import uuid
from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy import select, func
from ..config import settings
from ..models.asset import Asset, AssetVersion, ProcessingStatus
from ..models.user import User
from ..models.upload_request import RequestUpload, UploadRequest

PROVENANCE_SCHEMA = 'autoreview.submission-provenance.v1'
INTENT_SCHEMA = 'autoreview.natural-intent.v2'


def _identity(req, record, version):
    return dict(schema_version=PROVENANCE_SCHEMA, tenant_id=str(req.project_id), upload_request_id=str(req.id),
        share_token=req.review_share_token, asset_id=str(record.asset_id), version_id=str(version.id),
        version_number=version.version_number, submitted_at=record.submitted_at.isoformat())


def attest_request_timing(db, request_id, project_id, share_token, *, apply=False):
    """Caller uses existing write-capable bridge auth; U lock also guards submission."""
    from ..models.folder import Folder
    from ..models.project import Project
    from ..services.permissions import validate_share_link
    query = db.query(UploadRequest).filter(UploadRequest.id == request_id,
        UploadRequest.project_id == project_id, UploadRequest.review_share_token == share_token,
        UploadRequest.revoked_at.is_(None))
    req = (query.populate_existing().with_for_update() if apply else query).first()
    if not req:
        raise HTTPException(404, 'Timing request not found')
    now = db.scalar(select(func.clock_timestamp()))
    if req.completed_at or (req.expires_at and req.expires_at <= now):
        raise HTTPException(410, 'Timing request closed')
    if req.receive_iterations and req.iteration_mode != 'complete':
        raise HTTPException(409, 'Only complete-ad timing is supported')
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    folder = db.query(Folder).filter(Folder.id == req.folder_id, Folder.project_id == project_id, Folder.deleted_at.is_(None)).first()
    if not project or not folder:
        raise HTTPException(404, 'Timing request not found')
    share = validate_share_link(db, share_token)
    if share.folder_id != req.folder_id or share.visibility != 'public' or share.password_hash:
        raise HTTPException(404, 'Timing request not found')
    identity = dict(schema_version=INTENT_SCHEMA, tenant_id=str(project_id), upload_request_id=str(request_id), share_token=share_token)
    existing = req.timing_natural_intent
    if existing is not None and (not isinstance(existing, dict) or any(existing.get(k) != v for k, v in identity.items()) or not existing.get('attested_at')):
        raise HTTPException(409, 'Conflicting timing intent')
    if apply and existing is None:
        req.timing_natural_intent = {**identity, 'attested_at': now.isoformat(), 'customer_order_verified': True}
    return dict(mode='apply' if apply else 'dry-run', already_present=existing is not None,
        attested_at=(req.timing_natural_intent or {}).get('attested_at'), **identity)


def reopen_request(req):
    """A new file landed on a finished request: the normal review and finish flow runs again. Files already
    finished keep their result, it hangs on their version. `first_completed_at` survives, so a later finish
    is not reported as a second one. Called under U lock."""
    if req.completed_at is None:
        return
    req.first_completed_at = req.first_completed_at or req.completed_at
    req.completed_at = None
    req.completion_versions = None


def adopt_signed_in_upload(db, req, asset_id, version):
    """A version a signed-in user uploaded into this request's folder, on the guest route's terms: the
    RequestUpload row `_review_assets` reads as proof of the transfer. Called under U lock. Idempotent."""
    record = db.query(RequestUpload).filter(RequestUpload.request_id == req.id,
        RequestUpload.asset_id == asset_id, RequestUpload.version_number == version.version_number).first()
    if not record:
        author = db.get(User, version.created_by)
        record = RequestUpload(request_id=req.id, asset_id=asset_id, version_number=version.version_number,
            uploader_name=author.name, uploader_email=author.email)
        db.add(record)
    if record.submitted_at is None and version.processing_status in (ProcessingStatus.processing, ProcessingStatus.ready):
        freeze_submission_timing(db, req, record, version, adopted=True)
    return record


def freeze_submission_timing(db, req, record, version, *, adopted=False):
    """Called under U lock, before first submitted_at commit. Null legacy stays null."""
    if record.submitted_at is not None:
        return
    db.flush()
    version = db.query(AssetVersion).filter(AssetVersion.id == version.id).populate_existing().with_for_update().one()
    record.submitted_at = db.scalar(select(func.clock_timestamp()))
    evidence = {**_identity(req, record, version), 'provenance': 'unclassified'}
    intent = req.timing_natural_intent
    # A second source for the same physical version may not promote earlier evidence.
    prior = db.query(RequestUpload).filter(RequestUpload.asset_id == version.asset_id,
        RequestUpload.version_number == version.version_number, RequestUpload.id != record.id).first()
    if not adopted and prior is None and isinstance(intent, dict):
        try:
            when = datetime.fromisoformat(intent['attested_at'])
            if (intent.get('schema_version') == INTENT_SCHEMA and intent.get('customer_order_verified') is True
                and all(intent.get(k) == evidence[k] for k in ('tenant_id', 'upload_request_id', 'share_token'))
                and when.tzinfo and when < record.submitted_at):
                evidence['provenance'] = 'natural'
                evidence['provenance_attestation'] = hashlib.sha256(json.dumps({**evidence, 'intent': intent}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        except (KeyError, TypeError, ValueError):
            pass
    record.timing_provenance = evidence
    if _run_purpose(req.timing_run_purpose):
        _exclude_version(db, req, record, version, _run_purpose(req.timing_run_purpose))


ADMISSION_SCHEMA = 'autoreview.timing-admission.v1'
EXCLUSION_SCHEMA = 'autoreview.timing-exclusion.v1'


def _exclude_version(db, req, record, version, reason):
    # Caller holds U then V. First negative record is permanent across orders/retries.
    if version.timing_exclusion is None:
        version.timing_exclusion = {**_identity(req, record, version), 'schema_version': EXCLUSION_SCHEMA,
            'provenance': reason, 'excluded_at': db.scalar(select(func.clock_timestamp())).isoformat()}


def _purpose_flags(value):
    if value is None:
        return {'quiet': False, 'provenance': None}
    if (not isinstance(value, dict) or set(value) != {'quiet', 'provenance'}
        or type(value['quiet']) is not bool or value['provenance'] not in (None, 'operator-test', 'synthetic')):
        raise HTTPException(409, 'Invalid timing purpose authority')
    return dict(value)


def _run_purpose(value):
    flags = _purpose_flags(value)
    return 'operator-test' if flags['quiet'] else flags['provenance']


def set_timing_purpose(db, share_token, purpose=None, *, patch=None):
    from ..models.folder import Folder
    from ..models.project import Project
    from ..services.permissions import validate_share_link
    share = validate_share_link(db, share_token)
    if share.visibility != 'public' or share.password_hash or not share.folder_id:
        raise HTTPException(404, 'Timing share not found')
    requests = db.query(UploadRequest).join(Folder, Folder.id == UploadRequest.folder_id).join(Project, Project.id == UploadRequest.project_id).filter(
        UploadRequest.review_share_token == share_token, UploadRequest.folder_id == share.folder_id,
        UploadRequest.revoked_at.is_(None), Folder.deleted_at.is_(None), Project.deleted_at.is_(None)).order_by(UploadRequest.id).populate_existing().with_for_update(of=UploadRequest).all()
    if not requests:
        raise HTTPException(404, 'Timing request not found')
    # Omitted flags merge against the locked authority, never eventual watch KV.
    states = [{**_purpose_flags(req.timing_run_purpose), **patch} if patch is not None
        else {'quiet': False, 'provenance': purpose} for req in requests]
    if any(state != states[0] for state in states):
        raise HTTPException(409, 'Conflicting timing purpose authorities')
    flags = states[0]
    purpose = _run_purpose(flags)
    for req in requests:
        req.timing_run_purpose = flags if purpose else None
    if purpose is not None:
        by_id = {req.id: req for req in requests}
        pairs = db.query(AssetVersion, RequestUpload).join(RequestUpload,
            (RequestUpload.asset_id == AssetVersion.asset_id) & (RequestUpload.version_number == AssetVersion.version_number)).filter(
            RequestUpload.request_id.in_(by_id), RequestUpload.submitted_at.is_not(None), AssetVersion.deleted_at.is_(None)).order_by(AssetVersion.id, RequestUpload.id).populate_existing().with_for_update(of=AssetVersion).all()
        for version, record in pairs:
            _exclude_version(db, by_id[record.request_id], record, version, purpose)
    db.flush()
    return {'schema_version': ADMISSION_SCHEMA, 'purpose': purpose, 'flags': flags, 'requests': len(requests)}


def admit_timing(db, request_id, project_id, share_token, asset_id, version_id, exclusion=None):
    from ..models.folder import Folder
    from ..models.project import Project
    from ..services.permissions import validate_share_link
    req = db.query(UploadRequest).join(Folder, Folder.id == UploadRequest.folder_id).join(Project, Project.id == UploadRequest.project_id).filter(
        UploadRequest.id == request_id, UploadRequest.project_id == project_id, UploadRequest.review_share_token == share_token,
        UploadRequest.revoked_at.is_(None), Folder.deleted_at.is_(None), Project.deleted_at.is_(None)).populate_existing().with_for_update(of=UploadRequest).first()
    if not req:
        raise HTTPException(404, 'Timing request not found')
    share = validate_share_link(db, share_token)
    if share.folder_id != req.folder_id or share.visibility != 'public' or share.password_hash:
        raise HTTPException(404, 'Timing request not found')
    version = db.query(AssetVersion).join(Asset, Asset.id == AssetVersion.asset_id).filter(
        AssetVersion.id == version_id, AssetVersion.asset_id == asset_id, AssetVersion.deleted_at.is_(None),
        Asset.project_id == project_id, Asset.folder_id == req.folder_id, Asset.deleted_at.is_(None)).populate_existing().with_for_update(of=AssetVersion).first()
    if not version:
        raise HTTPException(404, 'Timing version not found')
    sources = db.query(RequestUpload).filter(RequestUpload.asset_id == asset_id,
        RequestUpload.version_number == version.version_number).limit(2).all()
    if len(sources) != 1:
        raise HTTPException(409, 'Ambiguous timing source')
    record = sources[0]
    if record.request_id != req.id or record.submitted_at is None:
        raise HTTPException(404, 'Timing source not found')
    frozen = _frozen_source(req, record, version)
    if frozen is None:
        raise HTTPException(409, 'Invalid timing source')
    reason = _run_purpose(req.timing_run_purpose) or exclusion
    if reason:
        _exclude_version(db, req, record, version, reason)
    db.flush()
    negative = version.timing_exclusion
    provenance = negative.get('provenance', 'unclassified') if isinstance(negative, dict) else ('unclassified' if negative is not None else frozen['provenance'])
    if negative is not None and provenance == 'natural':
        provenance = 'unclassified'
    if provenance not in ('natural', 'unclassified', 'unknown', 'operator-test', 'synthetic'):
        provenance = 'unclassified'
    return {**frozen, 'schema_version': ADMISSION_SCHEMA, 'provenance': provenance}


def admit_legacy_timing_exclusion(db, share_token, asset_id, version_id):
    """Only durable non-natural proof permits a context-free legacy review."""
    from ..models.folder import Folder
    from ..models.project import Project
    from ..services.permissions import validate_share_link, validate_asset_in_share
    share = validate_share_link(db, share_token)
    if share.visibility != 'public' or share.password_hash:
        raise HTTPException(404, 'Timing share not found')
    pair = db.query(AssetVersion, Asset).join(Asset, Asset.id == AssetVersion.asset_id).join(Project, Project.id == Asset.project_id).filter(
        AssetVersion.id == version_id, AssetVersion.asset_id == asset_id, AssetVersion.deleted_at.is_(None),
        Asset.deleted_at.is_(None), Project.deleted_at.is_(None)).populate_existing().with_for_update(of=AssetVersion).first()
    if not pair:
        raise HTTPException(404, 'Timing version not found')
    version, asset = pair
    if asset.folder_id and not db.query(Folder).filter(Folder.id == asset.folder_id, Folder.deleted_at.is_(None)).first():
        raise HTTPException(404, 'Timing version not found')
    validate_asset_in_share(db, share, asset)
    if version.timing_exclusion is None:
        # V lock also serializes future U->V submission/adoption. No U lock is acquired here.
        sources = db.query(RequestUpload).filter(RequestUpload.asset_id == asset.id,
            RequestUpload.version_number == version.version_number).limit(2).all()
        provenance = 'unknown'
        if sources:
            record = sources[0]
            req = db.get(UploadRequest, record.request_id) if len(sources) == 1 else None
            frozen = _frozen_source(req, record, version) if req and req.project_id == asset.project_id else None
            if not frozen or frozen['provenance'] != 'unclassified':
                raise HTTPException(409, 'Submission admission required')
            provenance = 'unclassified'
        elif version.processing_status != ProcessingStatus.ready:
            raise HTTPException(409, 'Legacy version not committed ready')
        version.timing_exclusion = dict(schema_version=EXCLUSION_SCHEMA, tenant_id=str(asset.project_id),
            share_token=share_token, asset_id=str(asset.id), version_id=str(version.id), version_number=version.version_number,
            upload_request_id=str(record.request_id) if sources else None,
            submitted_at=record.submitted_at.isoformat() if sources else None,
            provenance=provenance, reason='legacy-before-review', excluded_at=db.scalar(select(func.clock_timestamp())).isoformat())
    db.flush()
    negative = version.timing_exclusion
    provenance = negative.get('provenance') if isinstance(negative, dict) else None
    if provenance not in ('unknown', 'unclassified', 'operator-test', 'synthetic'):
        provenance = 'unknown'
    return dict(schema_version=ADMISSION_SCHEMA, tenant_id=str(asset.project_id), share_token=share_token,
        asset_id=str(asset.id), version_id=str(version.id), version_number=version.version_number, provenance=provenance)


def _frozen_source(req, record, version):
    if not record.submitted_at:
        return None
    identity = _identity(req, record, version)
    frozen = record.timing_provenance
    if frozen is None:
        return {**identity, 'provenance': 'unclassified'}
    if (not isinstance(frozen, dict) or any(frozen.get(k) != v for k, v in identity.items())
        or frozen.get('provenance') not in ('natural', 'unclassified')
        or (frozen.get('provenance') == 'natural' and (not isinstance(frozen.get('provenance_attestation'), str)
            or len(frozen['provenance_attestation']) != 64))):
        return None
    return frozen


def timing_status(db, identities):
    from sqlalchemy import tuple_
    keys = [(v.tenant_id, v.asset_id, v.version_id) for v in identities]
    if not keys:
        return {'schema_version': ADMISSION_SCHEMA, 'eligible': []}
    rows = db.query(AssetVersion, Asset, RequestUpload, UploadRequest).join(Asset, Asset.id == AssetVersion.asset_id).join(RequestUpload,
        (RequestUpload.asset_id == AssetVersion.asset_id) & (RequestUpload.version_number == AssetVersion.version_number)).join(UploadRequest, UploadRequest.id == RequestUpload.request_id).filter(
        tuple_(Asset.project_id, Asset.id, AssetVersion.id).in_(keys), Asset.deleted_at.is_(None), AssetVersion.deleted_at.is_(None),
        UploadRequest.revoked_at.is_(None), UploadRequest.project_id == Asset.project_id, UploadRequest.folder_id == Asset.folder_id,
        select(func.count(RequestUpload.id)).where(RequestUpload.asset_id == AssetVersion.asset_id,
            RequestUpload.version_number == AssetVersion.version_number).correlate(AssetVersion).scalar_subquery() == 1).all()
    grouped = {}
    for row in rows:
        version, asset, record, req = row
        grouped.setdefault((asset.project_id, asset.id, version.id), []).append(row)
    eligible = []
    for index, (item, key) in enumerate(zip(identities, keys)):
        matches = grouped.get(key, [])
        if len(matches) != 1:
            continue
        version, asset, record, req = matches[0]
        frozen = _frozen_source(req, record, version)
        if (version.timing_exclusion is None and req.timing_run_purpose is None and frozen
            and frozen['provenance'] == 'natural' and frozen.get('provenance_attestation') == item.provenance_attestation):
            eligible.append(index)
    return {'schema_version': ADMISSION_SCHEMA, 'eligible': eligible}


def private_timing_context(db, service_key, share_token, asset_id, version_id, project_id, *, service_user=None):
    if not service_user or not settings.service_api_key_email or service_user.email != settings.service_api_key_email:
        return {}
    if not isinstance(service_key, str) or not settings.service_api_key or not secrets.compare_digest(service_key, settings.service_api_key):
        return {}
    version = db.query(AssetVersion).filter(
        AssetVersion.id == version_id, AssetVersion.asset_id == asset_id,
        AssetVersion.deleted_at.is_(None)).first()
    if not version:
        return {}
    uploads = db.query(RequestUpload).filter(
        RequestUpload.asset_id == asset_id, RequestUpload.version_number == version.version_number,
        RequestUpload.request_id == UploadRequest.id,
        UploadRequest.review_share_token == share_token, UploadRequest.project_id == project_id,
        UploadRequest.revoked_at.is_(None)).limit(2).all()
    # Shares can be reused by multiple orders; never pick an arbitrary source clock.
    if len(uploads) != 1:
        return {}
    upload = uploads[0]
    if not upload.submitted_at:
        return {}
    # Verify current exact parents as well as the frozen source identities.
    req = db.query(UploadRequest).filter(UploadRequest.id == upload.request_id).first()
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.project_id == project_id,
        Asset.folder_id == req.folder_id, Asset.deleted_at.is_(None)).first() if req else None
    if not req or not asset:
        return {}
    frozen = _frozen_source(req, upload, version)
    if frozen is None:
        return {}
    # v2 requires fresh bridge admission; old Workers must not use v1 positive eligibility.
    return {'timing_context': {'tenant_id': str(project_id), 'submitted_at': upload.submitted_at.isoformat(),
        'upload_request_id': str(upload.request_id), 'submission_provenance': {**frozen, 'schema_version': 'autoreview.submission-provenance.v2'}}}



def iteration_review_progress(db, req, entry, *, source=False):
    """Project Parts facts only; the runner has no durable analysis/publication clock yet."""
    if not entry.get('asset_id') or not entry.get('version_id'):
        return {}
    asset_id, version_id = uuid.UUID(entry['asset_id']), uuid.UUID(entry['version_id'])
    version = db.query(AssetVersion).join(Asset, Asset.id == AssetVersion.asset_id).filter(
        AssetVersion.id == version_id, AssetVersion.asset_id == asset_id,
        AssetVersion.deleted_at.is_(None), Asset.project_id == req.project_id,
        Asset.deleted_at.is_(None)).first()
    progress = {'version_id':str(version_id), 'stage':'failed'}
    if not version:
        return {'review_progress':progress}
    processing = version.processing_status.value
    # Source review can finish before HLS; the runner uses this same durable readiness flag.
    if source and processing == 'processing' and getattr(version,'iteration_review_ready',False) is True:
        processing = 'ready'
    progress['stage'] = ('failed' if entry.get('status') == 'error' or processing == 'failed'
                         else 'done' if entry.get('status') in ('clear','held','delivered') else 'waiting')
    if source:
        upload = db.query(RequestUpload).filter(RequestUpload.request_id == req.id,
            RequestUpload.asset_id == asset_id, RequestUpload.version_number == version.version_number).first()
        if upload and upload.submitted_at:
            submitted = upload.submitted_at
            if submitted.tzinfo is None:
                submitted = submitted.replace(tzinfo=timezone.utc)
            progress.update(queued_at=submitted.isoformat(),
                elapsedSeconds=max(0,(datetime.now(timezone.utc)-submitted).total_seconds()))
    return {'processing':processing, 'version_number':version.version_number, 'review_progress':progress}
