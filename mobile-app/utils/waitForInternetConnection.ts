import NetInfo from "@react-native-community/netinfo";

/**
 * Single NetInfo check — no polling loop (fast startup).
 * Returns true when the device reports connected.
 */
export async function fetchNetConnected(): Promise<boolean> {
  const state = await NetInfo.fetch();
  return state.isConnected === true;
}

/**
 * Backward-compatible alias for {@link fetchNetConnected}.
 * Previously polled up to ~5s; now performs one fetch only.
 */
export async function waitForInternetConnection(): Promise<boolean> {
  return fetchNetConnected();
}
