import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  clearLanguagePreference,
  createTranslator,
  detectBrowserLanguage,
  normalizeLanguage,
  saveLanguagePreference
} from '../i18n.js';
import { setFlash } from '../utils.js';

export function createSettingsRouter() {
  const router = express.Router();

  router.get('/settings', requireAuth, (req, res) => {
    return res.render('settings', {
      title: req.t('Language settings')
    });
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

  return router;
}
