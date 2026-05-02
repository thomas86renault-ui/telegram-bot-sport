const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { query } = require('../config/database');
const logger = require('../config/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Récupère les cotes du match via The Odds API
 */
const getMatchOdds = async (sport, matchKeyword) => {
  try {
    const sportMap = {
      football: 'soccer_france_ligue1',
      tennis: 'tennis_atp_french_open',
      basketball: 'basketball_nba',
      default: 'soccer_epl'
    };
    const sportKey = sportMap[sport?.toLowerCase()] || sportMap.default;

    const res = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds`, {
      params: {
        apiKey: process.env.ODDS_API_KEY,
        regions: 'eu',
        markets: 'h2h,totals',
        oddsFormat: 'decimal'
      },
      timeout: 5000
    });

    const matches = res.data || [];
    const match = matches.find(m =>
      m.home_team?.toLowerCase().includes(matchKeyword?.toLowerCase()) ||
      m.away_team?.toLowerCase().includes(matchKeyword?.toLowerCase())
    );

    return match ? formatOddsData(match) : null;
  } catch (err) {
    logger.warn('Odds API error:', err.message);
    return null;
  }
};

const formatOddsData = (match) => {
  const bookmaker = match.bookmakers?.[0];
  if (!bookmaker) return null;
  const h2h = bookmaker.markets?.find(m => m.key === 'h2h');
  if (!h2h) return null;

  return {
    home_team: match.home_team,
    away_team: match.away_team,
    commence_time: match.commence_time,
    odds: h2h.outcomes.map(o => `${o.name}: ${o.price}`).join(' | ')
  };
};

/**
 * Lance une analyse IA pour un match donné
 */
const runAnalysis = async ({ user_id, sport, matchName, context = '' }) => {
  const oddsData = await getMatchOdds(sport, matchName);

  const prompt = buildPrompt({ sport, matchName, oddsData, context });

  logger.info(`Running analysis for user ${user_id}: ${matchName}`);

  const message = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  });

  const result = message.content[0].text;

  // Persiste l'analyse en BDD
  const saved = await query(
    `INSERT INTO analyses (user_id, sport, match_name, prompt_sent, result, credits_used)
     VALUES ($1, $2, $3, $4, $5, 1)
     RETURNING id`,
    [user_id, sport, matchName, prompt, result]
  );

  return { analysis_id: saved.rows[0].id, result, oddsData };
};

const buildPrompt = ({ sport, matchName, oddsData, context }) => {
  let prompt = `Tu es un expert en analyse sportive et paris. Analyse ce match et donne un pronostic argumenté.

Match: ${matchName}
Sport: ${sport || 'Non précisé'}`;

  if (oddsData) {
    prompt += `\n\nCotes actuelles du marché:
- ${oddsData.home_team} vs ${oddsData.away_team}
- ${oddsData.odds}
- Date: ${new Date(oddsData.commence_time).toLocaleDateString('fr-FR')}`;
  }

  if (context) {
    prompt += `\n\nContexte supplémentaire: ${context}`;
  }

  prompt += `

Réponds en français avec:
1. **Analyse** (forme des équipes, contexte, statistiques clés)
2. **Pronostic** (pari recommandé avec cote conseillée)
3. **Niveau de confiance** (Faible / Moyen / Élevé)
4. **Gestion du bankroll** (% de mise recommandé)
5. **Risques** (facteurs pouvant invalider le pronostic)

Sois concis et factuel. Max 400 mots.`;

  return prompt;
};

module.exports = { runAnalysis, getMatchOdds };
