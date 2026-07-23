import express from 'express';
import bcrypt from 'bcryptjs';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { isBlockedAdministrator } from '../admin-access.js';
import { logActivity } from '../database.js';
import {
  checkMfaRateLimit,
  clearLoginAttempts,
  clearMfaAttempts,
  loginRateLimit,
  recordLoginFailure,
  recordMfaFailure,
  releaseLoginAttempt,
  releaseMfaAttempt
} from '../middleware/login-rate-limit.js';
import {
  consumeRecoveryCode,
  getMfaState,
  resolveWebAuthnSettings,
  verifyAndConsumeTotp
} from '../security-service.js';
import { sessionAbsoluteDurationMs } from '../config.js';
import { safeInternalPath } from '../utils.js';
import { pruneUserSessions } from '../session-store.js';

const MFA_CHALLENGE_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_LOGIN_PASSWORD_BYTES = 1024;
const DUMMY_PASSWORD_HASH = '$2b$12$tmAY9ZRvy85L.ewBHL4X/uj9QzQnhapJ93kGHAOGKKK4MAGnpotLq';

function parseTransports(value) {
  try {
    const transports = JSON.parse(value || '[]');
    return Array.isArray(transports) ? transports : [];
  } catch {
    return [];
  }
}

function preserveAuthenticationFlow(req, userId, createdAt = Date.now()) {
  const normalizedUserId = Number(userId);
  if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId < 1) {
    delete req.session.authenticationFlow;
    return;
  }
  req.session.authenticationFlow = {
    userId: normalizedUserId,
    createdAt: Number(createdAt) || Date.now()
  };
}

function getPendingMfa(req, db, config) {
  const pending = req.session.pendingMfa;
  if (!pending || Date.now() - Number(pending.createdAt || 0) > MFA_CHALLENGE_MAX_AGE_MS) {
    if (pending) preserveAuthenticationFlow(req, pending.userId, pending.createdAt);
    delete req.session.pendingMfa;
    delete req.session.returnTo;
    delete req.session.webAuthnAuthentication;
    return null;
  }
  const user = db.prepare(`
    SELECT id, username, display_name, role, must_change_password, created_at
    FROM users
    WHERE id = ?
  `).get(pending.userId);
  if (!user || isBlockedAdministrator(config, user)) {
    clearPendingAuthentication(req, { preserveUserReference: true });
    return null;
  }
  return { pending, user, state: getMfaState(db, user.id) };
}

function clearPendingAuthentication(req, options = {}) {
  const referencedUserId = req.session.pendingMfa?.userId
    ?? req.session.userId
    ?? req.session.authenticationFlow?.userId;
  const referencedAt = req.session.pendingMfa?.createdAt
    ?? req.session.authenticatedAt
    ?? req.session.authenticationFlow?.createdAt;

  delete req.session.userId;
  delete req.session.authenticatedAt;
  delete req.session.sessionCreatedAt;
  delete req.session.pendingMfa;
  delete req.session.returnTo;
  delete req.session.mfaAttempts;
  delete req.session.webAuthnAuthentication;
  delete req.session.authenticationFlow;
  if (options.preserveUserReference) preserveAuthenticationFlow(req, referencedUserId, referencedAt);
}

function rejectLogin(req, res, username = '', options = {}) {
  const message = req.t('The username or password is incorrect.');
  const returnTo = safeInternalPath(options.returnTo ?? req.body?.returnTo, '/');
  if (options.json === true) return res.status(401).json({ error: message });
  return res.status(401).render('login', {
    title: req.t('Sign in'),
    error: message,
    username,
    returnTo
  });
}

function saveLimitedAuthenticationSession(req, next, db, config, userId, onSaved) {
  return req.session.save((saveError) => {
    if (saveError) return next(saveError);
    try {
      pruneUserSessions(
        db,
        userId,
        req.sessionID,
        config.maxSessionsPerUser,
        config.sessionSecret,
        sessionAbsoluteDurationMs(config)
      );
      return onSaved();
    } catch (error) {
      return next(error);
    }
  });
}

