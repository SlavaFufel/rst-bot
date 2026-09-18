'use strict';

const readline = require('node:readline');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { runPairing } = require('./register');
const { upload } = require('./upload');

// Ingest URL is baked at build time into ingest-url.txt; RST_INGEST_URL overrides.
function resolveIngestUrl() {
  if (process.env.RST_INGEST_URL) return process.env.RST_INGEST_URL.trim();
  try {
    const baked = readFileSync(path.join(__dirname, 'ingest-url.txt'), 'utf8').trim();
    if (baked) return baked;
  } catch {
    // ignore
  }
  return null;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

async function main() {
  console.log('=== Rust+ Bot — помощник привязки ===\n');

  const ingestUrl = resolveIngestUrl();
  if (!ingestUrl) {
    console.error('Не задан адрес сервера (ingest-url.txt). Обратись к администратору бота.');
    await ask('\nНажми Enter для выхода...');
    process.exit(1);
  }

  let code = (process.argv[2] || (await ask('Введи код из Telegram-бота (команда /pair): '))).trim().toUpperCase();
  if (!code) {
    console.error('Код не введён.');
    await ask('\nНажми Enter для выхода...');
    process.exit(1);
  }

  try {
    const creds = await runPairing((step) => console.log('• ' + step));
    console.log('• Отправляю привязку боту...');
    await upload(ingestUrl, code, creds);
    console.log('\n✅ Готово! Вернись в Telegram, зайди на сервер в игре и нажми «Pair with Server».');
  } catch (err) {
    console.error('\n❌ Ошибка: ' + err.message);
  }

  await ask('\nНажми Enter для выхода...');
}

main();
