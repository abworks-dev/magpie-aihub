// Magpie keeps exactly one connection per provider, so a fresh sign-in always
// arrives as a new instanceId while the previous runtime stays cached. Left
// alone it shows up in the monitor as a permanently dead account, and the
// replacement creates a second set of dedicated keys for the same groups.
// Retire the previous connection and, when it is the same person, hand its keys
// to the replacement.

export function adoptRuntime(runtimes, data) {
  if (!data || typeof data.instanceId !== 'string') return data;
  const managed = data.mode === 'managed';
  const inherited = [];
  for (const [id, item] of runtimes) {
    if (id === data.instanceId) continue;
    const previous = item.account.data;
    runtimes.delete(id);
    // Keys belong to the account that created them: never carry them across identities.
    if (managed && previous.mode === 'managed' && data.identity && previous.identity === data.identity) {
      inherited.push(...(previous.keys ?? []));
    }
  }
  if (!managed || !inherited.length || (data.keys?.length ?? 0) > 0) return data;
  return { ...data, keys: inherited };
}
