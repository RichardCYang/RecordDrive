import express from 'express';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse
} from '@simplewebauthn/server';
import { requireAuth } from '../middleware/auth.js';
import {
  clearLanguagePreference,
  createTranslator,
  detectBrowserLanguage,
  normalizeLanguage,
  saveLanguagePreference
} from '../i18n.js';
import { logActivity } from '../database.js';
import {
  countActiveRecoveryCodes,
  createRecoveryCodes,
  createTotpEnrollment,
  createTotpUri,
  decryptTotpSecret,
  encryptTotpSecret,
  getMfaState,
  isSecurityRecentlyVerified,
  replaceRecoveryCodes,
  resolveWebAuthnSettings,
  userIdBuffer,
  verifyTotpToken
} from '../security-service.js';
import { setFlash } from '../utils.js';

const ENROLLMENT_MAX_AGE_MS = 10 * 60 * 1000;
const SECURITY_PASSWORD_WINDOW_MS = 10 * 60 * 1000;
const SECURITY_PASSWORD_MAX_ATTEMPTS = 5;

function parseTransports(value) {
  try {
    const transports = JSON.parse(value || '[]');
    return Array.isArray(transports) ? transports : [];
  } catch {
    return [];
  }
}

function normalizePasskeyName(value, fallback) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  return (name || fallback).slice(0, 80);
}

function requireRecentSecurityVerification(req, res, next) {
  if (isSecurityRecentlyVerified(req)) return next();
  if (req.is('application/json') || req.path.includes('/passkeys/')) {
    return res.status(401).json({ error: req.t('Confirm your password before changing security settings.') });
  }
  setFlash(req, 'error', req.t('Confirm your password before changing security settings.'));
  return res.redirect('/settings#security-verification');
}

function consumeSecurityPasswordAttempt(req) {
  const now = Date.now();
  const record = req.session.securityPasswordAttempts;
  if (!record || now - Number(record.startedAt || 0) > SECURITY_PASSWORD_WINDOW_MS) {
    req.session.securityPasswordAttempts = { count: 1, startedAt: now };
    return true;
  }
  record.count += 1;
  return record.count <= SECURITY_PASSWORD_MAX_ATTEMPTS;
}

function pendingTotpFromSession(req, config) {
  const pending = req.session.pendingTotpEnrollment;
  if (!pending || Date.now() - Number(pending.createdAt || 0) > ENROLLMENT_MAX_AGE_MS) {
    delete req.session.pendingTotpEnrollment;
    return null;
  }
  try {
    return {
      secret: decryptTotpSecret(pending.secretEncrypted, config),
      createdAt: pending.createdAt
    };
  } catch {
    delete req.session.pendingTotpEnrollment;
    return null;
  }
}

