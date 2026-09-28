// Real Codex client, local provider only. Never prints its raw logs or credentials.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, dataDirectory } from "../src/settings.js";
import { createServer } from "node:http";
import { once } from "node:events";
const {key}=initialize(dataDirectory());
const directory=mkdtempSync(join(tmpdir(),"webgpt-client-check-"));
const withTool=process.argv.includes("--tool");
if (process.argv.includes("--plan")) throw Error("This CLI does not advertise update_plan; use the text or --tool check.");
const expected=withTool?randomBytes(16).toString("hex"):"CLIENT-CHECK-OK";
if(withTool)writeFileSync(join(directory,"marker.txt"),expected,{mode:0o600});
const shapes=[];
const proxy=createServer(async(req,res)=>{
  const abort=new AbortController();res.on('close',()=>{if(!res.writableFinished)abort.abort();});
  try {
    if(req.headers.authorization!==`Bearer ${key}`){res.writeHead(401);res.end();return;}
    if(req.method!=="POST"||req.url!=="/v1/responses"){res.writeHead(404);res.end();return;}
    let size=0;const chunks=[];
    for await(const part of req){size+=part.length;if(size>2*1024*1024)throw Error();chunks.push(part);}
    const body=Buffer.concat(chunks);const data=JSON.parse(body);
    const results=(data.input??[]).filter(x=>x.type==='function_call_output').map(x=>String(x.output??''));
    if(results.some(x=>x.includes('blocked by policy'))){policyBlocked=true;res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'client_execution_policy_blocked',message:'Client execution policy denied the tool. Test stopped without changing permissions.'}}));setImmediate(()=>child.kill());return;}
    if(withTool&&results.some(x=>x.includes(expected)))toolExecuted=true;
    shapes.push({fields:Object.keys(data),tool_types:[...new Set((data.tools??[]).map(t=>t.type))],tool_names:(data.tools??[]).map(t=>t.name),input_types:[...new Set((data.input??[]).map(m=>m.type??"message"))],calls:(data.input??[]).filter(x=>x.type==='function_call').map(x=>({name:x.name})),tool_result_has_marker:results.some(x=>x.includes(expected)),tool_result_flags:[...new Set(results.flatMap(x=>['sandbox','denied','not found','timed out','requires','invalid','not supported'].filter(flag=>x.toLowerCase().includes(flag))))],reasoning:data.reasoning,include:data.include,tool_choice:data.tool_choice,parallel_tool_calls:data.parallel_tool_calls});
    console.log(JSON.stringify({client_request:shapes.length,result_has_marker:shapes.at(-1).tool_result_has_marker,result_flags:shapes.at(-1).tool_result_flags}));
    const response=await fetch("http://127.0.0.1:17841/v1/responses",{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(90000)])});
    if(!response.ok){const diagnostic=await response.clone().json().catch(()=>null);const code=diagnostic?.error?.code;console.log(JSON.stringify({gateway_status:response.status,...(typeof code==='string'&&/^[a-z_]{1,80}$/.test(code)?{gateway_code:code}:{})}));}
    res.writeHead(response.status,{"content-type":response.headers.get("content-type")??"application/json"});
    for await(const part of response.body){if(!res.write(part))await once(res,"drain");}res.end();
  }catch{res.writeHead(502);res.end();}
});
proxy.listen(0,"127.0.0.1");await once(proxy,"listening");
const providerBase=`http://127.0.0.1:${proxy.address().port}/v1`;
const args=["exec","--ignore-user-config","--ephemeral","--skip-git-repo-check","--sandbox","read-only","--json","--color","never","-C",directory,
  "-c",'model_provider="webgpt_local_test"',"-c",'model="auto"',
  "-c",`model_providers.webgpt_local_test={name="webgpt-local-test",base_url="${providerBase}",env_key="WEBGPT_CLIENT_TEST_KEY",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
  "-c","features.hooks=false","-c","features.apps=false","-c","features.remote_plugin=false","-c","features.multi_agent=false","-c",'web_search="disabled"',
  withTool?"Use your local file-reading or terminal tool to read marker.txt in the working directory. It contains a random marker that is not in this prompt. Return the exact marker only. Do not guess, do not edit files, and do not ask the user to read it.":"Reply only CLIENT-CHECK-OK. Do not call tools or inspect files."];
const child=spawn("codex",args,{cwd:directory,windowsHide:true,env:{...process.env,WEBGPT_CLIENT_TEST_KEY:key},stdio:["ignore","pipe","pipe"]});
let buffer="",errorCount=0,success=false,unsupported=new Set(),timedOut=false,eventBuffer="",toolExecuted=false,policyBlocked=false;
function inspect(chunk){
  // Only extract fixed diagnostic markers from bounded in-memory output.
  buffer=(buffer+chunk.toString()).slice(-65536);
  for(const match of buffer.matchAll(/Unsupported option:\s*([a-z_]+)/g))unsupported.add(match[1]);
  errorCount=(buffer.match(/"type"\s*:\s*"(?:error|turn.failed)"/g)??[]).length;
}
child.stdout.on("data",chunk=>{
  inspect(chunk);eventBuffer+=chunk.toString();const lines=eventBuffer.split(/\r?\n/);eventBuffer=lines.pop();
  for(const line of lines){try{const e=JSON.parse(line);if(e.type==='item.completed'&&e.item?.type==='agent_message'&&e.item.text?.trim()===expected)success=true;if(e.type==='item.completed'&&e.item?.type==='command_execution'&&e.item.exit_code===0)toolExecuted=true;}catch{}}
});child.stderr.on("data",inspect);
const timer=setTimeout(()=>{timedOut=true;child.kill();},180000);
child.on("error",()=>{clearTimeout(timer);proxy.close();proxy.closeAllConnections();console.log(JSON.stringify({client:"codex",started:false}));process.exitCode=1;});
child.on("close",code=>{clearTimeout(timer);proxy.close();proxy.closeAllConnections();const passed=code===0&&success&&(!withTool||toolExecuted);console.log(JSON.stringify({client:"codex",test:withTool?"tool_read_random_file":"text",passed,exit_code:code,timed_out:timedOut,policy_blocked:policyBlocked,answer_received:success,tool_executed:toolExecuted,unsupported_options:[...unsupported],reported_errors:errorCount,request_shapes:shapes.slice(0,3)}));process.exitCode=passed?0:1;});
