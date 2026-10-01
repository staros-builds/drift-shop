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
