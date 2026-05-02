const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../config/database');
const { getUserByTelegramId, getUserStats, checkAnalysisPermission, consumeCredit } = require('../services/userService');
const { runAnalysis } = require('../services/analysisService');
const { handleWebhook } = require('../services/stripeService');
const logger = require('../config/logger');

const app = express();
app.set('trust proxy', 1);

// ─── Stripe webhook ───────────────────────────────────────────
app.post('/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const signature = req.headers['stripe-signature'];
      const result = await handleWebhook(req.body, signature);
      res.json({ received: true, ...result });
    } catch (err) {
      logger.error('Stripe webhook error:', err.message);
      res.status(400).json({ error: err.message });
    }
  }
);

// ─── Middlewares ──────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(rateLimit({ windowMs: 60 * 1000, max: 100, message: 'Trop de requêtes' }));

// ─── Auth Telegram WebApp ─────────────────────────────────────
const verifyTelegramWebApp = (req, res, next) => {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) return res.status(401).json({ error: 'Missing init data' });
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest();
    const expectedHash = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');
    if (expectedHash !== hash) {
      logger.warn(`Auth failed for user: ${params.get('user')}`);
    }
    const user = JSON.parse(params.get('user') || '{}');
    req.telegramUser = user;
    next();
  } catch (err) {
    logger.error('Telegram auth error:', err);
    res.status(401).json({ error: 'Auth failed' });
  }
};

