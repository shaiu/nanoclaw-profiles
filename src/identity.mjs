export function resolveViewer(email, { users, hiddenGroups, nanoclaw }) {
  const normalized = String(email ?? '').toLowerCase();
  const userId = users[normalized];
  if (!userId) return null;
  const groups = nanoclaw.listAgentGroups();
  const roles = nanoclaw.getRoles(userId);
  const isOwner = roles.some((r) => r.role === 'owner');
  let visible;
  if (isOwner) {
    visible = groups;
  } else {
    const hidden = new Set(hiddenGroups);
    const globalAdmin = roles.some((r) => r.role === 'admin' && r.agentGroupId === null);
    const ids = new Set([
      ...roles.filter((r) => r.role === 'admin' && r.agentGroupId).map((r) => r.agentGroupId),
      ...nanoclaw.getMemberships(userId),
    ]);
    visible = groups.filter((g) => !hidden.has(g.folder) && (globalAdmin || ids.has(g.id)));
  }
  return { email: normalized, userId, isOwner, groups: visible };
}
