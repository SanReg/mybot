# payBot

Discord bot for Coinos Lightning deposits, withdrawals and in-server tipping.

## Requirements

- Node.js >= 18
- A Postgres database (Supabase recommended)

## Setup

1. Install dependencies:
   - `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `COINOS_TOKEN`
   - `COINOS_PIN`
   - `DATABASE_URL`
3. Start the bot:
   - `npm start`

## Supabase / Postgres

1. Create a Postgres project (Supabase recommended).
2. Go to Project Settings -> Database -> Connection string and copy the `postgresql://` URL into `DATABASE_URL`.
3. Apply the schema in [sql/schema.sql](sql/schema.sql).

## What's new / Features

- Deposit responses now include a QR image of the BOLT11 invoice and a "Copy Invoice" button for easy copying.
- `/pay payreq` — pay a BOLT11 Lightning invoice directly from your bot balance.
- `/leaderboard type` — view top rain *makers* or *catchers*.
- `/help` — interactive help summary of available commands.
- Admin commands: `/admin`, `/userstats`, `/changestatus` (admin-only).

## Commands

- `/deposit amount:<sats>`
  - Creates a Lightning invoice via Coinos, shows the invoice text and a QR code image, and provides a quick "Copy Invoice" button.
- `/link address:<name@domain>`
  - Link a Lightning Address (LNURL/pay style) for withdrawals.
- `/withdraw amount:<sats>`
  - Withdraw sats to your linked Lightning address (uses the address' pay callback).
- `/pay payreq:<bolt11>`
  - Pay a BOLT11 invoice using your bot balance. Invoice must include an amount.
- `/balance`
  - Shows your current balance and linked address (syncs paid deposit invoices).
- `/tip user:<@user> amount:<sats>`
  - Tip another user publicly from your balance.
- `/rain amount:<sats> maxcount:<n>`
  - Send sats to recent active users in the current channel (scans up to the last 1000 messages).
- `/history`
  - Shows your last 10 balance ledger entries.
- `/leaderboard type:<makers|catchers>`
  - Shows top makers (who rain) or catchers (who received rain).
- `/help`
  - Shows the command summary.

## Admin Commands (restricted)

- `/admin` — shows admin dashboard with total balances and a button to view recent withdrawals.
- `/userstats user:<@user>` — view a user's recent stats and balances.
- `/changestatus type name` — change the bot activity status (Playing/Listening/etc.).

Global slash commands may take a few minutes to appear in all servers after registering.
