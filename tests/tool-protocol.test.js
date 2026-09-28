import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTools, decodeToolReply } from "../src/tool-protocol.js";
import { checkSchema, matchesSchema } from "../src/json-schema.js";
import { Engine, validateRequest } from "../src/engine.js";
import { ConversationStore } from "../src/state.js";
import { createLocalServer } from "../src/http.js";
import { readSse } from "../src/sse.js";
const tool={type:"function",name:"read_marker",parameters:{type:"object",properties:{path:{type:"string",enum:["marker.txt"]}},required:["path"],additionalProperties:false}};
const protocol=normalizeTools({tools:[tool],tool_choice:"required",parallel_tool_calls:false});
test("tool protocol validates function names, arguments, choice and parallelism before dispatch",()=>{
  const result=decodeToolReply(JSON.stringify({reply:null,actions:[{name:"read_marker",args:{path:"marker.txt"}}]}),protocol);
  assert.equal(result.items[0].type,"function_call");assert.match(result.items[0].call_id,/^call_/);
  for(const value of [
    {reply:null,actions:[{name:"unknown",args:{path:"marker.txt"}}]},
    {reply:null,actions:[{name:"read_marker",args:{path:"other"}}]},
    {reply:null,actions:[{name:"read_marker",args:{path:"marker.txt",extra:true}}]},
    {reply:"done",actions:[]},
    {reply:null,actions:[{name:"read_marker",args:{path:"marker.txt"}},{name:"read_marker",args:{path:"marker.txt"}}]},
  ])assert.throws(()=>decodeToolReply(JSON.stringify(value),protocol),{code:"invalid_tool_response"});
  assert.throws(()=>decodeToolReply("not JSON",protocol));
});
test("schema validation handles nested objects, refs and alternatives without accepting unsupported keywords",()=>{
  const schema={$defs:{positive:{type:"integer",minimum:1}},type:"object",properties:{values:{type:"array",minItems:1,uniqueItems:true,items:{$ref:"#/$defs/positive"}},name:{anyOf:[{type:"null"},{type:"string",minLength:2}]}},required:["values"],additionalProperties:false};
  checkSchema(schema);assert.equal(matchesSchema({values:[1,2],name:null},schema),true);
  for(const v of [{values:[0]},{values:[1,1]},{values:[],name:"x"},{values:[1],extra:1}])assert.equal(matchesSchema(v,schema),false);
  assert.throws(()=>checkSchema({type:"string",madeUpKeyword:true}),{code:"invalid_tool_schema"});
  assert.throws(()=>checkSchema({$ref:"https://example.test/schema"}),{code:"unsupported_schema_ref"});
});
async function fixture(t){
  const store=new ConversationStore(":memory:");const requests=[];
  const transport={models:async()=>[{id:"test",default:true}],async *generate(r){requests.push(r);const task=JSON.parse(r.messages[0].content);const last=task.conversation.at(-1);const value=last.type==="function_call_output"?{reply:last.output,actions:[]}:{reply:null,actions:[{name:"read_marker",args:{path:"marker.txt"}}]};yield{text:JSON.stringify(value),model:"test"};}};
  const engine=new Engine(transport,store);const key="test-only-local-tool-key-000000000000";const app=createLocalServer({engine,key});const url=await app.listen(0);
  t.after(async()=>{await app.close();store.close();});
  const post=async(path,body)=>fetch(url+path,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:JSON.stringify(body)});
  return{store,engine,requests,post};
}
test("Responses function calls persist and tool results resume with the same call_id",async t=>{
  const f=await fixture(t);const first=await(await f.post("/v1/responses",{input:"Read marker",tools:[tool],tool_choice:"required"})).json();
  assert.equal(first.status,"completed");const call=first.output[0];assert.equal(call.type,"function_call");
  const second=await(await f.post("/v1/responses",{input:[{type:"function_call_output",call_id:call.call_id,output:"OBSERVED-MARKER"}],previous_response_id:first.id,tools:[tool]})).json();
  assert.equal(second.output[0].content[0].text,"OBSERVED-MARKER");
  const context=JSON.parse(f.requests[1].messages[0].content).conversation;assert.equal(context[1].call_id,context[2].call_id);
  const bad=await f.post("/v1/responses",{input:[{type:"function_call_output",call_id:"wrong",output:"bad"}],tools:[tool]});assert.equal(bad.status,400);
});
test("Responses SSE sends function events and never text placeholder items for calls",async t=>{
  const {post}=await fixture(t);const r=await post("/v1/responses",{input:"Read marker",tools:[tool],stream:true});const events=[];
  for await(const data of readSse(r.body))events.push(JSON.parse(data));
  assert.ok(events.some(e=>e.type==="response.function_call_arguments.delta"));
  assert.ok(events.some(e=>e.type==="response.function_call_arguments.done"));
  assert.equal(events.some(e=>e.type==="response.content_part.added"),false);
  const done=events.at(-1);assert.equal(done.type,"response.completed");assert.equal(done.response.output[0].type,"function_call");
  assert.equal(events.find(e=>e.type==="response.output_item.added").item.call_id,done.response.output[0].call_id);
});
test("Chat Completions tool calls round-trip through role tool messages",async t=>{
  const {post}=await fixture(t);const tools=[{type:"function",function:{name:tool.name,parameters:tool.parameters}}];
  const first=await(await post("/v1/chat/completions",{messages:[{role:"user",content:"read"}],tools})).json();
  assert.equal(first.choices[0].finish_reason,"tool_calls");const message=first.choices[0].message;
  const second=await(await post("/v1/chat/completions",{messages:[{role:"user",content:"read"},message,{role:"tool",tool_call_id:message.tool_calls[0].id,content:"RESULT"}],tools})).json();
  assert.equal(second.choices[0].message.content,"RESULT");
});
test("reasoning effort is ignored and optional summary and metadata hints are accepted",()=>{
  assert.equal(validateRequest({input:"test",reasoning:{effort:"high"}}).model,"auto");
  assert.doesNotThrow(()=>validateRequest({input:"test",tools:[tool],reasoning:{summary:"auto"},include:["reasoning.encrypted_content"],client_metadata:{},prompt_cache_key:"test"}));
});
test("structured output accepts only JSON matching the declared schema",()=>{
  const p=normalizeTools({});const f={type:"json_schema",schema:{type:"object",properties:{total:{type:"integer"}},required:["total"],additionalProperties:false}};
  assert.equal(decodeToolReply(JSON.stringify({reply:'{"total":7}',actions:[]}),p,f).text,'{"total":7}');
  for(const reply of ['{"total":"7"}','not-json','{"total":7,"extra":true}'])assert.throws(()=>decodeToolReply(JSON.stringify({reply,actions:[]}),p,f),{code:"invalid_structured_output"});
  assert.throws(()=>checkSchema({maxLength:"unknown"}),{code:"invalid_tool_schema"});
  assert.throws(()=>checkSchema({multipleOf:0}),{code:"invalid_tool_schema"});
});
test("malformed or interrupted tool replies never dispatch partial calls or save a completed row",async t=>{
  const store=new ConversationStore(":memory:");t.after(()=>store.close());
  const transport={models:async()=>[{id:"test"}],async *generate(){yield{text:'{"reply":null,"actions":[',model:"test"};throw Error("synthetic interruption");}};
  const engine=new Engine(transport,store),seen=[];
  await assert.rejects(async()=>{for await(const e of engine.run(validateRequest({input:"test",tools:[tool]})))seen.push(e);});
  assert.deepEqual(seen,[]);assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM turns").get().n,0);
});
test("parallel tools require complete valid calls and distinct call IDs",()=>{
  const p=normalizeTools({tools:[tool],parallel_tool_calls:true});
  const result=decodeToolReply(JSON.stringify({reply:null,actions:[{name:"read_marker",args:{path:"marker.txt"}},{name:"read_marker",args:{path:"marker.txt"}}]}),p);
  assert.equal(result.items.length,2);assert.notEqual(result.items[0].call_id,result.items[1].call_id);
  const none=normalizeTools({tools:[tool],tool_choice:"none"});
  assert.throws(()=>decodeToolReply(JSON.stringify({reply:null,actions:[{name:"read_marker",args:{path:"marker.txt"}}]}),none));
});