function completeLogin(req, res, next, db, config, user, returnTo, options = {}) {
  const json = options.json === true;
  if (isBlockedAdministrator(config, user)) {
    clearPendingAuthentication(req);
    return rejectLogin(req, res, user.username, { json });
  }

  clearMfaAttempts(user.id, req);
  return req.session.regenerate((error) => {
    if (error) return next(error);
    const authenticatedAt = Date.now();
    req.session.userId = user.id;
    req.session.authenticatedAt = authenticatedAt;
    req.session.sessionCreatedAt = authenticatedAt;
    const intendedRedirect = safeInternalPath(returnTo, '/');
    if (Number(user.must_change_password) === 1) {
      req.session.postPasswordChangeReturnTo = intendedRedirect;
    }
    return saveLimitedAuthenticationSession(req, next, db, config, user.id, () => {
      logActivity(db, {
        actorId: user.id,
        action: 'LOGIN',
        targetType: 'USER',
        targetLabel: user.username
      });
      const redirect = Number(user.must_change_password) === 1
        ? '/settings/password'
        : intendedRedirect;
      if (json) return res.json({ verified: true, redirect });
      return res.redirect(redirect);
    });
  });
}

function renderMfa(req, res, db, config, options = {}) {
  const context = getPendingMfa(req, db, config);
  if (!context) return res.redirect('/login');
  return res.status(options.status || 200).render('login-mfa', {
    title: req.t('Two-step verification'),
    error: options.error || null,
    user: context.user,
    mfaState: context.state
  });
}

function rejectMfaRateLimit(req, res, db, config, context, options = {}) {
  const limit = checkMfaRateLimit(req, context.user.id, { reserve: options.reserve === true });
  if (!limit.blocked) return false;

  res.set('Retry-After', String(limit.retrySeconds));
  const error = req.t('Too many verification attempts. Try again later.');
  if (options.json === true) {
    res.status(429).json({ error });
  } else {
    renderMfa(req, res, db, config, { status: 429, error });
  }
  return true;
}

