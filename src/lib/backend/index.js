/**
 * Vendra backend adapter layer — interface docs + factory.
 *
 * Vendra is cloud-only: the only adapter is Supabase. The old localStorage
 * ("This device") and Replit adapters have been removed.
 *
 * Scale note: shops can later be spread across several Supabase
 * projects. The routing seam for that is ./directory.js
 * (slug → backend config, falling back to the build-time pair below).
 * Nothing consults the directory yet, so every install still boots
 * against the single build-time backend exactly as before.
 *
 * Every adapter exposes the SAME shape:
 *
 *   {
 *     kind: 'supabase',
 *     note: string | null,          // honest one-liner about the mode (shown in About/Login)
 *     auth: {
 *       // user = { id, email, username, role: 'admin'|'standard', isGuest }
 *       signUp({ email, password, username }) -> { user }
 *       signIn({ email, password }) -> { user }
 *       signInGuest() -> { user }            // extra: trial user flagged isGuest
 *       signOut() -> void
 *       getUser() -> { user } | null         // sync ok
 *       onAuthChange(cb) -> unsubscribe      // cb(user|null), sync ok
 *       // One login (2026-10-01): email signup with confirmation.
 *       signUpWithEmail({ email, password, displayName, kind, slug })
 *         -> { status: 'signed-in', user } | { status: 'needs-confirmation', email }
 *       resendConfirmation({ email, kind, slug }) -> void
 *       consumeAuthCallback()                 // email-link landing router
 *         -> { kind: 'confirmed', flow } | { kind: 'recovery' }
 *          | { kind: 'error', errorCode } | { kind: 'none' }
 *     },
 *     profile: {
 *       // Display identity only — never roles/paid/lock state.
 *       get() -> { username, displayName, avatarUrl }
 *       update({ username?, displayName?, avatarUrl? }) -> profile
 *     },
 *     settings: {
 *       // s = { visual_theme: 'daybreak'|'nightshift',
 *       //       wallpaper: 'paper-grain'|'linen'|'dusk'|'plain',
 *       //       accent_override: string|null, ai_engine: 'local'|'cloud',
 *       //       icon_positions: {} }
 *       get() -> s
 *       update(patch) -> s
 *     },
 *     files: {
 *       // entry = { name, path, type: 'file'|'folder', size, mime, updatedAt }
 *       list(path) -> [entry]                // '/Documents'; '/' = root
 *       read(path) -> { text }               // text only; binary throws { code: 'IS_BINARY' }
 *                                          // (binary rows with a text/* mime decode back to text)
 *       write(path, text) -> entry           // creates/overwrites; makes parent folders
 *                                          // (text over the 10 MB inline limit is stored via the
 *                                          //  binary path instead of throwing)
 *       mkdir(path) -> entry
 *       remove(path) -> void                 // files and folders (recursive)
 *       rename(oldPath, newPath) -> void
 *       downloadBlob(path) -> Blob           // raw bytes, binary or text (backup path)
 *     },
 *     spaces: {
 *       // space = { id, name, icon, wallpaper, accent, sortOrder }
 *       list() -> [space]                    // sortOrder order; Main/Focus/Play seeded
 *       create(name) -> space                // max 8 -> throws Error('maximum 8 spaces per user')
 *       rename(id, name) -> space
 *       remove(id) -> void                   // window states merge into 'Main' first
 *       replaceAll(entries) -> [space]       // import-only: replaces the whole set
 *                                          // (names, wallpaper, accent, icon, sort
 *                                          // order, window states); never re-seeds,
 *                                          // dedupes names, needs >= 1 entry
 *       // ws = { appId, x, y, w, h, z, minimized, props }
 *       getWindowStates(spaceId) -> [ws]
 *       saveWindowState(spaceId, ws) -> void // upsert on (spaceId, appId)
 *       removeWindowState(spaceId, appId) -> void
 *     },
 *     pins: {
 *       // pin = { id, kind: 'text'|'link'|'file'|'image'|'note', title, body, url,
 *       //         tags: [string], sourceApp, createdAt, updatedAt }
 *       list({ kind, tag, limit } = {}) -> [pin]     // newest first
 *       search(query, { kind, tag } = {}) -> [pin]   // ranked; empty query -> list()
 *       create({ kind, title, body, url, tags, sourceApp }) -> pin
 *       update(id, patch) -> pin
 *       remove(id) -> void
 *       tags() -> [string]                           // distinct tags, alpha order
 *       fileUrl(pin) -> string                       // fresh URL for a file/image pin
 *       fileData(pin) -> string                      // data URL of a file/image pin (backup path)
 *     },
 *     helm: {
 *       // thread = { id, title, createdAt, updatedAt }
 *       // message = { id, role: 'user'|'assistant'|'tool', content, toolCalls, createdAt }
 *       threads() -> [thread]                        // updatedAt desc
 *       createThread(title) -> thread
 *       messages(threadId) -> [message]              // createdAt asc
 *       addMessage(threadId, { role, content, toolCalls }) -> message
 *       removeThread(id) -> void
 *     },
 *     highscores: {
 *       // { gameId, score, meta, achievedAt }
 *       list(gameId, limit = 10) -> [{ score, meta, achievedAt }]  // score desc
 *       record(gameId, score, meta = {}) -> void
 *       exportAll() -> [{ gameId, score, meta, achievedAt }]
 *       importAll(rows) -> { inserted }      // merge-only, idempotent
 *     },
 *     notifications: {
 *       // { id, title, body, read, createdAt }
 *       list() -> [notif]                            // newest first
 *       push({ title, body }) -> notif
 *       markRead(id) -> void
 *       dismiss(id) -> void                          // real delete
 *       clearAll() -> void                           // real delete-all
 *       exportAll() -> [notif]
 *       importAll(rows) -> { inserted }      // merge-only by id, idempotent
 *     },
 *     pos: {
 *       // Multi-user point of sale. Shared stores with roles
 *       // (owner/manager/cashier), invite codes, per-store sale numbering.
 *       // store = { id, name, currency, taxRate, role, memberCount, joinedAt }
 *       // product = { id, name, sku, priceCents, category, active, createdAt }
 *       // sale = { id, number, items: [{ productId, name, priceCents, qty }],
 *       //          subtotalCents, discountCents, taxCents, totalCents,
 *       //          method: 'cash'|'card', tenderedCents, changeCents,
 *       //          createdBy, createdAt, voided, voidedAt }
 *       listStores() -> [store]
 *       createStore({ name, currency, taxRate }) -> store   // cloud only
 *       updateStore(storeId, { name, currency, taxRate }) -> store
 *       deleteStore(storeId) -> void                        // owner only
 *       createInvite(storeId, { role, maxUses, expiresInHours }) -> invite
 *       listInvites(storeId) -> [invite]
 *       revokeInvite(storeId, inviteId) -> void
 *       joinStore(code) -> storeId                         // cloud only
 *       listMembers(storeId) -> [{ userId, username, role, joinedAt }]
 *       setMemberRole(storeId, userId, role) -> void        // owner only
 *       removeMember(storeId, userId) -> void               // owner or self
 *       listProducts(storeId) -> [product]
 *       saveProduct(storeId, product) -> product            // manager+
 *       deleteProduct(storeId, id) -> void                  // manager+
 *       // storefront (migration 063): the shop's public web page.
 *       // product.publicVisible defaults TRUE (new POS products appear
 *       // on the published storefront automatically); the anonymous
 *       // public_storefront() RPC serves exactly these rows.
 *       getStorefrontProfile(storeId) -> profile|null       // member
 *       saveStorefrontProfile(storeId, profile) -> profile  // manager+
 *       setProductPublicVisible(storeId, id, visible) -> product
 *       listSales(storeId, { limit }) -> [sale]             // newest first
 *       recordSale(storeId, sale) -> sale                   // any member
 *       voidSale(storeId, id) -> void                       // manager+
 *       // POS upgrades: sale records also carry adjustments: [{ kind: 'giftcard'|
 *       // 'creditnote'|'loyalty'|'deposit', code, label, cents, refId }],
 *       // promoCode, promoDiscountCents, loyaltyEarned, loyaltyRedeemed,
 *       // refunds: [{ id, createdAt, lines, amountCents, method, reason }]
 *       listGiftCards({ outstandingOnly }) -> [giftcard]
 *       sellGiftCard(storeId, { amountCents, note, saleNumber }) -> giftcard
 *       redeemGiftCard(storeId, id, amountCents) -> giftcard
 *       creditGiftCard(storeId, id, amountCents) -> giftcard   // rollback
 *       listCreditNotes({ outstandingOnly }) -> [creditnote]
 *       issueCreditNote(storeId, { amountCents, customerId, customerName,
 *                                reason, saleNumber }) -> creditnote
 *       redeemCreditNote(storeId, id, amountCents) -> creditnote
 *       creditCreditNote(storeId, id, amountCents) -> creditnote // rollback
 *       lookupTenderCode(storeId, code) -> { kind, id, code, label, balanceCents }
 *       listDeposits({ status }) -> [deposit]               // open|ready|picked
 *       takeDeposit(storeId, { customerName, customerId, description,
 *                             totalCents, amountCents, saleNumber }) -> deposit
 *       depositAddPayment(storeId, id, amountCents) -> deposit
 *       depositApply(storeId, id, amountCents) -> deposit   // tender credit
 *       depositUnapply(storeId, id, amountCents) -> deposit // rollback
 *       depositSetReady(storeId, id) -> deposit
 *       depositSetOpen(storeId, id) -> deposit
 *       listPromos({ activeOnly }) -> [promo]               // percent|fixed|bogo
 *       savePromo(storeId, promo) -> promo                  // manager+
 *       deletePromo(storeId, id) -> void                    // manager+
 *       getPromoByCode(storeId, code) -> promo | null
 *       addLoyaltyPoints(storeId, customerId, points) -> points
 *       redeemLoyaltyPoints(storeId, customerId, points) -> points
 *       listSchoolLists() -> [schoollist]
 *       saveSchoolList(storeId, list) -> schoollist         // manager+
 *       deleteSchoolList(storeId, id) -> void                // manager+
 *       listPettyCashMovements(storeId, { limit }) -> [movement]
 *       addPettyCashMovement(storeId, { direction, amountCents,
 *                                       reason, byName }) -> movement
 *       refundSale(storeId, saleId, { lines, reason, asCreditNote, idemKey,
 *                    customerId, customerName }) -> { refund, creditNote }
 *     },
 *     customer: {
 *       // Per-shop customer identity (migration 073, one login 2026-10-01).
 *       // A confirmed customer account links itself to a shop the first
 *       // time it visits the shop's page; the customers worker builds
 *       // orders on top of the shop_customers table.
 *       linkShopCustomer(slug) -> row                     // idempotent
 *     },
 *   }
 *
 * All functions are async unless noted. All throw real Errors on failure —
 * never fake success.
 */

