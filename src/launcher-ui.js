/* Browser-only launcher; credentials never enter page markup or logs. */
const fragment = location.hash.slice(1);
if (fragment) { sessionStorage.setItem("launcher-token", fragment); history.replaceState(null, "", "/"); }
const token = sessionStorage.getItem("launcher-token");
const element = id => document.getElementById(id);
let stopped = false;
async function request(path, method = "GET") {
  const response = await fetch(path, { method, headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(response.status === 401 ? "請重新雙擊 start.cmd 開啟控制台。" : "操作未完成，請稍後再試。");
  return response.json();
}
const labels = { starting: "啟動中", checking: "正在測試實際生成…", login: "等候登入", ready: "可用：本次生成測試通過", blocked: "尚不可用：連線或生成失敗" };
const explanations = {
  web_verification_required: "網站尚未接受目前的 API 請求；這不代表你沒登入或 Cookie 已到期。重登不一定能解決，程式不會自動反覆開登入視窗。",
  session_required: "尚未登入。按「登入／更新登入」開始。",
  session_expired: "目前憑證已到期，請按「登入／更新登入」。",
  session_rejected: "目前憑證未被接受，請更新登入。",
  login_timeout: "登入尚未完成；沒有自動重開視窗。準備好後可再按登入。",
};
async function refresh() {
  if (stopped) return;
  try {
    const state = await request("/status");
    element("status").textContent = labels[state.phase] ?? state.phase;
    element("detail").textContent = state.error ? `${explanations[state.error.code] ?? state.error.message}\n${state.error.code}` : state.message ?? (state.generation_verified ? `測試實際使用模型：${state.actual_model ?? '未回報'}。可將下方網址與金鑰填入工作台；背景瀏覽器閒置後會自動關閉。` : "只有收到完整文字回覆，才會顯示生成測試通過。");
    element("url").textContent = state.api_url;
    for (const id of ["login", "check"]) element(id).disabled = ["login", "checking", "starting"].includes(state.phase);
  } catch (error) { element("status").textContent = "無法連上本機啟動器"; element("detail").textContent = error.message; }
  if (!stopped) setTimeout(refresh, 1500);
}
function action(id, fn) {
  element(id).onclick = async () => {
    try { await fn(); } catch (error) { element("notice").textContent = error.message; }
  };
}
action("login", () => request("/login", "POST"));
action("check", () => request("/check", "POST"));
action("copy-url", async () => { await navigator.clipboard.writeText(element("url").textContent); element("notice").textContent = "網址已複製。貼到程式的 API 位址，結尾要有 /v1。"; });
action("copy-key", async () => { const { key } = await request("/key", "POST"); await navigator.clipboard.writeText(key); element("notice").textContent = "本機 API Key 已複製。貼到程式的 API Key，不要公開。"; });
action("stop", async () => {
  await request("/stop", "POST"); stopped = true;
  element("status").textContent = "服務已收到停止指令";
  for (const button of document.querySelectorAll("button")) button.disabled = true;
});
void refresh();
