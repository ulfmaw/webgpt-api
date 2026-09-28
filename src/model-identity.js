// A requested-model echo is not proof that this model generated the response.
// Explicit selection requires matching reported identity as well.
export function matchesModelSelection(selected, reported, acknowledged) {
  if (typeof reported !== "string" || !reported || reported.length > 160) return false;
  if (acknowledged != null && acknowledged !== selected) return false;
  return reported === selected;
}

// A uniform unavailable reason is safe to surface. Mixed or free-text entries are not.
export function modelDenialReason(metadata) {
  const entries = metadata?.model_switcher_deny;
  if (!Array.isArray(entries) || !entries.length) return null;
  let reason = null;
  for (const entry of entries) {
    if (!entry || entry.is_available !== false || typeof entry.reason !== "string" || !/^[a-z_]{1,60}$/.test(entry.reason)) return null;
    if (reason && reason !== entry.reason) return null;
    reason = entry.reason;
  }
  return reason;
}
