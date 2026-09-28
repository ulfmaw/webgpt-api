import test from 'node:test';
import assert from 'node:assert/strict';
import { chatPickerCatalog, discoverChatCatalog } from '../src/transports/chat-catalog.js';

const catalog = () => ({default_model_slug:'chat', models:[
  {slug:'chat',title:'Chat',is_work_mode_model:false,thinking_efforts:[{thinking_effort:'standard'},{thinking_effort:'extended'}]},
  {slug:'internal',is_work_mode_model:false},
  {slug:'work',is_work_mode_model:true},
  {slug:'unknown'},
], versions:[{id:'example',display_text_for_intelligence:'Example',enabled:true,intelligence_presets:[
  {id:1,title:'Medium',model_slug:'chat',thinking_effort:'standard',preset_type:'available'},
  {id:2,title:'High',model_slug:'chat',thinking_effort:'extended',preset_type:'available'},
  {id:3,model_slug:'work',preset_type:'available'},
  {id:4,model_slug:'unknown',preset_type:'available'},
  {id:5,model_slug:'internal',preset_type:'upgrade'},
  {id:6,model_slug:'chat',thinking_effort:'invented',preset_type:'available'},
]}]});

test('Chat options require both picker membership and explicit Chat mode; no raw catalog fallback',()=>{
  assert.deepEqual(chatPickerCatalog(catalog()).models.map(m=>({key:m.option_key,id:m.slug,effort:m.thinking_effort})),[{key:'example:1',id:'chat',effort:'standard'},{key:'example:2',id:'chat',effort:'extended'}]);
  assert.throws(()=>chatPickerCatalog({models:catalog().models}),{code:'model_discovery_failed'});
  assert.throws(()=>chatPickerCatalog({...catalog(),versions:[]}),{code:'model_discovery_failed'});
});

test('native discovery ignores Work response and consumes only the Chat page request',async()=>{
  const handlers=new Map(); const calls=[];
  const connection={on(name,fn){handlers.set(name,fn);return()=>handlers.delete(name);},async call(name,args){
    calls.push({name,args});
    if(name==='Page.navigate'){
      for(const [requestId,path] of [['stale','/backend-api/models'],['work','/backend-api/tpp/models/'],['chat','/backend-api/models']]){
        handlers.get('Network.responseReceived')({requestId,loaderId:requestId==='stale'?'old':'current',response:{url:'https://chatgpt.com'+path,status:200}});
        handlers.get('Network.loadingFinished')({requestId});
      }
      return {loaderId:'current'};
    }
    if(name==='Network.getResponseBody'){assert.equal(args.requestId,'chat');return {body:JSON.stringify(catalog())};}
    return {};
  }};
  assert.equal((await discoverChatCatalog(connection)).models[0].slug,'chat');
  assert.equal(handlers.size,0);
  assert.equal(calls.some(c=>c.name==='Runtime.evaluate'),false);
});

test('missing native picker fails without invented models and removes observers',async()=>{
  const handlers=new Map();
  const connection={on(name,fn){handlers.set(name,fn);return()=>handlers.delete(name);},async call(){return {};}};
  await assert.rejects(discoverChatCatalog(connection,{timeout:5}),{code:'model_discovery_failed'});
  assert.equal(handlers.size,0);
});
