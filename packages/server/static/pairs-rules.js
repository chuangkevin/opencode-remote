// /pairs dashboard visibility rules — single source of truth.
//
// Shared by the /pairs client (packages/server/static/pairs.js) and the
// /remote-sessions 夥伴 badge (fetches /api/pairs, counts dashboard-visible).
// Pure functions, no DOM: safe to import from browsers and Node tests.
//
// Dashboard shows pairs that still need attention:
//   1. status busy / ask -> always visible
//   2. error -> archived immediately
//   3. non-busy/non-ask idle -> archived after 2 hours
//   4. accepted -> visible only if active within 30 min (unless archived)
// The list view shows everything newest first.

export const DASHBOARD_ACTIVE_MS = 30 * 60 * 1000;
export const DASHBOARD_IDLE_MS = 2 * 60 * 60 * 1000;
export const PAIR_ARCHIVE_MS = DASHBOARD_IDLE_MS;

export function archivedPair(pair, now = Date.now()) {
  if (pair.status === "busy" || pair.status === "ask") return false;
  if (pair.status === "error") return true;
  return now - pair.lastActivityAt > PAIR_ARCHIVE_MS;
}

export function dashboardVisible(pair, now = Date.now()) {
  if (archivedPair(pair, now)) return false;
  if (pair.status === "busy" || pair.status === "ask") return true;
  const accepted = pair.acceptedAt !== undefined && pair.acceptedAt !== null;
  if (accepted) return now - pair.lastActivityAt < DASHBOARD_ACTIVE_MS;
  if (pair.status === "error") return true;
  return now - pair.lastActivityAt < DASHBOARD_IDLE_MS;
}

export function visiblePairs(pairs, view, now = Date.now()) {
  const sorted = [...pairs].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  if (view === "archived") return sorted.filter((p) => archivedPair(p, now));
  if (view === "list") return sorted.filter((p) => !archivedPair(p, now));
  return sorted.filter((p) => dashboardVisible(p, now));
}