// ─── GET /api/me ──────────────────────────────────────────────
app.get('/api/me', verifyTelegramWebApp, async (req, res) => {
  try {
    const user = await getUserByTelegramId(req.telegramUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const stats = await getUserStats(user.id);
    res.json({ ...user, stats });
  } catch (err) {
    logger.error('GET /api/me:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/bets ────────────────────────────────────────────
app.get('/api/bets', verifyTelegramWebApp, async (req, res) => {
  try {
    const user = await getUserByTelegramId(req.telegramUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { status, limit = 20, offset = 0 } = req.query;
    let sql = 'SELECT * FROM bets WHERE user_id = $1';
    const params = [user.id];

    if (status) {
      sql += ` AND status = $${params.length + 1}`;
      params.push(status);
    }

    sql += ` ORDER BY bet_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    logger.error('GET /api/bets:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/bets ───────────────────────────────────────────
app.post('/api/bets', verifyTelegramWebApp, async (req, res) => {
  try {
    const user = await getUserByTelegramId(req.telegramUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { sport, match_name, bet_type, stake, odds, bet_date } = req.body;
    if (!sport || !match_name || !stake || !odds) {
      return res.status(400).json({ error: 'Champs requis manquants' });
    }

    const result = await query(
      `INSERT INTO bets (user_id, sport, match_name, bet_type, stake, odds, bet_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [user.id, sport, match_name, bet_type, stake, odds, bet_date || new Date()]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('POST /api/bets:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PATCH /api/bets/:id ──────────────────────────────────────
app.patch('/api/bets/:id', verifyTelegramWebApp, async (req, res) => {
  try {
    const user = await getUserByTelegramId(req.telegramUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { status } = req.body;
    if (!['won', 'lost', 'void'].includes(status)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }

    const result = await query(
      `UPDATE bets SET status = $1
       WHERE id = $2 AND user_id = $3 AND status = 'pending'
       RETURNING *`,
      [status, req.params.id, user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pari non trouvé ou déjà résolu' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('PATCH /api/bets:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── PATCH /api/bets/:id/notify ───────────────────────────────
app.patch('/api/bets/:id/notify', verifyTelegramWebApp, async (req, res) => {
  try {
    const user = await getUserByTelegramId(req.telegramUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { notify } = req.body;
    const result = await query(
      `UPDATE bets SET notify_result = $1
       WHERE id = $2 AND user_id = $3 AND status = 'pending'
       RETURNING *`,
      [notify, req.params.id, user.id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Pari non trouvé' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('PATCH /api/bets/notify:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/analyses ────────────────────────────────────────
app.get('/api/analyses', verifyTelegramWebApp, async (req, res) => {
  try {
    const user = await getUserByTelegramId(req.telegramUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const result = await query(
      'SELECT * FROM analyses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [user.id]
    );

    res.json(result.rows);
  } catch (err) {
    logger.error('GET /api/analyses:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── GET /api/bankroll/history ────────────────────────────────
app.get('/api/bankroll/history', verifyTelegramWebApp, async (req, res) => {
  try {
    const user = await getUserByTelegramId(req.telegramUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const result = await query(
      `SELECT DATE(bet_date) AS date, SUM(pnl) AS daily_pnl
       FROM bets WHERE user_id = $1 AND status IN ('won','lost')
       GROUP BY DATE(bet_date) ORDER BY date ASC`,
      [user.id]
    );

    let running = parseFloat(user.bankroll_initial);
    const history = [{ date: 'Départ', bankroll: running }];
    for (const row of result.rows) {
      running += parseFloat(row.daily_pnl);
      history.push({ date: row.date, bankroll: parseFloat(running.toFixed(2)) });
    }

    res.json(history);
  } catch (err) {
    logger.error('GET /api/bankroll/history:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/analyse ────────────────────────────────────────
app.post('/api/analyse', verifyTelegramWebApp, async (req, res) => {
  try {
    const user = await getUserByTelegramId(req.telegramUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { canAnalyze, isFree, reason } = await checkAnalysisPermission(req.telegramUser.id);
    if (!canAnalyze) return res.json({ error: reason });

    const { match_name, sport, context } = req.body;
    const { analysis_id, result, oddsData } = await runAnalysis({
      user_id: user.id,
      sport: sport || 'football',
      matchName: match_name,
      context,
    });

    await consumeCredit(user.id, isFree, analysis_id);
    res.json({ result, oddsData, was_free: isFree });
  } catch (err) {
    logger.error('POST /api/analyse:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── POST /api/analyse-combo ──────────────────────────────────
app.post('/api/analyse-combo', verifyTelegramWebApp, async (req, res) => {
  try {
    const user = await getUserByTelegramId(req.telegramUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { canAnalyze, isFree } = await checkAnalysisPermission(req.telegramUser.id);
    if (!canAnalyze) return res.json({ error: 'no_credits' });

    const { matches } = req.body;
    if (!matches || matches.length < 2) {
      return res.status(400).json({ error: 'Minimum 2 matchs' });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const matchList = matches.map((m, i) => {
      const oddsText = m.odds ? ` (cote: ${m.odds})` : '';
      return `${i + 1}. ${m.match} [${m.sport}]${oddsText}`;
    }).join('\n');

    const totalOdds = matches
      .map(m => parseFloat(m.odds))
      .filter(o => o > 1)
      .reduce((acc, o) => acc * o, 1);

    const prompt = `Tu es un expert en paris sportifs combinés. Analyse ce combiné de ${matches.length} matchs.

Matchs :
${matchList}
${totalOdds > 1 ? `\nCote combinée totale: ${totalOdds.toFixed(2)}` : ''}

Pour chaque match :
• Pronostic recommandé
• Niveau de confiance : 🟢 Élevé / 🟡 Moyen / 🔴 Faible
• Risque principal

Conclusion :
• Probabilité globale estimée
• Mise recommandée (% bankroll)
• Verdict : ✅ Combiné jouable / ⚠️ Risqué / ❌ Déconseillé

Sois concis et factuel. Format clair avec emojis.`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const result = message.content[0].text;

    const saved = await query(
      `INSERT INTO analyses (user_id, sport, match_name, prompt_sent, result, credits_used, was_free)
       VALUES ($1, 'combiné', $2, $3, $4, 1, $5) RETURNING id`,
      [user.id, `Combiné ${matches.length} matchs`, prompt, result, isFree]
    );

    await consumeCredit(user.id, isFree, saved.rows[0].id);
    res.json({ result, was_free: isFree });
  } catch (err) {
    logger.error('POST /api/analyse-combo:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = app;
