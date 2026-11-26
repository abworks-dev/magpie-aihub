// Magpie can hold several accounts for the same provider, and each of them
// arrives with its own instanceId, so different accounts must keep their own
// connections. A re-login of one account arrives as a new instanceId while that
// account's previous runtime stays cached: left alone it shows up in the monitor
// as a permanently dead account, and the replacement creates a second set of
// dedicated keys for the same groups. Retire only the same account's previous
// connection, and hand its keys to the replacement.

// The returned auth data also carries this process-local handoff to Account.
// Keep it out of the saved auth record.
export const adoptedKeyState = new WeakMap();

export function adoptRuntime(runtimes, data) {
  if (!data || typeof data.instanceId !== 'string') return data;
  const managed = data.mode === 'managed';
  const inherited = [];
  let keyState;
  for (const [id, item] of runtimes) {
    if (id === data.instanceId) continue;
    const previous = item.account.data;
    if (previous?.identity !== data.identity) continue;
    runtimes.delete(id);
    // Keys belong to the account that created them: never carry them across identities.
    if (managed && previous.mode === 'managed' && data.identity && previous.identity === data.identity) {
      inherited.push(...(previous.keys ?? []));
      keyState ??= item.account.keyState;
    }
  }
  const adopted = managed && inherited.length && !data.keys?.length ? { ...data, keys: inherited } : data;
  if (keyState) adoptedKeyState.set(adopted, keyState);
  return adopted;
}
