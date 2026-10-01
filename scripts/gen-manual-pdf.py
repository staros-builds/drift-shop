#!/usr/bin/env python3
"""Generate public/manual/drift-shop-manual.pdf — a short generic
getting-started guide for the Drift Shop build (EN + FR, no branding
beyond the product name from src/lib/brand.js).

Usage: python3 scripts/gen-manual-pdf.py
Then: node scripts/gen-manual-index.mjs   (regenerates manual-index.json)
"""
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.enums import TA_CENTER
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'manual', 'drift-shop-manual.pdf')

styles = getSampleStyleSheet()
title = ParagraphStyle('Title2', parent=styles['Title'], fontSize=26, spaceAfter=6)
h1 = ParagraphStyle('H1', parent=styles['Heading1'], fontSize=16, spaceBefore=14, spaceAfter=6)
h2 = ParagraphStyle('H2', parent=styles['Heading2'], fontSize=13, spaceBefore=10, spaceAfter=4)
body = ParagraphStyle('Body2', parent=styles['BodyText'], fontSize=10.5, leading=14.5, spaceAfter=5)
bul = ParagraphStyle('Bul', parent=body, leftIndent=18, bulletIndent=8, spaceAfter=3)
center = ParagraphStyle('Center', parent=body, alignment=TA_CENTER)
foot = ParagraphStyle('Foot', parent=body, fontSize=9, textColor='#666666', alignment=TA_CENTER)

PRODUCT = 'Drift Shop'

def P(text, style=body):
    return Paragraph(text, style)

def B(text):
    return Paragraph(text, bul, bulletText='\u2022')

story = []
# Cover
story += [Spacer(1, 2.2 * inch), P(PRODUCT, title),
          P('Getting started  \u00b7  Mise en route', center),
          Spacer(1, 0.3 * inch),
          P('Point of sale, catalogue, team and files \u2014 in one calm app.<br/>'
            'Caisse, catalogue, \u00e9quipe et fichiers \u2014 dans une seule appli.', center),
          Spacer(1, 0.5 * inch),
          P('Short guide \u00b7 Guide abr\u00e9g\u00e9 \u2014 October 2026', foot),
          PageBreak()]

def section(en_title, fr_title, blocks):
    story.append(P(f'{en_title} / {fr_title}', h1))
    for kind, text in blocks:
        if kind == 'h2':
            story.append(P(text, h2))
        elif kind == 'b':
            story.append(B(text))
        else:
            story.append(P(text))

