-- 063_storefront.sql
--
-- Public storefront (Comelin-style): every shop gets a public web page —
-- display name, tagline, about, opening hours, contact, product list —
-- reading the SAME cloud database the POS sells from, so what a customer
-- sees is always in sync with the shop's live catalogue.
--
-- What this adds:
-- - storefront_profiles: one row per shop (store_id unique), edited from
--   Admin -> Storefront by the shop's owners/managers (pos_role, the
--   migration 002 write pattern) and by the master account. RLS is on and
--   there is deliberately NO anon policy: anonymous visitors never touch
--   this table (or pos_products) directly.
-- - pos_products.public_visible: the POS sells from pos_products
--   (backend.pos.listProducts / saveProduct), so storefront visibility
--   lives on that table. It defaults to TRUE on purpose: a product
--   created in the POS flows to the shop's published storefront with no
--   extra step; the admin editor only hides individual items.
-- - public_storefront(p_slug): SECURITY DEFINER RPC, the ONLY anonymous
--   door. Granted to anon, it returns the shop display fields plus the
--   visible (public_visible + active) products — and ONLY for a
--   storefront whose published flag is on. Unknown or unpublished slugs
--   return NULL, so a draft storefront exposes nothing at all.
-- - factory_reset(): storefront_profiles joins the wipe list — the
--   function below is migration 062's body carried verbatim with that one
--   table added (CREATE OR REPLACE, grants unchanged).
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS.
-- Like 057-062 this ships as a file; it is applied deliberately, not
-- auto-run.

-- ---------- master helper (056 added profiles.is_master; no SQL helper yet) ----------
create or replace function public.is_master()
returns boolean
language sql security definer stable as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and is_master = true
  );
$$;

-- ---------- storefront profiles ----------
create table if not exists public.storefront_profiles (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null unique references public.pos_stores(id) on delete cascade,
  slug          text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  display_name  text,
  tagline       text,
  about         text,
  hours         text,
  contact_email text,
  contact_phone text,
  accent_color  text,
  published     boolean not null default false,
  show_prices   boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.storefront_profiles enable row level security;

drop trigger if exists storefront_profiles_touch on public.storefront_profiles;
create trigger storefront_profiles_touch
  before update on public.storefront_profiles
  for each row execute function public.touch_updated_at();

-- ---------- RLS: storefront_profiles ----------
-- Members can read their shop's row (the editor needs it; cashiers seeing
-- the draft is harmless — the PUBLIC only ever sees published data, via
-- the RPC below). Writes follow the migration 002 owner/manager pattern,
-- plus the master account. NO anon policy, on purpose.
drop policy if exists "storefront_member_select" on public.storefront_profiles;
create policy "storefront_member_select"
  on public.storefront_profiles for select
  using (public.is_pos_member(store_id) or public.is_master());

drop policy if exists "storefront_manager_insert" on public.storefront_profiles;
create policy "storefront_manager_insert"
  on public.storefront_profiles for insert
  with check (public.pos_role(store_id) in ('owner', 'manager') or public.is_master());

drop policy if exists "storefront_manager_update" on public.storefront_profiles;
create policy "storefront_manager_update"
  on public.storefront_profiles for update
  using (public.pos_role(store_id) in ('owner', 'manager') or public.is_master())
  with check (public.pos_role(store_id) in ('owner', 'manager') or public.is_master());

drop policy if exists "storefront_owner_delete" on public.storefront_profiles;
create policy "storefront_owner_delete"
  on public.storefront_profiles for delete
  using (public.pos_role(store_id) = 'owner' or public.is_master());

-- ---------- product visibility ----------
-- POS products flow to the storefront by default (see header).
alter table public.pos_products
  add column if not exists public_visible boolean not null default true;

