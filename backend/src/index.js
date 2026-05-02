require('dotenv').config();
// ─── Cloudflare Tunnel (HTTPS automatique) ────────────────────
const { execSync, spawn } = require('child_process');
try {
  execSync('which cloudflared', { stdio: 'ignore' });
} catch {
  execSync('curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /home/container/cloudflared && chmod +x /home/container/cloudflared', { stdio: 'inherit' });
}
const tunnel = spawn('/home/container/cloudflared', ['tunnel', '--url', 'http://localhost:3000'], { stdio: 'pipe' });
tunnel.stderr.on('data', async (data) => {
  const str = data.toString();
  const match = str.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
  if (match) {
    const tunnelUrl = match[0];
    logger.info(`Tunnel HTTPS: ${tunnelUrl}`);
    // Met à jour automatiquement la variable BACKEND_URL du Worker Cloudflare
    try {
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/workers/scripts/parissportif-api/secrets`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'BACKEND_URL', text: tunnelUrl, type: 'secret_text' }),
      });
      logger.info(`Worker mis à jour avec: ${tunnelUrl}`);
    } catch(e) {
      logger.warn('Impossible de mettre à jour le Worker:', e.message);
    }
  }
});
const { pool } = require('./config/database');
const logger = require('./config/logger');

const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'TELEGRAM_WEBAPP_URL',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    logger.error(`Variable d'environnement manquante: ${key}`);
    process.exit(1);
  }
}

(async () => {
  try {
    await pool.query('SELECT 1');
    logger.info('PostgreSQL connecté');
  } catch (err) {
    logger.error('Impossible de se connecter à PostgreSQL:', err.message);
    process.exit(1);
  }

  // Bot Telegram
  const bot = require('./bot/bot');

  // API Express
  const app = require('./api/routes');
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info(`API démarrée sur le port ${PORT}`);
  });

  // Cron jobs — on passe le bot pour les broadcasts
  const { setBot } = require('./jobs/scheduler');
  setBot(bot);

  logger.info('🚀 Bot Sport IA démarré avec succès');
})();

process.on('SIGTERM', async () => {
  logger.info('SIGTERM reçu, arrêt gracieux...');
  await pool.end();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection:', err);
});
