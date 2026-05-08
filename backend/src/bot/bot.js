const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const { findOrCreateUser, checkAnalysisPermission, consumeCredit, getUserByTelegramId } = require('../services/userService');
const { runAnalysis, getOdds, buildPrompt, saveCache, trackUser } = require('../services/analysisService');
const { createCreditsCheckout, createSubscriptionCheckout, sendNoCreditsMessage, sendPaypalInstructions, sendPaypalPaidInstructions, validatePaypalManually } = require('../services/stripeService');
const { query } = require('../config/database');
const logger = require('../config/logger');

// ══════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── URL dynamique du tunnel (mise à jour depuis index.js) ───
let WEBAPP_URL = process.env.TELEGRAM_WEBAPP_URL || '';

// Appelé depuis index.js une fois le tunnel démarré
const setWebappUrl = (url) => {
  WEBAPP_URL = url;
  logger.info(`[Bot] WEBAPP_URL mis à jour → ${url}`);
};

// ─── Tarification combinés ────────────────────────────────────
const getComboCredits = (n) => n <= 3 ? 2 : n <= 5 ? 3 : n <= 7 ? 5 : 6;

// ─── Détection sport ─────────────────────────────────────────
const detectSport = (text) => {
  const t = text.toLowerCase();
  if (/tennis|atp|wta|roland|wimbledon|us open|open d'australie|djokovic|alcaraz|sinner|nadal|federer|medvedev|zverev|tsitsipas|rublev|fritz|tiafoe|murray|kyrgios/.test(t)) return 'tennis';
  if (/basket|nba|nbl|euroleague|lakers|warriors|celtics|knicks|bulls|heat|nets|nuggets|suns|bucks|clippers|thunder|spurs|raptors|cavaliers|pistons|76ers|timberwolves|pacers|hawks|magic|hornets|wizards|pelicans|grizzlies|jazz|kings|blazers|rockets/.test(t)) return 'basketball';
  if (/rugby|top 14|pro14|six nations|premiership|stade toulousain|racing 92|montpellier|clermont|toulon|leinster|munster/.test(t)) return 'rugby';
  if (/nfl|patriots|chiefs|cowboys|eagles|packers|steelers|ravens|broncos|seahawks|49ers|rams|bears|giants|jets|bills|dolphins|bengals|browns|colts|titans|jaguars|texans|raiders|chargers|cardinals|falcons|saints|buccaneers|panthers|lions/.test(t)) return 'american_football';
  if (/baseball|mlb|yankees|dodgers|red sox|cubs|mets|astros/.test(t)) return 'baseball';
  if (/hockey|nhl|canadiens|leafs|rangers nhl|bruins|blackhawks|red wings|penguins|capitals|lightning|avalanche|golden knights/.test(t)) return 'hockey';
  if (/mma|ufc|bellator|boxe|boxing|combat/.test(t)) return 'mma';
  if (/formule|f1|gp |grand prix|verstappen|hamilton|leclerc|norris|alonso/.test(t)) return 'motorsport';
  if (/golf|masters|pga|ryder cup/.test(t)) return 'golf';
  return 'football';
};

// ─── Envoi message long ───────────────────────────────────────
const sendLong = async (chatId, text, options = {}) => {
  const MAX = 3900;
  if (text.length <= MAX) {
    return bot.sendMessage(chatId, text, options);
  }

  const lines = text.split('\n');
  const parts = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? current + '\n' + line : line;
    if (candidate.length > MAX) {
      if (current) parts.push(current.trim());
      if (line.length > MAX) {
        let remaining = line;
        while (remaining.length > MAX) {
          parts.push(remaining.substring(0, MAX));
          remaining = remaining.substring(MAX);
        }
        current = remaining;
      } else {
        current = line;
      }
    } else {
      current = candidate;
    }
  }
  if (current.trim()) parts.push(current.trim());

  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    try {
      await bot.sendMessage(chatId, parts[i], isLast ? options : { parse_mode: 'Markdown' });
    } catch (e) {
      await bot.sendMessage(chatId, parts[i], isLast ? { ...options, parse_mode: undefined } : {});
    }
    if (!isLast) await new Promise(r => setTimeout(r, 300));
  }
};