section('First-run setup', 'Premi\u00e8re installation', [
    ('p', f'This page is for the person installing <b>{PRODUCT}</b> on their own backend. The app is cloud-only: '
          'it needs a Supabase project before anyone can sign in.'),
    ('h2', '1. Create the database / 1. Cr\u00e9er la base de donn\u00e9es'),
    ('b', 'Create a free project at supabase.com \u2014 Dashboard \u2014 New project.'),
    ('b', 'Open the SQL editor and run every file in supabase/migrations/ in order, from 001 to 057. '
          'Migration 056 (056_master_admin.sql) creates the built-in master admin account; '
          '057 adds the master-only factory reset.'),
    ('b', 'Cr\u00e9ez un projet gratuit sur supabase.com, puis ex\u00e9cutez dans l\u2019\u00e9diteur SQL '
          'chaque fichier de supabase/migrations/ dans l\u2019ordre, de 001 \u00e0 057. '
          'La migration 056 cr\u00e9e le compte administrateur int\u00e9gr\u00e9; la 057 ajoute la r\u00e9initialisation.'),
    ('h2', '2. Connect and build / 2. Connecter et compiler'),
    ('b', 'Copy your project\u2019s URL and anon key (Project Settings \u2014 API) into a .env file '
          'as VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example).'),
    ('b', 'Run: npm install, then npm run build. Deploy the dist/ folder to any static host.'),
    ('b', 'Copiez l\u2019URL du projet et la cl\u00e9 anon (R\u00e9glages du projet \u2014 API) dans un fichier .env '
          '(VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY, voir .env.example), puis : npm install, npm run build. '
          'D\u00e9ployez le dossier dist/ sur n\u2019importe quel h\u00e9bergeur statique.'),
    ('h2', '3. First sign-in \u2014 the master account / 3. Premi\u00e8re connexion \u2014 le compte ma\u00eetre'),
    ('b', 'Sign in with username \u201cadmin\u201d and password \u201cadmin123\u201d. '
          'On first sign-in the app REQUIRES you to choose a new password before the desktop opens \u2014 '
          'the default password is temporary. Change it immediately and pick something strong '
          '(at least 8 characters, not a common or repeating password).'),
    ('b', 'Connectez-vous avec le nom d\u2019utilisateur \u00ab admin \u00bb et le mot de passe \u00ab admin123 \u00bb. '
          '\u00c0 la premi\u00e8re connexion, l\u2019appli EXIGE un nouveau mot de passe avant d\u2019ouvrir le bureau \u2014 '
          'le mot de passe par d\u00e9faut est temporaire. Changez-le aussit\u00f4t (8 caract\u00e8res minimum, '
          '\u00e9vitez les mots de passe courants ou r\u00e9p\u00e9titifs).'),
    ('b', 'Rebranding note: the master email must match BRAND.accountsDomain in src/lib/brand.js. '
          'If you change the domain, update the email in migration 056 before running it '
          '(bare usernames are mapped to <username>@<domain> at sign-in).'),
    ('b', 'Note : le courriel du compte ma\u00eetre doit correspondre \u00e0 BRAND.accountsDomain dans src/lib/brand.js. '
          'Si vous changez de domaine, mettez \u00e0 jour le courriel dans la migration 056 avant de l\u2019ex\u00e9cuter.'),
    ('h2', 'Factory reset / R\u00e9initialisation'),
    ('b', 'The master account has a Factory reset action (Admin panel \u2014 Danger zone, master account only). '
          'It permanently deletes EVERY account and ALL data \u2014 sales, catalogue, appointments, files, team, everything \u2014 '
          'then restores the build to its factory state with only the master account. '
          'The button arms only after typing RESET; the wipe runs in a single database transaction, so any failure rolls everything back instead of leaving a half-wiped database.'),
    ('b', 'No automatic backup is taken: download account backups from Settings \u2014 Backup BEFORE resetting \u2014 '
          'only what you saved beforehand survives. After the reset you are signed out; sign back in with the master account (you will be asked to choose a new password again).'),
    ('b', 'Le compte ma\u00eetre dispose d\u2019une action de r\u00e9initialisation (panneau Admin \u2014 Zone danger, compte ma\u00eetre uniquement). '
          'Elle supprime D\u00c9FINITIVEMENT tous les comptes et TOUTES les donn\u00e9es, puis ram\u00e8ne l\u2019appli \u00e0 son \u00e9tat d\u2019usine '
          'avec uniquement le compte ma\u00eetre. Le bouton s\u2019arme en tapant RESET; l\u2019effacement s\u2019ex\u00e9cute en une seule transaction '
          '(en cas d\u2019\u00e9chec, tout est annul\u00e9). Aucune sauvegarde automatique : t\u00e9l\u00e9chargez vos sauvegardes depuis R\u00e9glages \u2014 Sauvegarde AVANT. '
          'Vous serez d\u00e9connect\u00e9; reconnectez-vous avec le compte ma\u00eetre (nouveau mot de passe requis \u00e0 nouveau).'),
])

section('Welcome', 'Bienvenue', [
    ('p', f'<b>{PRODUCT}</b> is a small-business hub that runs in your browser: a point of sale, '
          'a product catalogue with ISBN/barcode lookup, appointments, files, a staff time clock '
          'with printable certificates, and team management \u2014 all in one calm desktop.'),
    ('p', f'<b>{PRODUCT}</b> est un outil de gestion pour petit commerce qui fonctionne dans votre '
          'navigateur : caisse, catalogue avec recherche ISBN/code-barres, rendez-vous, fichiers, '
          'pointeuse du personnel avec attestations imprimables, et gestion d\u2019\u00e9quipe.'),
    ('h2', 'Sign in / Connexion'),
    ('b', 'One account works on every device: sign in with your username or email and password.'),
    ('b', 'Usernames are allowed: they are mapped to a private login address automatically \u2014 you only ever type your username.'),
    ('b', 'New here? Create an account once; your files, notes and settings follow you. A guest/trial mode may be offered on the login screen.'),
    ('b', 'Un seul compte pour tous vos appareils : connectez-vous avec votre nom d\u2019utilisateur ou courriel et votre mot de passe.'),
    ('b', 'Nouveau? Cr\u00e9ez un compte une seule fois; vos fichiers, notes et r\u00e9glages vous suivent partout.'),
])

