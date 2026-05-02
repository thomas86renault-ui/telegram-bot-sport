const { query, withTransaction } = require('../config/database');

/**
 * Trouve ou crée un user depuis son telegram_id
 */
const findOrCreateUser = async (telegramUser) => {
  const { id: telegram_id, username, first_name } = telegramUser;

  const existing = await query(
    'SELECT * FROM users WHERE telegram_id = $1',
    [telegram_id]
  );

  if (existing.rows.length > 0) {
    // Mise à jour username/first_name si changé
    await query(
      `UPDATE users SET username = $1, first_name = $2 WHERE telegram_id = $3`,
      [username, first_name, telegram_id]
    );
    return existing.rows[0];
  }

  const result = await query(
    `INSERT INTO users (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [telegram_id, username, first_name]
  );
  return result.rows[0];
};

const getUserByTelegramId = async (telegram_id) => {
  const result = await query(
    'SELECT * FROM users WHERE telegram_id = $1',
    [telegram_id]
  );
  return result.rows[0] || null;
};

const getUserById = async (id) => {
  const result = await query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
};

/**
 * Vérifie si l'utilisateur peut lancer une analyse
 * Retourne { canAnalyze, reason, isFree }
 */
const checkAnalysisPermission = async (telegram_id) => {
  const user = await getUserByTelegramId(telegram_id);
  if (!user) return { canAnalyze: false, reason: 'user_not_found' };

  // Analyse gratuite hebdomadaire
  if (!user.free_analysis_used) {
    return { canAnalyze: true, isFree: true, user };
  }

  // Crédits payants
  if (user.credits > 0) {
    return { canAnalyze: true, isFree: false, user };
  }

  return { canAnalyze: false, reason: 'no_credits', user };
};

/**
 * Consomme 1 crédit (ou marque l'analyse gratuite)
 * Insère dans le ledger credit_transactions
 */
const consumeCredit = async (user_id, isFree, analysis_id) => {
  return withTransaction(async (client) => {
    if (isFree) {
      await client.query(
        'UPDATE users SET free_analysis_used = TRUE WHERE id = $1',
        [user_id]
      );
    } else {
      await client.query(
        'UPDATE users SET credits = credits - 1 WHERE id = $1 AND credits > 0',
        [user_id]
      );
      await client.query(
        `INSERT INTO credit_transactions (user_id, amount, type, description)
         VALUES ($1, -1, 'analysis', $2)`,
        [user_id, `Analyse #${analysis_id}`]
      );
    }
  });
};

/**
 * Ajoute des crédits (achat ou abonnement)
 */
const addCredits = async (user_id, amount, type, stripe_payment_id = null, description = '') => {
  return withTransaction(async (client) => {
    await client.query(
      'UPDATE users SET credits = credits + $1 WHERE id = $2',
      [amount, user_id]
    );
    await client.query(
      `INSERT INTO credit_transactions (user_id, amount, type, stripe_payment_id, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [user_id, amount, type, stripe_payment_id, description]
    );
  });
};

/**
 * Reset hebdomadaire — appelé par le cron chaque lundi
 */
const resetWeeklyFreeAnalysis = async () => {
  const result = await query(
    `UPDATE users
     SET free_analysis_used = FALSE,
         free_analysis_reset_at = NOW()
     WHERE free_analysis_used = TRUE`
  );
  return result.rowCount;
};

/**
 * Stats bankroll de l'utilisateur
 */
const getUserStats = async (user_id) => {
  const [userRes, betsRes] = await Promise.all([
    query('SELECT bankroll_initial, bankroll_current FROM users WHERE id = $1', [user_id]),
    query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'won') AS wins,
         COUNT(*) FILTER (WHERE status = 'lost') AS losses,
         COUNT(*) FILTER (WHERE status != 'pending' AND status != 'void') AS total_resolved,
         COALESCE(SUM(pnl), 0) AS total_pnl,
         COALESCE(SUM(stake) FILTER (WHERE status != 'void' AND status != 'pending'), 0) AS total_staked
       FROM bets WHERE user_id = $1`,
      [user_id]
    )
  ]);

  const user = userRes.rows[0];
  const stats = betsRes.rows[0];
  const total = parseInt(stats.total_resolved) || 1;

  return {
    bankroll_initial: parseFloat(user.bankroll_initial),
    bankroll_current: parseFloat(user.bankroll_current),
    bankroll_roi: ((parseFloat(user.bankroll_current) - parseFloat(user.bankroll_initial)) / (parseFloat(user.bankroll_initial) || 1) * 100).toFixed(1),
    wins: parseInt(stats.wins),
    losses: parseInt(stats.losses),
    win_rate: ((parseInt(stats.wins) / total) * 100).toFixed(1),
    total_pnl: parseFloat(stats.total_pnl).toFixed(2),
    total_staked: parseFloat(stats.total_staked).toFixed(2),
  };
};

module.exports = {
  findOrCreateUser,
  getUserByTelegramId,
  getUserById,
  checkAnalysisPermission,
  consumeCredit,
  addCredits,
  resetWeeklyFreeAnalysis,
  getUserStats,
};