// ─── Bot ──────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// ─── /start ───────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const user = await findOrCreateUser(msg.from);
  const name = user.first_name || user.username || 'toi';
  await bot.sendMessage(msg.chat.id,
    `👋 Salut ${name} !\n\n` +
    `Je suis ton assistant IA pour les paris sportifs.\n\n` +
    `🔍 *Ce que je fais :*\n` +
    `• Analyse IA avec infos en temps réel (blessures, forme, actu)\n` +
    `• Pronostics détaillés pour tous les sports\n` +
    `• Suivi bankroll & paris dans le dashboard\n\n` +
    `🎁 *1 analyse gratuite* t'attend cette semaine !`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '⚽ Analyser un match', callback_data: 'analyse' }, { text: '🎯 Faire un combiné', callback_data: 'combine' }],
        [{ text: '📊 Dashboard', web_app: { url: WEBAPP_URL } }, { text: '💰 Boutique', callback_data: 'shop' }],
        [{ text: '❓ Aide', callback_data: 'help' }, { text: '💬 Support', url: 'https://t.me/stckb2' }],
      ]}
    }
  );
});

bot.onText(/\/analyse/, async (msg) => promptForMatch(msg.chat.id, msg.from));
bot.onText(/\/combine/, async (msg) => promptForCombo(msg.chat.id, msg.from));

// ─── /credits ─────────────────────────────────────────────────
bot.onText(/\/credits/, async (msg) => {
  const user = await getUserByTelegramId(msg.from.id);
  if (!user) return;
  const freeStatus = user.free_analysis_used ? '❌ Utilisée' : '✅ Disponible';
  await bot.sendMessage(msg.chat.id,
    `💳 *Tes crédits*\n\nAnalyse gratuite hebdo : ${freeStatus}\nCrédits : *${user.credits}*`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '💸 PayPal — 3€ (10 crédits)', callback_data: 'buy_paypal' }, { text: '💳 Stripe — 3€', callback_data: 'buy_credits' }],
      [{ text: '📅 Mensuel — 14.99€', callback_data: 'sub_monthly' }, { text: '🔥 Annuel — 99€', callback_data: 'sub_yearly' }],
    ]}}
  );
});

// ─── /help ────────────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `🤖 *Commandes*\n\n/start — Menu\n/analyse — Analyser un match (1 crédit)\n/combine — Combiné multi-matchs\n/credits — Mes crédits\n\n` +
    `*Sports :* ⚽ Football · 🎾 Tennis · 🏀 Basket · 🏉 Rugby · 🏈 NFL · ⚾ Baseball · 🏒 Hockey · 🥊 MMA · 🏎 F1\n\n` +
    `*Tarif combinés :* 2-3 matchs=2cr · 4-5=3cr · 6-7=5cr · 8-10=6cr`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
      { text: '📊 Dashboard', web_app: { url: WEBAPP_URL } }, { text: '💬 Support', url: 'https://t.me/stckb2' }
    ]]}}
  );
});

