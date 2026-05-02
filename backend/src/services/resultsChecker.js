const axios = require('axios');
const { query } = require('../config/database');
const logger = require('../config/logger');

let bot = null;
const setBot = (botInstance) => { bot = botInstance; };

/**
 * Vérifie les résultats des paris en attente avec notify_result = true
 * Appelé toutes les heures par le cron
 */
const checkPendingResults = async () => {
  if (!bot) return;

  // Récupère tous les paris en attente avec notification activée
  const betsRes = await query(`
    SELECT b.*, u.telegram_id, u.first_name
    FROM bets b
    JOIN users u ON u.id = b.user_id
    WHERE b.status = 'pending'
      AND b.notify_result = TRUE
      AND b.bet_date > NOW() - INTERVAL '7 days'
  `);

  const bets = betsRes.rows;
  if (!bets.length) return;

  logger.info(`NOTIF: Vérification de ${bets.length} paris en attente...`);

  // Regroupe par sport pour minimiser les appels API
  const sportMap = {};
  for (const bet of bets) {
    const sport = bet.sport || 'football';
    if (!sportMap[sport]) sportMap[sport] = [];
    sportMap[sport].push(bet);
  }

  for (const [sport, sportBets] of Object.entries(sportMap)) {
    await checkSportResults(sport, sportBets);
    await sleep(500);
  }
};

const checkSportResults = async (sport, bets) => {
  const sportKey = getSportKey(sport);
  
  try {
    // Récupère les scores des matchs terminés
    const res = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/scores`, {
      params: {
        apiKey: process.env.ODDS_API_KEY,
        daysFrom: 1,
      },
      timeout: 8000,
    });

    const completedGames = (res.data || []).filter(g => g.completed === true);
    if (!completedGames.length) return;

    for (const bet of bets) {
      const match = findMatchForBet(bet, completedGames);
      if (!match) continue;

      // Détermine le résultat
      const result = determineResult(bet, match);
      if (!result) continue;

      // Met à jour le pari en BDD
      await query(
        `UPDATE bets SET status = $1, notify_result = FALSE WHERE id = $2`,
        [result.status, bet.id]
        // Le trigger SQL calcule automatiquement le PNL et met à jour la bankroll
      );

      // Envoie la notification Telegram
      await sendResultNotification(bet, match, result);

      logger.info(`NOTIF: Résultat envoyé pour ${bet.match_name} → ${result.status}`);
    }
  } catch (err) {
    logger.warn(`NOTIF: Erreur scores API pour ${sport}: ${err.message}`);
  }
};

/**
 * Trouve le match dans les résultats API qui correspond au pari
 */
const findMatchForBet = (bet, games) => {
  const betName = bet.match_name.toLowerCase();
  
  return games.find(game => {
    const home = game.home_team?.toLowerCase() || '';
    const away = game.away_team?.toLowerCase() || '';
    
    // Cherche si les équipes du pari sont dans le nom du match
    const homeWords = home.split(' ');
    const awayWords = away.split(' ');
    
    const betWords = betName.split(/[\s\-vs]+/).filter(w => w.length > 2);
    
    let matches = 0;
    for (const word of betWords) {
      if (homeWords.some(w => w.includes(word) || word.includes(w))) matches++;
      if (awayWords.some(w => w.includes(word) || word.includes(w))) matches++;
    }
    
    return matches >= 2;
  });
};

/**
 * Détermine si le pari est gagné, perdu ou nul
 * Logique basique basée sur le résultat 1X2
 */
const determineResult = (bet, game) => {
  const scores = game.scores;
  if (!scores || scores.length < 2) return null;

  const homeScore = parseInt(scores.find(s => s.name === game.home_team)?.score || 0);
  const awayScore = parseInt(scores.find(s => s.name === game.away_team)?.score || 0);
  
  const betType = (bet.bet_type || '').toLowerCase();
  
  let winner = null;
  if (homeScore > awayScore) winner = 'home';
  else if (awayScore > homeScore) winner = 'away';
  else winner = 'draw';

  // Détecte le type de pari et compare au résultat
  let status = 'void'; // Par défaut si on ne peut pas déterminer

  if (betType.includes('victoire') || betType.includes('win') || betType.includes('domicile') || betType.includes('home') || betType.includes('1')) {
    status = winner === 'home' ? 'won' : 'lost';
  } else if (betType.includes('extérieur') || betType.includes('away') || betType.includes('2')) {
    status = winner === 'away' ? 'won' : 'lost';
  } else if (betType.includes('nul') || betType.includes('draw') || betType.includes('x')) {
    status = winner === 'draw' ? 'won' : 'lost';
  } else {
    // Type non reconnu → on marque juste le score et laisse l'utilisateur décider
    return {
      status: 'void',
      homeScore,
      awayScore,
      unknown_type: true,
    };
  }

  return { status, homeScore, awayScore };
};

/**
 * Envoie la notification de résultat sur Telegram
 */
const sendResultNotification = async (bet, game, result) => {
  const scoreText = `${game.home_team} ${result.homeScore} - ${result.awayScore} ${game.away_team}`;
  const pnl = result.status === 'won'
    ? (parseFloat(bet.stake) * parseFloat(bet.odds) - parseFloat(bet.stake)).toFixed(2)
    : result.status === 'lost'
    ? `-${parseFloat(bet.stake).toFixed(2)}`
    : '0.00';

  let message = '';

  if (result.unknown_type) {
    message =
      `📊 *Résultat disponible*\n\n` +
      `Match: *${bet.match_name}*\n` +
      `Score final: *${scoreText}*\n\n` +
      `_Mets à jour ton pari manuellement dans le dashboard._`;
  } else if (result.status === 'won') {
    message =
      `🎉 *PARI GAGNÉ !*\n\n` +
      `Match: *${bet.match_name}*\n` +
      `Score: *${scoreText}*\n` +
      `Mise: ${parseFloat(bet.stake).toFixed(2)}€ @ ${parseFloat(bet.odds).toFixed(2)}\n` +
      `✅ Gain: *+${pnl}€*\n\n` +
      `Ton bankroll a été mis à jour automatiquement 📈`;
  } else if (result.status === 'lost') {
    message =
      `😔 *Pari perdu*\n\n` +
      `Match: *${bet.match_name}*\n` +
      `Score: *${scoreText}*\n` +
      `Mise: ${parseFloat(bet.stake).toFixed(2)}€\n` +
      `❌ Perte: *${pnl}€*\n\n` +
      `_Continue, la prochaine sera la bonne !_ 💪`;
  }

  await bot.sendMessage(bet.telegram_id, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Voir mon dashboard', web_app: { url: process.env.TELEGRAM_WEBAPP_URL } }],
        [{ text: '⚽ Analyser un match', callback_data: 'analyse' }],
      ]
    }
  });
};

const getSportKey = (sport) => {
  const map = {
    football: 'soccer_france_ligue1',
    tennis: 'tennis_atp_french_open',
    basketball: 'basketball_nba',
    rugby: 'rugbyunion_world_cup',
  };
  return map[sport] || 'soccer_epl';
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { checkPendingResults, setBot };
