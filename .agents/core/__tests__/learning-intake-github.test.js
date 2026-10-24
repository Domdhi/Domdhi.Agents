import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const subject = () => require('../learning-intake-github');
const store = () => require('../_lib/learning-intake-store');
const UUID = '22222222-2222-4222-8222-222222222222';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const marker = 'agents-learning-' + UUID;
const destination = { provider: 'github', owner: 'ToolkitOwner', repository: 'Toolkit', maintainerIds: [123] };
const request = { schemaVersion:1, requestId:UUID, projectId:PROJECT, projectName:'ToolkitFixture',
  createdAt:'2026-10-14T14:00:00.000Z', toolkitVersion:'6.0', runtime:'codex', component:'gate',
  applicability:'shared-toolkit', title:'Selected toolkit lesson', problem:'Observed fixture failure', expected:'Expected behavior',
  reproduction:'Bounded fixture', verification:'Focused regression', references:[], fingerprint:'a'.repeat(64), exportApproved:true };
const hash = () => store().canonicalHash(request);
const escape = value => JSON.stringify(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const remoteIssue = (overrides = {}) => ({ id:101, number:7, title:request.title, state:'open',
  url:'https://api.github.com/repos/ToolkitOwner/Toolkit/issues/7',
  repository_url:'https://api.github.com/repos/ToolkitOwner/Toolkit',
  html_url:'https://github.com/ToolkitOwner/Toolkit/issues/7',
  body:marker+'\nAGENTS_LEARNING_REQUEST_V1:<pre>'+escape({schemaVersion:1,requestHash:hash(),request})+'</pre>', ...overrides });
const receipt = () => ({ issueId:101, issueNumber:7, url:remoteIssue().html_url, destination,
  destinationHash:store().canonicalHash(destination), requestHash:hash(), marker, receivedAt:'2026-10-14T14:00:00.000Z' });
const lookupInput = () => ({ destination, marker, requestHash:hash(), projectId:PROJECT });
const createInput = () => ({ destination, marker, requestHash:hash(), request });
const resolution = {schemaVersion:1,requestId:UUID,disposition:'accepted',rationale:'Maintainer reviewed fixture',reviewedAt:'2026-10-14T14:00:00.000Z'};
const comment = (userId = 123, overrides = {}) => ({id:88,user:{id:userId},body:'AGENTS_LEARNING_RESOLUTION_V1:<pre>'+escape(resolution)+'</pre>',...overrides});
const response = (body, headers = {}, statusCode = 200) => ({statusCode,headers,body:JSON.stringify(body)});
function harness(overrides = {}) {
  const getToken = vi.fn(async () => 'fixture-token');
  const http = vi.fn(async input => {
    const url = new URL(input.url);
    if (input.method === 'POST') return response(remoteIssue(),{},201);
    if (url.pathname === '/search/issues') return response({total_count:0,incomplete_results:false,items:[]});
    if (url.pathname.endsWith('/comments')) return response([]);
    if (url.pathname.endsWith('/issues/7')) return response(remoteIssue());
    return response({id:1,name:'Toolkit',full_name:'ToolkitOwner/Toolkit',owner:{login:'ToolkitOwner'},html_url:'https://github.com/ToolkitOwner/Toolkit',has_issues:true,archived:false,disabled:false});
  });
  return { getToken, http, adapter: subject().createGithubTransport({getToken,request:http,...overrides}) };
}
describe('GitHub learning transport real adapter boundary', () => {
  it('imports without authenticating and validates exact receiver with last-moment guard', async () => {
    const h=harness(); const guard=vi.fn();
    expect(h.getToken).not.toHaveBeenCalled();
    expect(await h.adapter.validateDestination(destination,guard)).toEqual(destination);
    expect(guard).toHaveBeenCalledTimes(h.http.mock.calls.length);
    expect(h.http.mock.calls[0][0].url).toBe('https://api.github.com/repos/ToolkitOwner/Toolkit');
  });
  it('creates bounded issue payload and binds canonical receipt', async () => {
    const h=harness(); const got=await h.adapter.create(createInput(),vi.fn());
    expect(got).toMatchObject({issueId:101,issueNumber:7,url:remoteIssue().html_url,requestHash:hash(),marker,destination});
    const call=h.http.mock.calls.find(([input])=>input.method==='POST')[0];
    expect(call.url).toBe('https://api.github.com/repos/ToolkitOwner/Toolkit/issues');
    const payload=JSON.parse(call.body);
    expect(payload.title).toBe(request.title); expect(payload.body).toContain(marker);
    expect(payload.body).toContain('AGENTS_LEARNING_REQUEST_V1:');
    expect(Buffer.byteLength(call.body)).toBeLessThanOrEqual(16384);
  });
  it('empty initial search is observed-empty without resolving uncertainty', async () => {
    const h=harness(); expect(await h.adapter.findByMarker(lookupInput(),vi.fn())).toEqual({matches:[],inconclusive:true,observedEmpty:true});
  });
  it('hydrates an exact issue candidate and rechecks dispatch each time', async () => {
    const h=harness(); h.http.mockResolvedValueOnce(response({total_count:1,incomplete_results:false,items:[remoteIssue()]}));
    const guard=vi.fn(); const got=await h.adapter.findByMarker(lookupInput(),guard);
    expect(got.inconclusive).toBe(false); expect(got.matches).toHaveLength(1);
    expect(got.matches[0].issueId).toBe(101); expect(guard).toHaveBeenCalledTimes(2);
    const query=new URL(h.http.mock.calls[0][0].url).searchParams.get('q');
    expect(query).toContain('repo:ToolkitOwner/Toolkit'); expect(query).toContain('is:issue'); expect(query).toContain(marker);
  });
  it.each([
    {total_count:0,incomplete_results:true,items:[]},
    {total_count:2,incomplete_results:false,items:[remoteIssue()]},
    {total_count:3,incomplete_results:false,items:[remoteIssue(),remoteIssue(),remoteIssue()]},
  ])('incomplete/truncated search stays inconclusive',async report=>{
    const h=harness();h.http.mockResolvedValueOnce(response(report));
    const got=await h.adapter.findByMarker(lookupInput(),vi.fn());
    expect(got.inconclusive).toBe(true);expect(got.matches).toEqual([]);
  });
  it.each([
    {pull_request:{url:'https://api.github.com/repos/ToolkitOwner/Toolkit/pulls/7'}},
    {html_url:'https://github.com/Other/Toolkit/issues/7'},
    {id:0}, {number:8}, {body:'changed request'}, {repository_url:'https://api.github.com/repos/Other/Toolkit'},
  ])('candidate mismatch cannot become a receipt',async changes=>{
    const h=harness();h.http.mockResolvedValueOnce(response({total_count:1,incomplete_results:false,items:[remoteIssue()]}));
    h.http.mockResolvedValueOnce(response(remoteIssue(changes)));
    const got=await h.adapter.findByMarker(lookupInput(),vi.fn());
    expect(got.inconclusive).toBe(true); expect(got.matches).toEqual([]);
  });
  it.each([401,403,404,422,429])('definitive create rejection %s is safely classified',async status=>{
    const h=harness();h.http.mockResolvedValueOnce(response({}, {},status));
    await expect(h.adapter.create(createInput(),vi.fn())).rejects.toMatchObject({possibleWrite:false});
  });
  it.each(['timeout','malformed','oversized','server','redirect'])('possible committed create %s stays uncertain',async kind=>{
    const h=harness();
    if(kind==='timeout')h.http.mockRejectedValueOnce(new Error('private network diagnostics'));
    if(kind==='malformed')h.http.mockResolvedValueOnce({statusCode:201,headers:{},body:'{'});
    if(kind==='oversized')h.http.mockResolvedValueOnce({statusCode:201,headers:{},body:' '.repeat(262145)});
    if(kind==='server')h.http.mockResolvedValueOnce(response({}, {},500));
    if(kind==='redirect')h.http.mockResolvedValueOnce(response({}, {location:'https://private.invalid/next'},302));
    await expect(h.adapter.create(createInput(),vi.fn())).rejects.toMatchObject({code:'write-uncertain',possibleWrite:true});
  });
  it('revocation after authentication prevents HTTP and preserves bounded refusal',async()=>{
    const h=harness();const guard=()=>{throw Object.assign(new Error('private'),{code:'scope-mismatch'});};
    await expect(h.adapter.create(createInput(),guard)).rejects.toMatchObject({code:'scope-mismatch',possibleWrite:false});
    expect(h.http).not.toHaveBeenCalled();
  });
  it('revocation between candidate hydration requests prevents the next dispatch',async()=>{
    const h=harness();h.http.mockResolvedValueOnce(response({total_count:1,incomplete_results:false,items:[remoteIssue()]}));
    let n=0; const guard=()=>{if(++n===2)throw Object.assign(new Error('private'),{code:'disabled'});};
    await expect(h.adapter.findByMarker(lookupInput(),guard)).rejects.toMatchObject({code:'disabled'});
    expect(h.http).toHaveBeenCalledTimes(1);
  });
  it('show reads trusted maintainer comment separately from raw closed state',async()=>{
    const h=harness();h.http.mockResolvedValueOnce(response(remoteIssue({state:'closed'})));
    h.http.mockResolvedValueOnce(response([comment()]));
    expect(await h.adapter.show({destination,receipt:receipt()},vi.fn())).toMatchObject({remoteState:'closed',resolution});
  });
  it('untrusted comments and resolution text in issue body never imply acceptance',async()=>{
    const h=harness();h.http.mockResolvedValueOnce(response(remoteIssue({state:'closed',body:remoteIssue().body+'\n'+comment().body})));
    h.http.mockResolvedValueOnce(response([comment(999)]));
    const got=await h.adapter.show({destination,receipt:receipt()},vi.fn());
    expect(got.remoteState).toBe('closed');expect(got).not.toHaveProperty('resolution');
  });
  it.each(['multiple','malformed','truncated'])('unreliable trusted comments %s fail readback',async kind=>{
    const h=harness();h.http.mockResolvedValueOnce(response(remoteIssue()));
    h.http.mockResolvedValueOnce(response(kind==='multiple'?[comment(),comment()]:kind==='malformed'?[comment(123,{body:'AGENTS_LEARNING_RESOLUTION_V1:<pre>{</pre>'})]:[comment()],kind==='truncated'?{link:'<https://api.github.com/next>; rel="next"'}:{}));
    await expect(h.adapter.show({destination,receipt:receipt()},vi.fn())).rejects.toMatchObject({code:'invalid-resolution'});
  });
  it('missing trusted maintainer IDs permits only issue state and avoids comment lookup',async()=>{
    const dest={...destination,maintainerIds:[]};const rec={...receipt(),destination:dest,destinationHash:store().canonicalHash(dest)};
    const h=harness();const got=await h.adapter.show({destination:dest,receipt:rec},vi.fn());
    expect(got.remoteState).toBe('open');expect(got).not.toHaveProperty('resolution');expect(h.http).toHaveBeenCalledTimes(1);
  });
  it('invalid destination fails before authentication',async()=>{
    const h=harness();await expect(h.adapter.validateDestination({...destination,owner:'../escape'},vi.fn())).rejects.toMatchObject({code:'invalid-input'});
    expect(h.getToken).not.toHaveBeenCalled();expect(h.http).not.toHaveBeenCalled();
  });
});

describe('bounded native GitHub credential and HTTPS seams', () => {
  it('credential tool uses fixed shell-free public-host arguments', async () => {
    const runTool = vi.fn(async () => ({ status: 0, stdout: 'fixture-token\n', stderr: '' }));
    expect(await subject().acquireGithubToken({ runTool })).toBe('fixture-token');
    expect(runTool).toHaveBeenCalledWith(expect.objectContaining({ command: 'gh', args: ['auth','token','--hostname','github.com'], shell: false }));
    expect(runTool.mock.calls[0][0].timeoutMs).toBeGreaterThan(0);
    expect(runTool.mock.calls[0][0].maxOutputBytes).toBeGreaterThan(0);
  });

  it.each([{status:1,stdout:'',stderr:'private diagnostic'}, {status:null,signal:'SIGTERM',stdout:'fixture-token'}, {status:0,stdout:'two\ntokens'}, {status:0,stdout:' '.repeat(262145)}])('credential refusal is bounded without leaking output', async result => {
    await expect(subject().acquireGithubToken({runTool:async()=>result})).rejects.toMatchObject({code:'auth-unavailable'});
  });

  function fakeHttp({ statusCode = 200, body = '{}', headers = {}, hang = false, closeDelay = 0 } = {}) {
    const requests = [];
    const httpsRequest = vi.fn((_url, _options, callback) => {
      const req = new EventEmitter(); requests.push(req);
      req.write = vi.fn(); req.setTimeout = vi.fn();
      req.closed = false;
      req.destroy = vi.fn(error => { setTimeout(() => { if (error) req.emit('error', error); req.closed = true; req.emit('close'); }, closeDelay); });
      req.end = vi.fn(() => {
        if (hang) return;
        queueMicrotask(() => {
          const res = new EventEmitter(); res.statusCode = statusCode; res.headers = headers;
          res.destroy = vi.fn(error => { queueMicrotask(() => { if(error) res.emit('error',error); res.emit('close'); }); });
          callback(res); res.emit('data', Buffer.from(body)); res.emit('end'); res.emit('close');
        });
      });
      return req;
    });
    return { httpsRequest, requests };
  }
  const input = () => ({method:'GET',url:'https://api.github.com/repos/ToolkitOwner/Toolkit',headers:{Accept:'application/vnd.github+json'},timeoutMs:30,maxResponseBytes:32});

  it('native HTTPS reads bounded response through fixed host without redirects', async () => {
    const h = fakeHttp();
    expect(await subject().requestHttps(input(), h)).toEqual({statusCode:200,headers:{},body:'{}'});
    expect(h.httpsRequest).toHaveBeenCalledTimes(1);
  });
  it.each(['http://api.github.com/repos/x/y','https://api.github.com:444/repos/x/y','https://private.invalid/repos/x/y','https://user:secret@api.github.com/repos/x/y'])('native HTTPS refuses unsafe URL %s before dispatch', async url => {
    const h = fakeHttp();
    await expect(subject().requestHttps({...input(),url},h)).rejects.toBeDefined();
    expect(h.httpsRequest).not.toHaveBeenCalled();
  });
  it('oversized stream aborts and returns bounded failure', async () => {
    const h = fakeHttp({body:'x'.repeat(33)});
    await expect(subject().requestHttps(input(),h)).rejects.toBeDefined();
    expect(h.requests[0].destroy).toHaveBeenCalled();
  });
  it('timeout closes the owned request before returning failure', async () => {
    const h = fakeHttp({hang:true,closeDelay:15});
    await expect(subject().requestHttps(input(),h)).rejects.toBeDefined();
    expect(h.requests[0].destroy).toHaveBeenCalled();
    expect(h.requests[0].closed).toBe(true);
  });
  it('redirect is returned once and never followed by the HTTPS primitive', async () => {
    const h = fakeHttp({statusCode:302,headers:{location:'https://private.invalid/next'}});
    const value = await subject().requestHttps(input(),h);
    expect(value.statusCode).toBe(302);
    expect(h.httpsRequest).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === 'win32')('default credential runner executes only isolated fixture gh and reaps timeouts', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'github-credential-')));
    const prior = process.env.PATH;
    const gh = path.join(root, 'gh');
    try {
      process.env.PATH = root;
      fs.writeFileSync(gh, '#!' + process.execPath + '\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(["auth","token","--hostname","github.com"]))process.exit(7);process.stdout.write("fixture-token\\n");\n', { mode: 0o700 });
      expect(await subject().acquireGithubToken({limits:{OPERATION_TIMEOUT_MS:1000}})).toBe('fixture-token');
      fs.writeFileSync(gh, '#!' + process.execPath + '\nsetInterval(()=>{},1000);\n', { mode: 0o700 });
      await expect(subject().acquireGithubToken({limits:{OPERATION_TIMEOUT_MS:30}})).rejects.toMatchObject({code:'auth-unavailable'});
      fs.writeFileSync(gh, '#!' + process.execPath + '\nprocess.stdout.write("x".repeat(100));setInterval(()=>{},1000);\n', { mode: 0o700 });
      await expect(subject().acquireGithubToken({limits:{MAX_RESPONSE_BYTES:32,OPERATION_TIMEOUT_MS:1000}})).rejects.toMatchObject({code:'auth-unavailable'});
    } finally {
      if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior;
      fs.rmSync(root, {recursive:true,force:true});
    }
  });
});