import { createSupabaseBackend } from './supabase.js';

export const BackendKinds = {
  SUPABASE: 'supabase',
};

function env(name) {
  try {
    return import.meta.env?.[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * The build-time default connection pair { url, anonKey } from the
 * environment, without throwing. Used by the backend directory
 * (./directory.js) as the fallback every lookup lands on when no
 * directory is configured — pass to resolveBackendForSlug().
 */
export function buildDefaultBackendConfig() {
  return { url: env('VITE_SUPABASE_URL'), anonKey: env('VITE_SUPABASE_ANON_KEY') };
}

/**
 * Build the Supabase backend adapter.
 *
 * Throws an honest error when the Supabase env vars are absent — there is
 * no silent local fallback anymore (that split is exactly what confused
 * users between two separate accounts and data stores).
 *
 * The optional second argument is the scale groundwork: an explicit
 * { url, key } pair for a different project than the build-time one
 * (see ./directory.js). No caller passes it yet, so behavior today is
 * the env pair, unchanged.
 */
export function createBackend(kind, config = null) {
  if (kind === BackendKinds.SUPABASE) {
    if (config) {
      if (!config.url || !config.key) {
        throw new Error(
          'Supabase is not configured (explicit backend settings are incomplete). ' +
          'Drift Shop needs its cloud backend to sign in.'
        );
      }
      return createSupabaseBackend({ url: config.url, key: config.key });
    }
    const url = env('VITE_SUPABASE_URL');
    const key = env('VITE_SUPABASE_ANON_KEY');
    if (!url || !key) {
      throw new Error(
        'Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing). ' +
        'Vendra needs its cloud backend to sign in.'
      );
    }
    return createSupabaseBackend();
  }
  throw new Error(`Unknown backend kind "${kind}" — Vendra only supports Supabase.`);
}