export function createSettingsRouter(db, config) {
  const router = express.Router();

  router.get('/settings', requireAuth, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const mfaState = getMfaState(db, req.currentUser.id);
      const passkeys = db.prepare(`
        SELECT id, name, transports, device_type, backed_up, created_at, last_used_at
        FROM webauthn_credentials
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
      `).all(req.currentUser.id).map((passkey) => ({
        ...passkey,
        transports: parseTransports(passkey.transports)
      }));

      const pendingTotp = pendingTotpFromSession(req, config);
      let totpEnrollment = null;
      if (pendingTotp) {
        const uri = createTotpUri(pendingTotp.secret, req.currentUser, config);
        totpEnrollment = {
          secret: pendingTotp.secret,
          qrCodeDataUrl: await QRCode.toDataURL(uri, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 240
          })
        };
      }

      const newRecoveryCodes = Array.isArray(req.session.newRecoveryCodes)
        ? req.session.newRecoveryCodes
        : [];
      delete req.session.newRecoveryCodes;

      let webAuthnAvailable = true;
      let webAuthnError = '';
      try {
        resolveWebAuthnSettings(req, config);
      } catch (error) {
        webAuthnAvailable = false;
        webAuthnError = error.message;
      }

      return res.render('settings', {
        title: req.t('Account settings'),
        mfaState,
        passkeys,
        totpEnrollment,
        newRecoveryCodes,
        securityVerified: isSecurityRecentlyVerified(req),
        webAuthnAvailable,
        webAuthnError
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/settings/language', requireAuth, (req, res) => {
    const selection = String(req.body.language || '').trim().toLowerCase();
    let targetLanguage;

    if (selection === 'auto') {
      clearLanguagePreference(req, res);
      targetLanguage = detectBrowserLanguage(req);
    } else {
      const language = normalizeLanguage(selection);
      if (!language) {
        setFlash(req, 'error', req.t('The selected language is not supported.'));
        return res.redirect('/settings');
      }
      saveLanguagePreference(req, res, language);
      targetLanguage = language;
    }

    setFlash(req, 'success', createTranslator(targetLanguage)('Language preference updated.'));
    return res.redirect('/settings');
  });

  router.post('/settings/security/verify-password', requireAuth, async (req, res, next) => {
    try {
      if (!consumeSecurityPasswordAttempt(req)) {
        setFlash(req, 'error', req.t('Too many password confirmation attempts. Try again later.'));
        return res.redirect('/settings#security-verification');
      }
      const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.currentUser.id);
      const valid = user && await bcrypt.compare(String(req.body.password || ''), user.password_hash);
      if (!valid) {
        setFlash(req, 'error', req.t('The password is incorrect.'));
        return res.redirect('/settings#security-verification');
      }
      delete req.session.securityPasswordAttempts;
      req.session.securityVerifiedAt = Date.now();
      setFlash(req, 'success', req.t('Security settings are unlocked for ten minutes.'));
      return res.redirect('/settings#security');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/settings/security/totp/start', requireAuth, requireRecentSecurityVerification, (req, res, next) => {
    try {
      const enrollment = createTotpEnrollment(req.currentUser, config);
      req.session.pendingTotpEnrollment = {
        secretEncrypted: encryptTotpSecret(enrollment.secret, config),
        createdAt: Date.now()
      };
      return res.redirect('/settings#totp');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/settings/security/totp/cancel', requireAuth, requireRecentSecurityVerification, (req, res) => {
    delete req.session.pendingTotpEnrollment;
    return res.redirect('/settings#totp');
  });

  router.post('/settings/security/totp/confirm', requireAuth, requireRecentSecurityVerification, async (req, res, next) => {
    try {
      const pending = pendingTotpFromSession(req, config);
      if (!pending) {
        setFlash(req, 'error', req.t('The authenticator enrollment has expired. Start again.'));
        return res.redirect('/settings#totp');
      }
      const verification = await verifyTotpToken(pending.secret, req.body.token);
      if (!verification.valid || !Number.isInteger(verification.timeStep)) {
        setFlash(req, 'error', req.t('The authenticator code is invalid or expired.'));
        return res.redirect('/settings#totp');
      }

      db.prepare(`
        UPDATE users
        SET totp_enabled = 1,
            totp_secret_encrypted = ?,
            totp_last_used_step = ?
        WHERE id = ?
      `).run(encryptTotpSecret(pending.secret, config), verification.timeStep, req.currentUser.id);
      delete req.session.pendingTotpEnrollment;

      if (countActiveRecoveryCodes(db, req.currentUser.id) === 0) {
        req.session.newRecoveryCodes = createRecoveryCodes(db, req.currentUser.id, config);
      }
      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'TOTP_ENABLED',
        targetType: 'USER',
        targetLabel: req.currentUser.username
      });
      setFlash(req, 'success', req.t('Authenticator app verification is now enabled.'));
      return res.redirect('/settings#security');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/settings/security/totp/disable', requireAuth, requireRecentSecurityVerification, (req, res, next) => {
    try {
      db.prepare(`
        UPDATE users
        SET totp_enabled = 0,
            totp_secret_encrypted = NULL,
            totp_last_used_step = NULL
        WHERE id = ?
      `).run(req.currentUser.id);
      delete req.session.pendingTotpEnrollment;
      if (!getMfaState(db, req.currentUser.id).enabled) {
        db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.currentUser.id);
      }
      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'TOTP_DISABLED',
        targetType: 'USER',
        targetLabel: req.currentUser.username
      });
      setFlash(req, 'success', req.t('Authenticator app verification was disabled.'));
      return res.redirect('/settings#security');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/settings/security/recovery-codes/add', requireAuth, requireRecentSecurityVerification, (req, res, next) => {
    try {
      if (!getMfaState(db, req.currentUser.id).enabled) {
        setFlash(req, 'error', req.t('Enable an authenticator app or passkey before creating recovery keys.'));
        return res.redirect('/settings#recovery-codes');
      }
      const codes = createRecoveryCodes(db, req.currentUser.id, config);
      if (codes.length === 0) {
        setFlash(req, 'error', req.t('The maximum number of active recovery keys has been reached.'));
        return res.redirect('/settings#recovery-codes');
      }
      req.session.newRecoveryCodes = codes;
      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'RECOVERY_CODES_ADDED',
        targetType: 'USER',
        targetLabel: req.currentUser.username
      });
      return res.redirect('/settings#recovery-codes');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/settings/security/recovery-codes/regenerate', requireAuth, requireRecentSecurityVerification, (req, res, next) => {
    try {
      if (!getMfaState(db, req.currentUser.id).enabled) {
        setFlash(req, 'error', req.t('Enable an authenticator app or passkey before creating recovery keys.'));
        return res.redirect('/settings#recovery-codes');
      }
      req.session.newRecoveryCodes = replaceRecoveryCodes(db, req.currentUser.id, config);
      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'RECOVERY_CODES_REGENERATED',
        targetType: 'USER',
        targetLabel: req.currentUser.username
      });
      return res.redirect('/settings#recovery-codes');
    } catch (error) {
      return next(error);
    }
  });

  router.post('/settings/security/passkeys/options', requireAuth, requireRecentSecurityVerification, async (req, res, next) => {
    try {
      const webAuthn = resolveWebAuthnSettings(req, config);
      const credentials = db.prepare(`
        SELECT credential_id, transports
        FROM webauthn_credentials
        WHERE user_id = ?
        ORDER BY id ASC
      `).all(req.currentUser.id);
      const passkeyName = normalizePasskeyName(
        req.body?.name,
        req.t('Passkey {{number}}', { number: credentials.length + 1 })
      );
      const options = await generateRegistrationOptions({
        rpName: webAuthn.rpName,
        rpID: webAuthn.rpID,
        userName: req.currentUser.username,
        userDisplayName: req.currentUser.display_name,
        userID: userIdBuffer(req.currentUser.id),
        attestationType: 'none',
        excludeCredentials: credentials.map((credential) => ({
          id: credential.credential_id,
          transports: parseTransports(credential.transports)
        })),
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required'
        },
        timeout: 60000
      });

      req.session.webAuthnRegistration = {
        userId: req.currentUser.id,
        challenge: options.challenge,
        origin: webAuthn.origin,
        rpID: webAuthn.rpID,
        name: passkeyName,
        createdAt: Date.now()
      };
      return res.json(options);
    } catch (error) {
      if (error.message.startsWith('WEBAUTHN_') || error.message.startsWith('WebAuthn')) {
        return res.status(400).json({ error: error.message });
      }
      return next(error);
    }
  });

  router.post('/settings/security/passkeys/verify', requireAuth, requireRecentSecurityVerification, async (req, res, next) => {
    try {
      const challenge = req.session.webAuthnRegistration;
      if (!challenge || challenge.userId !== req.currentUser.id) {
        return res.status(401).json({ error: req.t('Your passkey registration has expired. Try again.') });
      }
      if (Date.now() - Number(challenge.createdAt || 0) > ENROLLMENT_MAX_AGE_MS) {
        delete req.session.webAuthnRegistration;
        return res.status(401).json({ error: req.t('Your passkey registration has expired. Try again.') });
      }

      const verification = await verifyRegistrationResponse({
        response: req.body?.credential,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        requireUserVerification: true
      });
      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: req.t('The passkey could not be registered.') });
      }

      const info = verification.registrationInfo;
      const credential = info.credential;
      db.prepare(`
        INSERT INTO webauthn_credentials (
          user_id, credential_id, public_key, counter, transports,
          device_type, backed_up, name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.currentUser.id,
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports || req.body?.credential?.response?.transports || []),
        info.credentialDeviceType,
        info.credentialBackedUp ? 1 : 0,
        challenge.name
      );
      delete req.session.webAuthnRegistration;

      if (countActiveRecoveryCodes(db, req.currentUser.id) === 0) {
        req.session.newRecoveryCodes = createRecoveryCodes(db, req.currentUser.id, config);
      }
      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'PASSKEY_REGISTERED',
        targetType: 'USER',
        targetLabel: challenge.name
      });
      setFlash(req, 'success', req.t('The passkey was registered.'));
      return res.json({ verified: true, redirect: '/settings#security' });
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: req.t('This passkey is already registered.') });
      }
      if (String(error.message).includes('Unexpected') || String(error.message).includes('required')) {
        return res.status(400).json({ error: req.t('The passkey response was rejected. Try again.') });
      }
      return next(error);
    }
  });

  router.post('/settings/security/passkeys/:id/delete', requireAuth, requireRecentSecurityVerification, (req, res, next) => {
    try {
      const passkeyId = Number.parseInt(req.params.id, 10);
      const passkey = Number.isInteger(passkeyId)
        ? db.prepare('SELECT id, name FROM webauthn_credentials WHERE id = ? AND user_id = ?').get(passkeyId, req.currentUser.id)
        : null;
      if (!passkey) {
        setFlash(req, 'error', req.t('The passkey could not be found.'));
        return res.redirect('/settings#passkeys');
      }
      db.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(passkey.id, req.currentUser.id);
      if (!getMfaState(db, req.currentUser.id).enabled) {
        db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.currentUser.id);
      }
      logActivity(db, {
        actorId: req.currentUser.id,
        action: 'PASSKEY_REMOVED',
        targetType: 'USER',
        targetLabel: passkey.name
      });
      setFlash(req, 'success', req.t('The passkey was removed.'));
      return res.redirect('/settings#passkeys');
    } catch (error) {
      return next(error);
    }
  });

  return router;
}
