const el = id => document.getElementById(id);
let stopped = false, acting = false, signature = "", pendingAction = null, latestState = null;
const hints = {
  session_required: "尚未登入，請按「登入／更新登入」。",
  background_session_unverified: "背景頁面未能及時確認登入。可能是連線、網站驗證或登入狀態問題，尚不能判定憑證已失效；可先重新測試。",
  session_expired: "登入憑證已過期，請更新登入後刷新。",
  session_rejected: "網站未接受目前登入，請更新登入後再試。",
  model_not_available: "刷新後的帳號清單沒有此模型。若會員或帳號狀態改變，請更新登入後刷新。",
  model_substituted: "網站回報的模型與指定模型不符，這次未套用。請求名稱的回顯不代表指定模型已生效。",
  unsupported_account_sharing: "網站接受了指定模型的請求名稱，但以帳號共用限制拒絕目前可選模型，並改用較小的模型。這次沒有保存，也不會把回顯當成選模成功。",
  model_discovery_failed: "無法取得 Chat 模式的模型選單，請重試刷新。系統不會以 Work 或通用模型清單代替。",
  web_generation_rejected: "網站拒絕本次生成。尚不能確定是額度、權限或其他問題；請刷新狀態後再試，重登不保證能解決。",
  web_verification_required: "網站要求驗證或拒絕請求。重登不一定能解決；不會自動換成其他模型。",
};
async function request(action, body) {
  const r = await fetch(`/v1/control/${action}`, { method: body === undefined ? "GET" : "POST", headers: { "x-webgpt-control": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await r.json();
  if (!r.ok) { const code = value.error?.code; const hint = value.error?.reason === "unsupported_account_sharing" ? hints.unsupported_account_sharing : hints[code]; throw Error(`${hint ?? value.error?.message ?? '操作失敗，請重新開啟此頁。'}${code ? '\n'+code : ''}`); }
  return value;
}
function render(state) {
  latestState = state;
  const labels = { starting:"啟動中", checking:"正在測試生成…", login:"等待完成登入…", ready:"服務已啟動", blocked:"需要處理連線或模型問題" };
  el("status").textContent = labels[state.phase] ?? state.phase;
  const selectionStatus = { verified: "目前設定已在最近一次測試中成功", account_reported: "Chat 選單已提供目前模型；尚未測試生成，可按「測試目前模型」。", failed: "目前模型最近一次測試失敗，請重新測試或切換模型。", not_reported: "目前設定已不在最新 Chat 選單中", not_refreshed: "尚未取得 Chat 模型選單" }[state.selected_status] ?? "尚未取得帳號模型狀態";
  el("detail").textContent = state.error ? (hints[state.error.code] ?? state.error.message) : state.message ?? (state.generation_verified ? `最近一次成功測試回報模型：${state.selected_actual_model}。${selectionStatus}` : selectionStatus);
  if (pendingAction && !["starting", "login", "checking"].includes(state.phase)) {
    el("notice").className = state.generation_verified ? "success" : "error";
    el("notice").textContent = state.generation_verified ? `${pendingAction === "login" ? "登入更新完成，清單已同步" : "目前模型測試完成"}；實際回報：${state.selected_actual_model}。` : (hints[state.error?.code] ?? state.error?.message ?? selectionStatus);
    pendingAction = null;
  }
  el("selected").textContent = state.selected?.label ?? "尚未選擇";
  el("url").textContent = state.api_url ?? location.origin + "/v1";
  el("catalog-time").textContent = state.checked_at ? `清單刷新時間：${new Date(state.checked_at).toLocaleString()}` : "登入後會刷新清單。";
  const next = JSON.stringify(state.options);
  if (next !== signature) {
    const old = el("models").value; el("models").replaceChildren();
    const optionStatus = { verified: "（生成成功）", account_reported: "（Chat 選單提供）", failed: "（最近測試失敗）", not_reported: "（目前未回報）" };
    const groups = new Map();
    for (const item of state.options ?? []) {
      const option = document.createElement("option"); option.value = item.key;
      const suffix = optionStatus[item.status] ?? "";
      option.textContent = `${item.preset ?? item.label}${suffix}`;
      if (item.group) {
        if (!groups.has(item.group)) { const group=document.createElement("optgroup"); group.label=item.group; groups.set(item.group,group); el("models").append(group); }
        groups.get(item.group).append(option);
      } else el("models").append(option);
    }
    el("models").value = state.options?.some(x=>x.key===old) ? old : state.selected?.key ?? "auto";
    signature = next;
  }
  for (const id of ["select","refresh","login","check"]) el(id).disabled = acting || state.busy || ["starting","login","checking"].includes(state.phase);
  renderChoice();
}
function renderChoice() {
  const option = latestState?.options?.find(item => item.key === el("models").value);
  if (!option) { el("choice-detail").textContent = "尚未取得此選項的狀態。"; return; }
  const status = option.status === "verified" ? `生成成功，實際模型：${option.actual_model}`
    : option.status === "failed" ? `最近測試失敗：${hints[option.error?.code] ?? option.error?.code ?? "請重試"}`
    : "帳號已提供此選項，尚未實測生成；不需要因此重新登入。";
  const denial = option.error?.reason === "unsupported_account_sharing" ? "網站原因：帳號共用限制。" : "";
  el("choice-detail").textContent = `${option.label}：${status}${option.error?.actual_model ? ` 實際回報：${option.error.actual_model}。` : ""}${denial}${option.at ? `（${new Date(option.at).toLocaleString()}）` : ""}`;
}
el("models").onchange = renderChoice;
async function poll() {
  if (stopped) return;
  try { render(await request("status")); } catch (e) { el("detail").textContent = e.message; }
  if (!stopped) setTimeout(poll, 2000);
}
function action(id, fn) { el(id).onclick = async () => {
  if (acting) return;
  acting = true; el("notice").className = ""; el("notice").textContent = id === "select" ? "正在測試所選模型，完成前保留原設定…" : "處理中…";
  for (const button of ["select", "refresh", "login", "check"]) el(button).disabled = true;
  try { await fn(); } catch(e) { el("notice").className="error"; el("notice").textContent=e.message; }
  finally { acting=false; if(!stopped) try { render(await request("status")); } catch {} }
}; }
action("select", async()=>{ const s=await request("select",{key:el("models").value}); el("notice").className="success"; el("notice").textContent=`已保存：${s.selected.label}。這次實際回報：${s.actual_model}。`; });
action("refresh", async()=>{await request("refresh",{});el("notice").textContent="清單已刷新；不會因刷新而更換目前設定。";});
action("login", async()=>{await request("login",{});pendingAction="login";el("notice").textContent="正在更新登入，完成後會自動刷新清單並測試目前模型。";});
action("check", async()=>{await request("check",{});pendingAction="check";el("notice").textContent="正在測試目前選擇。";});
action("copy-url", async()=>{await navigator.clipboard.writeText(location.origin+"/v1");el("notice").textContent="API 網址已複製。貼到程式的 API 位址，結尾要有 /v1。";});
action("copy-key", async()=>{const {key}=await request("key",{});await navigator.clipboard.writeText(key);el("notice").textContent="本機 API Key 已複製。貼到程式的 API Key，不要公開。";});
action("stop", async()=>{await request("stop",{});stopped=true;el("notice").textContent="已送出停止指令。";for(const b of document.querySelectorAll("button"))b.disabled=true;});
void poll();
