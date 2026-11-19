import copy
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException


def manifest():
    return {'schema_version': 1, 'summary': 'Two angles, one body → 2 ads', 'slots': [
        {'id': 'opening-a', 'label': 'Opening A', 'role': 'opening', 'group': 'Angle A', 'script': 'Hook A. Lead A.'},
        {'id': 'opening-b', 'label': 'Opening B', 'role': 'opening', 'group': 'Angle B', 'script': 'Hook B. Lead B.'},
        {'id': 'body', 'label': 'Body including CTA', 'role': 'body', 'group': 'Shared', 'script': 'Main content. Buy now.'}],
        'recipes': [{'id': 'a', 'label': 'Angle A', 'slots': ['opening-a', 'body']},
                    {'id': 'b', 'label': 'Angle B', 'slots': ['opening-b', 'body']}]}


def test_manifest_keeps_explicit_angle_recipes_without_cross_product():
    from apps.api.services.iteration_manifest import validate_manifest
    m = validate_manifest(manifest())
    assert len(m['recipes']) == 2
    assert m['recipes'][0]['slots'] == ['opening-a', 'body']


@pytest.mark.parametrize('mutation', ['missing', 'repeat', 'order', 'duplicate', 'unknown', 'unused', 'empty_script'])
def test_bad_manifests_never_become_renderable(mutation):
    from apps.api.services.iteration_manifest import validate_manifest
    m = manifest()
    if mutation == 'missing': m['recipes'][0]['slots'] = ['opening-a']
    if mutation == 'repeat': m['recipes'][0]['slots'] = ['opening-a', 'body', 'body']
    if mutation == 'order': m['recipes'][0]['slots'] = ['body', 'opening-a']
    if mutation == 'duplicate': m['slots'][1]['id'] = 'opening-a'
    if mutation == 'unknown': m['recipes'][0]['slots'] = ['x', 'body']
    if mutation == 'unused': m['recipes'] = m['recipes'][:1]
    if mutation == 'empty_script': m['slots'][0]['script'] = ''
    with pytest.raises(ValueError): validate_manifest(m)


def test_plan_cannot_be_reused_for_another_owner_project_or_brief():
    from apps.api.services.iteration_manifest import sign_plan, read_plan
    owner, project = str(uuid.uuid4()), str(uuid.uuid4())
    brief = {'brief_text': 'brief', 'brief_url': '', 'brief_pdf_base64': ''}
    token = sign_plan(manifest(), owner, project, brief, now=1000)
    assert read_plan(token, owner, project, brief, now=1001)['summary'] == manifest()['summary']
    for who, where, text, now in [(str(uuid.uuid4()), project, brief, 1001),
                                 (owner, str(uuid.uuid4()), brief, 1001),
                                 (owner, project, {**brief, 'brief_text': 'changed'}, 1001),
                                 (owner, project, brief, 5000)]:
        with pytest.raises(ValueError): read_plan(token, who, where, text, now=now)


def test_recipe_keys_change_only_for_dependent_sources_and_context():
    from apps.api.services.iteration_manifest import recipe_key
    m=manifest(); versions={s['id']: str(uuid.uuid4()) for s in m['slots']}
    before=[recipe_key('r',m,r,versions,'9:16') for r in m['recipes']]
    versions['opening-a']=str(uuid.uuid4())
    after=[recipe_key('r',m,r,versions,'9:16') for r in m['recipes']]
    assert before[0]!=after[0] and before[1]==after[1]
    assert recipe_key('other',m,m['recipes'][1],versions,'9:16') != after[1]
    assert recipe_key('r',m,m['recipes'][1],versions,'1:1') != after[1]


def test_unknown_review_is_never_approval_and_stale_review_is_rejected():
    from apps.api.services.iteration_manifest import review_result
    for value in [None, {}, {'status':'clear'}, {'status':'clear','version_id':'old','review_key':'key'}]:
        assert review_result(value,'new','key')['status']=='error'
    assert review_result({'status':'clear','version_id':'new','review_key':'key','findings':[]},'new','key')['status']=='clear'
    assert review_result({'status':'clear','version_id':'new','review_key':'key','findings':[{'body':'Fix','must_fix':True}]},'new','key')['status']=='held'