// ─── /admin ───────────────────────────────────────────────────
bot.onText(/\/admin/, async (msg) => {
  if (!ADMIN_IDS.includes(msg.from.id)) { await bot.sendMessage(msg.chat.id, '❌ Accès refusé.'); return; }
  try {
    const [u, s, c, a] = await Promise.all([
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE subscription_status='active') as premium FROM users`),
      query(`SELECT plan, COUNT(*) as count FROM subscriptions WHERE status='active' GROUP BY plan`),
      query(`SELECT SUM(amount) FILTER (WHERE type='purchase') as bought, SUM(ABS(amount)) FILTER (WHERE type='analysis') as used FROM credit_transactions`),
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE created_at>NOW()-INTERVAL '24 hours') as today FROM analyses`),
    ]);
    const subsText = s.rows.length ? s.rows.map(r => `  • ${r.plan}: ${r.count}`).join('\n') : '  Aucun';
    await bot.sendMessage(msg.chat.id,
      `📊 *Admin*\n\n👥 Users: ${u.rows[0].total} (${u.rows[0].premium} premium)\n\n💳 Abonnements:\n${subsText}\n\n🎯 Analyses: ${a.rows[0].total} (${a.rows[0].today} aujourd'hui)\n\n💰 Crédits achetés: ${c.rows[0].bought||0} | Consommés: ${c.rows[0].used||0}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) { await bot.sendMessage(msg.chat.id, '❌ Erreur stats: ' + err.message); }
});

// ─── /addcredits [telegram_id] [montant] (admin only) ─────────
bot.onText(/\/addcredits (.+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(msg.from.id)) { await bot.sendMessage(msg.chat.id, '❌ Accès refusé.'); return; }
  const parts = match[1].trim().split(' ');
  if (parts.length < 2) { await bot.sendMessage(msg.chat.id, 'Usage: /addcredits [telegram_id] [montant]'); return; }
  const [targetId, amount] = [parseInt(parts[0]), parseInt(parts[1])];
  if (!targetId || !amount) { await bot.sendMessage(msg.chat.id, '❌ Paramètres invalides.'); return; }
  try {
    const user = await validatePaypalManually(msg.from.id, targetId, amount);
    await bot.sendMessage(msg.chat.id, `✅ ${amount} crédits ajoutés à ${user.first_name || user.username || targetId}`);
  } catch (err) { await bot.sendMessage(msg.chat.id, '❌ Erreur: ' + err.message); }
});

// ─── Callbacks ────────────────────────────────────────────────
bot.on('callback_query', async (cb) => {
  const chatId = cb.message.chat.id;
  const from = cb.from;
  await bot.answerCallbackQuery(cb.id);

  if (cb.data.startsWith('refresh_')) {
    const raw = cb.data.replace('refresh_', '');
    const sepIdx = raw.lastIndexOf('__');
    const matchName = raw.substring(0, sepIdx).replace(/_/g, ' ').trim();
    const sport = raw.substring(sepIdx + 2) || 'football';
    await runRefreshAnalysis(chatId, from, matchName, sport);
    return;
  }

  if (cb.data.startsWith('analyse_fresh_')) {
    await promptForMatch(chatId, from);
    return;
  }

  switch (cb.data) {
    case 'analyse':
      await promptForMatch(chatId, from);
      break;

    case 'combine':
      await promptForCombo(chatId, from);
      break;

    case 'shop':
      await bot.sendMessage(chatId, `💰 *Boutique*\n\nChoisis ton option :`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '💸 PayPal — 3€ (10 crédits)', callback_data: 'buy_paypal' }, { text: '💳 Carte — 3€', callback_data: 'buy_credits' }],
          [{ text: '📅 Mensuel — 14.99€/mois', callback_data: 'sub_monthly' }, { text: '🔥 Annuel — 99€/an', callback_data: 'sub_yearly' }],
        ]}
      });
      break;

    case 'buy_paypal': {
      const user = await getUserByTelegramId(from.id);
      if (!user) break;
      await sendPaypalInstructions(user);
      break;
    }

    case 'paypal_paid': {
      const user = await getUserByTelegramId(from.id);
      if (!user) break;
      await sendPaypalPaidInstructions(user);
      break;
    }

    case 'buy_credits': {
      const user = await getUserByTelegramId(from.id);
      if (!user) break;
      try {
        const url = await createCreditsCheckout(user);
        await bot.sendMessage(chatId, `🛒 *Pack 10 crédits — 3€*`, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '💳 Payer par carte', url }]] }
        });
      } catch (e) { await bot.sendMessage(chatId, '❌ Paiement carte non disponible. Essaie PayPal !'); }
      break;
    }

    case 'sub_monthly':
    case 'sub_yearly': {
      const plan = cb.data === 'sub_monthly' ? 'monthly' : 'yearly';
      const user = await getUserByTelegramId(from.id);
      if (!user) break;
      try {
        const url = await createSubscriptionCheckout(user, plan);
        const label = plan === 'monthly' ? 'Mensuel 14.99€/mois (60 crédits)' : 'Annuel 99€/an (80 crédits/mois)';
        await bot.sendMessage(chatId,
          `📦 *Abonnement ${label}*\n\n✅ Analyse auto chaque soir\n✅ Crédits mensuels inclus\n✅ Alertes breaking news`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💳 Souscrire', url }]] } }
        );
      } catch (e) { await bot.sendMessage(chatId, '❌ Abonnement non disponible pour l\'instant.'); }
      break;
    }

    case 'help':
      await bot.sendMessage(chatId,
        `/analyse — Match simple\n/combine — Combiné\n/credits — Crédits`,
        { reply_markup: { inline_keyboard: [[
          { text: '📊 Dashboard', web_app: { url: WEBAPP_URL } }, { text: '💬 Support', url: 'https://t.me/stckb2' }
        ]]}}
      );
      break;
  }
});

// ═══════════════════════════════════════════════════════════════
// ANALYSE SIMPLE
// ═══════════════════════════════════════════════════════════════
const pendingAnalysis = new Map();

const promptForMatch = async (chatId, telegramUser) => {
  const { canAnalyze, isFree, user } = await checkAnalysisPermission(telegramUser.id);
  if (!canAnalyze) { await sendNoCreditsMessage(telegramUser.id); return; }
  const label = isFree ? '_(analyse gratuite 🎁)_' : `_(1 crédit — solde: ${user.credits})_`;
  await bot.sendMessage(chatId,
    `🔍 *Quel match veux-tu analyser ?* ${label}\n\n` +
    `Je vérifierai en temps réel : blessures, forme, actu\n\n` +
    `Exemples :\n• \`PSG vs Bayern Munich\`\n• \`Djokovic vs Alcaraz\`\n• \`Lakers vs Warriors\``,
    { parse_mode: 'Markdown' }
  );
  pendingAnalysis.set(telegramUser.id, { step: 'match', isFree, user });
};

