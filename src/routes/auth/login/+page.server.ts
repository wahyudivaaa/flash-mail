import type { PageServerLoad } from './$types';
import { getTurnstileSiteKey } from '$lib/server/turnstile';

export const load: PageServerLoad = async ({ platform }) => {
    const db = platform?.env?.DB;

    let requiresSetupToken = false;
    if (db) {
        try {
            const row = await db.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number | string | null }>();
            requiresSetupToken = Number(row?.count ?? 0) === 0;
        } catch {
            requiresSetupToken = false;
        }
    }

    return {
        turnstileSiteKey: getTurnstileSiteKey(platform?.env),
        requiresSetupToken
    };
};
