-- Create app_settings table for global settings (currency, etc.)
CREATE TABLE IF NOT EXISTS app_settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(50) UNIQUE NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default currency if not exists
INSERT INTO app_settings (key, value) 
VALUES ('currency', 'NZD')
ON CONFLICT (key) DO NOTHING;

-- Supported currencies: code, symbol, and name
CREATE TABLE IF NOT EXISTS currencies (
  code VARCHAR(3) PRIMARY KEY,
  symbol VARCHAR(10) NOT NULL,
  name VARCHAR(100) NOT NULL,
  locale VARCHAR(10) DEFAULT 'en-US'
);

-- Insert common currencies
INSERT INTO currencies (code, symbol, name, locale) VALUES
  ('USD', '$', 'US Dollar', 'en-US'),
  ('NZD', '$', 'New Zealand Dollar', 'en-NZ'),
  ('PHP', '₱', 'Philippine Peso', 'en-PH'),
  ('AUD', '$', 'Australian Dollar', 'en-AU'),
  ('CAD', '$', 'Canadian Dollar', 'en-CA'),
  ('GBP', '£', 'British Pound', 'en-GB'),
  ('EUR', '€', 'Euro', 'en-EU'),
  ('JPY', '¥', 'Japanese Yen', 'ja-JP'),
  ('SGD', '$', 'Singapore Dollar', 'en-SG'),
  ('HKD', '$', 'Hong Kong Dollar', 'en-HK'),
  ('INR', '₹', 'Indian Rupee', 'en-IN'),
  ('THB', '฿', 'Thai Baht', 'th-TH'),
  ('MYR', 'RM', 'Malaysian Ringgit', 'en-MY')
ON CONFLICT (code) DO NOTHING;
