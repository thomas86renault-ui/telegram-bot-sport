# 🤖 Bot Sport IA — Telegram

Bot Telegram d'analyse sportive IA avec système de crédits, abonnements Stripe et Mini App dashboard.

## Stack

| Composant | Techno |
|---|---|
| Bot + API | Node.js + Express |
| Base de données | PostgreSQL 16 |
| Paiements | Stripe |
| IA | Anthropic Claude |
| Cotes sportives | The Odds API |
| Mini App | HTML/JS (Telegram WebApp) |
| Hébergement | Caprover / Docker |

---

## Démarrage rapide

### 1. Prérequis

- Node.js 20+
- Docker + Docker Compose
- Un bot Telegram (via [@BotFather](https://t.me/BotFather))
- Compte Stripe
- Clé API Anthropic
- Clé API The Odds API (gratuit jusqu'à 500 req/mois)

### 2. Configuration

```bash
cp backend/.env.example backend/.env
# Remplis toutes les variables dans backend/.env
```

**Variables critiques :**
- `TELEGRAM_BOT_TOKEN` → BotFather → /newbot
- `STRIPE_SECRET_KEY` → Dashboard Stripe → Developers
- `STRIPE_WEBHOOK_SECRET` → Stripe → Webhooks → Endpoint secret
- `ANTHROPIC_API_KEY` → console.anthropic.com
- `TELEGRAM_WEBAPP_URL` → URL publique où tu héberges le frontend

### 3. Lancer en local

```bash
# Lance PostgreSQL + backend
docker-compose up -d

# Ou sans Docker :
cd backend && npm install && npm run dev
```

### 4. Appliquer le schéma BDD

```bash
psql $DATABASE_URL -f database/migrations/001_initial_schema.sql
```

---

## Structure du projet

```
telegram-bot-sport/
├── backend/
│   ├── src/
│   │   ├── index.js              # Point d'entrée
│   │   ├── bot/
│   │   │   └── bot.js            # Bot Telegram (toutes les commandes)
│   │   ├── api/
│   │   │   └── routes.js         # API REST pour la Mini App
│   │   ├── services/
│   │   │   ├── userService.js    # Gestion users, crédits, stats
│   │   │   ├── analysisService.js # IA (Anthropic) + Odds API
│   │   │   └── stripeService.js  # Paiements, webhooks, abonnements
│   │   ├── jobs/
│   │   │   └── scheduler.js      # Cron jobs (reset hebdo, cleanup)
│   │   └── config/
│   │       ├── database.js       # Pool PostgreSQL
│   │       └── logger.js         # Winston logger
│   ├── .env.example
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   └── index.html                # Mini App Telegram (dashboard)
├── database/
│   └── migrations/
│       └── 001_initial_schema.sql
├── docker-compose.yml
└── README.md
```

---

## Commandes Telegram

| Commande | Description |
|---|---|
| `/start` | Menu principal |
| `/analyse` | Lancer une analyse IA |
| `/credits` | Voir son solde et acheter |
| `/help` | Aide |

---

## Stripe — Setup Webhooks

Dans le dashboard Stripe, configure un endpoint webhook pointant vers :
```
https://ton-domaine.com/webhook/stripe
```

Événements à activer :
- `checkout.session.completed`
- `invoice.paid`
- `customer.subscription.deleted`
- `customer.subscription.updated`

---

## Déploiement Caprover

1. Crée une app `sportbot` dans Caprover
2. Ajoute les variables d'env depuis `.env.example`
3. Configure le domaine HTTPS (requis pour Telegram WebApp)
4. Deploy via `git push caprover main` ou l'interface

---

## Logique crédits

```
Chaque analyse coûte 1 crédit
├── Analyse gratuite hebdo → free_analysis_used = true
│   Reset chaque lundi à 00:00 (cron)
└── Crédit payant → credits -= 1
    Loggé dans credit_transactions

Achat : 3€ = 10 crédits (Stripe checkout)
Abonnement mensuel : 9.99€/mois = 30 crédits
Abonnement annuel  : 79€/an    = 50 crédits/mois
```

---

## Mini App

Le `frontend/index.html` est la Mini App Telegram. Pour l'activer :

1. Héberge le fichier sur ton domaine (nginx, Caprover...)
2. Met l'URL dans `TELEGRAM_WEBAPP_URL`
3. Dans BotFather : `/setmenubutton` → URL de ta Mini App

La Mini App s'authentifie automatiquement via `Telegram.WebApp.initData` — pas de login à gérer.
