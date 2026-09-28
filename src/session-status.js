// Diagnostics contain names/times only, never cookie or bearer values.
function cookieDeadline(cookies, now) {
  if (!cookies.length) return { present: false, declared_expiry: null, expiry_state: "missing" };
  const deadlines = cookies.map(cookie => cookie.expires * 1000)
    .filter(value => Number.isFinite(value) && value > 0 && value <= 8.64e15);
  const earliest = deadlines.length ? Math.min(...deadlines) : null;
  const allKnown = deadlines.length === cookies.length;
  return {
    present: true,
    declared_expiry: allKnown ? new Date(earliest).toISOString() : null,
    expiry_state: earliest !== null && earliest <= now ? "expired"
      : allKnown ? "not_expired" : "unknown",
  };
}

export function sessionStatus(session, now = Date.now()) {
  const cookies = session.cookies ?? [];
  const authentication = cookies.filter(cookie => /^__Secure-(?:next-auth|authjs)\.session-token(?:\.\d+)?$/.test(cookie.name));
  return {
    present: Boolean(session.token || cookies.length),
    type: session.token ? "access_token" : "cookies",
    cookie_count: cookies.length,
    access_token_declared_expiry: session.deadline ?? null,
    session_cookie: cookieDeadline(authentication, now),
    clearance_cookie: cookieDeadline(cookies.filter(cookie => cookie.name === "cf_clearance"), now),
    bot_management_cookie: cookieDeadline(cookies.filter(cookie => cookie.name === "__cf_bm"), now),
    server_validity: "not_verified",
    note: "Declared expiry is not guaranteed usability. Website verification and server-side revocation are independent.",
  };
}
