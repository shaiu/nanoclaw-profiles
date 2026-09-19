export function resolveViewer(email, { users, hiddenGroups, nanoclaw }) {
  const normalized = String(email ?? '').toLowerCase();
  const userId = users[normalized];
  if (!userId) return null;
  const groups = nanoclaw.listAgentGroups();
  const roles = nanoclaw.getRoles(userId);
  const isOwner = roles.some((r) => r.role === 'owner');
  const hidden = new Set(hiddenGroups);
  let visible;
  if (isOwner) {
    visible = groups.filter((g) => !hidden.has(g.folder));
  } else {
    const globalAdmin = roles.some((r) => r.role === 'admin' && r.agentGroupId === null);
    const ids = new Set([
      ...roles.filter((r) => r.role === 'admin' && r.agentGroupId).map((r) => r.agentGroupId),
      ...nanoclaw.getMemberships(userId),
    ]);
    visible = groups.filter((g) => !hidden.has(g.folder) && (globalAdmin || ids.has(g.id)));
  }
  // `reachable` governs direct-URL access (e.g. /agents/<folder>): owners can still open a
  // hidden group's profile by its exact URL, even though it's excluded from their list.
  // Non-owners get no such backdoor — a hidden group stays a 404 for them either way.
  const reachable = isOwner ? groups : visible;
  return { email: normalized, userId, isOwner, groups: visible, reachable };
}
