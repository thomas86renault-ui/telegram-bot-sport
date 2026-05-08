require('dotenv').config();
const { pool } = require('./config/database');
const logger = require('./config/logger');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

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

// ─── Tunnel cloudflared auto ──────────────────────────────────
const CF_PATH = '/tmp/cloudflared';

function startTunnel(bin) {
  logger.info('[Tunnel] Démarrage du tunnel...');
  const proc = spawn(bin, ['tunnel', '--url', 'http://localhost:3000'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stderr.on('data', (data) => {
    const line = data.toString();
    const match = line.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/);
    if (match) {
      logger.info(`🌐 TUNNEL URL → ${match[0]}`);
      logger.info(`👉 Copie cette URL dans BACKEND_URL sur Cloudflare Workers`);
    }
  });

  proc.on('error', (err) => {
    logger.warn('[Tunnel] Erreur: ' + err.message);
  });

  proc.unref();
}

function downloadAndStartTunnel() {
  if (fs.existsSync(CF_PATH)) {
    logger.info('[Tunnel] cloudflared déjà présent, démarrage...');
    startTunnel(CF_PATH);
    return;
  }

  logger.info('[Tunnel] Téléchargement de cloudflared...');
  const file = fs.createWriteStream(CF_PATH);

  const download = (url, redirectCount = 0) => {
    if (redirectCount > 5) {
      logger.warn('[Tunnel] Trop de redirections, abandon.');
      return;
    }
    https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        download(res.headers.location, redirectCount + 1);
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        fs.chmodSync(CF_PATH, '755');
        logger.info('[Tunnel] cloudflared téléchargé ✅');
        startTunnel(CF_PATH);
      });
    }).on('error', (err) => {
      logger.warn('[Tunnel] Téléchargement échoué: ' + err.message);
      fs.unlink(CF_PATH, () => {});
    });
  };

  download('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64');
}

// ─── Démarrage principal ──────────────────────────────────────
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
    // Lance le tunnel après que l'API soit prête
    downloadAndStartTunnel();
  });

  // Cron jobs
  const { setBot } = require('./jobs/scheduler');
  setBot(bot);

  // Breaking news + alertes pré-match
  const { startBreakingNewsJob } = require('./services/analysisCacheService');
  startBreakingNewsJob(bot);

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