-- ---------- public storefront RPC (the only anonymous door) ----------
create or replace function public.public_storefront(p_slug text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_row      public.storefront_profiles%rowtype;
  v_products jsonb;
begin
  select * into v_row
  from public.storefront_profiles
  where slug = lower(btrim(coalesce(p_slug, '')))
    and published = true;
  if not found then
    return null;
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object('name', p.name, 'price', p.price_cents)
             order by p.name
           ),
           '[]'::jsonb
         )
    into v_products
  from public.pos_products p
  where p.store_id = v_row.store_id
    and p.public_visible = true
    and p.active = true;

  return jsonb_build_object(
    'shop', jsonb_build_object(
      'display_name', v_row.display_name,
      'tagline', v_row.tagline,
      'about', v_row.about,
      'hours', v_row.hours,
      'contact_email', v_row.contact_email,
      'contact_phone', v_row.contact_phone,
      'accent_color', v_row.accent_color,
      'show_prices', v_row.show_prices
    ),
    'products', v_products
  );
end $$;

revoke all on function public.public_storefront(text) from public;
grant execute on function public.public_storefront(text) to anon, authenticated;

-- ---------- factory reset: storefront_profiles joins the wipe ----------
-- CREATE OR REPLACE carried verbatim from migration 062 with ONE change:
-- public.storefront_profiles added to the TRUNCATE list below.
create or replace function public.factory_reset()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  c_master_email constant text := 'admin@drift-shop.app';
  c_default_pw   constant text := 'admin123';
  v_id           uuid := gen_random_uuid();
  v_instance_id  uuid;
  v_rows         int;