const runSingleAnalysis = async (msg, state) => {
  const sport = detectSport(msg.text);
  const isPremium = state.user.subscription_status === 'active';
  const waitMsg = await bot.sendMessage(msg.chat.id,
    `🔍 Analyse *${msg.text}* en cours...\n⏳ Blessures · Forme · Actu`,
    { parse_mode: 'Markdown' }
  );
  try {
    const { analysis_id, result, fromCache, cacheBadge, oddsData } = await runAnalysis({
      user_id: state.user.id, sport, matchName: msg.text, isPremium,
    });
    await consumeCredit(state.user.id, state.isFree, analysis_id);
    await bot.deleteMessage(msg.chat.id, waitMsg.message_id);

    let header = `🔍 *${msg.text}*\n`;
    if (oddsData && !fromCache) header += `📈 ${oddsData.odds}\n`;
    header += '\n';

    const baseButtons = [
      [{ text: '⚽ Nouvelle analyse', callback_data: 'analyse' }, { text: '🎯 Combiné', callback_data: 'combine' }],
      [{ text: '📊 Dashboard', web_app: { url: WEBAPP_URL } }],
    ];

    if (fromCache) {
      header += cacheBadge + '\n\n';
      const freshUser = await getUserByTelegramId(msg.from.id);
      const hasCredits = freshUser && freshUser.credits > 0;
      const safeMatch = msg.text.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
      const refreshKey = `refresh_${safeMatch}__${sport}`;
      if (hasCredits) {
        baseButtons.unshift([{ text: `🔄 Refresh — 1 crédit (solde: ${freshUser.credits})`, callback_data: refreshKey }]);
      } else {
        baseButtons.unshift([{ text: '🔄 Refresh — acheter des crédits', callback_data: 'shop' }]);
      }
    }

    await sendLong(msg.chat.id, header + result, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: baseButtons }
    });
  } catch (err) {
    logger.error('Analyse simple error:', err);
    await bot.editMessageText(
      `❌ Erreur lors de l'analyse : ${err.message}\n\nTes crédits n'ont pas été débités.`,
      { chat_id: msg.chat.id, message_id: waitMsg.message_id }
    );
  }
};

