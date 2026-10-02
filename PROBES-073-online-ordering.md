# Live probes — migration 073: customer accounts + online ordering

For merge time. Run AFTER the coordinator renumbers/applies draft
migration `073_draft_customer_orders.sql` and deploys the branch build.
Everything below needs two test browsers (or one + incognito) and a
throwaway customer mailbox.

## Happy path (one customer, one shop)

1. **Setup.** Owner enables *Online ordering* in
   Settings → Public page → Online ordering. Turn it OFF first: reload
   the public page and confirm the page is browse-only (no "Order
   online" section, no Add buttons).
2. **Toggle on.** Turn it ON with a prep note (e.g. "Usually ready in
   2 hours."). Reload the public page: the note shows, products show
   Add buttons, out-of-stock products show "Out of stock".
3. **Sign up.** Create a customer account with a throwaway email.
   Confirm the "Check your email" step appears when email confirmation
   is required; after confirming, sign in works. Confirm the pickup
   name/phone saved in the profile is reused on the next order.
4. **Place an order.** Add 2 items, place the order. Confirm the
   confirmation screen shows a big order number (#1 for the shop).
   Confirm "My orders" lists it as "Received — the shop has your order".
5. **Staff inbox.** Open Point of Sale → Online orders. Badge count
   matches. The order appears with items, totals, pickup note.
   - Start preparing → status "Being prepared".
   - Mark ready for pickup → status "Ready for pickup".
6. **Convert to sale.** Tap "Convert to sale", pay cash, tendered =
   total. Confirm: sale recorded with a sale number; History shows the
   sale; Reports includes it (channel 'online'); the POS Customers tab
   now has a row for the customer; each product's stock dropped by
   exactly the ordered quantity — once.
7. **Double-tap conversion.** Tap "Convert to sale" again on the same
   order (or refresh and re-open it): NO second sale, NO second stock
   drop. The order stays Done.
8. **Reorder.** Customer taps "Order again" — cart refills with the
   same items; placing it creates order #2 for that shop.
9. **Customer cancel.** Place order #3, customer cancels from "My
   orders" while status is Received. Shop inbox shows it cancelled;
   staff convert button is gone; stock unchanged.
10. **Staff cancel.** Place order #4, cancel from the inbox. Customer
    sees "Cancelled"; can't reorder-cancel again (button gone).

## Security / abuse probes

11. **Cross-customer bleed.** Sign in as customer B. "My orders" must
    NOT show customer A's orders. Cancel attempt on A's order id via
    RPC → ONLINE_FORBIDDEN error, order unchanged.
12. **Cross-shop bleed.** A second shop's owner opens their inbox:
    must NOT see shop 1's orders. Direct REST GET on online_orders
    with the anon key → 401/empty (RLS: anon has no read).
13. **Anon access.** Signed-out REST GET of online_orders,
    online_customers, online_order_items → empty/401. The public page
    still browses products (public_storefront RPC unaffected).
14. **Tampered prices.** From the browser console, call
    online_order_place with a hand-built items payload (wrong/absurd
    prices are not even accepted — the RPC only takes product ids +
    quantities). Change a shop product's price between Add and Place:
    the ORDER carries the new price; the cart preview warned
    "price changed".
15. **Absurd quantities.** Try placing qty 9999 or -5 for an item:
    server clamps/rejects (ONLINE_BAD_ITEMS or qty between 1 and 999);
    no order row created.
16. **Rate limit.** Place 5 orders in 10 minutes as one customer; the
    6th → "You placed several orders in the last few minutes" friendly
    error (ONLINE_TOO_MANY_ORDERS). A different customer is unaffected.
17. **HTML/JS injection.** Put `<script>alert(1)</script>` and emoji in
    the customer name, pickup note, and ordering note. Public page and
    inbox render it as plain text everywhere (React escaping); no
    script executes.
18. **Out-of-stock at order time.** Add the last unit of a tracked
    product to a cart, meanwhile sell it in the till, then place the
    order → friendly "just ran out of stock" error, no order created.
19. **Stale retry / double-submit.** Place an order, then re-send the
    same request (refresh mid-submit, double-tap Place): only ONE
    order exists (idempotency key); the confirmation shows the same
    order number.
20. **Payment honesty.** The whole flow contains NO card-entry form —
    at pickup only. Confirm the receipt/print path exists only from
    the till sale, and the customer page never promises "paid".

## Residual assumptions to re-check at merge

- The customer sign-in flow wraps Supabase email+password auth
  (src/lib/onlineOrders.js `signUp`). If the email-auth workstream
  lands its own signup flow, these wrappers must be swapped for it —
  the page only depends on: session user, email-confirmed detection.
- On a pre-073 database the public page degrades silently to
  browse-only (capability probe fails → no ordering UI, no errors).
- The ES/PT strings live in src/lib/locales/onlineOrders-es-pt.js on
  this branch; merge instructions are in that file's header.
