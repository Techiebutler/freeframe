"""Owner plan previews, guest progress and current cleared outputs."""
from copy import deepcopy
from datetime import datetime, timezone
from typing import Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..middleware.auth import get_current_user
from ..middleware.rate_limit import rate_limit
from ..models.checklist_binding import ChecklistBinding
from ..models.project import Project, ProjectRole
from ..models.upload_request import UploadRequest, RequestUpload
from ..models.user import User
from ..services import review_bridge, iteration_mixer, s3_service, deliveries, download_gate
from ..services.permissions import require_project_role
from ..services.iteration_manifest import sign_plan, validate_manifest
from ..services.iteration_requests import locked_request, snapshot
from ..services.checklists import dispatch_binding
from ..services.iteration_flow import current_recipes
from .requests import _live_request

router=APIRouter(tags=['iterations'])


class Preview(BaseModel):
    project_id: uuid.UUID
    brief_text: str = Field(default='', max_length=100000)
    brief_url: str = Field(default='', max_length=4000)
    brief_pdf_base64: str = Field(default='', max_length=15_000_000)


def require_connected():
    if not settings.iterations_enabled or not iteration_mixer.configured() or not review_bridge.is_configured():
        raise HTTPException(503, 'Automatic assembly is not connected yet. You can still request complete ads.')


@router.post('/requests/iterations/preview')
def preview(body: Preview, db: Session=Depends(get_db), current_user: User=Depends(get_current_user)):
    project=db.query(Project).filter(Project.id==body.project_id,Project.deleted_at.is_(None)).first()
    if not project: raise HTTPException(404,'Project not found')
    require_project_role(db,body.project_id,current_user,ProjectRole.editor)
    require_connected()
    brief=body.model_dump(exclude={'project_id'})
    result=review_bridge.plan_iterations(**brief)
    if result is None: raise HTTPException(503,'The briefing reader is unavailable. Try again shortly.')
    if result.get('error') or result.get('clarification'):
        raise HTTPException(422,str(result.get('clarification') or result.get('message') or result['error'])[:2000])
    try:
        manifest=validate_manifest(result.get('manifest',result))
    except ValueError as e: raise HTTPException(422,str(e)) from e
    return {'manifest':manifest,'plan_token':sign_plan(manifest,str(current_user.id),str(body.project_id),brief)}


def owner_request(db, request_id, user):
    req=db.query(UploadRequest).filter(UploadRequest.id==request_id).first()
    if not req: raise HTTPException(404,'Request not found')
    require_project_role(db,req.project_id,user,ProjectRole.owner)
    return req


@router.get('/requests/{request_id}/iterations')
def owner_progress(request_id: uuid.UUID, db: Session=Depends(get_db), current_user: User=Depends(get_current_user)):
    return snapshot(owner_request(db,request_id,current_user),db)


@router.get('/r/{token}/iterations', dependencies=[Depends(rate_limit('iteration_progress',360,600))])
def guest_progress(token: str, db: Session=Depends(get_db)):
    return snapshot(_live_request(db,token),db)


class Mode(BaseModel):
    mode: Literal['complete','components']


@router.post('/r/{token}/submission-mode')
def submission_mode(token: str, body: Mode, db: Session=Depends(get_db)):
    req=_live_request(db,token)
    req=locked_request(db,req.id)
    if req.receive_iterations is not True: raise HTTPException(409,'This request receives complete ads.')
    if req.iteration_mode == body.mode: return snapshot(req,db)
    if (req.iteration_state or {}).get('slots') or db.query(RequestUpload).filter(RequestUpload.request_id==req.id).first():
        raise HTTPException(409,'Files have already been uploaded. Keep using the current submission format.')
    from ..services.checklists import request_binding, registration_options, checklist_reference
    binding = request_binding(db, req)
    options = registration_options(binding)
    if options:
        options['checklist'] = checklist_reference(binding)
    # Register first; the source folder must never be reviewed through both processes.
    registration=review_bridge.register_request(req.review_share_token,req.brand_slug,req.title,
        req.iteration_brief or '',receive_iterations=body.mode=='components', **options)
    if not registration or not registration.get('ok'): raise HTTPException(503,'The reviewer is unavailable. Please retry the format change.')
    req.iteration_mode=body.mode
    db.commit()
    return snapshot(req,db)


