import { interactiveLogin } from "../src/login.js";
import { dataDirectory, readSession } from "../src/settings.js";
import { publicError } from "../src/errors.js";
try {
  await interactiveLogin(dataDirectory(), { background: true, timeout: 20_000, onStatus: () => {}, onAuthenticated: async connection => {
    const browser = await connection.call("Browser.getVersion");
    const {token,cookies} = readSession(dataDirectory());
    const headers={authorization:`Bearer ${token}`,cookie:cookies.filter(c=>c.expires<=0||c.expires*1000>Date.now()).map(c=>`${c.name}=${c.value}`).join('; '),
      'user-agent':browser.userAgent,accept:'application/json',referer:'https://chatgpt.com/',
      'sec-fetch-dest':'empty','sec-fetch-mode':'cors','sec-fetch-site':'same-origin'};
    const device=cookies.find(c=>c.name==='oai-did');if(device)headers['oai-device-id']=device.value;
    const r=await fetch('https://chatgpt.com/backend-api/models',{headers,redirect:'error',signal:AbortSignal.timeout(20000)});
    const type=r.headers.get('content-type');let count;
    if(r.ok){const b=await r.json();count=b.models?.length;}else await r.body?.cancel();
    console.log(JSON.stringify({status:r.status,type,models:count,challenge:r.headers.get('cf-mitigated')==='challenge'}));
  }});
}catch(error){console.log(JSON.stringify(publicError(error)));process.exitCode=1;}