const runRefreshAnalysis = async (chatId, telegramUser, matchName, sport) => {
  const { canAnalyze, isFree, user } = await checkAnalysisPermission(telegramUser.id);
  if (!canAnalyze) { await sendNoCreditsMessage(telegramUser.id); return; }

  const waitMsg = await bot.sendMessage(chatId,
    `🔄 Refresh *${matchName}*...\n⏳ Nouvelle recherche en temps réel`,
    { parse_mode: 'Markdown' }
  );

  try {
    const oddsData = await getOdds(sport, matchName);
    const prompt = buildPrompt(matchName, sport, oddsData);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    });

    const result = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!result) throw new Error('Réponse vide');

    const saved = await query(
      `INSERT INTO analyses (user_id, sport, match_name, prompt_sent, result, credits_used)
       VALUES ($1,$2,$3,$4,$5,1) RETURNING id`,
      [user.id, sport, matchName, prompt, result]
    );
    const analysisId = saved.rows[0].id;
    await saveCache(matchName, sport, analysisId, oddsData?.commence_time);
    await trackUser(user.id, matchName, sport);
    await consumeCredit(user.id, isFree, analysisId);

    await bot.deleteMessage(chatId, waitMsg.message_id);

    const freshUser = await getUserByTelegramId(telegramUser.id);
    const header = `🔄 *Refresh — ${matchName}*\n📅 _Analyse fraîche — maintenant_\n\n`;

    const baseButtons = [
      [{ text: '⚽ Nouvelle analyse', callback_data: 'analyse' }, { text: '🎯 Combiné', callback_data: 'combine' }],
      [{ text: '📊 Dashboard', web_app: { url: WEBAPP_URL } }],
    ];

    if (freshUser && freshUser.credits > 0) {
      const safeMatch = matchName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
      baseButtons.unshift([{
        text: `🔄 Refresh à nouveau — solde: ${freshUser.credits} crédits`,
        callback_data: `refresh_${safeMatch}__${sport}`
      }]);
    }

    await sendLong(chatId, header + result, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: baseButtons }
    });
  } catch (err) {
    logger.error('Refresh error:', err);
    await bot.editMessageText(
      `❌ Erreur refresh : ${err.message}\n\nCrédits non débités.`,
      { chat_id: chatId, message_id: waitMsg.message_id }
    );
  }
};

// ═══════════════════════════════════════════════════════════════
// COMBINÉ
// ═══════════════════════════════════════════════════════════════
const promptForCombo = async (chatId, telegramUser) => {
  const { user } = await checkAnalysisPermission(telegramUser.id);
  if (!user) return;
  await bot.sendMessage(chatId,
    `🎯 *Analyse de combiné*\n\n` +
    `💳 Tarif : 2-3 matchs=2cr | 4-5=3cr | 6-7=5cr | 8-10=6cr\n\n` +
    `Envoie tes matchs *un par ligne* (max 10) :\n\`\`\`\nPSG vs Bayern\nDjokovic vs Alcaraz\nLakers vs Warriors\n\`\`\``,
    { parse_mode: 'Markdown' }
  );
  pendingAnalysis.set(telegramUser.id, { step: 'combo', user });
};

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const state = pendingAnalysis.get(msg.from.id);
  if (!state) return;
  pendingAnalysis.delete(msg.from.id);
  if (state.step === 'match') await runSingleAnalysis(msg, state);
  else if (state.step === 'combo') await runComboAnalysis(msg, state);
});

