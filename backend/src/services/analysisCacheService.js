/**
 * analysisCacheService.js
 * Job breaking news : toutes les 30min, scan UNIQUEMENT les matchs
 * qui ont eu au moins une demande aujourd'hui.
 * Notif groupée 1-2h avant le match (1 message par user, pas de doublon).
 * Si le user veut l'analyse à jour maintenant → lien stripe recharge crédits.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../config/database');
const { todayParis } = require('./analysisService');
const logger = require('../config/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const INTERVAL_MS = 30 * 60 * 1000; // 30 min
const NOTIF_WINDOW_MINUTES = 120;   // alerte entre 60 et 120min avant le match

// ─── Prompt breaking news (court = peu de tokens) ────────────
const buildNewsPrompt = (matchName, sport, lastAt) => {
  const lastStr = new Date(lastAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  return `Recherche web rapide sur "${matchName}" (${sport}).
Cherche UNIQUEMENT des infos NOUVELLES depuis le ${lastStr} :
- Nouvelle blessure / forfait confirmé
- Composition officielle publiée
- Report ou incident majeur

Si rien de nouveau : réponds exactement "RAS"
Sinon : "ALERTE|[résumé max 80 chars]|[conseil pari 1 phrase]"`.trim();
};

const checkBreakingNews = async (matchName, sport, lastAt) => {
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: buildNewsPrompt(matchName, sport, lastAt) }],
    });
    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text || text === 'RAS' || !text.startsWith('ALERTE|')) return null;
    const parts = text.split('|');
    if (parts.length < 3) return null;
    return { summary: parts[1]?.trim(), advice: parts[2]?.trim() };
  } catch (e) {
    logger.warn(`[BreakingNews] check error (${matchName}):`, e.message);
    return null;
  }
};

const markAlerted = async (userIds, cacheKey, cacheDate) => {
  if (!userIds.length) return;
  await query(
    `UPDATE analysis_cache_users SET alerted=true, alerted_at=NOW()
     WHERE user_id=ANY($1) AND cache_key=$2 AND cache_date=$3`,
    [userIds, cacheKey, cacheDate]
  );
};

// ─── Job principal ────────────────────────────────────────────
const startBreakingNewsJob = (bot) => {
  const STRIPE_CREDITS_URL = process.env.STRIPE_CREDITS_URL || null;
  const WEBAPP_URL = process.env.TELEGRAM_WEBAPP_URL || '';

  const run = async () => {
    logger.info('[BreakingNews] Scan...');
    const today = todayParis();

    try {
      // Récupère UNIQUEMENT les matchs qui ont eu une demande aujourd'hui
      // ET qui commencent dans 60-120 min (fenêtre d'alerte pré-match)
      // ET qui ont au moins 1 user non alerté
      const rows = await query(
        `SELECT ac.cache_key, ac.match_name, ac.sport, ac.commence_time,
                a.created_at AS last_analysis_at,
                COUNT(acu.user_id) FILTER (WHERE acu.alerted = false) AS pending
         FROM analysis_cache ac
         JOIN analyses a ON a.id = ac.analysis_id
         JOIN analysis_cache_users acu
           ON acu.cache_key = ac.cache_key AND acu.cache_date = ac.cache_date
         WHERE ac.cache_date = $1
           AND ac.commence_time IS NOT NULL
           AND ac.commence_time > NOW() + INTERVAL '60 minutes'
           AND ac.commence_time < NOW() + INTERVAL '120 minutes'
           AND acu.alerted = false
         GROUP BY ac.cache_key, ac.match_name, ac.sport, ac.commence_time, a.created_at
         HAVING COUNT(acu.user_id) FILTER (WHERE acu.alerted = false) > 0`,
        [today]
      );

      logger.info(`[BreakingNews] ${rows.rows.length} match(s) dans la fenêtre 60-120min`);

      for (const cache of rows.rows) {
        await new Promise(r => setTimeout(r, 2000)); // anti-flood

        // Vérifier s'il y a du nouveau
        const news = await checkBreakingNews(cache.match_name, cache.sport, cache.last_analysis_at);

        // Récupérer les users non alertés pour ce match
        const usersRes = await query(
          `SELECT acu.user_id, u.telegram_id
           FROM analysis_cache_users acu
           JOIN users u ON u.id = acu.user_id
           WHERE acu.cache_key = $1 AND acu.cache_date = $2 AND acu.alerted = false`,
          [cache.cache_key, today]
        );
        const users = usersRes.rows;
        if (!users.length) continue;

        const matchTime = new Date(cache.commence_time).toLocaleString('fr-FR', {
          timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit',
        });

        // Message différent selon s'il y a du nouveau ou non
        let text, buttons;
        if (news) {
          text =
            `🚨 *Actu avant match — ${cache.match_name}*\n\n` +
            `${news.summary}\n\n` +
            `💡 *Paris :* ${news.advice}\n\n` +
            `_Match à ${matchTime}_`;
          buttons = [
            [{ text: '⚡ Analyse fraîche — recharger crédits', url: STRIPE_CREDITS_URL || 'https://t.me/stckb2' }],
            [{ text: '📊 Dashboard', web_app: { url: WEBAPP_URL } }],
          ];
        } else {
          text =
            `⏰ *Rappel — ${cache.match_name}*\n\n` +
            `Match dans ~1h (${matchTime}). Aucun changement majeur détecté.\n\n` +
            `_Veux-tu une analyse fraîche avec les compos officielles ?_`;
          buttons = [
            [{ text: '⚡ Analyse fraîche — recharger crédits', url: STRIPE_CREDITS_URL || 'https://t.me/stckb2' }],
          ];
        }

        const notifiedIds = [];
        for (const user of users) {
          try {
            await bot.sendMessage(user.telegram_id, text, {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: buttons },
            });
            notifiedIds.push(user.user_id);
          } catch (e) {
            logger.warn(`[BreakingNews] Échec envoi ${user.telegram_id}:`, e.message);
          }
        }

        await markAlerted(notifiedIds, cache.cache_key, today);

        if (news) {
          await query(
            `INSERT INTO breaking_news_alerts (cache_key, match_name, sport, summary, bet_advice, users_notified)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [cache.cache_key, cache.match_name, cache.sport, news.summary, news.advice, notifiedIds.length]
          );
        }

        logger.info(`[BreakingNews] "${cache.match_name}" → ${notifiedIds.length} users notifiés${news ? ' (ALERTE)' : ' (rappel)'}`);
      }

      logger.info('[BreakingNews] Scan terminé');
    } catch (e) {
      logger.error('[BreakingNews] Erreur générale:', e);
    }
  };

  run();
  setInterval(run, INTERVAL_MS);
  logger.info('[BreakingNews] Job démarré (toutes les 30min)');
};

module.exports = { startBreakingNewsJob };