def download(req,key,db):
    # Rendered ads open only once a human approved every part (E5): the runner's own `delivered` is the auto review.
    if not deliveries.progress(db,req)['complete'] or not deliveries.request_parts(db,req):
        raise HTTPException(403,download_gate.NOT_RELEASED)
    state=req.iteration_state or {}
    active={k for _,k in current_recipes(str(req.id),req.iteration_manifest or {'recipes':[]},state,req.iteration_ratio)}
    data=state.get('outputs',{}).get(key,{})
    if key not in active or data.get('status')!='delivered' or not data.get('s3_key'):
        raise HTTPException(404,'No approved output is available for this version.')
    return RedirectResponse(s3_service.generate_presigned_get_url(data['s3_key'],download_filename=data.get('label','Ad')+'.mp4'),status_code=307)


@router.get('/r/{token}/iterations/outputs/{key}/download')
def guest_download(token:str,key:str,db:Session=Depends(get_db)):
    return download(_live_request(db,token),key,db)


@router.get('/requests/{request_id}/iterations/outputs/{key}/download')
def owner_download(request_id:uuid.UUID,key:str,db:Session=Depends(get_db),current_user:User=Depends(get_current_user)):
    return download(owner_request(db,request_id,current_user),key,db)


@router.post('/r/{token}/iterations/retry', dependencies=[Depends(rate_limit('iteration_retry',20,600))])
def retry(token:str,db:Session=Depends(get_db)):
    req=_live_request(db,token); req=locked_request(db,req.id)
    state=deepcopy(req.iteration_state or {})
    for category in ('slots','outputs'):
        for item in state.get(category,{}).values():
            if item.get('status')=='error':
                item.update(attempts=0,next_attempt_at=0,error=None,review_generation=item.get('review_generation',0)+1)
    if state.get('delivery',{}).get('status')=='error': state['delivery'].update(attempts=0,next_attempt_at=0,error=None)
    req.iteration_state=state
    # A part review waits for the card's checklist. When preparing it failed (e.g. the card had no
    # briefing yet), resetting only the parts left the submission stuck: retry the checklist too.
    failed=[b for b in db.query(ChecklistBinding).filter(ChecklistBinding.request_id==req.id).with_for_update().all()
            if b.status=='failed' or b.registration_error]
    for b in failed:
        if b.status=='failed':
            b.status='queued'; b.error_code=None; b.attempts=0; b.next_attempt_at=datetime.now(timezone.utc)
        b.registration_attempts=0; b.registration_error=None; b.next_registration_at=None
    db.commit()
    for b in failed: dispatch_binding(b.id)
    return snapshot(req,db)


@router.get('/requests/{request_id}/iterations/mixer-link')
def mixer_link(request_id:uuid.UUID,db:Session=Depends(get_db),current_user:User=Depends(get_current_user)):
    import time
    from jose import jwt
    from urllib.parse import quote
    req=owner_request(db,request_id,current_user)
    state=req.iteration_state or {}
    jobs=[state.get('outputs',{}).get(key,{}) for _,key in current_recipes(str(req.id),req.iteration_manifest or {'recipes':[]},state,req.iteration_ratio)]
    job_ids=[o['job_id'] for o in jobs if o.get('status')=='delivered' and o.get('job_id')]
    if not job_ids: raise HTTPException(409,'No finished ads are ready yet.')
    if not iteration_mixer.configured(): raise HTTPException(503,'AdMixer is unavailable.')
    from ..services.iteration_runner import identity
    claims={'purpose':'freeframe-iterations-release','iss':'freeframe','aud':'admixer-iterations',
        **identity(req),
        'jobs':job_ids,'exp':int(time.time())+900}
    token=jwt.encode(claims,settings.mixer_iterations_secret,algorithm='HS256')
    return {'url':settings.mixer_iterations_url.rstrip('/')+'/iterations#'+quote(token,safe='')}


class OutputObjection(BaseModel):
    comment_id: str = Field(min_length=1,max_length=128)
    body: str = Field(min_length=1,max_length=4000)
    text: str = Field(min_length=1,max_length=4000)
    who: str = Field(default='Editor',min_length=1,max_length=255)


