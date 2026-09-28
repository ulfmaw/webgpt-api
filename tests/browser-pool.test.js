import test from "node:test";
import assert from "node:assert/strict";
import { BrowserPool } from "../src/browser-pool.js";
import { prepareWebsiteBody } from "../src/transports/browser.js";
import { setTimeout as delay } from "node:timers/promises";

test("browser pool reuses one worker, serializes jobs and releases idle resources", async () => {
  let opens=0, closes=0, active=0, peak=0;
  const pool=new BrowserPool("unused",{idleMs:10,login:async(_,options)=>{
    opens++; assert.equal(options.background,true);
    const connection={closed:false};
    try{await options.onAuthenticated(connection);}finally{connection.closed=true;closes++;}
  }});
  try{
    await Promise.all([1,2,3].map(()=>pool.run(async()=>{active++;peak=Math.max(peak,active);await delay(2);active--;})));
    assert.equal(opens,1);assert.equal(peak,1);
    await delay(40);assert.equal(closes,1);
    await pool.run(async()=>{});assert.equal(opens,2);
  }finally{await pool.close();}
  assert.equal(closes,2);
});

test("background login failure is surfaced without an automatic visible-window retry", async () => {
  let count=0;
  const pool=new BrowserPool("unused",{login:async()=>{count++;throw Object.assign(new Error("timeout"),{code:"login_timeout"});}});
  await assert.rejects(pool.run(async()=>{}),{code:"background_session_unverified",status:503});
  assert.equal(count,1);await pool.close();
});

test("website body preserves full history, exact model and native authentication preparation", () => {
  const original={model:"old",conversation_id:"old-thread",client_prepare_state:{opaque:"test-only"},messages:[{id:"native-user-id"}]};
  const messages=[{role:"user",content:"marker"},{role:"assistant",content:"remembered"},{role:"user",content:"which marker?"}];
  const updated=prepareWebsiteBody(original,"/backend-api/f/conversation",{model:"new-model",messages,instructions:"Be brief"});
  assert.deepEqual(updated.messages.map(m=>({role:m.author.role,content:m.content.parts[0]})),[{role:"system",content:"Be brief"},...messages]);
  assert.equal(updated.messages.at(-1).id,"native-user-id");
  assert.equal(updated.model,"new-model");assert.equal(updated.is_do_not_remember,true);
  assert.equal(updated.conversation_id,undefined);
  assert.deepEqual(updated.client_prepare_state,original.client_prepare_state);
  assert.equal(original.model,"old");assert.equal(original.messages.length,1);
});
test("native Auto is sent literally and never inherits a saved draft reasoning setting", () => {
  const original={model:"old-pro",thinking_effort:"max",messages:[{id:"test-message"}]};
  const body=prepareWebsiteBody(original,"/backend-api/f/conversation",{model:"auto",messages:[{role:"user",content:"test"}]});
  assert.equal(body.model,"auto");assert.equal(body.thinking_effort,undefined);
  assert.equal(original.model,"old-pro");assert.equal(original.thinking_effort,"max");
});

test("init and generation use the same selected model and preset effort",()=>{
  const original={requested_default_model:'old-model',conversation_id:null};
  assert.deepEqual(prepareWebsiteBody(original,'/backend-api/conversation/init',{model:'chosen'}),{requested_default_model:'chosen',conversation_id:null});
  assert.equal(prepareWebsiteBody(original,'/backend-api/conversation/init',{model:'auto'}).requested_default_model,null);
  const request={model:'chosen',thinking_effort:'extended',messages:[{role:'user',content:'test'}]};
  for(const path of ['/backend-api/f/conversation/prepare','/backend-api/f/conversation']){
    const body=prepareWebsiteBody({model:'old',thinking_effort:'max'},path,request);
    assert.equal(body.model,'chosen');assert.equal(body.thinking_effort,'extended');
    assert.equal(prepareWebsiteBody(body,path,{...request,thinking_effort:undefined}).thinking_effort,undefined);
  }
});