def test_next_action_reviews_unique_sources_then_renders_only_clear_recipes():
    from apps.api.services.iteration_flow import next_action
    m=manifest(); state={'submitted':True,'slots':{}}
    assert next_action('r',m,state,'9:16',0) is None
    for i,s in enumerate(m['slots']):
        state['slots'][s['id']]={'asset_id':s['id'],'version_id':str(i),'version_number':1,'status':'ready'}
    action=next_action('r',m,state,'9:16',0)
    assert action['kind']=='review_part' and action['slot_id']=='opening-a'
    state['slots']['opening-a']['status']='held'; state['slots']['opening-a']['next_attempt_at']=100
    state['slots']['opening-b']['status']='clear'; state['slots']['body']['status']='clear'
    action=next_action('r',m,state,'9:16',0)
    assert action['kind']=='render' and action['recipe']['id']=='b'


def test_clear_parts_never_count_as_delivered_and_held_combination_is_independent():
    from apps.api.services.iteration_flow import progress
    assert progress([], [], 2)['state']=='waiting'
    assert progress([{'status':'clear'}], [], 2)['state']=='rendering'
    assert progress([{'status':'clear'}], [{'status':'delivered'},{'status':'held'}], 2)=={
        'state':'held','delivered':1,'total':2}
    assert progress([{'status':'clear'}],[{'status':'delivered'},{'status':'delivered'}],2)['state']=='delivered'


def test_render_action_key_does_not_depend_on_signed_url_expiry():
    from apps.api.services.iteration_flow import next_action
    m=manifest(); state={'submitted':True,'slots':{s['id']:{'status':'clear','version_id':s['id'],'asset_id':s['id']} for s in m['slots']}}
    a=next_action('r',m,state,'9:16',0)
    state['slots']['body']['url']='https://example.test/body?signature=changed'
    assert next_action('r',m,state,'9:16',0)['key']==a['key']


def test_a_review_returning_after_replacement_cannot_apply():
    from apps.api.services.iteration_flow import action_current
    m=manifest(); state={'submitted':True,'slots':{'opening-a':{'version_id':'v2'}}}
    assert not action_current('r',m,state,'9:16',{'kind':'review_part','slot_id':'opening-a','version_id':'v1'})
    assert action_current('r',m,state,'9:16',{'kind':'review_part','slot_id':'opening-a','version_id':'v2'})


def test_component_upload_requires_known_slot_and_video():
    from apps.api.services.iteration_requests import upload_slot
    from types import SimpleNamespace
    req=SimpleNamespace(receive_iterations=True,iteration_mode='components',iteration_manifest=manifest())
    for slot, mime in [(None,'video/mp4'),('foreign','video/mp4'),('body','image/png')]:
        with pytest.raises(HTTPException): upload_slot(req,slot,mime)
    assert upload_slot(req,'body','video/mp4')['label']=='Body including CTA'
    req.iteration_mode='complete'
    assert upload_slot(req,None,'video/mp4') is None


def test_iteration_status_never_uses_legacy_fail_open_gate():
    from apps.api.services.iteration_requests import request_fields
    from types import SimpleNamespace
    req=SimpleNamespace(receive_iterations=True,iteration_mode='components',iteration_manifest=manifest(),iteration_state={},iteration_ratio='9:16',id='r')
    data=request_fields(req)
    assert data['status']=='reviewing'
    assert data['iteration_status']['state']=='waiting'


def test_mixer_client_refuses_missing_config_and_sends_service_auth(monkeypatch):
    from apps.api.services import iteration_mixer
    monkeypatch.setattr(iteration_mixer.settings,'mixer_iterations_url','')
    with pytest.raises(RuntimeError): iteration_mixer.call('GET','/jobs/x',{})
    monkeypatch.setattr(iteration_mixer.settings,'mixer_iterations_url','https://mixer.test')
    monkeypatch.setattr(iteration_mixer.settings,'mixer_iterations_secret','secret')
    seen=[]
    class R:
        def raise_for_status(self): pass
        def json(self): return {'status':'queued'}
    monkeypatch.setattr(iteration_mixer.httpx,'request',lambda *a,**k: seen.append((a,k)) or R())
    assert iteration_mixer.call('POST','/render',{'key':'x'})['status']=='queued'
    assert seen[0][1]['headers']['authorization']=='Bearer secret'
    assert seen[0][1]['follow_redirects'] is False


