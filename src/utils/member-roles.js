function getMemberRoleIds(member) {
  if (Array.isArray(member?.roles)) return new Set(member.roles);
  if (member?.roles?.cache) return new Set(member.roles.cache.keys());
  return null;
}

module.exports = { getMemberRoleIds };
