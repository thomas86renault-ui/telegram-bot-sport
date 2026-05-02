// POST /api/analyse-combo — Analyse un combiné depuis la Mini App
app.post('/api/analyse-combo', verifyTelegramWebApp, async (req, res) => {
  try {
    const user = await getUserByTelegramId(req.telegramUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { canAnalyze, isFree } = await checkAnalysisPermission(req.telegramUser.id);
    if (!canAnalyze) return res.json({ error: 'no_credits' });

    const { matches } = req.body;
    if (!matches || matches.length < 2) return res.status(400).json({ error: 'Minimum 2 matchs' });

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const matchList = matches.map((m, i) => {
      const oddsText = m.odds ? ` (cote: ${m.odds})` : '';
      return `${i+1}. ${m.match} [${m.sport}]${oddsText}`;
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

    const { query } = require('../config/database');
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