section('Point of Sale', 'Point de vente', [
    ('p', 'The <b>Point of Sale</b> app rings up sales, prints receipts, and tracks products, '
          'customers, discounts, gift cards, loyalty points and promos. Open it from the desktop or the Start menu.'),
    ('p', 'L\u2019appli <b>Point de vente</b> enregistre les ventes, imprime les re\u00e7us et g\u00e8re produits, '
          'clients, rabais, cartes-cadeaux, points de fid\u00e9lit\u00e9 et promotions.'),
    ('h2', 'Taxes / Taxes'),
    ('b', 'Taxes are per-store settings \u2014 never hardcoded. Each store defines its own tax rows: a name and a rate (for example \u201cTax 1\u201d at 0%). New stores start with two empty slots at 0%.'),
    ('b', 'Rows marked stacked are each calculated on the pre-tax subtotal; a row can optionally compound on the taxes above it. Ask your accountant which method your jurisdiction requires, then press Save \u2014 rate changes never apply silently.'),
    ('b', 'Les taxes sont des r\u00e9glages par boutique, jamais cod\u00e9es en dur. Chaque boutique d\u00e9finit ses lignes (nom + taux, p. ex. \u00ab Taxe 1 \u00bb \u00e0 0 %). Les lignes cumul\u00e9es se calculent chacune sur le sous-total avant taxes. Validez la m\u00e9thode avec votre comptable, puis Enregistrer.'),
    ('h2', 'Refunds, gift cards, loyalty / Remboursements, cartes-cadeaux, fid\u00e9lit\u00e9'),
    ('b', 'Refunds can be issued with or without a reason; refunded lines are badged in History and a refunded sale cannot be voided.'),
    ('b', 'Gift cards are sold tax-free; tax applies when they are redeemed. Loyalty points and promos are configured per store in POS Settings.'),
    ('b', 'Les remboursements (avec ou sans motif) sont identifi\u00e9s dans l\u2019historique; une vente rembours\u00e9e ne peut pas \u00eatre annul\u00e9e. Les cartes-cadeaux sont vendues sans taxes.'),
])

section('Catalogue', 'Catalogue', [
    ('p', 'The <b>Catalogue</b> app tracks inventory items with optional ISBN/barcode lookup, '
          'quantities, shelf locations and statuses. Items marked \u201cIn store\u201d can be scanned straight into a POS sale.'),
    ('p', 'Le <b>Catalogue</b> g\u00e8re les articles en inventaire avec recherche ISBN/code-barres, '
          'quantit\u00e9s, emplacements et statuts. Les articles \u00ab En magasin \u00bb se scannent directement dans une vente.'),
    ('b', 'Add items one by one, or import many at once from CSV (a template with the expected columns is built in).'),
    ('b', 'Donations, fair days and special orders are tracked as separate flows with their own reports.'),
    ('b', 'Ajoutez des articles un par un ou importez-en plusieurs via CSV. Dons, journ\u00e9es de foire et commandes sp\u00e9ciales sont suivis s\u00e9par\u00e9ment.'),
    ('h2', 'Appointments & Files / Rendez-vous et Fichiers'),
    ('b', 'Appointments books time slots with overlap protection. Files stores documents and media with full-text search.'),
    ('b', 'Rendez-vous r\u00e9serve des plages horaires (les chevauchements sont bloqu\u00e9s). Fichiers stocke documents et m\u00e9dias avec recherche plein texte.'),
])

section('Certificates (time clock)', 'Attestations (pointeuse)', [
    ('p', 'The <b>Certificates</b> app is the staff time clock: employees clock in and out with a personal PIN, '
          'managers build schedules (overlapping shifts for the same person are blocked), correct punches, and approve payroll periods.'),
    ('p', 'L\u2019appli <b>Attestations</b> est la pointeuse : le personnel pointe avec son NIP, '
          'les gestionnaires font l\u2019horaire (les quarts qui se chevauchent sont bloqu\u00e9s), corrigent les pointages et approuvent la paie.'),
    ('b', 'Community-service / volunteer hours are tracked separately from payroll, with printable per-person attestations (daily breakdown, signatures, organization grouping).'),
    ('b', 'Les heures de b\u00e9n\u00e9volat sont suivies s\u00e9par\u00e9ment de la paie, avec attestations imprimables par personne (d\u00e9tail quotidien, signatures, regroupement par organisme).'),
    ('h2', 'Team & organizations / \u00c9quipe et organismes'),
    ('b', 'Invite staff with codes; roles are Owner, Manager, Cashier. Organizations can be flagged tax-exempt so their sales print tax-free.'),
    ('b', 'Invitez le personnel avec des codes; r\u00f4les : propri\u00e9taire, g\u00e9rant, caissier. Les organismes peuvent \u00eatre exon\u00e9r\u00e9s de taxes.'),
])

