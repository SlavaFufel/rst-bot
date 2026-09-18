'use strict';

// Uploads the freshly-obtained credentials to the bot's ingest endpoint,
// authenticated by the single-use pair code (Bearer). Retries a few times.
async function upload(ingestUrl, code, creds, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(ingestUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${code}`,
        },
        body: JSON.stringify(creds),
      });
      if (res.status === 401) throw new Error('Код истёк или неверный. Запроси новый: /pair в боте.');
      if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
      return await res.json().catch(() => ({ ok: true }));
    } catch (err) {
      lastErr = err;
      if (err.message.includes('Код истёк')) throw err; // no point retrying a bad code
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

module.exports = { upload };
