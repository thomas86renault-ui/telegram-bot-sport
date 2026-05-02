-- ============================================================
-- Migration 001 — Initial schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ────────────────────────────────────────────────────────────
-- USERS
-- ────────────────────────────────────────────────────────────
CREATE TABLE users (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_id            BIGINT UNIQUE NOT NULL,
  username               VARCHAR(100),
  first_name             VARCHAR(100),
  credits                INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  free_analysis_used     BOOLEAN NOT NULL DEFAULT FALSE,
  free_analysis_reset_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  bankroll_initial       DECIMAL(10,2) NOT NULL DEFAULT 0,
  bankroll_current       DECIMAL(10,2) NOT NULL DEFAULT 0,
  subscription_status    VARCHAR(20) NOT NULL DEFAULT 'free'
                         CHECK (subscription_status IN ('free','active','cancelled','past_due')),
  stripe_customer_id     VARCHAR(100) UNIQUE,
  created_at             TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at             TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_users_telegram_id ON users(telegram_id);
CREATE INDEX idx_users_stripe_customer_id ON users(stripe_customer_id);

-- ────────────────────────────────────────────────────────────
-- BETS
-- ────────────────────────────────────────────────────────────
CREATE TABLE bets (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sport        VARCHAR(50) NOT NULL,
  match_name   VARCHAR(200) NOT NULL,
  bet_type     VARCHAR(100),
  stake        DECIMAL(10,2) NOT NULL CHECK (stake > 0),
  odds         DECIMAL(6,2) NOT NULL CHECK (odds > 1),
  status       VARCHAR(20) NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','won','lost','void')),
  pnl          DECIMAL(10,2) DEFAULT 0,
  bet_date     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_bets_user_id ON bets(user_id);
CREATE INDEX idx_bets_status ON bets(status);
CREATE INDEX idx_bets_bet_date ON bets(bet_date DESC);

-- ────────────────────────────────────────────────────────────
-- ANALYSES
-- ────────────────────────────────────────────────────────────
CREATE TABLE analyses (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sport          VARCHAR(50),
  match_name     VARCHAR(200),
  prompt_sent    TEXT NOT NULL,
  result         TEXT,
  credits_used   INTEGER NOT NULL DEFAULT 1,
  was_free       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_analyses_user_id ON analyses(user_id);
CREATE INDEX idx_analyses_created_at ON analyses(created_at DESC);

-- ────────────────────────────────────────────────────────────
-- CREDIT TRANSACTIONS (ledger)
-- ────────────────────────────────────────────────────────────
CREATE TABLE credit_transactions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount              INTEGER NOT NULL, -- positif = crédit, négatif = débit
  type                VARCHAR(30) NOT NULL
                      CHECK (type IN ('purchase','analysis','subscription_monthly','refund','bonus')),
  stripe_payment_id   VARCHAR(200),
  description         VARCHAR(300),
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX idx_credit_transactions_created_at ON credit_transactions(created_at DESC);

-- ────────────────────────────────────────────────────────────
-- SUBSCRIPTIONS
-- ────────────────────────────────────────────────────────────
CREATE TABLE subscriptions (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id  VARCHAR(200) UNIQUE NOT NULL,
  plan                    VARCHAR(20) NOT NULL CHECK (plan IN ('monthly','yearly')),
  status                  VARCHAR(20) NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','cancelled','past_due','incomplete')),
  credits_per_month       INTEGER NOT NULL DEFAULT 30,
  current_period_end      TIMESTAMP WITH TIME ZONE,
  created_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at              TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_id ON subscriptions(stripe_subscription_id);

-- ────────────────────────────────────────────────────────────
-- STRIPE EVENTS (idempotency)
-- ────────────────────────────────────────────────────────────
CREATE TABLE stripe_events (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id  UUID REFERENCES subscriptions(id),
  event_type       VARCHAR(100) NOT NULL,
  stripe_event_id  VARCHAR(200) UNIQUE NOT NULL,
  payload          JSONB,
  processed        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_stripe_events_stripe_event_id ON stripe_events(stripe_event_id);
CREATE INDEX idx_stripe_events_processed ON stripe_events(processed);

-- ────────────────────────────────────────────────────────────
-- TRIGGER: updated_at auto-update
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_bets_updated_at
  BEFORE UPDATE ON bets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ────────────────────────────────────────────────────────────
-- TRIGGER: auto-update bankroll_current on bet resolution
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_bankroll_on_bet()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status != OLD.status AND OLD.status = 'pending' THEN
    IF NEW.status = 'won' THEN
      NEW.pnl = (NEW.stake * NEW.odds) - NEW.stake;
    ELSIF NEW.status = 'lost' THEN
      NEW.pnl = -NEW.stake;
    ELSIF NEW.status = 'void' THEN
      NEW.pnl = 0;
    END IF;

    UPDATE users
    SET bankroll_current = bankroll_current + NEW.pnl
    WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bet_bankroll
  BEFORE UPDATE ON bets
  FOR EACH ROW EXECUTE FUNCTION update_bankroll_on_bet();
