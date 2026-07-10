import express from 'express';
import bcrypt from 'bcryptjs';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { logActivity } from '../database.js';
import { clearLoginAttempts, loginRateLimit } from '../middleware/login-rate-limit.js';
import {
  consumeRecoveryCode,
  getMfaState,
  resolveWebAuthnSettings,
  verifyAndConsumeTotp
} from '../security-service.js';

const MFA_CHALLENGE_MAX_AGE_MS = 10 * 60 * 1000;
const MFA_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MFA_MAX_ATTEMPTS = 10;

function parseTransports(value) {
  try {
    const transports = JSON.parse(value || '[]');
    return Array.isArray(transports) ? transports : [];
  } catch {
    return [];
  }
}

function getPendingMfa(req, db) {
  const pending = req.session.pendingMfa;
  if (!pending || Date.now() - Number(pending.createdAt || 0) > MFA_CHALLENGE_MAX_AGE_MS) {
    delete req.session.pendingMfa;
    delete req.session.webAuthnAuthentication;
    return null;
  }
  const user = db.prepare(`
    SELECT id, username, display_name, role, created_at
    FROM users
    WHERE id = ?
  `).get(pending.userId);
  if (!user) {
    delete req.session.pendingMfa;
    delete req.session.webAuthnAuthentication;
    return null;
  }
  return { pending, user, state: getMfaState(db, user.id) };
}

function consumeMfaAttempt(req) {
  const now = Date.now();
  const attempts = req.session.mfaAttempts;
  if (!attempts || now - Number(attempts.startedAt || 0) > MFA_ATTEMPT_WINDOW_MS) {
    req.session.mfaAttempts = { count: 1, startedAt: now };
    return { allowed: true, retrySeconds: 0 };
  }
  attempts.count += 1;
  if (attempts.count <= MFA_MAX_ATTEMPTS) return { allowed: true, retrySeconds: 0 };
  const retrySeconds = Math.max(1, Math.ceil((MFA_ATTEMPT_WINDOW_MS - (now - attempts.startedAt)) / 1000));
  return { allowed: false, retrySeconds };
}

function clearPendingAuthentication(req) {
  delete req.session.pendingMfa;
  delete req.session.mfaAttempts;
  delete req.session.webAuthnAuthentication;
}

function completeLogin(req, res, next, db, user, returnTo, options = {}) {
  const json = options.json === true;
  return req.session.regenerate((error) => {
    if (error) return next(error);
    req.session.userId = user.id;
    req.session.authenticatedAt = Date.now();
    logActivity(db, {
      actorId: user.id,
      action: 'LOGIN',
      targetType: 'USER',
      targetLabel: user.username
    });
    if (json) return res.json({ verified: true, redirect: returnTo });
    return res.redirect(returnTo);
  });
}

function renderMfa(req, res, db, options = {}) {
  const context = getPendingMfa(req, db);
  if (!context) return res.redirect('/login');
  return res.status(options.status || 200).render('login-mfa', {
    title: req.t('Two-step verification'),
    error: options.error || null,
    user: context.user,
    mfaState: context.state
  });
}

