import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelSelection, modelOptions } from "../src/model-selection.js";
import { Engine, validateRequest } from "../src/engine.js";
import { ConversationStore } from "../src/state.js";
import { Fault } from "../src/errors.js";
import { createLocalServer } from "../src/http.js";
import { controlToken } from "../src/launcher.js";
const key="local-model-control-test-00000000000000";
const collect=async iterable=>{const out=[];for await(const item of iterable)out.push(item);return out;};

test("presets sharing a model retain distinct keys, effort, saved selection and verification",async t=>{
  const f=fixture(t);
  f.setOptions(modelOptions({models:[
    {slug:'candidate',option_key:'version:medium',title:'Medium',group:'Version',preset:'Medium',thinking_effort:'standard'},
    {slug:'candidate',option_key:'version:high',title:'High',group:'Version',preset:'High',thinking_effort:'extended'},
  ]}));
  await f.selection.apply('version:high');
  assert.equal(f.calls.at(-1).thinking_effort,'extended');
  assert.equal(f.selection.state().options.find(o=>o.key==='version:high').status,'verified');
  assert.equal(f.selection.state().options.find(o=>o.key==='version:medium').status,'account_reported');
  const restored=new ModelSelection(f.directory,f.engine,async()=>f.selection.options);
  assert.equal(restored.snapshot().key,'version:high');
  assert.equal(restored.snapshot().thinking_effort,'extended');
  await f.selection.apply('version:medium');
  assert.equal(f.calls.at(-1).thinking_effort,'standard');
  f.setOptions(modelOptions({models:[{slug:'replacement',option_key:'version:medium',thinking_effort:'extended'}]}));
  await f.selection.refresh();
  assert.equal(f.selection.snapshot().id,'replacement');
  assert.equal(f.selection.snapshot().thinking_effort,'extended');
  assert.equal(f.selection.state().generation_verified,false);
});
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),"webgpt-selection-"));
  const store=new ConversationStore(":memory:"); const calls=[];
  let options=modelOptions({models:[{slug:"candidate",title:"Candidate"},{slug:"work-model",title:"Work model",is_work_mode_model:true},{slug:"unavailable"}]});
  const transport={models:async()=>[{id:"candidate",default:true}],async *generate(r){calls.push(r);yield{text:"OK",model:r.model==='auto'?'website-routed':r.model};}};
  const engine=new Engine(transport,store);
  const selection=new ModelSelection(directory,engine,async()=>options);engine.selection=selection;
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return{directory,store,calls,transport,engine,selection,setOptions:v=>{options=v;}};
}
test("native Auto goes upstream as auto, not the catalog default; selection persists after successful probe",async t=>{
  const f=fixture(t);const refreshed=await f.selection.refresh();
  assert.equal(refreshed.selected_status,"account_reported");
  assert.equal(refreshed.options.some(option=>option.id==="work-model"),false);
  assert.equal(refreshed.options.find(option=>option.id==="candidate").status,"account_reported");
  await collect(f.engine.run(validateRequest({input:"first",store:false})));
  assert.equal(f.calls[0].model,"auto");assert.equal(f.calls[0].automatic,true);
  const saved=await f.selection.apply("candidate");assert.equal(saved.actual_model,"candidate");
  assert.equal(saved.selected_status,"verified");
  assert.equal(saved.options.find(option=>option.id==="candidate").status,"verified");
  await collect(f.engine.run(validateRequest({input:"second",model:"auto",store:false})));
  assert.equal(f.calls.at(-1).model,"candidate");assert.equal(f.calls.at(-1).automatic,false);
  assert.equal(new ModelSelection(f.directory,f.engine,async()=>[]).snapshot().id,"candidate");
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM turns").get().n,0);
});
test("unavailable, substituted, failed and cancelled selections leave original settings unchanged",async t=>{
  const f=fixture(t);await f.selection.apply("candidate");
  await assert.rejects(f.selection.apply("not-in-list"),{code:"model_not_available"});
  f.transport.generate=async function*(){yield{text:"OK",model:"different"};};
  await assert.rejects(f.selection.apply("unavailable"),{code:"model_substituted"});
  f.transport.generate=async function*(){throw new Fault(429,"web_generation_rejected","synthetic");};
  await assert.rejects(f.selection.apply("auto"),{code:"web_generation_rejected"});
  await assert.rejects(f.selection.apply("auto",AbortSignal.abort()));
  assert.equal(f.selection.snapshot().id,"candidate");
  assert.equal(new ModelSelection(f.directory,f.engine,async()=>[]).snapshot().id,"candidate");
  assert.equal(f.selection.busy,false);
});

