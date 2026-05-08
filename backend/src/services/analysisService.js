const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { query } = require('../config/database');
const logger = require('../config/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Helpers ──────────────────────────────────────────────────
const normalizeKey = (matchName, sport) =>
  (matchName + '_' + sport)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const todayParis = () => {
  const parts = new Date().toLocaleDateString('fr-FR', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).split('/');
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
};

// ─── Cache ────────────────────────────────────────────────────
const getCached = async (matchName, sport, isPremium) => {
  try {
    const res = await query(
      `SELECT ac.analysis_id, a.result, a.created_at
       FROM analysis_cache ac JOIN analyses a ON a.id = ac.analysis_id
       WHERE ac.cache_key = $1 AND ac.cache_date = $2
       ORDER BY ac.updated_at DESC LIMIT 1`,
      [normalizeKey(matchName, sport), todayParis()]
    );
    if (!res.rows.length) return null;
    const row = res.rows[0];
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    const maxAge = isPremium ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return ageMs < maxAge ? row : null;
  } catch (e) { logger.warn('[Cache] get:', e.message); return null; }
};

const saveCache = async (matchName, sport, analysisId, commenceTime) => {
  try {
    await query(
      `INSERT INTO analysis_cache (cache_key, match_name, sport, analysis_id, cache_date, commence_time)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (cache_key,cache_date,sport)
       DO UPDATE SET analysis_id=$4, updated_at=NOW()`,
      [normalizeKey(matchName, sport), matchName, sport, analysisId, todayParis(), commenceTime || null]
    );
  } catch (e) { logger.warn('[Cache] save:', e.message); }
};

const trackUser = async (userId, matchName, sport) => {
  try {
    await query(
      `INSERT INTO analysis_cache_users (user_id,cache_key,cache_date,alerted)
       VALUES ($1,$2,$3,false) ON CONFLICT DO NOTHING`,
      [userId, normalizeKey(matchName, sport), todayParis()]
    );
  } catch (e) { logger.warn('[Cache] track:', e.message); }
};

const cacheBadge = (createdAt) => {
  const t = new Date(createdAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  return `🕐 _Analyse générée à ${t} — partagée avec d'autres users aujourd'hui. Refresh = 1 crédit._`;
};

// ─── Odds API (optionnelle) ───────────────────────────────────
const getOdds = async (sport, matchName) => {
  const sportMap = {
    football:          ['soccer_france_ligue1','soccer_epl','soccer_uefa_champs_league','soccer_spain_la_liga','soccer_germany_bundesliga','soccer_italy_serie_a'],
    tennis:            ['tennis_atp_french_open','tennis_wta_french_open','tennis_atp_wimbledon','tennis_atp_us_open'],
    basketball:        ['basketball_nba','basketball_euroleague'],
    rugby:             ['rugbyunion_world_cup','rugbyunion_premiership'],
    american_football: ['americanfootball_nfl'],
    baseball:          ['baseball_mlb'],
    hockey:            ['icehockey_nhl'],
  };
  const leagues = sportMap[sport] || sportMap.football;
  const words = matchName.toLowerCase().split(/[\s\-vs]+/).filter(w => w.length > 2);
  for (const league of leagues) {
    try {
      const res = await axios.get(`https://api.the-odds-api.com/v4/sports/${league}/odds`, {
        params: { apiKey: process.env.ODDS_API_KEY, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal' },
        timeout: 4000,
      });
      const match = (res.data || []).find(m =>
        words.some(w => (m.home_team||'').toLowerCase().includes(w) || (m.away_team||'').toLowerCase().includes(w))
      );
      if (match) {
        const h2h = match.bookmakers?.[0]?.markets?.find(m => m.key === 'h2h');
        if (h2h) return {
          home: match.home_team, away: match.away_team,
          commence_time: match.commence_time,
          odds: h2h.outcomes.map(o => `${o.name}:${o.price}`).join(' | '),
        };
      }
    } catch (_) {}
  }
  return null;
};

// ─── Prompt universel optimisé (−40% tokens) ─────────────────
const buildPrompt = (matchName, sport, oddsData) => {
  const date = new Date().toLocaleDateString('fr-FR', {
    timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long',
  });
  const oddsLine = oddsData
    ? `Cotes: ${oddsData.odds}`
    : `Cotes: estime avec "(est.)"`;

  // Prompt compact : même structure, beaucoup moins de verbosité
  return `Analyste paris sportifs. ${date}. Match: ${matchName} | Sport: ${sport}. ${oddsLine}.

Cherche infos récentes (blessures, forme, compos), puis analyse. Règle: toujours produire une analyse, jamais de refus. Si info manque: estime avec "(est.)". Vocabulaire adapté au sport. Max 650 tokens.

Format:
🚨 *INFOS*
• [A]: [blessures/RAS] • [B]: [blessures/RAS]

📊 *FORME* (5 derniers)
• [A]: ... • [B]: ...

⚔️ *ANALYSE*
• [Facteur 1] • [Facteur 2] • [Facteur 3]

🎯 *PARIS*
🥇 [Pari] — [X.XX] — [XX]% — [X]% bankroll
🥈 [Pari] — [X.XX] — [XX]% — [X]% bankroll
🥉 [Value] — [X.XX] — [XX]% — [X]% bankroll
💡 Combi: [A]+[B] → ~[X.XX] — 1-2%

⚠️ *RISQUES*: [R1] / [R2]`;
};

// ─── Export principal ─────────────────────────────────────────
const runAnalysis = async ({ user_id, sport, matchName, context = '', isPremium = false }) => {
  logger.info(`[Analysis] "${matchName}" sport=${sport} user=${user_id}`);

  // Cache
  const cached = await getCached(matchName, sport, isPremium);
  if (cached) {
    await trackUser(user_id, matchName, sport);
    return { analysis_id: cached.analysis_id, result: cached.result, fromCache: true, cacheBadge: cacheBadge(cached.created_at) };
  }

  // Odds (optionnel)
  const oddsData = await getOdds(sport, matchName);

  // Appel API
  const prompt = buildPrompt(matchName, sport, oddsData);
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }],
  });

  const result = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!result) throw new Error('Réponse vide de l\'IA');

  const saved = await query(
    `INSERT INTO analyses (user_id, sport, match_name, prompt_sent, result, credits_used)
     VALUES ($1,$2,$3,$4,$5,1) RETURNING id`,
    [user_id, sport, matchName, prompt, result]
  );
  const analysisId = saved.rows[0].id;

  await saveCache(matchName, sport, analysisId, oddsData?.commence_time);
  await trackUser(user_id, matchName, sport);

  return { analysis_id: analysisId, result, fromCache: false, oddsData };
};

module.exports = { runAnalysis, normalizeKey, todayParis, trackUser, getOdds, buildPrompt, saveCache };
