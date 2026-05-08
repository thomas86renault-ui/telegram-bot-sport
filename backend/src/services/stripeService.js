const Stripe = require('stripe');
const { query, withTransaction } = require('../config/database');
const { addCredits } = require('./userService');
const logger = require('../config/logger');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ─── Config PayPal (lien + montant par crédit) ────────────────
// Dans ton .env :
//   PAYPAL_ME_LINK=https://www.paypal.me/stckb2
//   PAYPAL_PRICE_PER_CREDIT=0.30   (ex: 0.30€ le crédit)
//   CREDITS_PER_PAYPAL_PACK=10     (nombre de crédits par pack)
const PAYPAL_LINK = process.env.PAYPAL_ME_LINK || 'https://www.paypal.me/stckb2';
const PAYPAL_PACK_CREDITS = parseInt(process.env.CREDITS_PER_PAYPAL_PACK || '10');
const PAYPAL_PACK_PRICE = process.env.PAYPAL_PACK_PRICE || '3'; // € affiché

let bot = null;
const setBot = (botInstance) => { bot = botInstance; };

// ─── Helpers ──────────────────────────────────────────────────
const sendTelegramMessage = async (telegram_id, message, options = {}) => {
  if (!bot) return;
  try {
    await bot.sendMessage(telegram_id, message, { parse_mode: 'Markdown', ...options });
  } catch (err) {
    logger.warn(`Impossible d'envoyer le message Telegram à ${telegram_id}:`, err.message);
  }
};

const getOrCreateCustomer = async (user) => {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const customer = await stripe.customers.create({
    metadata: { telegram_id: String(user.telegram_id), user_id: user.id },
    name: user.first_name || user.username,
  });
  await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customer.id, user.id]);
  return customer.id;
};

// ─── Stripe : checkout crédits ────────────────────────────────
const createCreditsCheckout = async (user) => {
  const customer_id = await getOrCreateCustomer(user);
  const session = await stripe.checkout.sessions.create({
    customer: customer_id,
    payment_method_types: ['card'],
    line_items: [{ price: process.env.STRIPE_PRICE_CREDITS_10, quantity: 1 }],
    mode: 'payment',
    success_url: `${process.env.TELEGRAM_WEBAPP_URL}/success?type=credits`,
    cancel_url: `${process.env.TELEGRAM_WEBAPP_URL}/cancel`,
    metadata: { user_id: user.id, telegram_id: String(user.telegram_id), type: 'credits', amount: '10' },
  });
  return session.url;
};

// ─── Stripe : checkout abonnement ────────────────────────────
const createSubscriptionCheckout = async (user, plan = 'monthly') => {
  const customer_id = await getOrCreateCustomer(user);
  const priceId = plan === 'yearly' ? process.env.STRIPE_PRICE_YEARLY : process.env.STRIPE_PRICE_MONTHLY;
  const session = await stripe.checkout.sessions.create({
    customer: customer_id,
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: 'subscription',
    success_url: `${process.env.TELEGRAM_WEBAPP_URL}/success?type=subscription&plan=${plan}`,
    cancel_url: `${process.env.TELEGRAM_WEBAPP_URL}/cancel`,
    metadata: { user_id: user.id, telegram_id: String(user.telegram_id), type: 'subscription', plan },
  });
  return session.url;
};

// ─── PayPal : message avec instructions ──────────────────────
const sendPaypalInstructions = async (user) => {
  const telegramId = user.telegram_id;

  // Enregistrement de la demande en base
  await query(
    `INSERT INTO paypal_credit_requests (user_id, telegram_id, credits_amount, status)
     VALUES ($1, $2, $3, 'pending')`,
    [user.id, telegramId, PAYPAL_PACK_CREDITS]
  );

  const msg =
    `💳 *Achat de crédits via PayPal*\n\n` +
    `📦 *Pack : ${PAYPAL_PACK_CREDITS} crédits — ${PAYPAL_PACK_PRICE}€*\n\n` +
    `*Étapes :*\n` +
    `1️⃣ Clique sur le bouton PayPal ci-dessous\n` +
    `2️⃣ Envoie exactement *${PAYPAL_PACK_PRICE}€* avec la note : \`CREDITS ${telegramId}\`\n` +
    `3️⃣ Une fois payé, appuie sur *"J'ai payé"* ci-dessous\n\n` +
    `⏱️ _Validation sous quelques heures par un admin._`;

  await sendTelegramMessage(telegramId, msg, {
    reply_markup: {
      inline_keyboard: [
        [{ text: `💸 Payer ${PAYPAL_PACK_PRICE}€ sur PayPal`, url: `${PAYPAL_LINK}/${PAYPAL_PACK_PRICE}EUR` }],
        [{ text: '✅ J\'ai payé', callback_data: 'paypal_paid' }],
      ],
    },
  });
};