def test_preview_requires_project_edit_permission_before_calling_engine(monkeypatch):
    from apps.api.routers import iterations
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    db=MagicMock(); db.query.return_value.filter.return_value.first.return_value=SimpleNamespace(id='p')
    called=[]
    def deny(*args): raise HTTPException(403,'No access')
    monkeypatch.setattr(iterations,'require_project_role',deny)
    monkeypatch.setattr(iterations.review_bridge,'plan_iterations',lambda **kwargs:called.append(kwargs))
    with pytest.raises(HTTPException) as exc:
        iterations.preview(iterations.Preview(project_id=uuid.uuid4(),brief_text='text'),db,SimpleNamespace(id='u'))
    assert exc.value.status_code==403 and not called


def test_mode_switch_refuses_existing_uploads(monkeypatch):
    from apps.api.routers import iterations
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    req=SimpleNamespace(id=uuid.uuid4(),receive_iterations=True,iteration_mode='components',iteration_state={'submitted':True,'slots':{'body':{'asset_id':'a'}}})
    monkeypatch.setattr(iterations,'_live_request',lambda *args:req)
    monkeypatch.setattr(iterations,'locked_request',lambda *args:req)
    with pytest.raises(HTTPException) as exc: iterations.submission_mode('t',iterations.Mode(mode='complete'),MagicMock())
    assert exc.value.status_code==409


def test_retry_also_requeues_a_failed_checklist(monkeypatch):
    from apps.api.routers import iterations
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    req=SimpleNamespace(id=uuid.uuid4(),iteration_state={'slots':{'hook':{'status':'error','attempts':3}}})
    failed=SimpleNamespace(id=uuid.uuid4(),status='failed',error_code='briefing-unavailable',attempts=3,next_attempt_at=None,
                           registration_attempts=2,registration_error=None,next_registration_at=None)
    ready=SimpleNamespace(id=uuid.uuid4(),status='ready',error_code=None,attempts=0,next_attempt_at=None,
                          registration_attempts=0,registration_error=None,next_registration_at=None)
    db=MagicMock(); db.query.return_value.filter.return_value.with_for_update.return_value.all.return_value=[failed,ready]
    dispatched=[]
    monkeypatch.setattr(iterations,'_live_request',lambda *args:req)
    monkeypatch.setattr(iterations,'locked_request',lambda *args:req)
    monkeypatch.setattr(iterations,'snapshot',lambda *args:{})
    monkeypatch.setattr(iterations,'dispatch_binding',dispatched.append)
    iterations.retry('t',db)
    assert failed.status=='queued' and failed.attempts==0 and failed.error_code is None and failed.next_attempt_at
    assert ready.status=='ready'
    assert dispatched==[failed.id]
    assert req.iteration_state['slots']['hook']['attempts']==0


def test_guest_download_never_exposes_a_held_output(monkeypatch):
    from apps.api.routers import iterations
    from types import SimpleNamespace
    req=SimpleNamespace(id='r',iteration_manifest=manifest(),iteration_ratio='9:16',iteration_state={'submitted':True,'slots':{},'outputs':{'key':{'status':'held','s3_key':'secret'}}})
    monkeypatch.setattr(iterations.deliveries,'request_parts',lambda db,r:[('a','v',True)])
    monkeypatch.setattr(iterations.deliveries,'progress',lambda db,r:{'approved':1,'total':1,'complete':True})
    with pytest.raises(HTTPException) as exc: iterations.download(req,'key',None)
    assert exc.value.status_code==404


def test_rendered_output_stays_locked_until_a_human_approved_every_part(monkeypatch):
    from apps.api.routers import iterations
    from types import SimpleNamespace
    req=SimpleNamespace(id='r',iteration_manifest=manifest(),iteration_ratio='9:16',iteration_state={'submitted':True,'slots':{},'outputs':{'key':{'status':'delivered','s3_key':'secret'}}})
    monkeypatch.setattr(iterations.deliveries,'request_parts',lambda db,r:[('a','v',True),('b','w',False)])
    monkeypatch.setattr(iterations.deliveries,'progress',lambda db,r:{'approved':1,'total':2,'complete':False})
    with pytest.raises(HTTPException) as exc: iterations.download(req,'key',None)
    assert exc.value.status_code==403 and exc.value.detail=='not_released'
    monkeypatch.setattr(iterations.deliveries,'request_parts',lambda db,r:[])  # no parts at all is not "approved"
    monkeypatch.setattr(iterations.deliveries,'progress',lambda db,r:{'approved':0,'total':0,'complete':True})
    with pytest.raises(HTTPException) as exc: iterations.download(req,'key',None)
    assert exc.value.status_code==403