@router.post('/r/{token}/iterations/outputs/{key}/object', dependencies=[Depends(rate_limit('request_object',20,600))])
def output_objection(token:str,key:str,body:OutputObjection,db:Session=Depends(get_db)):
    req=_live_request(db,token); state=req.iteration_state or {}
    active={k for _,k in current_recipes(str(req.id),req.iteration_manifest or {'recipes':[]},state,req.iteration_ratio)}
    out=state.get('outputs',{}).get(key,{})
    if key not in active or out.get('status')!='held': raise HTTPException(404,'This review is no longer current.')
    finding=next((f for f in out.get('findings',[]) if f.get('id')==body.comment_id),None)
    if not finding: raise HTTPException(404,'Review note not found.')
    result=review_bridge.object_to_note(out['share_token'],out['asset_id'],body.comment_id,
        finding['body'],body.text,body.who,version_id=out['version_id'])
    if result is None: raise HTTPException(503,'The reviewer is unavailable. Try again shortly.')
    if result.get('withdrawn') is True:
        from ..services.iteration_requests import withdraw_finding
        req=locked_request(db,req.id)
        withdraw_finding(req,out['asset_id'],out['version_id'],body.comment_id)
        db.commit()
    return result


class Part(BaseModel):
    id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,80}$')
    role: Literal['hook','lead','body','cta']
    label: str = Field(min_length=1,max_length=200)


class Parts(BaseModel):
    parts: list[Part] = Field(min_length=1,max_length=40)


@router.post('/r/{token}/iterations/parts',dependencies=[Depends(rate_limit('iteration_parts',120,600))])
def declare(token:str,body:Parts,db:Session=Depends(get_db)):
    from ..services.iteration_requests import declare_parts
    require_connected()
    req=locked_request(db,_live_request(db,token).id)
    declare_parts(req,[p.model_dump() for p in body.parts]);db.commit()
    return snapshot(req,db)


@router.delete('/r/{token}/iterations/parts/{slot_id}')
def remove_part(token:str,slot_id:str,db:Session=Depends(get_db)):
    from ..services.iteration_requests import declare_parts
    req=locked_request(db,_live_request(db,token).id);state=deepcopy(req.iteration_state or {})
    if state.get('submitted') or state.get('structured'):raise HTTPException(409,'The batch membership is fixed.')
    source=state.get('slots',{}).get(slot_id,{})
    if source.get('status')=='uploading':raise HTTPException(409,'Cancel the active transfer before removing this part.')
    state.get('slots',{}).pop(slot_id,None)
    req.iteration_state=state
    manifest=deepcopy(req.iteration_manifest);manifest['slots']=[s for s in manifest['slots'] if s['id']!=slot_id]
    req.iteration_manifest=manifest;declare_parts(req,[]);db.commit()
    return snapshot(req,db)


@router.post('/r/{token}/iterations/submit',dependencies=[Depends(rate_limit('iteration_submit',30,600))])
def submit(token:str,db:Session=Depends(get_db)):
    from ..services.iteration_requests import seal
    require_connected()
    req=locked_request(db,_live_request(db,token).id);seal(req);db.commit()
    # The database plus beat reconciliation is authoritative even if broker dispatch fails.
    from ..tasks.iteration_tasks import advance_iteration_request
    from ..tasks.celery_app import send_task_safe
    send_task_safe(advance_iteration_request,str(req.id))
    return snapshot(req,db)


def project_scope(project_id,db,user):
    project=db.query(Project).filter(Project.id==project_id,Project.deleted_at.is_(None)).first()
    if not project:raise HTTPException(404,'Project not found')
    require_project_role(db,project_id,user,ProjectRole.owner)
    return {'owner_id':f'freeframe:{project.created_by}','brand_id':f'freeframe:{project.id}'}


@router.get('/projects/{project_id}/iteration-parts')
def owner_parts(project_id:uuid.UUID,db:Session=Depends(get_db),current_user:User=Depends(get_current_user)):
    scope=project_scope(project_id,db,current_user)
    try:return iteration_mixer.call('GET','/parts',scope)
    except Exception as error:raise HTTPException(503,'The private parts library is unavailable.') from error


