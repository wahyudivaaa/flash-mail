declare global {
  namespace App {
    interface Locals {
      authenticated: boolean;
      sessionUserId?: string;
      sessionEmail?: string;
      sessionRole?: 'owner' | 'member';
    }

    interface Platform {
      env: {
        DB?: D1Database;
        MAILFLARE_USER_DOMAIN?: string;
        TELEGRAM_BOT_TOKEN?: string;
        TELEGRAM_WEBHOOK_SECRET?: string;
        TELEGRAM_ALLOWED_IDS?: string;
        TELEGRAM_DEFAULT_CHAT_ID?: string;
        TELEGRAM_TEST_CHAT_ID?: string;
        TELEGRAM_INTERNAL_SECRET?: string;
        TURNSTILE_SECRET_KEY?: string;
        TURNSTILE_SITE_KEY?: string;
        SETUP_TOKEN?: string;
        CLOUDFLARE_API_TOKEN?: string;
        CLOUDFLARE_ACCOUNT_ID?: string;
        CLOUDFLARE_ZONE_ID?: string;
        CLOUDFLARE_ZONE_NAME?: string;
        CLOUDFLARE_EMAIL_WORKER_NAME?: string;
        MAILFLARE_EMAIL_WORKER_NAME?: string;
        OUTLOOK_TENANT_ID?: string;
        OUTLOOK_CLIENT_ID?: string;
        OUTLOOK_CLIENT_SECRET?: string;
        OUTLOOK_LICENSE_SKU_ID?: string;
        OUTLOOK_INITIAL_DOMAIN?: string;
        MICROSOFT_TENANT_ID?: string;
        MICROSOFT_CLIENT_ID?: string;
        MICROSOFT_CLIENT_SECRET?: string;
        MICROSOFT_LICENSE_SKU_ID?: string;
        MICROSOFT_INITIAL_DOMAIN?: string;
      };
    }
  }
}

export {};