def test_stale_render_completion_cannot_create_or_release_output():
    from apps.api.services.iteration_runner import apply_effect
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    req=SimpleNamespace(id='r',iteration_manifest=manifest(),iteration_ratio='9:16',iteration_state={'submitted':True,'slots':{}})
    db=MagicMock()
    assert apply_effect(db,req,{'kind':'poll_render','key':'old','recipe':manifest()['recipes'][0]},
                        {'status':'delivered','import_output':True}) is False
    db.add.assert_not_called()


def test_errors_stop_after_three_attempts_but_hold_can_be_rechecked():
    from apps.api.services.iteration_flow import next_action
    from apps.api.services.iteration_runner import apply_effect
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    state={'submitted':True,'slots':{'opening-a':{'version_id':'v','status':'ready'}}}
    req=SimpleNamespace(id='r',iteration_manifest=manifest(),iteration_ratio='9:16',iteration_state=state)
    action={'kind':'review_part','slot_id':'opening-a','version_id':'v'}
    for i in range(3): apply_effect(MagicMock(),req,action,{'status':'error','error':'down'})
    assert req.iteration_state['slots']['opening-a']['attempts']==3
    assert next_action('r',manifest(),req.iteration_state,'9:16',10**12) is None
    apply_effect(MagicMock(),req,action,{'status':'held','findings':[{'body':'Fix','must_fix':True}]})
    assert next_action('r',manifest(),req.iteration_state,'9:16',10**12)['kind']=='review_part'


def test_runner_performs_real_adapter_sequence_with_mocked_external_services(monkeypatch):
    from apps.api.services import iteration_runner as runner
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    req=SimpleNamespace(id=uuid.uuid4(),created_by=uuid.uuid4(),iteration_owner_id=uuid.uuid4(),project_id=uuid.uuid4(),folder_id=uuid.uuid4(),brand_slug='cust-test',title='Test',
        iteration_brief='Brief',review_share_token='source',iteration_manifest=manifest(),iteration_ratio='9:16',
        iteration_state={'submitted':True,'slots':{s['id']:{'asset_id':str(uuid.uuid4()),'version_id':str(uuid.uuid4()),'version_number':1,'status':'ready'} for s in manifest()['slots']}})
    db=MagicMock(); calls=[]
    db.query.return_value.filter.return_value.first.return_value=SimpleNamespace(id=uuid.uuid4(),project_id=req.project_id,intent={},intent_sha256='44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',review_share_token='source',context_sha256='a'*64,plan_id=None,content_sha256=None,snapshot={'briefing':{'text':'Frozen brief'}})
    monkeypatch.setattr(runner.review_bridge,'register_request',lambda *args,**kw:{'ok':True,'brand':'cust-test','brief_status':'ready'})
    def review(payload):
        calls.append(payload)
        return {'status':'clear','review_key':payload['review_key'],'version_id':payload['version_id'],'findings':[]}
    monkeypatch.setattr(runner.review_bridge,'review_iteration',review)
    for s in manifest()['slots']:
        action=runner.next_action(str(req.id),req.iteration_manifest,req.iteration_state,'9:16',0)
        effect=runner.perform(db,req,action);runner.apply_effect(db,req,action,effect)
    assert len(calls)==3 and {p['role'] for p in calls}=={'opening','body'}
    monkeypatch.setattr(runner,'media_for',lambda *args:SimpleNamespace(s3_key_raw='raw/body'))
    monkeypatch.setattr(runner.s3_service,'generate_presigned_get_url',lambda *args,**kwargs:'https://media.test/v.mp4')
    jobs=[]
    monkeypatch.setattr(runner.iteration_mixer,'call',lambda method,path,payload:jobs.append(payload) or {'job_id':'j1','status':'queued'})
    action=runner.next_action(str(req.id),req.iteration_manifest,req.iteration_state,'9:16',0)
    runner.apply_effect(db,req,action,runner.perform(db,req,action))
    assert jobs[0]['owner_id']==f'freeframe:{req.iteration_owner_id}'
    assert [s['role'] for s in jobs[0]['sources']]==['opening','body']
    assert req.iteration_state['outputs'][action['key']]['status']=='rendering'
    assert runner.next_action(str(req.id),req.iteration_manifest,req.iteration_state,'9:16',0)['recipe']['id']=='b'


