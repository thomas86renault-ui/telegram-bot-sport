const cron = require('node-cron');
const { resetWeeklyFreeAnalysis } = require('../services/userService');
const { query } = require('../config/database');
const logger = require('../config/logger');

/**
 * Reset hebdomadaire — chaque lundi à 00:00
 * Remet free_analysis_used = FALSE pour tous les users
 */
cron.schedule('0 0 * * 1', async () => {
  logger.info('CRON: Reset analyses gratuites hebdomadaires...');
  try {
    const count = await resetWeeklyFreeAnalysis();
    logger.info(`CRON: ${count} users réinitialisés`);
  } catch (err) {
    logger.error('CRON reset error:', err);
  }
}, {
  timezone: 'Europe/Paris'
});

/**
 * Nettoyage des events Stripe anciens — chaque dimanche à 03:00
 */
cron.schedule('0 3 * * 0', async () => {
  logger.info('CRON: Nettoyage events Stripe anciens...');
  try {
    const result = await query(
      `DELETE FROM stripe_events
       WHERE processed = TRUE
         AND created_at < NOW() - INTERVAL '90 days'`
    );
    logger.info(`CRON: ${result.rowCount} events Stripe supprimés`);
  } catch (err) {
    logger.error('CRON cleanup error:', err);
  }
}, { timezone: 'Europe/Paris' });

logger.info('Cron jobs initialisés (Paris timezone)');
