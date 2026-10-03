// Stripe webhook handler (hardened)
// Receives checkout.session.completed / payment_intent.succeeded from Stripe
// and marks the corresponding Vendra online order as paid.
//
// Security:
// - Verifies Stripe-Signature header (HMAC-SHA256 of timestamp.raw_body)
// - Timestamp tolerance: 5 minutes (replay protection)
// - Looks up the shop's endpoint secret via store_id in metadata
// - Rejects unsigned/forged/expired events with 400/401
//
// Deploy: supabase functions deploy stripe-webhook
// Configure in Stripe: Developers → Webhooks → URL = <function-url>
//   Events: checkout.session.completed. Signing secret → paste into Vendra Admin → Storefront → Stripe webhook secret.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TOLERANCE_SECONDS = 300; // 5 minutes

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | null,
  secret: string
): Promise<{ valid: boolean; reason?: string }> {
  if (!sigHeader) return { valid: false, reason: 'Missing Stripe-Signature header' };
  if (!secret) return { valid: false, reason: 'No webhook secret configured' };

  // Parse: t=timestamp,v1=signature[,v0=...]
  const parts: Record<string, string> = {};
  for (const part of sigHeader.split(',')) {
    const [k, v] = part.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  const timestamp = parts['t'];
  const sig = parts['v1'];
  if (!timestamp || !sig) {
    return { valid: false, reason: 'Malformed Stripe-Signature header' };
  }

  // Timestamp tolerance (replay protection)
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return { valid: false, reason: 'Invalid timestamp' };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) {
    return { valid: false, reason: 'Timestamp outside tolerance' };
  }

  try {
    const signedPayload = `${timestamp}.${rawBody}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(signedPayload)
    );
    const expected = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    if (!timingSafeEqual(expected, sig.toLowerCase())) {
      return { valid: false, reason: 'Signature mismatch' };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'Verification error' };
  }
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const rawBody = await req.text();
    const sigHeader = req.headers.get('stripe-signature');

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const eventType = payload?.type;
    const paidEvents = ['checkout.session.completed', 'payment_intent.succeeded'];
    if (!paidEvents.includes(eventType)) {
      return new Response(JSON.stringify({ received: true, ignored: eventType }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const session = payload?.data?.object || {};
    const metadata = session.metadata || {};
    const vendraOrderId = metadata.vendra_order_id;
    const storeId = metadata.store_id;

    if (!vendraOrderId) {
      return new Response(JSON.stringify({ received: true, skipped: 'no order id' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Determine shop for secret lookup
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
      .select('stripe_webhook_secret')
      .eq('store_id', lookupStoreId)
      .single();

    const secret = profile?.stripe_webhook_secret;
    if (!secret) {
      return new Response(
        JSON.stringify({ error: 'Webhook secret not configured for this shop' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { valid, reason } = await verifyStripeSignature(rawBody, sigHeader, secret);
    if (!valid) {
      return new Response(JSON.stringify({ error: reason || 'Invalid signature' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Idempotency: skip already-processed events
    const eventId = payload?.id;
    if (eventId) {
      const { data: existing } = await supabase
        .from('webhook_events')
        .select('id')
        .eq('provider', 'stripe')
        .eq('event_id', String(eventId))
        .single();
      if (existing) {
        return new Response(JSON.stringify({ received: true, deduped: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

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

    if (eventId) {
      await supabase.from('webhook_events').insert({
        provider: 'stripe',
        event_id: String(eventId),
        order_id: vendraOrderId,
        event_type: eventType,
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
