// Live function round trip using a fixed, harmless test function. Never executes model code.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { initialize,dataDirectory } from "../src/settings.js";
import { readSse } from "../src/sse.js";
const directory=dataDirectory(),{key}=initialize(directory),ids=[];
const tools=[{type:"function",name:"lookup_test_value",description:"Read a test value unavailable in the prompt. The caller performs this function.",parameters:{type:"object",properties:{key:{type:"string",enum:["verification"]}},required:["key"],additionalProperties:false}}];
async function post(body){const r=await fetch("http://127.0.0.1:17841/v1/responses",{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});if(!r.ok){const e=await r.json();throw Error(`HTTP ${r.status}: ${e.error?.code}`);}return r;}
try{
  const r=await post({model:"auto",input:"Call lookup_test_value with key verification. Do not guess the result.",tools,tool_choice:"required",parallel_tool_calls:false,stream:true});
  const events=[];for await(const data of readSse(r.body))events.push(JSON.parse(data));
  const done=events.findLast(e=>e.type==="response.completed");assert.ok(done);ids.push(done.response.id);
  const call=done.response.output[0];assert.equal(call.type,"function_call");assert.equal(call.name,"lookup_test_value");assert.deepEqual(JSON.parse(call.arguments),{key:"verification"});
  assert.ok(events.some(e=>e.type==="response.function_call_arguments.delta"));
  console.log(JSON.stringify({test:"live_function_sse",passed:true,model:done.response.model}));
  const secret=randomBytes(16).toString("hex");
  const answer=await(await post({model:"auto",previous_response_id:done.response.id,input:[{type:"function_call_output",call_id:call.call_id,output:secret}],tools,tool_choice:"none",instructions:"Return the exact value from lookup_test_value only, without any extra text.",store:false})).json();
  assert.equal(answer.output[0].content[0].text.trim(),secret);
  console.log(JSON.stringify({test:"live_function_result_continuation",passed:true,model:answer.model}));
  const structured=await(await post({model:"auto",input:"Return total 7, label ready and email test@example.com.",text:{format:{type:"json_schema",name:"test_result",schema:{type:"object",properties:{total:{type:"integer",const:7},label:{type:"string",pattern:"^ready$"},email:{type:"string",format:"email"}},required:["total","label","email"],additionalProperties:false},strict:true}},store:false})).json();
  assert.deepEqual(JSON.parse(structured.output[0].content[0].text),{total:7,label:"ready",email:"test@example.com"});
  console.log(JSON.stringify({test:"live_json_schema",passed:true,model:structured.model}));
}catch(error){console.error(error.message);process.exitCode=1;}
finally{if(ids.length){const db=new DatabaseSync(join(directory,"conversations.sqlite"));try{for(const id of ids)db.prepare("DELETE FROM turns WHERE id = ?").run(id);}finally{db.close();}}}