section('Settings, backup & offline', 'R\u00e9glages, sauvegarde et hors ligne', [
    ('b', 'Settings \u00b7 Appearance: light/dark mode, accent color, wallpaper, interface style, touch mode.'),
    ('b', 'Settings \u00b7 Backup: download a full backup of your account and re-upload it later (for example on a new account).'),
    ('b', 'Settings changes sync across terminals about once a minute; a form with unsaved edits is never overwritten by the sync.'),
    ('b', 'The app works offline once installed: sales made offline are queued and synced when the connection returns. The service worker updates itself \u2014 a toast invites you to refresh when a new version is ready.'),
    ('b', 'R\u00e9glages \u00b7 Apparence : clair/sombre, couleur d\u2019accent, fond d\u2019\u00e9cran, style d\u2019interface, mode tactile.'),
    ('b', 'R\u00e9glages \u00b7 Sauvegarde : t\u00e9l\u00e9chargez une copie compl\u00e8te de votre compte et restaurez-la plus tard.'),
    ('b', 'L\u2019appli fonctionne hors ligne une fois install\u00e9e : les ventes hors ligne sont mises en file et synchronis\u00e9es au retour de la connexion.'),
    ('h2', 'Support / Soutien'),
    ('b', 'Stuck? Open Help & Guide from the Start menu, or send a support ticket from the login screen.'),
    ('b', 'Un probl\u00e8me? Ouvrez Aide & Guide depuis le menu D\u00e9marrer, ou envoyez un billet de soutien depuis l\u2019\u00e9cran de connexion.'),
])

