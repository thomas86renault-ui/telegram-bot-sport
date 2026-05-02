require('dotenv').config();
const { pool } = require('./config/database');
const logger = require('./config/logger');

// ─── Vérification des variables d'env requises ────────────────
const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'ANTHROPIC_API_KEY',
  'TELEGRAM_WEBAPP_URL',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    logger.error(`Variable d'environnement manquante: ${key}`);
    process.exit(1);
  }
}

// ─── Démarrage ────────────────────────────────────────────────
(async () => {
  // Test connexion BDD
  try {
    await pool.query('SELECT 1');
    logger.info('PostgreSQL connecté');
  } catch (err) {
    logger.error('Impossible de se connecter à PostgreSQL:', err.message);
    process.exit(1);
  }

  // Bot Telegram
  require('./bot/bot');

  // API Express
  const app = require('./api/routes');
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info(`API démarrée sur le port ${PORT}`);
  });

  // Cron jobs
  require('./jobs/scheduler');

  logger.info('🚀 Bot Sport IA démarré avec succès');
})();

// ─── Graceful shutdown ────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM reçu, arrêt gracieux...');
  await pool.end();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection:', err);
});
