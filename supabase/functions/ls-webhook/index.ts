// Lemon Squeezy webhook handler
// Receives order.created / subscription events from Lemon Squeezy
// and marks the corresponding Vendra online order as paid.
//
// Deploy: supabase functions deploy ls-webhook
// Configure in Lemon Squeezy: Settings → Webhooks → URL = <function-url>

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
    const eventName = payload?.meta?.event_name || payload?.event_name;

    // We care about successful order/payment events
    const paidEvents = ['order_created', 'subscription_created', 'subscription_updated'];
    if (!paidEvents.includes(eventName)) {
      return new Response(JSON.stringify({ received: true, ignored: eventName }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Extract custom data - the shop should pass order ID as custom data
    // when creating the Lemon Squeezy checkout
    const customData = payload?.meta?.custom_data || {};
    const vendraOrderId = customData.vendra_order_id;
    const storeId = customData.store_id;

    if (!vendraOrderId) {
      console.log('No vendra_order_id in webhook, skipping');
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
