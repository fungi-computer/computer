/** Wait for the actual SDK receipt, or fail when dispatch ends without one. */
export async function waitForNativeHandle(
  received: Promise<void>,
  settled: Promise<void>,
): Promise<void> {
  await Promise.race([
    received,
    settled.then(() => {
      throw new Error("Execution settled before a native SDK handle arrived");
    }),
  ]);
}
