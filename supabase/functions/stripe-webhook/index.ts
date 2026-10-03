// Stripe webhook handler
// Receives checkout.session.completed / payment_intent.succeeded from Stripe
// and marks the corresponding Vendra online order as paid.
//
// Deploy: supabase functions deploy stripe-webhook
// Configure in Stripe: Developers → Webhooks → URL = <function-url>
// Events: checkout.session.completed

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const payload = await req.json();
    const eventType = payload?.type;

    // We care about completed checkout sessions
    const paidEvents = ['checkout.session.completed', 'payment_intent.succeeded'];
    if (!paidEvents.includes(eventType)) {
      return new Response(JSON.stringify({ received: true, ignored: eventType }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Extract metadata - the shop should pass order ID as metadata
    // when creating the Stripe payment link
    const session = payload?.data?.object || {};
    const metadata = session.metadata || {};
    const vendraOrderId = metadata.vendra_order_id;

    if (!vendraOrderId) {
      console.log('No vendra_order_id in webhook metadata, skipping');
      return new Response(JSON.stringify({ received: true, skipped: 'no order id' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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

    return new Response(JSON.stringify({ received: true, order_id: vendraOrderId, status: 'paid' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('Webhook error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