section('What can still go wrong (honest failure modes)', 'Ce qui peut encore mal tourner (modes de défaillance honnêtes)', [
    ('p', 'This product is hardened, not unbreakable. Here is what happens in each failure mode we know about, and what each one costs you.'),
    ('p', 'Ce produit est renforcé, pas incassable. Voici ce qui se passe dans chaque mode de défaillance connu, et ce que chacun vous coûte.'),
    ('h2', 'Internet goes down mid-sale / Panne d\u2019Internet en pleine vente'),
    ('b', '<b>Cash sales keep working.</b> The sale is saved on the device with a unique idempotency key and a loud amber banner counts the queued sales. When the connection returns, they sync automatically in order; the idempotency key means a sale can never be posted twice, even if the network drops mid-sync.'),
    ('b', '<b>Card, gift-card, loyalty and promo sales do NOT queue.</b> Balances and tender instruments must be validated by the server, so these sales fail loudly instead of being captured. Any debited gift-card/loyalty amounts are reversed automatically. The cashier must retry when back online \u2014 the sale is not lost silently, but it is not saved either. <b>Cost: the sale must be re-rung.</b>'),
    ('b', '<b>Never clear the device\u2019s browser data while the amber banner is showing.</b> Queued sales live on that device until they sync. Clearing site data before a sync deletes them permanently.'),
    ('b', '<b>Les ventes comptant continuent de fonctionner.</b> La vente est enregistrée sur l\u2019appareil avec une clé d\u2019idempotence unique, et un bandeau ambre bien visible compte les ventes en attente. Au retour de la connexion, elles se synchronisent automatiquement dans l\u2019ordre; la clé d\u2019idempotence garantit qu\u2019une vente ne peut jamais être comptabilisée deux fois, même si le réseau coupe en pleine synchronisation.'),
    ('b', '<b>Les ventes par carte, carte-cadeau, points de fidélité et codes promo ne sont PAS mises en file.</b> Les soldes doivent être validés par le serveur : ces ventes échouent bruyamment au lieu d\u2019être capturées. Les montants débités sont automatiquement reversés. Le caissier doit recommencer la vente une fois reconnecté \u2014 elle n\u2019est pas perdue silencieusement, mais elle n\u2019est pas sauvegardée non plus. <b>Coût : la vente doit être refaite.</b>'),
    ('b', '<b>N\u2019effacez jamais les données du navigateur tant que le bandeau ambre est affiché.</b> Les ventes en attente vivent sur cet appareil jusqu\u2019à leur synchronisation. Effacer les données du site avant la synchro les supprime définitivement.'),
    ('h2', 'The backend is unreachable at startup / Serveur injoignable au démarrage'),
    ('b', 'The app checks the connection before loading. If it fails you get a clear screen with Retry and \u201cContinue offline\u201d \u2014 the shop can still sell for cash offline. If the server answers but a required database table is missing, the screen says so explicitly: the backend is misconfigured or points at the wrong project.'),
    ('b', 'L\u2019appli vérifie la connexion avant de charger. En cas d\u2019échec, un écran clair propose Réessayer et \u00ab Continuer hors ligne \u00bb \u2014 la boutique peut toujours vendre comptant hors ligne. Si le serveur répond mais qu\u2019une table requise est manquante, l\u2019écran le dit explicitement : le serveur est mal configuré ou pointe vers le mauvais projet.'),
    ('h2', 'One part of the app crashes / Une partie de l\u2019appli plante'),
    ('b', 'Each region (app window, login screen, kiosk, POS overlay) is isolated. A crash shows that region\u2019s own error card with a Retry button and a support reference (e.g. <font face="Courier">RS-9K2Q1-4F2A</font>) \u2014 quote it when reporting the problem. The rest of the app keeps running. If the app crashes 3 times in a row on boot, it SCRAMs into Safe Mode with diagnostics and recovery options instead of crash-looping.'),
    ('b', 'Chaque zone (fenêtre d\u2019appli, écran de connexion, kiosque, POS overlay) est isolée. Un plantage affiche la carte d\u2019erreur de cette zone avec un bouton Réessayer et une référence d\u2019assistance (p. ex. <font face="Courier">RS-9K2Q1-4F2A</font>) \u2014 citez-la en signalant le problème. Le reste de l\u2019appli continue de fonctionner. Si l\u2019appli plante 3 fois de suite au démarrage, elle bascule en mode sans échec avec diagnostics et options de récupération au lieu de planter en boucle.'),
    ('h2', 'Destructive actions / Actions destructives'),
    ('b', 'Voiding a gift card or deleting a time punch triggers an automatic device-local snapshot first (last 3 kept). This is a safety net, not a backup strategy \u2014 keep downloading the manual \u201cDownload account backup\u201d from Settings regularly. Factory reset (master account only) wipes all accounts and data after typed confirmation; it is irreversible, and the pre-reset snapshot is your only way back.'),
    ('b', 'Annuler une carte-cadeau ou supprimer un pointage déclenche d\u2019abord une capture automatique locale (les 3 dernières sont conservées). C\u2019est un filet de sécurité, pas une stratégie de sauvegarde \u2014 continuez de télécharger régulièrement la sauvegarde manuelle (\u00ab Télécharger la sauvegarde \u00bb dans Réglages). La réinitialisation d\u2019usine (compte maître uniquement) efface tous les comptes et toutes les données après confirmation tapée; elle est irréversible, et la capture pré-réinitialisation est votre seul retour en arrière.'),
    ('h2', 'What is NOT protected / Ce qui n\u2019est PAS protégé'),
    ('b', 'A crash or power loss <i>between</i> recording a sale and awarding loyalty points can leave points unawarded (the sale itself is safe; points are best-effort).'),
    ('b', 'The offline queue holds at most 100 sales; beyond that, new offline sales are refused loudly rather than queued.'),
    ('b', 'Auto-backup snapshots live on the same device. If the device itself is lost or wiped, they are gone \u2014 the manual backup file is the off-device copy.'),
    ('b', 'Un plantage ou une coupure de courant <i>entre</i> l\u2019enregistrement d\u2019une vente et l\u2019attribution des points de fidélité peut laisser des points non attribués (la vente elle-même est en sécurité; les points sont au mieux).'),
    ('b', 'La file hors ligne contient au maximum 100 ventes; au-delà, les nouvelles ventes hors ligne sont refusées bruyamment plutôt que mises en file.'),
    ('b', 'Les captures automatiques vivent sur le même appareil. Si l\u2019appareil est perdu ou effacé, elles disparaissent \u2014 le fichier de sauvegarde manuelle est la copie hors appareil.'),
])

story.append(Spacer(1, 0.4 * inch))
story.append(P(f'{PRODUCT} \u2014 getting-started guide. The on-screen text is the final authority.<br/>'
               f'{PRODUCT} \u2014 guide de d\u00e9marrage. Le texte \u00e0 l\u2019\u00e9cran fait foi.', foot))

doc = SimpleDocTemplate(OUT, pagesize=LETTER,
                        leftMargin=0.9 * inch, rightMargin=0.9 * inch,
                        topMargin=0.8 * inch, bottomMargin=0.8 * inch,
                        title=f'{PRODUCT} \u2014 Getting started',
                        author=PRODUCT)
doc.build(story)
print('wrote', OUT)
