import { readSession } from "./settings.js";
import { Credentials } from "./credentials.js";
import { Fault } from "./errors.js";

const authName = /^__Secure-(?:next-auth|authjs)\.session-token(?:\.\d+)?$/;
export async function restoreBrowserSession(connection, directory, { verify, now = Date.now() } = {}) {
  const session = readSession(directory, {});
  // Restore only existing login cookies, never verification/clearance cookies.
  const cookies = session.cookies.filter(cookie => authName.test(cookie.name) && (cookie.expires <= 0 || cookie.expires * 1000 > now));
  if (!cookies.length) throw new Fault(401, "session_required", "The dedicated browser is signed out and no usable saved login cookies are available.");
  const exchange = verify ?? ((cookie, ua) => new Credentials(directory).exchange(cookie, ua));
  await exchange(cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; "), session.userAgent);
  const existing = await connection.call("Network.getAllCookies");
  for (const cookie of existing.cookies ?? []) {
    if (["chatgpt.com", ".chatgpt.com"].includes(cookie.domain) && authName.test(cookie.name) && !cookies.some(saved => saved.name === cookie.name && saved.domain === cookie.domain && saved.path === cookie.path)) {
      await connection.call("Network.deleteCookies", { name: cookie.name, domain: cookie.domain, path: cookie.path });
    }
  }
  await connection.call("Network.setCookies", { cookies: cookies.map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: true, httpOnly: true, sameSite: "Lax", ...(cookie.expires > 0 ? { expires: cookie.expires } : {}) })) });
}
