const Stripe = require('stripe');
const { query, withTransaction } = require('../config/database');
const { addCredits } = require('./userService');
const logger = require('../config/logger');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Crée ou récupère le customer Stripe d'un user
 */
const getOrCreateCustomer = async (user) => {
  if (user.stripe_customer_id) {
    return user.stripe_customer_id;
  }

  const customer = await stripe.customers.create({
    metadata: { telegram_id: String(user.telegram_id), user_id: user.id },
    name: user.first_name || user.username,
  });

  await query(
    'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
    [customer.id, user.id]
  );

  return customer.id;
};

/**
 * Crée un lien de paiement pour l'achat de crédits (pack 3€ = 10 crédits)
 */
const createCreditsCheckout = async (user) => {
  const customer_id = await getOrCreateCustomer(user);

  const session = await stripe.checkout.sessions.create({
    customer: customer_id,
    payment_method_types: ['card'],
    line_items: [{
      price: process.env.STRIPE_PRICE_CREDITS_10,
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `${process.env.TELEGRAM_WEBAPP_URL}/success?type=credits`,
    cancel_url: `${process.env.TELEGRAM_WEBAPP_URL}/cancel`,
    metadata: { user_id: user.id, type: 'credits', amount: '10' },
  });

  return session.url;
};

/**
 * Crée un lien d'abonnement mensuel ou annuel
 */
const createSubscriptionCheckout = async (user, plan = 'monthly') => {
  const customer_id = await getOrCreateCustomer(user);
  const priceId = plan === 'yearly'
    ? process.env.STRIPE_PRICE_YEARLY
    : process.env.STRIPE_PRICE_MONTHLY;

  const session = await stripe.checkout.sessions.create({
    customer: customer_id,
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: 'subscription',
    success_url: `${process.env.TELEGRAM_WEBAPP_URL}/success?type=subscription&plan=${plan}`,
    cancel_url: `${process.env.TELEGRAM_WEBAPP_URL}/cancel`,
    metadata: { user_id: user.id, type: 'subscription', plan },
  });

  return session.url;
};

/**
 * Traite les webhooks Stripe (idempotent)
 */
const handleWebhook = async (payload, signature) => {
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    throw new Error(`Webhook signature invalide: ${err.message}`);
  }

  // Vérif idempotence
  const existing = await query(
    'SELECT id FROM stripe_events WHERE stripe_event_id = $1',
    [event.id]
  );
  if (existing.rows.length > 0) {
    logger.info(`Event Stripe déjà traité: ${event.id}`);
    return { already_processed: true };
  }

  // Sauvegarde de l'event
  await query(
    `INSERT INTO stripe_events (event_type, stripe_event_id, payload, processed)
     VALUES ($1, $2, $3, FALSE)`,
    [event.type, event.id, JSON.stringify(event.data)]
  );

  // Traitement selon le type
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
    default:
      logger.debug(`Event non géré: ${event.type}`);
  }

  // Marque comme traité
  await query(
    'UPDATE stripe_events SET processed = TRUE WHERE stripe_event_id = $1',
    [event.id]
  );

  return { processed: true, type: event.type };
};

const handleCheckoutCompleted = async (session) => {
  const { user_id, type, amount, plan } = session.metadata || {};
  if (!user_id) return;

  if (type === 'credits') {
    await addCredits(
      user_id,
      parseInt(amount || 10),
      'purchase',
      session.payment_intent,
      'Achat pack 10 crédits'
    );
    logger.info(`Crédits ajoutés pour user ${user_id}`);
  } else if (type === 'subscription') {
    await withTransaction(async (client) => {
      // Crée l'abonnement en BDD
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      const creditsPerMonth = plan === 'yearly' ? 50 : 30;

      const result = await client.query(
        `INSERT INTO subscriptions
           (user_id, stripe_subscription_id, plan, status, credits_per_month, current_period_end)
         VALUES ($1, $2, $3, 'active', $4, $5)
         ON CONFLICT (stripe_subscription_id) DO UPDATE
           SET status = 'active', updated_at = NOW()
         RETURNING id`,
        [user_id, sub.id, plan, creditsPerMonth, new Date(sub.current_period_end * 1000)]
      );

      await client.query(
        `UPDATE users SET subscription_status = 'active' WHERE id = $1`,
        [user_id]
      );

      // Crédits du premier mois
      await addCredits(user_id, creditsPerMonth, 'subscription_monthly', null, `Abonnement ${plan} - crédits du mois`);
    });
    logger.info(`Abonnement activé pour user ${user_id} (${plan})`);
  }
};

const handleInvoicePaid = async (invoice) => {
  // Renouvellement mensuel → on rajoute les crédits
  const customer = await stripe.customers.retrieve(invoice.customer);
  const telegram_id = customer.metadata?.telegram_id;
  if (!telegram_id) return;

  const user = await query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
  if (!user.rows[0]) return;

  const sub = await query(
    'SELECT * FROM subscriptions WHERE stripe_subscription_id = $1',
    [invoice.subscription]
  );

  if (sub.rows[0]) {
    await addCredits(
      user.rows[0].id,
      sub.rows[0].credits_per_month,
      'subscription_monthly',
      invoice.payment_intent,
      'Renouvellement abonnement - crédits mensuels'
    );
    logger.info(`Crédits mensuels ajoutés pour user ${user.rows[0].id}`);
  }
};

const handleSubscriptionUpdate = async (subscription) => {
  const status = subscription.status === 'active' ? 'active' : 'cancelled';
  await query(
    `UPDATE subscriptions SET status = $1, updated_at = NOW()
     WHERE stripe_subscription_id = $2`,
    [status, subscription.id]
  );

  // Met à jour le statut user si annulé
  if (status === 'cancelled') {
    const sub = await query(
      'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1',
      [subscription.id]
    );
    if (sub.rows[0]) {
      await query(
        `UPDATE users SET subscription_status = 'cancelled' WHERE id = $1`,
        [sub.rows[0].user_id]
      );
    }
  }
};

module.exports = {
  createCreditsCheckout,
  createSubscriptionCheckout,
  handleWebhook,
  getOrCreateCustomer,
};