begin
  -- Gate 1: the caller must be the master account. Checked FIRST, before
  -- touching any data.
  if not exists (select 1 from public.profiles where id = auth.uid() and is_master = true) then
    raise exception 'factory reset is restricted to the master account';
  end if;

  -- ---- wipe: application data ----
  -- Single transaction from here on: any failure rolls back everything.
  -- storage.objects is guarded by the statement-level BEFORE DELETE trigger
  -- storage.protect_delete(), which rejects direct SQL deletes unless the
  -- GUC storage.allow_delete_query = 'true' (the Storage API sets this GUC
  -- when deleting through the API — this is its sanctioned escape hatch).
  -- A typed-RESET factory reset is deliberate, master-confirmed data loss,
  -- so opt in transaction-locally: SET LOCAL auto-reverts with the
  -- transaction, and any wipe failure rolls back the data AND the GUC.
  perform set_config('storage.allow_delete_query', 'true', true);
  -- WHERE true: Supabase preloads the safeupdate extension for the API
  -- roles, which rejects unqualified DELETEs ("DELETE requires a WHERE
  -- clause") even inside SECURITY DEFINER functions. This is "every row",
  -- stated explicitly.
  delete from storage.objects where true;

  -- TRUNCATE list covers ALL 42 public tables (verified against pg_tables).
  -- profiles: must be listed because its device_store_id FK references
  -- pos_stores — Postgres blocks truncating a table referenced by ANY foreign
  -- key unless the referencing table is truncated in the same command, even
  -- when the referencing table is empty. profiles is re-seeded below by the
  -- auth.users insert via the handle_new_user trigger. The only FK
  -- referencing profiles is its own self-reference
  -- (profiles_created_by_fkey), which TRUNCATE tolerates in a single command.
  truncate table
    public.bq_donation_items, public.bq_donations, public.bq_fair_sales,
    public.bq_fairs, public.bq_items, public.bq_special_orders,
    public.feedback, public.game_highscores, public.helm_messages,
    public.helm_threads, public.notifications, public.pins,
    public.pos_appointments, public.pos_breaks, public.pos_community_hours,
    public.pos_customers, public.pos_drawer_shifts, public.pos_gift_card_events,
    public.pos_gift_cards, public.pos_invites, public.pos_orgs,
    public.pos_pay_periods, public.pos_pin_attempts, public.pos_products,
    public.pos_punch_audits, public.pos_punch_settings, public.pos_refunds,
    public.pos_sales, public.pos_shifts, public.pos_staff,
    public.pos_store_members, public.pos_stores, public.pos_time_off,
    public.pos_time_punches, public.profiles, public.spaces,
    public.storefront_profiles, public.support_tickets,
    public.user_settings, public.vfs_files, public.vfs_folders,
    public.window_states;

  -- Cascades to auth.identities and public.profiles (both ON DELETE CASCADE).
  -- Application tables above are already empty, so their user_id FKs cannot
  -- block this regardless of their ON DELETE action.
  -- WHERE true: see the safeupdate note above — unqualified DELETEs are
  -- rejected for the API roles even inside SECURITY DEFINER functions.
  delete from auth.users where true;

  -- ---- reseed: the master account, exactly as migration 056 seeds it ----
  -- instance_id identifies the GoTrue instance. GoTrue's password grant
  -- filters users with "instance_id = uuid.Nil" (see supabase/auth
  -- internal/models/user.go: FindUserByEmailAndAudience), so the reseeded
  -- user MUST carry the nil UUID 00000000-0000-0000-0000-000000000000.
  -- auth.instances is normally EMPTY on Supabase (even on healthy
  -- projects), so it cannot be used to discover the value — reading it
  -- here would reseed with NULL and break master sign-in after reset.
  v_instance_id := '00000000-0000-0000-0000-000000000000'::uuid;

  -- The on_auth_user_created -> handle_new_user() trigger builds the
  -- profile (username 'admin', role 'admin' while profiles is empty) plus
  -- the factory-fresh user_settings, vfs_folders and spaces rows — the
  -- same canonical path as a normal signup (see 020).
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token,
                          email_change_token_current, email_change_token_new, email_change,
                          phone_change_token, phone_change, reauthentication_token)
  values (v_instance_id, v_id, 'authenticated', 'authenticated', c_master_email,
          extensions.crypt(c_default_pw, extensions.gen_salt('bf')),
          now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('username', 'admin', 'is_guest', false),
          now(), now(),
          '', '',
          '', '', '',
          '', '', '');

  -- NOTE: auth.identities.email is GENERATED ALWAYS as
  -- lower(identity_data->>'email') — it must NOT appear in the INSERT
  -- column list.
  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id,
          jsonb_build_object('sub', v_id::text, 'email', c_master_email),
          'email', v_id::text,
          now(), now(), now());

  -- Stamp the master flags. The caller's profile row was deleted above
  -- (delete from auth.users cascades to public.profiles), so auth.uid() no
  -- longer resolves to any profile row and public.is_admin() is FALSE for
  -- the rest of this transaction — an earlier comment claiming is_admin()
  -- stays true here was wrong. Without the DISABLE below,
  -- protect_profile_fields() raises on the guarded columns and rolls back
  -- the ENTIRE reset (the B2 blocker). The triggers are disabled only for
  -- this UPDATE and re-enabled immediately after; ALTER ... DISABLE
  -- TRIGGER is transactional DDL, so any failure rolls the triggers back
  -- to enabled along with everything else. handle_new_user() already set
  -- role 'admin' (profiles was empty, so is_first was true), so the role
  -- stamp is a no-op and profiles_guard_role is disabled only for
  -- determinism.
  alter table public.profiles disable trigger protect_profile_fields;
  alter table public.profiles disable trigger profiles_guard_role;
  update public.profiles
     set role = 'admin',
         is_paid = true,
         is_locked = false,
         disabled_until = null,
         must_change_password = true,
         is_master = true
   where id = v_id;
  get diagnostics v_rows = row_count;
  alter table public.profiles enable trigger protect_profile_fields;
  alter table public.profiles enable trigger profiles_guard_role;
  if v_rows <> 1 then
    raise exception 'factory reset reseed failed: master profile row missing (handle_new_user did not run?)';
  end if;
  -- is_master must survive re-seeding — verify, never assume.
  if not exists (select 1 from public.profiles where id = v_id and is_master = true) then
    raise exception 'factory reset reseed failed: is_master flag not set';
  end if;
end;
$$;

revoke all on function public.factory_reset() from public, anon;
grant execute on function public.factory_reset() to authenticated;