test("request echoes cannot verify a substituted model; API and storage preserve both identities",async t=>{
  const f=fixture(t);
  f.transport.generate=async function*(request){yield{text:"OK",model:"reported-model",requested_model:request.model};};
  await assert.rejects(f.selection.apply("candidate"),{code:"model_substituted"});
  assert.equal(f.selection.current.id,"auto");
  assert.equal(f.selection.state().options.find(o=>o.id==='candidate').status,'failed');
  const app=createLocalServer({key,engine:f.engine,selection:f.selection});const url=await app.listen(0);t.after(()=>app.close());
  const headers={authorization:"Bearer "+key,"content-type":"application/json"};
  const response=await(await fetch(url+"/v1/responses",{method:"POST",headers,body:JSON.stringify({model:"auto",input:"test",store:true})})).json();
  assert.equal(response.model,"reported-model");assert.equal(response.requested_model,"auto");
  const saved=await(await fetch(url+"/v1/responses/"+response.id,{headers})).json();
  assert.equal(saved.model,response.model);assert.equal(saved.requested_model,response.requested_model);
  const chat=await(await fetch(url+"/v1/chat/completions",{method:"POST",headers,body:JSON.stringify({model:"auto",messages:[{role:"user",content:"test"}]})})).json();
  assert.equal(chat.model,"reported-model");assert.equal(chat.requested_model,"auto");
  const stream=await(await fetch(url+"/v1/responses",{method:"POST",headers,body:JSON.stringify({model:"auto",input:"test",stream:true,store:false})})).text();
  const completed=stream.split(/\r?\n/).filter(line=>line.startsWith("data: ")).map(line=>JSON.parse(line.slice(6))).find(event=>event.type==="response.completed").response;
  assert.equal(completed.model,"reported-model");assert.equal(completed.requested_model,"auto");
  f.transport.generate=async function*(){yield{text:"OK",model:"candidate",requested_model:"wrong-selection"};};
  await assert.rejects(f.selection.apply("candidate"),{code:"model_substituted"});
  assert.equal(f.selection.current.id,"auto");
});
test("refresh does not replace a selection that disappears after an account change",async t=>{
  const f=fixture(t);await f.selection.apply("candidate");
  f.setOptions(modelOptions({models:[]}));await f.selection.refresh();
  assert.equal(f.selection.snapshot().id,"candidate");
  assert.equal(f.selection.state().selected_status,"not_reported");
  assert.equal(f.selection.state().generation_verified,false);
  await assert.rejects(f.selection.apply("candidate"),{code:"model_not_available"});
});

test("refresh and failed switches retain successful evidence; login invalidation clears all account evidence",async t=>{
  const f=fixture(t);await f.selection.apply("candidate");
  const verifiedAt=f.selection.state().verified_at;
  await f.selection.refresh();
  assert.equal(f.selection.state().verified_at,verifiedAt);
  f.transport.generate=async function*(){yield{text:"OK",model:"different"};};
  await assert.rejects(f.selection.apply("unavailable"),{code:"model_substituted"});
  const state=f.selection.state();
  assert.equal(state.selected_status,"verified");
  assert.equal(state.selected_actual_model,"candidate");
  assert.equal(state.options.find(o=>o.id==="unavailable").status,"failed");
  assert.equal(state.options.find(o=>o.id==="unavailable").error.actual_model,"different");
  assert.equal(f.selection.markVerified("different","candidate"),false);
  f.selection.invalidate();
  assert.equal(f.selection.state().generation_verified,false);
  assert.equal(f.selection.state().options.every(o=>o.status==="account_reported"),true);
});

test("catalog refresh excludes overlapping selection or refresh mutations",async t=>{
  const f=fixture(t);const entered=Promise.withResolvers(),finish=Promise.withResolvers();
  f.selection.discover=async()=>{entered.resolve();await finish.promise;return modelOptions({models:[]});};
  const refreshing=f.selection.refresh();await entered.promise;
  await assert.rejects(f.selection.refresh(),{code:"selection_busy"});
  await assert.rejects(f.selection.apply("auto"),{code:"selection_busy"});
  finish.resolve();await refreshing;
  assert.equal(f.selection.busy,false);
});

