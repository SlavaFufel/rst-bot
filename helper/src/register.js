'use strict';

// Vendored Rust+ pairing flow (the 4 steps from @liamcottle/rustplus.js CLI,
// which are not exported). Steps 1/2/4 are plain HTTPS. Step 3 captures the Steam
// auth token via the Chrome DevTools Protocol — the supported replacement for the
// old "--load-extension" / "--disable-web-security popup" tricks, both of which
// modern Chrome (137+) blocks. We inject a ReactNativeWebView handler into the
// facepunch page's MAIN world via Page.addScriptToEvaluateOnNewDocument; when the
// login page posts the token to it, we redirect to our local callback.

const express = require('express');
const ChromeLauncher = require('chrome-launcher');
const { randomUUID } = require('node:crypto');
const { mkdirSync, rmSync } = require('node:fs');
const { execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const AndroidFCM = require('@liamcottle/push-receiver/src/android/fcm');

// Hardcoded Facepunch Rust+ companion app identifiers (from the official CLI).
const FACEPUNCH = {
  apiKey: 'AIzaSyB5y2y-Tzqb4-I4Qnlsh_9naYv_TD8pCvY',
  projectId: 'rust-companion-app',
  gcmSenderId: '976529667804',
  gmsAppId: '1:976529667804:android:d6f1ddeb4403b338fea619',
  androidPackageName: 'com.facepunch.rust.companion',
  androidPackageCert: 'E28D05345FB78A7A1A63D70F4A302DBF426CA5AD',
};
const EXPO_PROJECT_ID = '49451aca-a822-41e6-ad59-955718d0ff9c';
const PAIR_PORT = 3000;

// Injected into the facepunch page (MAIN world, before its scripts) via CDP.
// Defines the ReactNativeWebView the login page calls with the auth token.
const INJECT_SOURCE = `(function () {
  if (window.__rstPairInstalled) return;
  window.__rstPairInstalled = true;
  window.ReactNativeWebView = {
    postMessage: function (message) {
      try {
        var auth = JSON.parse(message);
        if (auth && auth.Token) {
          window.location.href = 'http://localhost:${PAIR_PORT}/callback?token=' + encodeURIComponent(auth.Token);
        }
      } catch (e) {}
    },
  };
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome needs an ASCII path for the isolated profile (a Cyrillic Windows
// username under %TEMP% can make Chrome fail to use it).
function asciiBase() {
  return process.platform === 'win32' ? (process.env.PUBLIC || 'C:\\Users\\Public') : os.tmpdir();
}

// A running Chrome makes a new launch hand off to it and exit, so the debug port
// never opens (CDP connect → ECONNREFUSED) and our isolated profile is ignored.
// Close it so chrome-launcher starts a real, debuggable instance. Tabs restore
// via Ctrl+Shift+T.
function killChrome() {
  if (process.platform !== 'win32') return;
  try {
    execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' });
  } catch {
    // not running — fine
  }
}

async function getPageTarget(port) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) return target;
    } catch {
      // devtools endpoint not ready yet
    }
    await sleep(250);
  }
  throw new Error('CDP page target not found');
}

async function getExpoPushToken(fcmToken) {
  const res = await fetch('https://exp.host/--/api/v2/push/getExpoPushToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'fcm',
      deviceId: randomUUID(),
      development: false,
      appId: 'com.facepunch.rust.companion',
      deviceToken: fcmToken,
      projectId: EXPO_PROJECT_ID,
    }),
  });
  if (!res.ok) throw new Error(`Expo push token failed (${res.status})`);
  const json = await res.json();
  return json.data.expoPushToken;
}

async function registerWithRustPlus(authToken, expoPushToken) {
  const res = await fetch('https://companion-rust.facepunch.com/api/push/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      AuthToken: authToken,
      DeviceId: 'rstbot-helper',
      PushKind: 3,
      PushToken: expoPushToken,
    }),
  });
  if (!res.ok) throw new Error(`Rust+ Companion register failed (${res.status})`);
}

function linkSteamWithRustPlus() {
  return new Promise((resolve, reject) => {
    const app = express();
    let server;
    let chrome;
    let ws;
    let done = false;

    const finish = async (fn, arg) => {
      if (done) return;
      done = true;
      try { ws?.close(); } catch { /* ignore */ }
      try { await chrome?.kill(); } catch { /* ignore */ }
      try { server?.close(); } catch { /* ignore */ }
      fn(arg);
    };

    app.get('/callback', (req, res) => {
      const token = req.query.token;
      if (token) {
        res.send('Steam-аккаунт привязан. Можно закрыть это окно и вернуться к программе.');
        finish(resolve, token);
      } else {
        res.status(400).send('Token missing');
        finish(reject, new Error('Steam auth token missing from callback'));
      }
    });

    server = app.listen(PAIR_PORT, async () => {
      try {
        // Close any running Chrome so the launched instance is fresh and its
        // remote-debugging port actually opens (otherwise CDP gets ECONNREFUSED).
        console.log('  (закрываю Chrome для привязки — вкладки вернутся через Ctrl+Shift+T)');
        killChrome();
        await sleep(2000);

        const profileDir = path.join(asciiBase(), 'rst-pair-chrome');
        try {
          rmSync(profileDir, { recursive: true, force: true }); // force a fresh login
        } catch { /* ignore */ }
        mkdirSync(profileDir, { recursive: true });

        chrome = await ChromeLauncher.launch({
          startingUrl: 'about:blank',
          userDataDir: profileDir,
          chromeFlags: ['--no-first-run', '--no-default-browser-check'],
          handleSIGINT: false,
        });

        const target = await getPageTarget(chrome.port);
        ws = new WebSocket(target.webSocketDebuggerUrl);
        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
          ws.send(JSON.stringify({ id: 2, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: INJECT_SOURCE } }));
          ws.send(JSON.stringify({ id: 3, method: 'Page.navigate', params: { url: 'https://companion-rust.facepunch.com/login' } }));
        });
        ws.addEventListener('error', () => finish(reject, new Error('CDP WebSocket error')));
      } catch (err) {
        finish(reject, new Error('Не удалось запустить браузер. Установи Google Chrome или Edge. ' + err.message));
      }
    });
  });
}

// Run all 4 steps. `log` is an optional progress callback.
async function runPairing(log = () => {}) {
  log('Регистрация в FCM...');
  const fcm_credentials = await AndroidFCM.register(
    FACEPUNCH.apiKey,
    FACEPUNCH.projectId,
    FACEPUNCH.gcmSenderId,
    FACEPUNCH.gmsAppId,
    FACEPUNCH.androidPackageName,
    FACEPUNCH.androidPackageCert,
  );

  log('Получение Expo-токена...');
  const expo_push_token = await getExpoPushToken(fcm_credentials.fcm.token);

  log('Открываю браузер — войди в Steam...');
  const rustplus_auth_token = await linkSteamWithRustPlus();

  log('Регистрация в Rust+ Companion API...');
  await registerWithRustPlus(rustplus_auth_token, expo_push_token);

  return { fcm_credentials, expo_push_token, rustplus_auth_token };
}

module.exports = { runPairing };
