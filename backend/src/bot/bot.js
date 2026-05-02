const TelegramBot = require('node-telegram-bot-api');
const { findOrCreateUser, checkAnalysisPermission, consumeCredit, getUserByTelegramId } = require('../services/userService');
const { runAnalysis } = require('../services/analysisService');
const { createCreditsCheckout, createSubscriptionCheckout } = require('../services/stripeService');
const logger = require('../config/logger');

const WEBAPP_URL = 'https://telegram-bot-sport.thomas86renault.workers.dev';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// ─── /start ──────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const user = await findOrCreateUser(msg.from);
  const name = user.first_name || user.username || 'là';

  await bot.sendMessage(msg.chat.id,
    `👋 Bienvenue ${name} !\n\n` +
    `Je suis ton assistant d'analyse sportive propulsé par l'IA.\n\n` +
    `🎁 *1 analyse gratuite par semaine* offerte\n` +
    `💳 Crédits supplémentaires disponibles à la carte\n\n` +
    `Que veux-tu faire ?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⚽ Analyser un match', callback_data: 'analyse' }],
          [{ text: '📊 Mon dashboard', web_app: { url: WEBAPP_URL } }],
          [{ text: '💰 Crédits & Abonnements', callback_data: 'shop' }],
          [{ text: '❓ Aide', callback_data: 'help' }],
        ]
      }
    }
  );
});

// ─── /analyse ─────────────────────────────────────────────────
bot.onText(/\/analyse/, async (msg) => {
  await promptForMatch(msg.chat.id, msg.from);
});

// ─── /credits ─────────────────────────────────────────────────
bot.onText(/\/credits/, async (msg) => {
  const user = await getUserByTelegramId(msg.from.id);
  if (!user) return;

  const freeStatus = user.free_analysis_used
    ? '❌ Utilisée cette semaine'
    : '✅ Disponible';

  await bot.sendMessage(msg.chat.id,
    `💳 *Tes crédits*\n\n` +
    `Analyse gratuite hebdo: ${freeStatus}\n` +
    `Crédits payants: *${user.credits}*\n\n` +
    `1 crédit = 1 analyse`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛒 Acheter 10 crédits (3€)', callback_data: 'buy_credits' }],
          [{ text: '📅 Abonnement mensuel', callback_data: 'sub_monthly' }],
          [{ text: '🔥 Abonnement annuel', callback_data: 'sub_yearly' }],
        ]
      }
    }
  );
});

// ─── /help ────────────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `🤖 *Comment ça marche ?*\n\n` +
    `1. Utilise /analyse et indique le match\n` +
    `2. L'IA analyse les stats et les cotes\n` +
    `3. Tu reçois un pronostic détaillé\n\n` +
    `*Commandes disponibles:*\n` +
    `/start - Menu principal\n` +
    `/analyse - Lancer une analyse\n` +
    `/credits - Voir tes crédits\n` +
    `/help - Cette aide`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Ouvrir le dashboard', web_app: { url: WEBAPP_URL } }],
        ]
      }
    }
  );
});