// ─── PayPal : message après "J'ai payé" ──────────────────────
const sendPaypalPaidInstructions = async (user) => {
  const telegramId = user.telegram_id;

  const msg =
    `✅ *Super, on va vérifier ton paiement !*\n\n` +
    `Pour que l'admin valide rapidement, envoie-lui en DM :\n\n` +
    `📸 *1. Ta preuve de paiement PayPal* (screenshot)\n` +
    `🪪 *2. Ton identifiant Telegram :* \`${telegramId}\`\n\n` +
    `👉 *Comment trouver ton ID Telegram :*\n` +
    `Va sur @userinfobot et tape /start — il t'affichera ton ID.\n\n` +
    `Une fois reçu, l'admin ajoutera tes crédits manuellement. ⏱️ _Délai : quelques heures max._`;

  await sendTelegramMessage(telegramId, msg, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💬 Envoyer au support', url: 'https://t.me/stckb2' }],
        [{ text: '🤖 Obtenir mon ID Telegram', url: 'https://t.me/userinfobot' }],
      ],
    },
  });
};

// ─── Admin : valider manuellement un paiement PayPal ─────────
// Appelée par la commande /addcredits [telegram_id] [montant]
const validatePaypalManually = async (adminTelegramId, targetTelegramId, creditsToAdd) => {
  const userRes = await query('SELECT * FROM users WHERE telegram_id = $1', [targetTelegramId]);
  if (!userRes.rows.length) {
    throw new Error(`Utilisateur introuvable (telegram_id: ${targetTelegramId})`);
  }
  const user = userRes.rows[0];

  await addCredits(user.id, creditsToAdd, 'purchase', null, `PayPal validé manuellement par admin ${adminTelegramId}`);

  // Mise à jour de la demande en base
  await query(
    `UPDATE paypal_credit_requests
     SET status = 'approved', validated_at = NOW(), validated_by = $1
     WHERE telegram_id = $2 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [adminTelegramId, targetTelegramId]
  );

  // Notifier l'utilisateur
  await sendTelegramMessage(targetTelegramId,
    `✅ *Paiement validé !*\n\n` +
    `🎯 *${creditsToAdd} crédits* ont été ajoutés à ton compte.\n\n` +
    `Lance une analyse quand tu veux ! ⚡`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '⚽ Lancer une analyse', callback_data: 'analyse' },
          { text: '📊 Dashboard', web_app: { url: process.env.TELEGRAM_WEBAPP_URL } },
        ]],
      },
    }
  );

  return user;
};

// ─── Stripe webhook ───────────────────────────────────────────
const handleWebhook = async (payload, signature) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    throw new Error(`Webhook signature invalide: ${err.message}`);
  }

  const existing = await query('SELECT id FROM stripe_events WHERE stripe_event_id = $1', [event.id]);
  if (existing.rows.length > 0) return { already_processed: true };

  await query(
    `INSERT INTO stripe_events (event_type, stripe_event_id, payload, processed) VALUES ($1, $2, $3, FALSE)`,
    [event.type, event.id, JSON.stringify(event.data)]
  );

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object);
      break;
    case 'invoice.paid':
      await handleInvoicePaid(event.data.object);
      break;
    case 'customer.subscription.deleted':
    case 'customer.subscription.updated':
      await handleSubscriptionUpdate(event.data.object);
      break;
  }

  await query('UPDATE stripe_events SET processed = TRUE WHERE stripe_event_id = $1', [event.id]);
  return { processed: true, type: event.type };
};

const handleCheckoutCompleted = async (session) => {
  const { user_id, telegram_id, type, amount, plan } = session.metadata || {};
  if (!user_id) return;

  if (type === 'credits') {
    const credits = parseInt(amount || 10);
    await addCredits(user_id, credits, 'purchase', session.payment_intent, 'Achat pack 10 crédits');
    if (telegram_id) {
      await sendTelegramMessage(telegram_id,
        `✅ *Paiement confirmé !*\n\n🎯 *${credits} crédits* ajoutés. Lance une analyse ! ⚡`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '⚽ Lancer une analyse', callback_data: 'analyse' },
              { text: '📊 Dashboard', web_app: { url: process.env.TELEGRAM_WEBAPP_URL } },
            ]],
          },
        }
      );
    }
  } else if (type === 'subscription') {
    await withTransaction(async (client) => {
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      const creditsPerMonth = plan === 'yearly' ? 80 : 60;
      await client.query(
        `INSERT INTO subscriptions (user_id, stripe_subscription_id, plan, status, credits_per_month, current_period_end)
         VALUES ($1, $2, $3, 'active', $4, $5)
         ON CONFLICT (stripe_subscription_id) DO UPDATE SET status = 'active', updated_at = NOW()`,
        [user_id, sub.id, plan, creditsPerMonth, new Date(sub.current_period_end * 1000)]
      );
      await client.query(`UPDATE users SET subscription_status = 'active' WHERE id = $1`, [user_id]);
    });

    const creditsPerMonth = plan === 'yearly' ? 80 : 60;
    await addCredits(user_id, creditsPerMonth, 'subscription_monthly', null, `Abonnement ${plan} - crédits du mois`);

    if (telegram_id) {
      const planLabel = plan === 'yearly' ? '🔥 Annuel' : '📅 Mensuel';
      const price = plan === 'yearly' ? '99€/an' : '14.99€/mois';
      await sendTelegramMessage(telegram_id,
        `🎉 *Bienvenue dans le club Premium !*\n\n` +
        `Abonnement *${planLabel}* activé ✅\n${price} · ${creditsPerMonth} crédits/mois\n\n` +
        `🎁 *${creditsPerMonth} crédits* ajoutés immédiatement.\n` +
        `🕐 Analyses rafraîchies *toutes les heures* pour toi.\n` +
        `🌙 Analyse automatique *chaque soir*.\n` +
        `🔔 Alertes breaking news activées. 🚀`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '⚽ Lancer une analyse', callback_data: 'analyse' },
              { text: '📊 Dashboard', web_app: { url: process.env.TELEGRAM_WEBAPP_URL } },
            ]],
          },
        }
      );
    }
  }
};

const handleInvoicePaid = async (invoice) => {
  if (invoice.billing_reason === 'subscription_create') return;
  const customer = await stripe.customers.retrieve(invoice.customer);
  const telegram_id = customer.metadata?.telegram_id;
  if (!telegram_id) return;

  const userRes = await query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
  if (!userRes.rows[0]) return;
  const user = userRes.rows[0];

  const sub = await query('SELECT * FROM subscriptions WHERE stripe_subscription_id = $1', [invoice.subscription]);
  if (!sub.rows[0]) return;

  const subscription = sub.rows[0];
  const credits = subscription.credits_per_month;
  const planLabel = subscription.plan === 'yearly' ? 'Annuel 🔥' : 'Mensuel 📅';

  await addCredits(user.id, credits, 'subscription_monthly', invoice.payment_intent, 'Renouvellement abonnement');

  const stripeSub = await stripe.subscriptions.retrieve(invoice.subscription);
  await query(
    'UPDATE subscriptions SET current_period_end = $1 WHERE stripe_subscription_id = $2',
    [new Date(stripeSub.current_period_end * 1000), invoice.subscription]
  );

  await sendTelegramMessage(telegram_id,
    `🔄 *Abonnement renouvelé !*\n\nAbonnement *${planLabel}* renouvelé ✅\n\n` +
    `💳 *${credits} crédits* ajoutés.\n` +
    `📅 Prochain renouvellement: ${new Date(stripeSub.current_period_end * 1000).toLocaleDateString('fr-FR')}\n\nContinue sur ta lancée ! 🚀`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '⚽ Lancer une analyse', callback_data: 'analyse' },
          { text: '📊 Dashboard', web_app: { url: process.env.TELEGRAM_WEBAPP_URL } },
        ]],
      },
    }
  );
};

const handleSubscriptionUpdate = async (subscription) => {
  const status = subscription.status === 'active' ? 'active' : 'cancelled';
  await query(
    `UPDATE subscriptions SET status = $1, updated_at = NOW() WHERE stripe_subscription_id = $2`,
    [status, subscription.id]
  );

  if (status === 'cancelled') {
    const sub = await query(
      `SELECT u.telegram_id FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE s.stripe_subscription_id = $1`,
      [subscription.id]
    );
    await query(
      `UPDATE users SET subscription_status = 'cancelled' WHERE id = (SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1)`,
      [subscription.id]
    );
    if (sub.rows[0]?.telegram_id) {
      await sendTelegramMessage(sub.rows[0].telegram_id,
        `😔 *Abonnement annulé*\n\nTon abonnement Premium a été annulé.\nTu gardes tes crédits restants.\n\n_Pour te réabonner : /credits_`
      );
    }
  }
};

const sendNoCreditsMessage = async (telegram_id) => {
  await sendTelegramMessage(telegram_id,
    `⚠️ *Tu n'as plus de crédits !*\n\n` +
    `Choisis ton option :\n\n` +
    `🎯 *Pack 10 crédits* — ${PAYPAL_PACK_PRICE}€ (PayPal rapide)\n` +
    `💳 *Pack 10 crédits* — 3€ (carte bancaire via Stripe)\n` +
    `📅 *Abonnement mensuel* — 14.99€/mois (60 crédits + analyses auto)\n` +
    `🔥 *Abonnement annuel* — 99€/an (80 crédits/mois)\n\n` +
    `_Les abonnés reçoivent les analyses rafraîchies toutes les heures 🕐_`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '💸 PayPal (rapide)', callback_data: 'buy_paypal' },
            { text: '💳 Carte bancaire', callback_data: 'buy_credits' },
          ],
          [
            { text: '📅 Abonnement mensuel', callback_data: 'sub_monthly' },
            { text: '🔥 Abonnement annuel', callback_data: 'sub_yearly' },
          ],
        ],
      },
    }
  );
};

module.exports = {
  createCreditsCheckout,
  createSubscriptionCheckout,
  handleWebhook,
  getOrCreateCustomer,
  setBot,
  sendNoCreditsMessage,
  sendPaypalInstructions,
  sendPaypalPaidInstructions,
  validatePaypalManually,
};