const runComboAnalysis = async (msg, state) => {
  const matches = msg.text.split('\n').map(m => m.trim()).filter(m => m.length > 3).slice(0, 10);
  if (matches.length < 2) {
    await bot.sendMessage(msg.chat.id, '❌ Envoie au moins 2 matchs, un par ligne.',
      { reply_markup: { inline_keyboard: [[{ text: '🔄 Réessayer', callback_data: 'combine' }]] }}
    );
    return;
  }

  const creditsNeeded = getComboCredits(matches.length);
  const user = state.user;

  if (user.credits < creditsNeeded) {
    await bot.sendMessage(msg.chat.id,
      `❌ *Crédits insuffisants*\n${matches.length} matchs = *${creditsNeeded} crédits* — Solde : *${user.credits}*`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💰 Acheter des crédits', callback_data: 'shop' }]] }}
    );
    return;
  }

  const waitMsg = await bot.sendMessage(msg.chat.id,
    `🔍 Analyse combiné (${matches.length} matchs) — ${creditsNeeded} crédits...\n⏳ Recherche en temps réel...`
  );

  try {
    const date = new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });

    const prompt = `Expert paris combinés. ${date}. ${matches.length} matchs:
${matches.map((m, i) => `${i + 1}. ${m}`).join('\n')}

Cherche infos rapides (blessures/forme) pour chaque match, puis analyse. Jamais de refus. Max 750 tokens.

${matches.map((m, i) => `🔹 *${i+1}. ${m}*\n• Infos: [blessures/RAS] • Forme: [3 derniers résultats]\n• Pronostic: [pari recommandé] @ [cote] — Confiance: [XX]%`).join('\n')}

━━━━━
📈 *BILAN COMBINÉ*
• Proba globale: [XX]% • Maillon faible: [match le plus risqué]
• Mise: [X]% bankroll • Verdict: ✅ Jouable / ⚠️ Risqué / ❌ Déconseillé`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 900,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    });

    const result = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!result) throw new Error('Réponse vide');

    await query(
      `INSERT INTO analyses (user_id, sport, match_name, prompt_sent, result, credits_used)
       VALUES ($1,'combiné',$2,$3,$4,$5) RETURNING id`,
      [user.id, `Combiné ${matches.length} matchs`, prompt, result, creditsNeeded]
    );
    await query('UPDATE users SET credits = credits - $1 WHERE id = $2', [creditsNeeded, user.id]);
    await query(
      `INSERT INTO credit_transactions (user_id, amount, type, description) VALUES ($1,$2,'analysis',$3)`,
      [user.id, -creditsNeeded, `Combiné ${matches.length} matchs`]
    );

    await bot.deleteMessage(msg.chat.id, waitMsg.message_id);
    await sendLong(msg.chat.id,
      `🎯 *Combiné ${matches.length} matchs* — ${creditsNeeded} crédits débités\n\n${result}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '⚽ Analyse simple', callback_data: 'analyse' }, { text: '🎯 Nouveau combiné', callback_data: 'combine' }],
        [{ text: '📊 Mon dashboard', web_app: { url: WEBAPP_URL } }],
      ]}}
    );
  } catch (err) {
    logger.error('Combiné error:', err);
    await bot.editMessageText(
      `❌ Erreur : ${err.message}\n\nTes crédits n'ont pas été débités.`,
      { chat_id: msg.chat.id, message_id: waitMsg.message_id }
    );
  }
};

logger.info('✅ Bot Telegram démarré');
module.exports = { bot, setWebappUrl };
