const cron = require('node-cron');
const { resetWeeklyFreeAnalysis } = require('../services/userService');
const { query } = require('../config/database');
const { runAnalysis } = require('../services/analysisService');
const { checkPendingResults, setBot: setCheckerBot } = require('../services/resultsChecker');
const logger = require('../config/logger');

let bot = null;

const setBot = (botInstance) => {
  bot = botInstance;
  setCheckerBot(botInstance);
};

// ─── Vérification résultats — toutes les heures ───────────────
cron.schedule('0 * * * *', async () => {
  logger.info('CRON: Vérification résultats paris...');
  try {
    await checkPendingResults();
  } catch (err) {
    logger.error('CRON results error:', err);
  }
});

// ─── Analyse automatique soirée — 18h serveur (= 20h Paris) ──
cron.schedule('0 18 * * *', async () => {
  logger.info('CRON: Lancement analyse automatique soirée...');
  if (!bot) return;

  try {
    const matchesSoiree = await getMatchesDuSoir();
    if (!matchesSoiree.length) {
      logger.info('CRON: Aucun match important trouvé ce soir');
      return;
    }

    const usersRes = await query(
      `SELECT telegram_id, first_name FROM users WHERE subscription_status = 'active'`
    );
    const users = usersRes.rows;
    if (!users.length) return;

    logger.info(`CRON: ${matchesSoiree.length} matchs, envoi à ${users.length} abonnés`);

    const analysesPromises = matchesSoiree.slice(0, 3).map(match => runAnalyseSoiree(match));
    const analyses = await Promise.allSettled(analysesPromises);

    let message = `🌙 *Analyse du soir — matchs importants*\n\n`;
    message += `_${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}_\n\n`;

    for (const analyse of analyses) {
      if (analyse.status === 'fulfilled' && analyse.value) {
        message += `⚽ *${analyse.value.matchName}*\n${analyse.value.resume}\n\n─────────────────\n\n`;
      }
    }
    message += `💡 _Pour une analyse complète, utilise /analyse_`;

    for (const user of users) {
      try {
        await bot.sendMessage(user.telegram_id, message, { parse_mode: 'Markdown' });
        await sleep(100);
      } catch (err) {
        logger.warn(`CRON: Envoi échoué pour ${user.telegram_id}`);
      }
    }

    logger.info('CRON: Analyse soirée envoyée');
  } catch (err) {
    logger.error('CRON analyse soirée error:', err);
  }
});

// ─── Reset hebdomadaire — lundi 00:00 ────────────────────────
cron.schedule('0 0 * * 1', async () => {
  logger.info('CRON: Reset analyses gratuites...');
  try {
    const count = await resetWeeklyFreeAnalysis();
    logger.info(`CRON: ${count} users réinitialisés`);
  } catch (err) {
    logger.error('CRON reset error:', err);
  }
});

// ─── Nettoyage Stripe — dimanche 03:00 ───────────────────────
cron.schedule('0 3 * * 0', async () => {
  try {
    const result = await query(
      `DELETE FROM stripe_events WHERE processed = TRUE AND created_at < NOW() - INTERVAL '90 days'`
    );
    logger.info(`CRON: ${result.rowCount} events Stripe supprimés`);
  } catch (err) {
    logger.error('CRON cleanup error:', err);
  }
});

// ─── Helpers ──────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const getMatchesDuSoir = async () => {
  const axios = require('axios');
  const sports = ['soccer_france_ligue1', 'soccer_epl', 'soccer_uefa_champs_league', 'basketball_nba'];
  const matches = [];
  const now = new Date();
  const end = new Date(now.getTime() + 6 * 60 * 60 * 1000);

  for (const sport of sports) {
    try {
      const res = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds`, {
        params: { apiKey: process.env.ODDS_API_KEY, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal' },
        timeout: 5000,
      });
      const soiree = (res.data || []).filter(m => {
        const t = new Date(m.commence_time);
        return t >= now && t <= end;
      });
      for (const m of soiree.slice(0, 2)) {
        matches.push({
          sport,
          matchName: `${m.home_team} vs ${m.away_team}`,
          commence_time: m.commence_time,
          odds: m.bookmakers?.[0]?.markets?.[0]?.outcomes?.map(o => `${o.name}: ${o.price}`).join(' | ') || '',
        });
      }
    } catch (err) {
      logger.warn(`CRON odds error ${sport}: ${err.message}`);
    }
  }
  return matches.sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));
};

const runAnalyseSoiree = async (match) => {
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const heure = new Date(match.commence_time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Analyse ce match en 3 lignes max et donne UN pronostic.\nMatch: ${match.matchName}\nHeure: ${heure}\n${match.odds ? `Cotes: ${match.odds}` : ''}\n\nFormat: 🕐 ${heure} | Pronostic: [pronostic] @ [cote]\n📊 [analyse courte]\n🎯 Confiance: [Faible/Moyen/Élevé]`
    }],
  });

  return { matchName: match.matchName, resume: message.content[0].text };
};

logger.info('Cron jobs initialisés (résultats/h, soirée 18h, reset lundi)');

module.exports = { setBot };
