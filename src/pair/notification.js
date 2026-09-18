// Parse a raw FCM `ON_DATA_RECEIVED` object from the Rust+ companion app.
// `appData` is an array of { key, value }; the 'body' entry holds a JSON string
// with the pairing details. type 'server' = server pairing (ip/port/playerId/
// playerToken), type 'entity' = smart device (alarm/switch/storage).

function readBody(data) {
  const appData = data?.appData;
  if (!Array.isArray(appData)) return null;
  const entry = appData.find((e) => e?.key === 'body');
  if (!entry?.value) return null;
  try {
    return JSON.parse(entry.value);
  } catch {
    return null;
  }
}

export function parseNotification(data) {
  const body = readBody(data);
  if (!body) return null;

  if (body.type === 'server') {
    return {
      type: 'server',
      name: body.name,
      ip: body.ip,
      port: Number(body.port),
      playerId: String(body.playerId),
      playerToken: Number(body.playerToken),
    };
  }

  if (body.type === 'entity') {
    return {
      type: 'entity',
      name: body.name,
      entityId: body.entityId,
      entityType: body.entityType,
      ip: body.ip,
      port: body.port ? Number(body.port) : undefined,
      playerId: body.playerId ? String(body.playerId) : undefined,
      playerToken: body.playerToken ? Number(body.playerToken) : undefined,
    };
  }

  return { type: body.type ?? 'unknown', body };
}