test("a probe records the candidate outcome without changing the saved API model",async t=>{
  const f=fixture(t);await f.selection.apply("auto");
  const result=await f.selection.apply("candidate",undefined,{save:false});
  assert.equal(result.actual_model,"candidate");
  assert.equal(f.selection.current.id,"auto");
  assert.equal(new ModelSelection(f.directory,f.engine,async()=>[]).current.id,"auto");
  assert.equal(f.selection.state().options.find(o=>o.id==="candidate").status,"verified");
  assert.equal(f.selection.state().selected_actual_model,"website-routed");
});

test("control status uses the selected model evidence, not an earlier launcher probe",async t=>{
  const f=fixture(t);await f.selection.apply("candidate");
  let lifecycle={phase:"ready",generation_verified:true,actual_model:"stale-auto-model"};
  const app=createLocalServer({key,engine:f.engine,selection:f.selection,control:{state:()=>lifecycle,selected:()=>{lifecycle={phase:"ready",error:null};}}});
  const url=await app.listen(0);t.after(()=>app.close());
  const status=async()=> (await fetch(url+"/v1/control/status",{headers:{authorization:"Bearer "+controlToken(key)}})).json();
  assert.equal((await status()).actual_model,"candidate");
  f.selection.invalidate();
  assert.equal((await status()).generation_verified,false);
  assert.equal((await status()).actual_model,null);
  lifecycle={phase:"blocked",error:{code:"prior_failure"}};
  const probe=await fetch(url+"/v1/control/probe",{method:"POST",headers:{authorization:"Bearer "+controlToken(key),"content-type":"application/json"},body:JSON.stringify({key:"candidate"})});
  assert.equal(probe.status,200);
  assert.equal((await status()).phase,"ready");
  assert.equal((await status()).generation_verified,true);
});
test("switching is serialized and requests accepted before save retain their model snapshot",async t=>{
  const f=fixture(t);const entered=Promise.withResolvers(),finish=Promise.withResolvers();
  f.transport.generate=async function*(r){f.calls.push(r);if(r.model==='candidate'){entered.resolve();await finish.promise;}yield{text:"OK",model:r.model==='auto'?'website-routed':r.model};};
  const selection=f.selection.apply("candidate");await entered.promise;
  await assert.rejects(f.selection.apply("auto"),{code:"selection_busy"});
  const oldRequest=collect(f.engine.run(validateRequest({input:"accepted before save",store:false})));
  finish.resolve();await selection;await oldRequest;
  assert.equal(f.calls.at(-1).model,"auto");
  await collect(f.engine.run(validateRequest({input:"accepted after save",store:false})));
  assert.equal(f.calls.at(-1).model,"candidate");
});
test("panel is reachable at v1, protected operations require same-origin control auth; generation API stays closed to browser origins",async t=>{
  const f=fixture(t);await f.selection.refresh();
  const app=createLocalServer({key,engine:f.engine,selection:f.selection});const url=await app.listen(0);t.after(()=>app.close());
  const page=await fetch(url+"/v1");assert.equal(page.status,200);assert.match(await page.text(),/ChatGPT 一般對話的原生 Auto/);
  assert.match(page.headers.get("set-cookie"),/HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(url+"/v1",{headers:{origin:"https://evil.test"}})).status,403);
  assert.equal((await fetch(url+"/v1",{headers:{"sec-fetch-site":"cross-site"}})).status,403);
  assert.equal((await fetch(url+"/v1/control/status")).status,401);
  const headers={authorization:"Bearer "+controlToken(key),"content-type":"application/json"};
  const status=await(await fetch(url+"/v1/control/status",{headers})).json();assert.equal(status.selected.id,"auto");
  assert.equal((await fetch(url+"/v1/control/select",{method:"POST",headers,body:JSON.stringify({key:"candidate"})})).status,200);
  const probe=await fetch(url+"/v1/control/probe",{method:"POST",headers,body:JSON.stringify({key:"auto"})});
  assert.equal(probe.status,200);
  assert.equal((await probe.json()).actual_model,"website-routed");
  assert.equal(f.selection.current.id,"candidate");
  assert.equal((await fetch(url+"/v1/control/probe",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({key:"auto"})})).status,401);
  assert.equal((await fetch(url+"/v1/models",{headers:{authorization:"Bearer "+key,origin:url}})).status,403);
  assert.equal((await fetch(url+"/v1/control/status",{headers:{...headers,origin:"https://evil.test"}})).status,403);
  const cookie=page.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(url+"/v1/control/status",{headers:{cookie,"sec-fetch-site":"same-origin","x-webgpt-control":"1"}})).status,200);
  assert.equal((await fetch(url+"/v1/control/status",{headers:{cookie,"sec-fetch-site":"same-origin"}})).status,401);
});