@router.get('/projects/{project_id}/iteration-parts/{part_id}/file')
def owner_part_file(project_id:uuid.UUID,part_id:uuid.UUID,db:Session=Depends(get_db),current_user:User=Depends(get_current_user)):
    import httpx
    import re
    from email.message import Message
    from urllib.parse import quote
    from fastapi.responses import StreamingResponse
    scope=project_scope(project_id,db,current_user)
    try:url,headers=iteration_mixer.connection(f'/parts/{part_id}/file')
    except RuntimeError as error:raise HTTPException(503,'The private part is unavailable.') from error
    client=httpx.Client(timeout=120,follow_redirects=False)
    try:
        response=client.send(client.build_request('GET',url,headers=headers,params=scope),stream=True)
        if response.status_code==404:raise HTTPException(404,'Part not found')
        response.raise_for_status()
    except Exception as error:
        client.close()
        if isinstance(error,HTTPException):raise
        raise HTTPException(503,'The private part is unavailable.') from error
    def chunks():
        try:yield from response.iter_bytes(1024*1024)
        finally:response.close();client.close()
    metadata=Message();metadata['Content-Disposition']=response.headers.get('content-disposition','')
    filename=metadata.get_filename() or str(part_id)
    filename=re.sub(r'[\x00-\x1f\x7f]', '', filename.replace('\\','/').rsplit('/',1)[-1])[:255] or str(part_id)
    mime=response.headers.get('content-type','').split(';',1)[0].strip().lower()
    if not re.fullmatch(r'video/[a-z0-9.+-]+',mime):mime='application/octet-stream'
    return StreamingResponse(chunks(),media_type=mime,headers={'Content-Disposition':f"attachment; filename*=UTF-8''{quote(filename,safe='')}",'Cache-Control':'private, no-store'})


class Handin(BaseModel):
    project_id: uuid.UUID
    card_url: str = Field(min_length=1,max_length=2048)
    idempotency_key: uuid.UUID


@router.post('/handins',status_code=201)
def create_handin(body:Handin,db:Session=Depends(get_db),current_user:User=Depends(get_current_user)):
    import re
    from urllib.parse import urlparse
    from .requests import create_request,RequestCreate
    if getattr(current_user,'is_staff',False) is not True:raise HTTPException(403,'Internal hand-in is available to staff.')
    project=db.query(Project).filter(Project.id==body.project_id,Project.deleted_at.is_(None)).populate_existing().with_for_update().first()
    if not project or not project.is_workspace:raise HTTPException(404,'Workspace not found')
    require_project_role(db,body.project_id,current_user,ProjectRole.editor)
    parsed=urlparse(body.card_url)
    card=re.fullmatch(r'/c/([A-Za-z0-9]{8})(?:/[^?#]*)?/?',parsed.path)
    # Links copied from Trello often carry ?filter=… or #comment-…; only the card id is used.
    if parsed.scheme!='https' or parsed.netloc not in ('trello.com','www.trello.com') or not card:
        raise HTTPException(422,'Paste an https://trello.com/c/... card link.')
    card_url=f'https://trello.com/c/{card.group(1)}'
    from sqlalchemy import text
    from ..models.checklist_binding import ChecklistBinding
    source_key=f'request:{body.idempotency_key}'
    db.execute(text('SELECT pg_advisory_xact_lock(hashtextextended(:ref, 0))'),
        {'ref':f'autoreview.handin:{body.project_id}:{source_key}'})
    previous=db.query(ChecklistBinding).filter(ChecklistBinding.project_id==body.project_id,
        ChecklistBinding.source_key==source_key).with_for_update().first()
    if previous:
        title=previous.intent['title']
    else:
        resolved=review_bridge._call('POST','/api/gate/card',json={'url':card_url}) or {}
        title=str(resolved.get('name') or f'Hand-in {card.group(1)}')[:255]
    result=create_request(RequestCreate(project_id=body.project_id,title=title,brief_url=card_url,receive_iterations=True,idempotency_key=body.idempotency_key),db,current_user)
    req=locked_request(db,uuid.UUID(result['id']))
    state=deepcopy(req.iteration_state or {})
    state['internal_handin']={'card_url':card_url,'editor_name':current_user.name,'editor_id':str(current_user.id)}
    req.iteration_state=state;req.last_uploader_name=current_user.name;req.last_uploader_email=current_user.email;db.commit()
    return {**result,'upload_url':result['url']}
