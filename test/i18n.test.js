import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApplication } from '../src/app.js';

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'CSRF token should exist in rendered HTML');
  return match[1];
}

function testConfig(tempRoot) {
  return {
    port: 0,
    nodeEnv: 'test',
    isProduction: false,
    sessionSecret: 'test-session-secret-with-more-than-thirty-two-characters',
    adminUsername: 'admin',
    adminPassword: 'TestPassword123!',
    adminDisplayName: 'Test Administrator',
    maxFileSizeMb: 5,
    maxFilesPerUpload: 3,
    dbPath: path.join(tempRoot, 'recorddrive.db'),
    uploadRoot: path.join(tempRoot, 'uploads')
  };
}

test('detects browser languages and persists a selected language', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recorddrive-i18n-test-'));
  const app = createApplication({ config: testConfig(tempRoot) });
  const db = app.locals.db;
  const agent = request.agent(app);

  t.after(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const koreanLogin = await agent
    .get('/login')
    .set('Accept-Language', 'ko-KR,ko;q=0.9,en;q=0.8')
    .expect(200)
    .expect('Content-Language', 'ko');
  assert.match(koreanLogin.text, /<html lang="ko">/);
  assert.match(koreanLogin.text, /RecordDrive 로그인/);

  await agent
    .post('/login')
    .set('Accept-Language', 'ko-KR,ko;q=0.9')
    .type('form')
    .send({
      _csrf: csrfFrom(koreanLogin.text),
      username: 'admin',
      password: 'TestPassword123!'
    })
    .expect(302)
    .expect('Location', '/');

  const koreanSettings = await agent
    .get('/settings')
    .set('Accept-Language', 'ko-KR,ko;q=0.9')
    .expect(200)
    .expect('Content-Language', 'ko');
  assert.match(koreanSettings.text, /언어 설정/);
  assert.match(koreanSettings.text, /value="auto" selected/);
  for (const language of ['en', 'ja', 'ko', 'fr', 'es', 'pt']) {
    assert.match(koreanSettings.text, new RegExp(`value=\"${language}\"`));
  }

  const savedLanguage = await agent
    .post('/settings/language')
    .set('Accept-Language', 'ko-KR')
    .type('form')
    .send({ _csrf: csrfFrom(koreanSettings.text), language: 'ja' })
    .expect(302)
    .expect('Location', '/settings');
  assert.ok(savedLanguage.headers['set-cookie'].some((value) => value.startsWith('recorddrive.lang=ja;')));

  const japaneseSettings = await agent
    .get('/settings')
    .set('Accept-Language', 'ko-KR')
    .expect(200)
    .expect('Content-Language', 'ja');
  assert.match(japaneseSettings.text, /<html lang="ja">/);
  assert.match(japaneseSettings.text, /言語設定/);
  assert.match(japaneseSettings.text, /value="ja" selected/);

  const automaticLanguage = await agent
    .post('/settings/language')
    .set('Accept-Language', 'fr-FR,fr;q=0.9')
    .type('form')
    .send({ _csrf: csrfFrom(japaneseSettings.text), language: 'auto' })
    .expect(302)
    .expect('Location', '/settings');
  assert.ok(automaticLanguage.headers['set-cookie'].some((value) => value.startsWith('recorddrive.lang=;')));

  const frenchSettings = await agent
    .get('/settings')
    .set('Accept-Language', 'fr-FR,fr;q=0.9')
    .expect(200)
    .expect('Content-Language', 'fr');
  assert.match(frenchSettings.text, /<html lang="fr">/);
  assert.match(frenchSettings.text, /Paramètres de langue/);
  assert.match(frenchSettings.text, /value="auto" selected/);


  const spanishLogin = await request(app)
    .get('/login')
    .set('Accept-Language', 'es-ES,es;q=0.9')
    .expect(200)
    .expect('Content-Language', 'es');
  assert.match(spanishLogin.text, /Inicia sesión en RecordDrive/);

  const portugueseLogin = await request(app)
    .get('/login')
    .set('Accept-Language', 'pt-BR,pt;q=0.9')
    .expect(200)
    .expect('Content-Language', 'pt');
  assert.match(portugueseLogin.text, /Entre no RecordDrive/);

  const fallbackLogin = await request(app)
    .get('/login')
    .set('Accept-Language', 'zh-CN,zh;q=0.9')
    .expect(200)
    .expect('Content-Language', 'en');
  assert.match(fallbackLogin.text, /<html lang="en">/);
  assert.match(fallbackLogin.text, /Sign in to RecordDrive/);
});
