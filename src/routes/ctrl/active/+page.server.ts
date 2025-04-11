import type { PageServerLoad } from './$types';
// import { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } from '$env/static/private'
import { env } from '$env/dynamic/private'
import twilio from 'twilio'

export const load = (async () => {
    try {
        const client = twilio (env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN)
        const turnCredential = await client.tokens.create ({ ttl: 3600 })
        return { iceServers: turnCredential.iceServers }
    } catch (error) {
        console.error (`Error fetching Twilio TURN credentials:`, error)
        return {
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], //Default STUN
            error: 'Failed to fetch Twilio TURN credentials. Using STUN only.'
        }
    }
}) satisfies PageServerLoad