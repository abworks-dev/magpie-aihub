// Magpie can hold several accounts for the same provider, and each of them
// arrives with its own instanceId, so different accounts must keep their own
// connections. A re-login of one account arrives as a new instanceId while that
// account's previous runtime stays cached: left alone it shows up in the monitor
// as a permanently dead account, and the replacement creates a second set of
// dedicated keys for the same groups. Retire only the same account's previous
// connection, and hand its keys to the replacement.

export function adoptRuntime(runtimes, data) {
  if (!data || typeof data.instanceId !== 'string') return data;
  const managed = data.mode === 'managed';
  const inherited = [];
  for (const [id, item] of runtimes) {
    if (id === data.instanceId) continue;
    const previous = item.account.data;
    if (previous?.identity !== data.identity) continue;
    runtimes.delete(id);
    // Keys belong to the account that created them: never carry them across identities.
    if (managed && previous.mode === 'managed' && data.identity && previous.identity === data.identity) {
      inherited.push(...(previous.keys ?? []));
    }
  }
  if (!managed || !inherited.length || (data.keys?.length ?? 0) > 0) return data;
  return { ...data, keys: inherited };
}
