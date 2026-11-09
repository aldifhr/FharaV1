/**
 * The agents on a project's team. A project with no member list (or an
 * empty one) shows the whole registry, which is how the chat and the team
 * sidebar have always behaved.
 */
export function projectMembers<T extends { _id: string }>(
  allAgents: T[] | undefined,
  memberIds: string[] | undefined,
): T[] {
  const all = allAgents ?? [];
  return memberIds && memberIds.length ? all.filter((agent) => memberIds.includes(agent._id)) : all;
}
