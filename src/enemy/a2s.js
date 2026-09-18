// A2S server query (M4 — STUB).
//
// Polls the game server directly (Source A2S_PLAYER) for the current player list,
// then diffs successive polls into our own session log. Independent of BattleMetrics.
//
// Recommended dependency (add when implementing): `@fabricio-191/valve-server-query`.
// Caveat: some Rust servers obfuscate/limit the player list — verify per server.
//
// Planned: queryPlayers(ip, port) -> [{ name, durationSec }]

export async function queryPlayers(/* ip, port */) {
  throw new Error('a2s.queryPlayers not implemented (M4)');
}
