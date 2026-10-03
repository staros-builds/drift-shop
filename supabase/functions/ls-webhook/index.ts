// Lemon Squeezy webhook handler (hardened)
// Receives order.created / subscription events from Lemon Squeezy
// and marks the corresponding Vendra online order as paid.
//
// Security:
// - Verifies X-Signature header (HMAC-SHA256 of raw body with shop's webhook secret)
// - Looks up the shop's secret via store_id in custom_data
// - Rejects unsigned/forged events with 401
//
// Deploy: supabase functions deploy ls-webhook
// Configure in Lemon Squeezy: Settings → Webhooks → URL = <function-url>
//   Events: order_created. Signing secret → paste into Vendra Admin → Storefront → Lemon Squeezy webhook secret.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Constant-time hex string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifySignature(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
    const expected = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return timingSafeEqual(expected, signature.toLowerCase());
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // Read raw body FIRST for signature verification
    const rawBody = await req.text();
    const signature = req.headers.get('x-signature');

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const eventName = payload?.meta?.event_name || payload?.event_name;
    const paidEvents = ['order_created', 'subscription_created', 'subscription_updated'];
    if (!paidEvents.includes(eventName)) {
      return new Response(JSON.stringify({ received: true, ignored: eventName }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const customData = payload?.meta?.custom_data || {};
    const vendraOrderId = customData.vendra_order_id;
    const storeId = customData.store_id;

    if (!vendraOrderId) {
      return new Response(JSON.stringify({ received: true, skipped: 'no order id' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Look up the shop's webhook secret
    // We need store_id to find the right secret. Try from custom_data, else from the order.
    let lookupStoreId = storeId;
    if (!lookupStoreId) {
      const { data: order } = await supabase
        .from('online_orders')
        .select('store_id')
        .eq('id', vendraOrderId)
        .single();
      lookupStoreId = order?.store_id;
    }

    if (!lookupStoreId) {
      return new Response(JSON.stringify({ error: 'Cannot determine shop for order' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { data: profile } = await supabase
      .from('storefront_profiles')
      .select('ls_webhook_secret')
      .eq('store_id', lookupStoreId)
      .single();

    const secret = profile?.ls_webhook_secret;
    if (!secret) {
      // No secret configured — reject to force proper setup
      // (fail-closed: better than accepting unsigned webhooks)
      return new Response(
        JSON.stringify({ error: 'Webhook secret not configured for this shop' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const valid = await verifySignature(rawBody, signature, secret);
    if (!valid) {
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Idempotency: skip if we've already processed this event
    const eventId = payload?.meta?.event_id || payload?.id;
    if (eventId) {
      const { data: existing } = await supabase
        .from('webhook_events')
        .select('id')
        .eq('provider', 'lemonsqueezy')
        .eq('event_id', String(eventId))
        .single();
      if (existing) {
        return new Response(JSON.stringify({ received: true, deduped: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Mark the order as paid
    const { error } = await supabase.rpc('online_order_set_status', {
      p_order_id: vendraOrderId,
      p_status: 'paid',
    });

    if (error) {
      console.error('Failed to update order status:', error);
      return new Response(JSON.stringify({ error: 'Failed to update order' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Record the processed event for idempotency
    if (eventId) {
      await supabase.from('webhook_events').insert({
        provider: 'lemonsqueezy',
        event_id: String(eventId),
        order_id: vendraOrderId,
        event_type: eventName,
      });
    }

    return new Response(JSON.stringify({ received: true, order_id: vendraOrderId, status: 'paid' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('Webhook error:', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