// ─── Callback queries ─────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from;

  await bot.answerCallbackQuery(query.id);

  switch (query.data) {
    case 'analyse':
      await promptForMatch(chatId, userId);
      break;

    case 'shop':
      await bot.sendMessage(chatId,
        `💰 *Boutique*\n\nChoisis ton option :`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎯 Pack 10 crédits — 3€', callback_data: 'buy_credits' }],
              [{ text: '📅 Abonnement mensuel — 14.99€/mois', callback_data: 'sub_monthly' }],
              [{ text: '🔥 Abonnement annuel — 99€/an', callback_data: 'sub_yearly' }],
            ]
          }
        }
      );
      break;

    case 'buy_credits': {
      const user = await getUserByTelegramId(userId.id);
      if (!user) break;
      try {
        const url = await createCreditsCheckout(user);
        await bot.sendMessage(chatId,
          `🛒 *Achat de crédits*\n\nClique ci-dessous pour payer 3€ et recevoir 10 crédits.`,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '💳 Payer maintenant', url }]] }
          }
        );
      } catch(e) {
        await bot.sendMessage(chatId, '❌ Paiement non configuré pour l\'instant.');
      }
      break;
    }

    case 'sub_monthly':
    case 'sub_yearly': {
      const plan = query.data === 'sub_monthly' ? 'monthly' : 'yearly';
      const user = await getUserByTelegramId(userId.id);
      if (!user) break;
      try {
        const url = await createSubscriptionCheckout(user, plan);
        const label = plan === 'monthly' ? 'mensuel — 14.99€/mois' : 'annuel — 99€/an';
        await bot.sendMessage(chatId,
          `📦 *Abonnement ${label}*`,
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '💳 Souscrire', url }]] }
          }
        );
      } catch(e) {
        await bot.sendMessage(chatId, '❌ Paiement non configuré pour l\'instant.');
      }
      break;
    }

    case 'help':
      await bot.sendMessage(chatId,
        `🤖 *Commandes disponibles:*\n\n` +
        `/start - Menu principal\n` +
        `/analyse - Lancer une analyse\n` +
        `/credits - Voir tes crédits\n` +
        `/help - Cette aide`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📊 Ouvrir le dashboard', web_app: { url: WEBAPP_URL } }],
            ]
          }
        }
      );
      break;
  }
});

// ─── Analyse flow ─────────────────────────────────────────────
const pendingAnalysis = new Map();

const promptForMatch = async (chatId, telegramUser) => {
  const { canAnalyze, reason, isFree, user } = await checkAnalysisPermission(telegramUser.id);

  if (!canAnalyze) {
    await bot.sendMessage(chatId,
      `❌ *Pas de crédits disponibles*\n\nAchète un pack ou souscris à un abonnement 👇`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🛒 Acheter des crédits', callback_data: 'buy_credits' }],
            [{ text: '📦 Voir les abonnements', callback_data: 'shop' }],
          ]
        }
      }
    );
    return;
  }

  const freeText = isFree
    ? ' _(analyse gratuite de la semaine)_'
    : ` _(1 crédit — solde: ${user.credits})_`;

  await bot.sendMessage(chatId,
    `⚽ *Quel match veux-tu analyser ?*${freeText}\n\n` +
    `Exemple: \`PSG vs Real Madrid\``,
    { parse_mode: 'Markdown' }
  );

  pendingAnalysis.set(telegramUser.id, { step: 'awaiting_match', isFree, user });
};

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const state = pendingAnalysis.get(msg.from.id);
  if (!state) return;

  if (state.step === 'awaiting_match') {
    pendingAnalysis.delete(msg.from.id);

    const waitMsg = await bot.sendMessage(msg.chat.id,
      `⏳ Analyse en cours pour *${msg.text}*...`,
      { parse_mode: 'Markdown' }
    );

    try {
      const { analysis_id, result, oddsData } = await runAnalysis({
        user_id: state.user.id,
        sport: detectSport(msg.text),
        matchName: msg.text,
      });

      await consumeCredit(state.user.id, state.isFree, analysis_id);
      await bot.deleteMessage(msg.chat.id, waitMsg.message_id);

      const oddsText = oddsData ? `\n\n📈 *Cotes:* ${oddsData.odds}` : '';

      await bot.sendMessage(msg.chat.id,
        `🔍 *Analyse: ${msg.text}*${oddsText}\n\n${result}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '⚽ Nouvelle analyse', callback_data: 'analyse' }],
              [{ text: '📊 Mon dashboard', web_app: { url: WEBAPP_URL } }],
            ]
          }
        }
      );
    } catch (err) {
      logger.error('Erreur analyse:', err);
      await bot.editMessageText(
        '❌ Erreur lors de l\'analyse. Tes crédits n\'ont pas été débités.',
        { chat_id: msg.chat.id, message_id: waitMsg.message_id }
      );
    }
  }
});

const detectSport = (text) => {
  const t = text.toLowerCase();
  if (t.includes('tennis') || t.includes('atp')) return 'tennis';
  if (t.includes('basket') || t.includes('nba')) return 'basketball';
  if (t.includes('rugby')) return 'rugby';
  return 'football';
};

logger.info('Bot Telegram démarré en mode polling');

module.exports = bot;