export function createAuthRouter(db, config) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.currentUser) return res.redirect('/');
    if (getPendingMfa(req, db)) return res.redirect('/login/mfa');
    return res.render('login', {
      title: req.t('Sign in'),
      error: null,
      username: ''
    });
  });

  router.post('/login', loginRateLimit, async (req, res, next) => {
    try {
      const username = String(req.body.username || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      const passwordMatches = user ? await bcrypt.compare(password, user.password_hash) : false;

      if (!user || !passwordMatches) {
        return res.status(401).render('login', {
          title: req.t('Sign in'),
          error: req.t('The username or password is incorrect.'),
          username
        });
      }

      clearLoginAttempts(req);
      const returnTo = req.session.returnTo && req.session.returnTo.startsWith('/')
        ? req.session.returnTo
        : '/';
      const mfaState = getMfaState(db, user.id);

      if (!mfaState.enabled) {
        return completeLogin(req, res, next, db, user, returnTo);
      }

      return req.session.regenerate((error) => {
        if (error) return next(error);
        req.session.pendingMfa = {
          userId: user.id,
          returnTo,
          createdAt: Date.now()
        };
        return res.redirect('/login/mfa');
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/login/mfa', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.currentUser) return res.redirect('/');
    return renderMfa(req, res, db);
  });

  router.post('/login/mfa/totp', async (req, res, next) => {
    try {
      const context = getPendingMfa(req, db);
      if (!context) return res.redirect('/login');
      if (!context.state.totpEnabled) {
        return renderMfa(req, res, db, {
          status: 400,
          error: req.t('Authenticator app verification is not available for this account.')
        });
      }

      const attempt = consumeMfaAttempt(req);
      if (!attempt.allowed) {
        res.set('Retry-After', String(attempt.retrySeconds));
        return renderMfa(req, res, db, {
          status: 429,
          error: req.t('Too many verification attempts. Try again later.')
        });
      }

      const verified = await verifyAndConsumeTotp(db, context.user.id, req.body.token, config);
      if (!verified) {
        return renderMfa(req, res, db, {
          status: 401,
          error: req.t('The authenticator code is invalid, expired, or already used.')
        });
      }

      const returnTo = context.pending.returnTo;
      clearPendingAuthentication(req);
      return completeLogin(req, res, next, db, context.user, returnTo);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/login/mfa/recovery', (req, res, next) => {
    try {
      const context = getPendingMfa(req, db);
      if (!context) return res.redirect('/login');

      const attempt = consumeMfaAttempt(req);
      if (!attempt.allowed) {
        res.set('Retry-After', String(attempt.retrySeconds));
        return renderMfa(req, res, db, {
          status: 429,
          error: req.t('Too many verification attempts. Try again later.')
        });
      }

      const verified = consumeRecoveryCode(db, context.user.id, req.body.recoveryCode, config);
      if (!verified) {
        return renderMfa(req, res, db, {
          status: 401,
          error: req.t('The recovery key is invalid or has already been used.')
        });
      }

      const returnTo = context.pending.returnTo;
      clearPendingAuthentication(req);
      return completeLogin(req, res, next, db, context.user, returnTo);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/login/mfa/passkey/options', async (req, res, next) => {
    try {
      const context = getPendingMfa(req, db);
      if (!context) return res.status(401).json({ error: req.t('Your sign-in session has expired. Start again.') });
      if (!context.state.passkeyEnabled) {
        return res.status(400).json({ error: req.t('Passkey verification is not available for this account.') });
      }

      const attempt = consumeMfaAttempt(req);
      if (!attempt.allowed) {
        res.set('Retry-After', String(attempt.retrySeconds));
        return res.status(429).json({ error: req.t('Too many verification attempts. Try again later.') });
      }

      const webAuthn = resolveWebAuthnSettings(req, config);
      const credentials = db.prepare(`
        SELECT credential_id, transports
        FROM webauthn_credentials
        WHERE user_id = ?
        ORDER BY id ASC
      `).all(context.user.id);
      const options = await generateAuthenticationOptions({
        rpID: webAuthn.rpID,
        allowCredentials: credentials.map((credential) => ({
          id: credential.credential_id,
          transports: parseTransports(credential.transports)
        })),
        userVerification: 'required',
        timeout: 60000
      });

      req.session.webAuthnAuthentication = {
        userId: context.user.id,
        challenge: options.challenge,
        origin: webAuthn.origin,
        rpID: webAuthn.rpID,
        createdAt: Date.now()
      };
      return res.json(options);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/login/mfa/passkey/verify', async (req, res, next) => {
    try {
      const context = getPendingMfa(req, db);
      const challenge = req.session.webAuthnAuthentication;
      if (!context || !challenge || challenge.userId !== context.user.id) {
        return res.status(401).json({ error: req.t('Your passkey challenge has expired. Try again.') });
      }
      if (Date.now() - Number(challenge.createdAt || 0) > MFA_CHALLENGE_MAX_AGE_MS) {
        delete req.session.webAuthnAuthentication;
        return res.status(401).json({ error: req.t('Your passkey challenge has expired. Try again.') });
      }

      const response = req.body?.credential;
      const stored = db.prepare(`
        SELECT *
        FROM webauthn_credentials
        WHERE user_id = ? AND credential_id = ?
      `).get(context.user.id, response?.id);
      if (!stored) return res.status(401).json({ error: req.t('The passkey could not be verified.') });

      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        credential: {
          id: stored.credential_id,
          publicKey: new Uint8Array(stored.public_key),
          counter: stored.counter,
          transports: parseTransports(stored.transports)
        },
        requireUserVerification: true
      });
      if (!verification.verified) {
        return res.status(401).json({ error: req.t('The passkey could not be verified.') });
      }

      db.prepare(`
        UPDATE webauthn_credentials
        SET counter = ?, backed_up = ?, last_used_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        verification.authenticationInfo.newCounter,
        verification.authenticationInfo.credentialBackedUp ? 1 : 0,
        stored.id
      );

      const returnTo = context.pending.returnTo;
      clearPendingAuthentication(req);
      return completeLogin(req, res, next, db, context.user, returnTo, { json: true });
    } catch (error) {
      if (String(error.message).includes('counter value')) {
        return res.status(401).json({ error: req.t('The passkey counter was rejected. Remove and register this passkey again.') });
      }
      return next(error);
    }
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('recorddrive.sid');
      return res.redirect('/login');
    });
  });

  return router;
}
