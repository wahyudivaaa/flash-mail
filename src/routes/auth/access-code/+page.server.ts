import type { PageServerLoad } from './$types';
import { getTurnstileSiteKey } from '$lib/server/turnstile';

export const load: PageServerLoad = async ({ platform }) => {
    return {
        turnstileSiteKey: getTurnstileSiteKey(platform?.env)
    };
};
