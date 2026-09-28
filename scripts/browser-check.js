// Read-only live diagnosis; prints selected status/schema fields, never credentials.
import { interactiveLogin } from "../src/login.js";
import { dataDirectory } from "../src/settings.js";
import { publicError } from "../src/errors.js";

try {
  await interactiveLogin(dataDirectory(), {
    timeout: 60_000,
    onAuthenticated: async connection => {
      if (process.argv.includes("--inspect-ui")) {
        const ui = await connection.call("Runtime.evaluate", {
          expression: `new Promise(resolve=>setTimeout(()=>resolve([...document.querySelectorAll('textarea,[contenteditable="true"],button[data-testid]')].map(e=>({tag:e.tagName,id:e.id,testid:e.getAttribute('data-testid'),role:e.getAttribute('role'),label:e.getAttribute('aria-label')}))),3000))`,
          awaitPromise: true, returnByValue: true,
        });
        console.log(JSON.stringify({ ui: ui.result?.value }));
      }
      const result = await connection.call("Runtime.evaluate", {
        expression: `(async () => {
          const session = await (await fetch('/api/auth/session', {credentials:'include'})).json();
          const response = await fetch('/backend-api/models', {credentials:'include', headers:{authorization:'Bearer '+session.accessToken}});
          let body; try {body=await response.json();} catch {return {status:response.status,json:false};}
          return {status:response.status,json:true,hasModels:Array.isArray(body.models),defaultModel:body.default_model_slug,
            models:Array.isArray(body.models)?body.models.map(m=>m.slug).filter(m=>typeof m==='string'):[]};
        })()`,
        awaitPromise: true, returnByValue: true,
      });
      console.log(JSON.stringify(result.result?.value ?? { diagnostic: "no_result" }));
      if (process.argv.includes("--generate")) {
        const generation = await connection.call("Runtime.evaluate", {
          expression: `(async () => {
            const session=await (await fetch('/api/auth/session')).json();
            const headers={authorization:'Bearer '+session.accessToken,'content-type':'application/json'};
            const catalog=await (await fetch('/backend-api/models',{headers})).json();
            const r=await fetch('/backend-api/conversation',{method:'POST',headers,signal:AbortSignal.timeout(45000),body:JSON.stringify({action:'next',model:catalog.default_model_slug,parent_message_id:crypto.randomUUID(),history_and_training_disabled:true,messages:[{id:crypto.randomUUID(),author:{role:'user'},content:{content_type:'text',parts:['Reply only: OK']}}]})});
            const type=r.headers.get('content-type');
            if(!r.ok){let b;try{b=await r.json();}catch{}const c=b?.error?.code??b?.detail?.code;const summary=JSON.stringify(b??{}).toLowerCase();return{status:r.status,type,errorCode:typeof c==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(c)?c:null,mentions:Object.fromEntries(['sentinel','requirements','turnstile','proof','token','permission','csrf','unusual','invalid'].map(k=>[k,summary.includes(k)]))};}
            let bytes=0,text='';const reader=r.body.getReader();const decoder=new TextDecoder();
            try{while(bytes<65536){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;text+=decoder.decode(part.value,{stream:true});}}
            finally{await reader.cancel();}
            const frames=text.split('\\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim());
            return{status:r.status,type,bytes,done:frames.includes('[DONE]'),eventShapes:frames.filter(f=>f!=='[DONE]').slice(0,12).map(f=>{try{const e=JSON.parse(f);return{keys:Object.keys(e),type:e.type,hasMessage:!!e.message};}catch{return{nonJson:true};}})};
          })()`, awaitPromise: true, returnByValue: true,
        }, 50_000);
        console.log(JSON.stringify({ generation: generation.result?.value ?? { diagnostic: "no_result" } }));
      }
    },
  });
} catch (error) { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; }