export function createAuthRouter(db, config) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.currentUser) return res.redirect('/');
    if (getPendingMfa(req, db, config)) return res.redirect('/login/mfa');
    return res.render('login', {
      title: req.t('Sign in'),
      error: null,
      username: '',
      returnTo: safeInternalPath(req.query.returnTo, '/')
    });
  });

  router.post('/login', loginRateLimit, async (req, res, next) => {
    try {
      const username = String(req.body.username || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const passwordWithinLimit = Buffer.byteLength(password, 'utf8') <= MAX_LOGIN_PASSWORD_BYTES;
      const user = db.prepare(`
        SELECT id, username, display_name, password_hash, role, must_change_password, created_at
        FROM users
        WHERE username = ?
      `).get(username);
      const passwordHash = user?.password_hash || DUMMY_PASSWORD_HASH;
      const passwordMatches = await bcrypt.compare(passwordWithinLimit ? password : '', passwordHash);

      if (!user || !passwordWithinLimit || !passwordMatches || isBlockedAdministrator(config, user)) {
        recordLoginFailure(req, username);
        clearPendingAuthentication(req, { preserveUserReference: true });
        return rejectLogin(req, res, username);
      }

      clearLoginAttempts(username, req);
      const returnTo = safeInternalPath(req.body.returnTo ?? req.session.returnTo, '/');
      const mfaState = getMfaState(db, user.id);

      if (!mfaState.enabled) {
        return completeLogin(req, res, next, db, config, user, returnTo);
      }

      return req.session.regenerate((error) => {
        if (error) return next(error);
        const createdAt = Date.now();
        req.session.sessionCreatedAt = createdAt;
        req.session.pendingMfa = {
          userId: user.id,
          returnTo,
          createdAt
        };
        return saveLimitedAuthenticationSession(req, next, db, config, user.id, () => {
          return res.redirect('/login/mfa');
        });
      });
    } catch (error) {
      releaseLoginAttempt(req);
      return next(error);
    }
  });

  router.get('/login/mfa', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.currentUser) return res.redirect('/');
    return renderMfa(req, res, db, config);
  });

  router.post('/login/mfa/totp', async (req, res, next) => {
    try {
      const context = getPendingMfa(req, db, config);
      if (!context) return res.redirect('/login');
      if (!context.state.totpEnabled) {
        return renderMfa(req, res, db, config, {
          status: 400,
          error: req.t('Authenticator app verification is not available for this account.')
        });
      }
      if (rejectMfaRateLimit(req, res, db, config, context, { reserve: true })) return undefined;

      const verified = await verifyAndConsumeTotp(db, context.user.id, req.body.token, config);
      if (!verified) {
        recordMfaFailure(req, context.user.id);
        return renderMfa(req, res, db, config, {
          status: 401,
          error: req.t('The authenticator code is invalid, expired, or already used.')
        });
      }

      const returnTo = context.pending.returnTo;
      clearPendingAuthentication(req);
      return completeLogin(req, res, next, db, config, context.user, returnTo);
    } catch (error) {
      releaseMfaAttempt(req);
      return next(error);
    }
  });

  router.post('/login/mfa/recovery', (req, res, next) => {
    try {
      const context = getPendingMfa(req, db, config);
      if (!context) return res.redirect('/login');
      if (rejectMfaRateLimit(req, res, db, config, context, { reserve: true })) return undefined;

      const verified = consumeRecoveryCode(db, context.user.id, req.body.recoveryCode, config);
      if (!verified) {
        recordMfaFailure(req, context.user.id);
        return renderMfa(req, res, db, config, {
          status: 401,
          error: req.t('The recovery key is invalid or has already been used.')
        });
      }

      const returnTo = context.pending.returnTo;
      clearPendingAuthentication(req);
      return completeLogin(req, res, next, db, config, context.user, returnTo);
    } catch (error) {
      releaseMfaAttempt(req);
      return next(error);
    }
  });

  router.post('/login/mfa/passkey/options', async (req, res, next) => {
    try {
      const context = getPendingMfa(req, db, config);
      if (!context) return res.status(401).json({ error: req.t('Your sign-in session has expired. Start again.') });
      if (!context.state.passkeyEnabled) {
        return res.status(400).json({ error: req.t('Passkey verification is not available for this account.') });
      }
      if (rejectMfaRateLimit(req, res, db, config, context, { json: true })) return undefined;

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
      const context = getPendingMfa(req, db, config);
      const challenge = req.session.webAuthnAuthentication;
      if (!context || !challenge || challenge.userId !== context.user.id) {
        return res.status(401).json({ error: req.t('Your passkey challenge has expired. Try again.') });
      }
      if (Date.now() - Number(challenge.createdAt || 0) > MFA_CHALLENGE_MAX_AGE_MS) {
        delete req.session.webAuthnAuthentication;
        return res.status(401).json({ error: req.t('Your passkey challenge has expired. Try again.') });
      }
      if (rejectMfaRateLimit(req, res, db, config, context, { json: true, reserve: true })) return undefined;

      const response = req.body?.credential;
      const stored = db.prepare(`
        SELECT *
        FROM webauthn_credentials
        WHERE user_id = ? AND credential_id = ?
      `).get(context.user.id, response?.id);
      if (!stored) {
        delete req.session.webAuthnAuthentication;
        recordMfaFailure(req, context.user.id);
        return res.status(401).json({ error: req.t('The passkey could not be verified.') });
      }

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
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
      } catch (error) {
        delete req.session.webAuthnAuthentication;
        recordMfaFailure(req, context.user.id);
        if (String(error.message).includes('counter value')) {
          return res.status(401).json({
            error: req.t('The passkey counter was rejected. Remove and register this passkey again.')
          });
        }
        return res.status(401).json({ error: req.t('The passkey could not be verified.') });
      }

      delete req.session.webAuthnAuthentication;
      if (!verification.verified) {
        recordMfaFailure(req, context.user.id);
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
      return completeLogin(req, res, next, db, config, context.user, returnTo, { json: true });
    } catch (error) {
      releaseMfaAttempt(req);
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
