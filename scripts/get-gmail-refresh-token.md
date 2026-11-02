# [DEPRECATED] Getting a Gmail API OAuth Refresh Token for CareerMonke Early-Access Emails

> **DEPRECATION NOTICE**: Gmail OAuth for CareerMonke early-access emails (thank-you & daily digest) has been deprecated and replaced by Google Apps Script web app mail routing (`APPS_SCRIPT_MAIL_URL` + `APPS_SCRIPT_MAIL_SECRET`). Gmail OAuth is no longer needed or used by the application or cron workflows. This guide is retained solely for legacy documentation and reference.

This guide walks the founder step-by-step through setting up a Google Cloud OAuth 2.0 **Web application** client, enabling the **Gmail API**, publishing the consent screen to **"In production"**, and generating a long-lived `GMAIL_REFRESH_TOKEN` using Google OAuth 2.0 Playground so CareerMonke can send early-access thank-you and daily digest emails from your personal Gmail account.

> **Security Rule**: Never commit your Client ID, Client Secret, Refresh Token, or email addresses to the repository. Store them only in Cloudflare Pages and GitHub Actions environment secrets (and `.env.local` if testing locally).

---

## Step 1: Create a Google Cloud Project & Enable the Gmail API

1. Open the [Google Cloud Console](https://console.cloud.google.com/) while signed in to your founder Google account.
2. Create a new project (e.g., `CareerMonke Mailer`) or select an existing project.
3. Navigate to **APIs & Services → Library**.
4. Search for **Gmail API**, click on it, and click **Enable**.

---

## Step 2: Configure the OAuth Consent Screen & Publish "In production"

1. Go to **APIs & Services → OAuth consent screen** (or **Google Auth Platform → Audience / Branding**).
2. Choose **External** as the User Type and click **Create**.
3. Fill in the required fields:
   - **App name**: `CareerMonke`
   - **User support email**: your founder Gmail address
   - **Developer contact information**: your founder Gmail address
4. Click **Save and Continue** to the **Scopes** step:
   - Click **Add or Remove Scopes**.
   - Enter the exact send-only scope in the manual scope box:
     ```text
     https://www.googleapis.com/auth/gmail.send
     ```
   - Click **Add to table**, then **Update**, and **Save and Continue**.
5. Continue to the **Summary** page and return to the **OAuth consent screen** dashboard.
6. **CRITICAL — Publish the app to "In production"**:
   - Under **Publishing status**, click **Publish App** and confirm.
   - Make sure the status reads **"In production"** (not "Testing").
   - *Why this is required*: If the consent screen remains in **"Testing"** mode, Google automatically revokes refresh tokens after **7 days**. Publishing to **"In production"** ensures your refresh token does not expire after 7 days (you do not need to submit for Google verification because only your own personal account will authorize it).

---

## Step 3: Create the OAuth 2.0 Client ID (**Web application**)

1. Go to **APIs & Services → Credentials**.
2. Click **+ Create Credentials → OAuth client ID**.
3. Set **Application type** to **Web application** (do **not** choose Desktop app).
4. Set **Name** to `CareerMonke OAuth Playground Web Client`.
5. Under **Authorized redirect URIs**, click **+ Add URI** and enter the exact OAuth Playground URL:
   ```text
   https://developers.google.com/oauthplayground
   ```
6. Click **Create**.
7. Copy your **Client ID** (`GMAIL_CLIENT_ID`) and **Client Secret** (`GMAIL_CLIENT_SECRET`) and keep them safe.

---

## Step 4: Generate the Refresh Token in Google OAuth 2.0 Playground

1. Open [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground).
2. Click the **Gear icon (OAuth 2.0 configuration)** in the top-right corner of the page and verify:
   - **OAuth flow**: `Server-side`
   - **Access type**: `Offline` (ensures a refresh token is issued)
   - Check the box **"Use your own OAuth credentials"**
   - **OAuth Client ID**: paste your `GMAIL_CLIENT_ID`
   - **OAuth Client secret**: paste your `GMAIL_CLIENT_SECRET`
3. Close the configuration popover.
4. In **Step 1 (Select & authorize APIs)** on the left panel:
   - In the *"Input your own scopes"* box at the bottom of the list, enter ONLY:
     ```text
     https://www.googleapis.com/auth/gmail.send
     ```
   - Click **Authorize APIs**.
5. Sign in with your **personal founder Gmail account**:
   - If Google displays an *"Google hasn't verified this app"* screen (normal for self-owned unverified apps in production), click **Advanced → Go to CareerMonke (unsafe)**.
   - Review the permission (*"Send email on your behalf"*) and click **Allow** to grant permission for CareerMonke to send emails from your personal Gmail account.
6. You will be redirected back to **Step 2 (Exchange authorization code for tokens)** in OAuth Playground:
   - Click **Exchange authorization code for tokens**.
   - Copy the `refresh_token` value from the JSON response — this is your `GMAIL_REFRESH_TOKEN`.

---

## Step 5: Set Environment Variables in Cloudflare Pages & GitHub Actions Secrets

Add the following environment variables in **Cloudflare Pages → Settings → Environment variables** AND **GitHub Repository → Settings → Secrets and variables → Actions**:

| Variable | Description |
| :--- | :--- |
| `GMAIL_CLIENT_ID` | OAuth 2.0 Web Application Client ID from Step 3 |
| `GMAIL_CLIENT_SECRET` | OAuth 2.0 Web Application Client Secret from Step 3 |
| `GMAIL_REFRESH_TOKEN` | Refresh token obtained in Step 4 (`offline` access) |
| `GMAIL_SENDER_EMAIL` | Your personal Gmail address that authorized the token |
| `GMAIL_SENDER_NAME` | Display name for the `From` header (e.g., `Roman from CareerMonke`) |
| `EARLY_ACCESS_NOTIFY_EMAIL` | Destination email address for the scheduled daily early-access signup digest |

---

## Step 6: Ensure Database Tables Exist in Supabase

Ensure both `early_access_emails` and `gmail_send_log` exist in Supabase (`supabase/migrations/20261029_early_access_emails.sql`):

```sql
CREATE TABLE IF NOT EXISTS public.early_access_emails (
  email      TEXT PRIMARY KEY CHECK (char_length(email) <= 254 AND position('@' in email) > 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.gmail_send_log (
  id              BIGSERIAL PRIMARY KEY,
  recipient_email TEXT,
  kind            TEXT NOT NULL DEFAULT 'thank_you' CHECK (kind IN ('thank_you', 'digest')),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- `POST /api/early-access` sends at most **one thank-you email per distinct address ever**, checks `gmail_send_log` before each send (failing closed if the log cannot be read), and caps total outgoing messages at **150 messages/day**.
- The scheduled GitHub Actions workflow (`.github/workflows/early-access-digest-cron.yml` → `scripts/early-access-digest-cron.ts`) runs once a day and sends **one digest email** containing all new `early_access_emails` rows since the last digest (or sends nothing if there are no new rows).