def test_pending_output_is_private_to_dedicated_reviewer_share():
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    from apps.api.services.permissions import validate_asset_in_share
    asset=SimpleNamespace(id=uuid.uuid4(),project_id=uuid.uuid4(),folder_id=None,iteration_pending=True)
    project_link=SimpleNamespace(id=uuid.uuid4(),asset_id=None,project_id=asset.project_id,folder_id=None)
    db=MagicMock();db.query.return_value.filter.return_value.all.return_value=[]
    with pytest.raises(HTTPException) as error:
        validate_asset_in_share(db,project_link,asset)
    assert error.value.status_code==403
    review_link=SimpleNamespace(asset_id=asset.id,project_id=None,folder_id=None)
    validate_asset_in_share(MagicMock(),review_link,asset)


def test_refresh_sources_requeues_lost_transcode_and_resets_external_replacement(monkeypatch):
    monkeypatch.setattr("apps.api.services.iteration_runner.transcode_missing",lambda _:True)
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    from datetime import timedelta
    from apps.api.models.asset import ProcessingStatus
    from apps.api.services.iteration_runner import refresh_sources
    db=MagicMock();version_id=uuid.uuid4();asset_id=uuid.uuid4();folder_id=uuid.uuid4()
    version=SimpleNamespace(id=version_id,version_number=2,processing_status=ProcessingStatus.processing,
        created_at=datetime.now(timezone.utc)-timedelta(minutes=20))
    asset=SimpleNamespace(id=asset_id,folder_id=folder_id)
    db.query.return_value.filter.return_value.first.return_value=asset
    db.query.return_value.filter.return_value.order_by.return_value.first.return_value=version
    state={'submitted':True,'slots':{'body':{'asset_id':str(asset_id),'version_id':str(uuid.uuid4()),'status':'clear','findings':[{'body':'old'}]}}}
    pending=refresh_sources(db,SimpleNamespace(folder_id=folder_id),state)
    assert state['slots']['body']['version_id']==str(version_id)
    assert state['slots']['body']['status']=='processing' and state['slots']['body']['findings']==[]
    assert pending==[(str(asset_id),str(version_id))]


def test_pending_output_does_not_announce_to_legacy_review(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import MagicMock
    from apps.api.services import automation_share
    monkeypatch.setattr(automation_share.settings,'automation_share_webhook_url','https://example.test/project-registered')
    post=MagicMock();monkeypatch.setattr(automation_share.httpx,'post',post)
    automation_share.announce_asset_ready(MagicMock(),SimpleNamespace(iteration_pending=True,project_id=uuid.uuid4(),id=uuid.uuid4(),name='pending'),uuid.uuid4())
    post.assert_not_called()


def test_withdrawal_updates_only_the_reviewed_source_version():
    from types import SimpleNamespace
    from apps.api.services.iteration_requests import withdraw_finding
    req=SimpleNamespace(iteration_state={'submitted':True,'slots':{'body':{'asset_id':'a','version_id':'v2','status':'held','findings':[{'id':'note','body':'Fix','must_fix':True}]}}})
    withdraw_finding(req,'a','v1','note')
    assert req.iteration_state['slots']['body']['status']=='held'
    withdraw_finding(req,'a','v2','note')
    source=req.iteration_state['slots']['body']
    assert source['status']=='ready' and source['findings']==[] and source['next_attempt_at']==0


def test_imported_render_uses_existing_storage_cleanup_namespace(monkeypatch):
    from types import SimpleNamespace
    from contextlib import contextmanager
    from unittest.mock import MagicMock
    from apps.api.services import iteration_runner as runner
    req=SimpleNamespace(id=uuid.uuid4(),project_id=uuid.uuid4(),created_by=uuid.uuid4(),iteration_owner_id=uuid.uuid4(),
        iteration_manifest=manifest(),iteration_state={'outputs':{'key':{'job_id':'job'}}})
    monkeypatch.setattr(runner.iteration_mixer,'call',lambda *a:{'status':'ready'})
    @contextmanager
    def output(*args): yield SimpleNamespace(iter_bytes=lambda size:iter([b'mp4']))
    monkeypatch.setattr(runner.iteration_mixer,'output',output)
    monkeypatch.setattr(runner.s3_service,'get_s3_client',MagicMock())
    effect=runner.perform(None,req,{'kind':'poll_render','key':'key','recipe':manifest()['recipes'][0]})
    asset=uuid.uuid5(req.id,'iteration-asset:key');version=uuid.uuid5(req.id,'iteration-version:key')
    assert effect['s3_key']==f'raw/{req.project_id}/{asset}/{version}/original.mp4'
