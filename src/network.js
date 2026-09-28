import { execFileSync } from "node:child_process";
import { setGlobalProxyFromEnv } from "node:http";

export function proxyEnvironment(env, setting = "") {
  const bypass = [env.NO_PROXY, env.no_proxy, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(",");
  const output = { ...env, NO_PROXY: bypass, no_proxy: bypass };
  if (env.HTTPS_PROXY || env.HTTP_PROXY || env.https_proxy || env.http_proxy) return output;
  const entries = setting.trim().split(";");
  const address = entries.find(s => s.startsWith("https="))?.slice(6) ?? entries.find(s => s.startsWith("http="))?.slice(5) ?? (entries.length === 1 ? entries[0] : "");
  if (/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]):\d{1,5}$/.test(address)) {
    try {
      const url = new URL(`http://${address}`);
      if (Number(address.slice(address.lastIndexOf(":") + 1)) > 0) { output.HTTP_PROXY = url.href; output.HTTPS_PROXY = url.href; }
    } catch { /* Invalid/PAC configurations are not guessed. */ }
  }
  return output;
}

let configured = false;
export function configureNetwork(env = process.env) {
  if (configured) return;
  let setting = "";
  if (process.platform === "win32" && !env.HTTPS_PROXY && !env.HTTP_PROXY && !env.https_proxy && !env.http_proxy) {
    try {
      setting = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; if($p.ProxyEnable -eq 1){$p.ProxyServer}"],
      { encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { /* Browser fallback remains available; no OS settings are changed. */ }
  }
  setGlobalProxyFromEnv(proxyEnvironment(env, setting));
  configured = true;
}
