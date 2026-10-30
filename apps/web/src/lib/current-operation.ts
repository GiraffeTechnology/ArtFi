/** A continuation belongs to one committed screen and its original terms. Retirement is final. */
export function currentOperation() {
  let active = true;
  return {
    isCurrent: () => active,
    retire() {
      active = false;
    },
    assertCurrent() {
      if (!active)
        throw new Error(
          "The screen, wallet, session or terms changed. No further wallet request was made.",
        );
    },
  };
}

/** A receipt read and its follow-up queries must still belong to the displayed terms. */
export async function reconcileCurrentView<T>({
  isCurrent,
  read,
  refresh,
  publish,
  fail,
}: {
  isCurrent: () => boolean;
  read: () => Promise<T>;
  refresh: () => Promise<unknown>;
  publish: (result: T) => void;
  fail: (error: unknown) => void;
}) {
  try {
    const result = await read();
    if (!isCurrent()) return;
    await refresh();
    if (isCurrent()) publish(result);
  } catch (error) {
    if (isCurrent()) fail(error);
  }
}
