#!/usr/bin/env python3
"""Generate public/manual/vendra-manual.pdf — a beginner-proof,
hand-holding guide for the Vendra build (EN + FR today; ES + PT-BR are
scaffolded with TODO placeholders at the end of this file and are filled in
by hand at the final pass — never machine-translate them).

Written for a reader who has never used a system like this: every term is
defined the first time it appears, every task is tiny numbered steps with
"You should now see…" checkpoints and an "If something goes wrong" box.

Screenshots: each walkthrough step can carry an image from
public/manual/shots/<name>.png. While the file does not exist (the real
shots are captured from the FINAL shipped UI), a clearly marked
placeholder box is rendered instead. See ~/workspace/build3/manual-shot-list.md
for the shot list.

Usage: python3 scripts/gen-manual-pdf.py
Then: node scripts/gen-manual-index.mjs   (regenerates manual-index.json)
"""
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_CENTER
from reportlab.lib import colors
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, PageBreak,
                                Table, TableStyle, Image)
from reportlab.lib.utils import ImageReader
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'manual', 'vendra-manual.pdf')
SHOTS = os.path.join(ROOT, 'public', 'manual', 'shots')

styles = getSampleStyleSheet()
title = ParagraphStyle('Title2', parent=styles['Title'], fontSize=26, spaceAfter=6)
h1 = ParagraphStyle('H1', parent=styles['Heading1'], fontSize=16, spaceBefore=14, spaceAfter=6)
h2 = ParagraphStyle('H2', parent=styles['Heading2'], fontSize=13, spaceBefore=10, spaceAfter=4)
body = ParagraphStyle('Body2', parent=styles['BodyText'], fontSize=10.5, leading=14.5, spaceAfter=5)
bul = ParagraphStyle('Bul', parent=body, leftIndent=18, bulletIndent=8, spaceAfter=3)
stepstyle = ParagraphStyle('Step', parent=body, leftIndent=22, firstLineIndent=-22, spaceAfter=4)
seestyle = ParagraphStyle('See', parent=body, leftIndent=22, textColor='#1a5c1a', spaceAfter=6)
termstyle = ParagraphStyle('Term', parent=body, leftIndent=18, spaceAfter=4)
center = ParagraphStyle('Center', parent=body, alignment=TA_CENTER)
foot = ParagraphStyle('Foot', parent=body, fontSize=9, textColor='#666666', alignment=TA_CENTER)
shotcap = ParagraphStyle('ShotCap', parent=body, fontSize=9.5, textColor='#7a4d00', alignment=TA_CENTER)

PRODUCT = 'Vendra'
PAGE_W = 6.7 * inch  # usable text width

def P(text, style=body):
    return Paragraph(text, style)

def B(text):
    return Paragraph(text, bul, bulletText='\u2022')

def STEP(n, text):
    return Paragraph(f'<b>Step {n}.</b> {text}', stepstyle)

def FR_STEP(n, text):
    return Paragraph(f'<b>\u00c9tape {n}.</b> {text}', stepstyle)

def SEE(text):
    return Paragraph(f'You should now see: {text}', seestyle)

def FR_SEE(text):
    return Paragraph(f'Vous devriez maintenant voir : {text}', seestyle)

# ES / PT-BR chrome for the scaffold sections at the end of this file.
# These four fixed labels ('Paso', 'Passo', 'Ahora debería ver:', 'Agora
# você deve ver:') are the ONLY non-placeholder ES/PT words in the manual;
# every content string in the scaffold stays a TODO placeholder until the
# human translation pass.
def ES_STEP(n, text):
    return Paragraph(f'<b>Paso {n}.</b> {text}', stepstyle)

def PT_STEP(n, text):
    return Paragraph(f'<b>Passo {n}.</b> {text}', stepstyle)

def ES_SEE(text):
    return Paragraph(f'Ahora debería ver: {text}', seestyle)

def PT_SEE(text):
    return Paragraph(f'Agora você deve ver: {text}', seestyle)

def TERM(en_word, en_def, fr_word, fr_def):
    return Paragraph(f'<b>{en_word}</b> \u2014 {en_def} <b>{fr_word}</b> \u2014 {fr_def}', termstyle)

def SHOT(fname, desc_en, desc_fr):
    """Image if public/manual/shots/<fname> exists, else a marked box."""
    path = os.path.join(SHOTS, fname)
    if os.path.exists(path):
        iw, ih = ImageReader(path).getSize()
        w = min(PAGE_W, float(iw))
        h = w * float(ih) / float(iw)
        if h > 4.4 * inch:
            h = 4.4 * inch
            w = h * float(iw) / float(ih)
        return [Image(path, width=w, height=h),
                P(f'{desc_en} / {desc_fr}', shotcap), Spacer(1, 6)]
    cell = Paragraph(f'\U0001F4F7 <b>Screenshot \u2014 {desc_en}</b><br/>'
                     f'<b>Capture d\u2019\u00e9cran \u2014 {desc_fr}</b><br/>'
                     f'<font size="8" color="#999999">({fname} \u2014 added when the final app is ready / '
                     f'ajout\u00e9e quand l\u2019appli finale est pr\u00eate)</font>', shotcap)
    t = Table([[cell]], colWidths=[PAGE_W])
    t.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 1, colors.HexColor('#d97706')),
        ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#fffbeb')),
        ('TOPPADDING', (0, 0), (-1, -1), 12),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 12),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
    ]))
    return [t, Spacer(1, 8)]

def TROUBLE(en_lines, fr_lines):
    """Shaded 'If something goes wrong' box (EN lines, then FR lines)."""
    inner = [Paragraph('<b>If something goes wrong</b>', body)]
    inner += [Paragraph(x, body) for x in en_lines]
    inner.append(Paragraph('<b>Si quelque chose ne va pas</b>', body))
    inner += [Paragraph(x, body) for x in fr_lines]
    t = Table([[inner]], colWidths=[PAGE_W])
    t.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.75, colors.HexColor('#9ca3af')),
        ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#f3f4f6')),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
    ]))
    return [Spacer(1, 2), t, Spacer(1, 8)]

story = []
# ---------------------------------------------------------------- cover
story += [Spacer(1, 2.2 * inch), P(PRODUCT, title),
          P('Getting started  \u00b7  Mise en route', center),
          Spacer(1, 0.3 * inch),
          P('Point of sale, catalogue, team and files \u2014 in one calm app.<br/>'
            'Caisse, catalogue, \u00e9quipe et fichiers \u2014 dans une seule appli.', center),
          Spacer(1, 0.4 * inch),
          P('A step-by-step guide for complete beginners. No experience needed.<br/>'
            'Un guide \u00e9tape par \u00e9tape pour les vrais d\u00e9butants. Aucune exp\u00e9rience requise.', center),
          Spacer(1, 0.5 * inch),
          P('Guide \u2014 October 2026', foot),
          PageBreak()]

def _emit(blocks):
    """Render one section's blocks; EN/FR/ES/PT tag sets share this loop."""
    for b in blocks:
        if isinstance(b, list) and b and str(b[0]).startswith('shot:'):
            story.extend(SHOT(str(b[0])[5:], b[1], b[2]))
        elif isinstance(b, list):
            story.extend(b)
        elif b[0] == 'h2':
            story.append(P(b[1], h2))
        elif b[0] == 'b':
            story.append(B(b[1]))
        elif b[0] == 'step':
            story.append(STEP(b[1], b[2]))
        elif b[0] == 'frstep':
            story.append(FR_STEP(b[1], b[2]))
        elif b[0] == 'esstep':
            story.append(ES_STEP(b[1], b[2]))
        elif b[0] == 'ptstep':
            story.append(PT_STEP(b[1], b[2]))
        elif b[0] == 'see':
            story.append(SEE(b[1]))
        elif b[0] == 'frsee':
            story.append(FR_SEE(b[1]))
        elif b[0] == 'essee':
            story.append(ES_SEE(b[1]))
        elif b[0] == 'ptsee':
            story.append(PT_SEE(b[1]))
        elif b[0] == 'term':
            story.append(TERM(b[1], b[2], b[3], b[4]))
        else:
            story.append(P(b[1]))

def section(en_title, fr_title, blocks):
    story.append(P(f'{en_title} / {fr_title}', h1))
    _emit(blocks)

def section_es(en_title, blocks):
    story.append(P(f'TODO[ES] {en_title}', h1))
    _emit(blocks)

def section_pt(en_title, blocks):
    story.append(P(f'TODO[PT] {en_title}', h1))
    _emit(blocks)

# ------------------------------------------------- chapter 1: start here
section('Start here \u2014 read this first', 'Commencez ici \u2014 lisez ceci d\u2019abord', [
    ('p', f'Welcome! This guide shows you how to use <b>{PRODUCT}</b>, one small step at a time. '
          'You do not need to know anything about computers. Just follow the steps in order, '
          'and look at the pictures.'),
    ('p', f'Bienvenue! Ce guide vous montre comment utiliser <b>{PRODUCT}</b>, un petit pas \u00e0 la fois. '
          'Vous n\u2019avez pas besoin de conna\u00eetre les ordinateurs. Suivez les \u00e9tapes dans l\u2019ordre, '
          'et regardez les images.'),
    ('h2', 'What you need / Ce qu\u2019il vous faut'),
    ('b', 'A phone, a tablet, or a computer. Any of them works.'),
    ('b', 'An internet connection. The shop lives on the internet, so your device must be connected.'),
    ('b', 'The shop\u2019s web address (the link you were given when the shop was set up). '
          'Keep it somewhere safe \u2014 you will type it or tap it every time you open the shop.'),
    ('b', 'Un t\u00e9l\u00e9phone, une tablette ou un ordinateur. N\u2019importe lequel convient.'),
    ('b', 'Une connexion Internet. La boutique vit sur Internet, donc votre appareil doit \u00eatre connect\u00e9.'),
    ('b', 'L\u2019adresse Web de la boutique (le lien qu\u2019on vous a donn\u00e9 \u00e0 l\u2019installation). '
          'Gardez-la en lieu s\u00fbr \u2014 vous la taperez ou la toucherez chaque fois que vous ouvrez la boutique.'),
    ('h2', 'Words we use in this guide / Les mots utilis\u00e9s dans ce guide'),
    ('p', 'Every new word is explained here, in plain language. If a word further down is new to you, come back to this list.'),
    ('p', 'Chaque nouveau mot est expliqu\u00e9 ici, en langage simple. Si un mot plus loin est nouveau pour vous, revenez \u00e0 cette liste.'),
    ('term', 'Internet', 'the worldwide network that connects devices; it is how your shop talks to its saved information.',
     'Internet', 'le r\u00e9seau mondial qui relie les appareils; c\u2019est comme \u00e7a que votre boutique parle \u00e0 ses informations enregistr\u00e9es.'),
    ('term', 'Wi-Fi', 'the wireless way your device connects to the internet at home or at work \u2014 it is the signal with the fan-shaped icon.',
     'Wi-Fi', 'la fa\u00e7on sans fil de brancher votre appareil \u00e0 Internet \u00e0 la maison ou au travail \u2014 c\u2019est le signal avec l\u2019ic\u00f4ne en forme d\u2019\u00e9ventail.'),
    ('term', 'Browser', 'the app you use to visit pages on the internet (it is called Chrome, Safari, Edge or Firefox on most devices).',
     'Navigateur', 'l\u2019appli qui sert \u00e0 visiter des pages sur Internet (elle s\u2019appelle Chrome, Safari, Edge ou Firefox sur la plupart des appareils).'),
    ('term', 'Web address (a \u201clink\u201d)', 'the shop\u2019s address on the internet, like an address for a house. Typing it or tapping it takes you to the shop.',
     'Adresse Web (un \u00ab lien \u00bb)', 'l\u2019adresse de la boutique sur Internet, comme l\u2019adresse d\u2019une maison. La taper ou la toucher vous am\u00e8ne \u00e0 la boutique.'),
    ('term', 'Tap / click', '\u201ctap\u201d means touch once with a finger on a screen; \u201cclick\u201d means press once with a mouse. They do the same thing.',
     'Toucher / cliquer', '\u00ab toucher \u00bb veut dire toucher une fois du doigt sur un \u00e9cran; \u00ab cliquer \u00bb veut dire appuyer une fois avec une souris. \u00c7a fait la m\u00eame chose.'),
    ('term', 'Sign in', 'telling the shop who you are, so it shows your shop and keeps other people out.',
     'Se connecter', 'dire \u00e0 la boutique qui vous \u00eates, pour qu\u2019elle montre votre boutique et garde les autres dehors.'),
    ('term', 'Password', 'a secret word only you know. You type it when you sign in, like a key for a lock.',
     'Mot de passe', 'un mot secret que vous \u00eates le seul \u00e0 conna\u00eetre. Vous le tapez \u00e0 la connexion, comme une cl\u00e9 pour une serrure.'),
    ('term', 'Settings', 'the place where you change how the shop behaves \u2014 like the dials on a machine.',
     'R\u00e9glages', 'l\u2019endroit o\u00f9 vous changez la fa\u00e7on dont la boutique se comporte \u2014 comme les boutons sur une machine.'),
    ('term', 'Download', 'saving a copy of a file from the internet onto your device, so you keep it.',
     'T\u00e9l\u00e9charger', 'enregistrer une copie d\u2019un fichier depuis Internet sur votre appareil, pour la garder.'),
    ('term', 'Backup', 'a safety copy of everything in your shop. If something goes wrong, the backup can put it back.',
     'Sauvegarde', 'une copie de s\u00e9curit\u00e9 de tout ce qui est dans votre boutique. Si quelque chose va mal, la sauvegarde peut tout remettre.'),
    ('term', 'The cloud', 'a short way of saying \u201csaved safely on the internet\u201d instead of only on your device.',
     'Le nuage (infonuagique)', 'une fa\u00e7on courte de dire \u00ab enregistr\u00e9 en s\u00e9curit\u00e9 sur Internet \u00bb plut\u00f4t que seulement sur votre appareil.'),
    ('h2', 'Opening your shop for the first time / Ouvrir votre boutique pour la premi\u00e8re fois'),
    ('step', 1, 'Find the browser icon on your device and tap it. (Look for Chrome, Safari, Edge or Firefox.)'),
    ('frstep', 1, 'Trouvez l\u2019ic\u00f4ne du navigateur sur votre appareil et touchez-la. (Cherchez Chrome, Safari, Edge ou Firefox.)'),
    ('step', 2, 'Tap the address bar \u2014 the long box at the top of the browser where addresses go.'),
    ('frstep', 2, 'Touchez la barre d\u2019adresse \u2014 la longue bo\u00eete en haut du navigateur o\u00f9 vont les adresses.'),
    ['shot:task-start-address.png', 'The address bar at the top of the browser', 'La barre d\u2019adresse en haut du navigateur'],
    ('step', 3, 'Type the shop\u2019s web address exactly as it was given to you, then press Enter (or tap Go).'),
    ('frstep', 3, 'Tapez l\u2019adresse Web de la boutique exactement comme on vous l\u2019a donn\u00e9e, puis appuyez sur Entr\u00e9e (ou touchez Aller).'),
    ('see', 'a page that says it is checking the connection, then the sign-in screen.'),
    ('frsee', 'une page qui dit qu\u2019elle v\u00e9rifie la connexion, puis l\u2019\u00e9cran de connexion.'),
    TROUBLE(['If the page says it cannot reach the shop: check that Wi-Fi is on (look for the fan-shaped icon), then tap Retry. If it still fails, wait a minute and try again \u2014 the internet itself may be down.'],
            ['Si la page dit qu\u2019elle ne peut pas joindre la boutique : v\u00e9rifiez que le Wi-Fi est actif (cherchez l\u2019ic\u00f4ne en \u00e9ventail), puis touchez R\u00e9essayer. Si \u00e7a \u00e9choue encore, attendez une minute et r\u00e9essayez \u2014 Internet lui-m\u00eame est peut-\u00eatre en panne.']),
    ('h2', 'Keeping the shop one tap away / Garder la boutique \u00e0 un toucher'),
    ('p', 'So you do not have to type the address every time, save it once:'),
    ('p', 'Pour ne pas avoir \u00e0 taper l\u2019adresse chaque fois, enregistrez-la une fois :'),
    ('step', 1, 'Open the shop in your browser (see above).'),
    ('step', 2, 'On a computer: press Ctrl+D (Windows) or Cmd+D (Mac) to bookmark it. On a phone or tablet: open the browser menu (three dots or a share icon) and tap \u201cAdd to Home screen\u201d (or \u201cAdd bookmark\u201d).'),
    ('step', 3, 'From now on, tap that bookmark or the new home-screen icon to open the shop.'),
    ('frstep', 1, 'Ouvrez la boutique dans votre navigateur (voir ci-dessus).'),
    ('frstep', 2, 'Sur un ordinateur : appuyez sur Ctrl+D (Windows) ou Cmd+D (Mac) pour l\u2019ajouter aux favoris. Sur un t\u00e9l\u00e9phone ou une tablette : ouvrez le menu du navigateur (trois points ou ic\u00f4ne de partage) et touchez \u00ab Ajouter \u00e0 l\u2019\u00e9cran d\u2019accueil \u00bb (ou \u00ab Ajouter un favori \u00bb).'),
    ('frstep', 3, '\u00c0 partir de maintenant, touchez ce favori ou la nouvelle ic\u00f4ne sur l\u2019\u00e9cran d\u2019accueil pour ouvrir la boutique.'),
    ['shot:task-start-bookmark.png', 'The browser menu with \u201cAdd to Home screen\u201d', 'Le menu du navigateur avec \u00ab Ajouter \u00e0 l\u2019\u00e9cran d\u2019accueil \u00bb'],
])

# ------------------------------------------- chapter 2: guided tasks
story.append(P('Your first day, step by step / Votre premi\u00e8re journ\u00e9e, \u00e9tape par \u00e9tape', h1))
story.append(P('Do these tasks in order the first time. Later, jump straight to the one you need. '
               'Suivez ces t\u00e2ches dans l\u2019ordre la premi\u00e8re fois. Plus tard, allez directement \u00e0 celle qu\u2019il vous faut.', body))

# Task 1 — sign in
section('Task 1 \u2014 Sign in for the first time', 'T\u00e2che 1 \u2014 Se connecter pour la premi\u00e8re fois', [
    ('p', 'When the shop is new, it has one built-in account: the master account. '
          'Its username is <b>admin</b> and its first password is <b>admin123</b>. '
          'You will only use that password once \u2014 the shop makes you choose your own right away.'),
    ('p', 'Quand la boutique est neuve, elle a un seul compte int\u00e9gr\u00e9 : le compte ma\u00eetre. '
          'Son nom d\u2019utilisateur est <b>admin</b> et son premier mot de passe est <b>admin123</b>. '
          'Vous n\u2019utiliserez ce mot de passe qu\u2019une fois \u2014 la boutique vous force \u00e0 choisir le v\u00f4tre tout de suite.'),
    ('step', 1, 'Open the shop (see \u201cStart here\u201d).'),
    ('step', 2, 'In the username box, type <b>admin</b>.'),
    ('step', 3, 'In the password box, type <b>admin123</b>.'),
    ('step', 4, 'Tap <b>Sign in</b>.'),
    ['shot:task1-signin.png', 'The sign-in screen with admin typed in', 'L\u2019\u00e9cran de connexion avec admin tap\u00e9'],
    ('see', 'a box asking you to choose a new password. The shop will not open until you do \u2014 this is on purpose, so nobody can keep using the first password.'),
    ('step', 5, 'Type a new password of your own. Make it at least 8 characters, and not something easy to guess (not your name, not 123456).'),
    ('step', 6, 'Type the same new password again in the second box.'),
    ('step', 7, 'Tap the confirm button.'),
    ['shot:task1-newpassword.png', 'The \u201cchoose a new password\u201d box', 'La bo\u00eete \u00ab choisir un nouveau mot de passe \u00bb'],
    ('see', 'the shop\u2019s main screen (the desktop), with icons for the different parts of the shop.'),
    ('frstep', 1, 'Ouvrez la boutique (voir \u00ab Commencez ici \u00bb).'),
    ('frstep', 2, 'Dans la bo\u00eete du nom d\u2019utilisateur, tapez <b>admin</b>.'),
    ('frstep', 3, 'Dans la bo\u00eete du mot de passe, tapez <b>admin123</b>.'),
    ('frstep', 4, 'Touchez <b>Se connecter</b>.'),
    ('frsee', 'une bo\u00eete qui demande de choisir un nouveau mot de passe. La boutique ne s\u2019ouvrira pas avant \u2014 c\u2019est fait expr\u00e8s, pour que personne ne puisse garder le premier mot de passe.'),
    ('frstep', 5, 'Tapez un nouveau mot de passe \u00e0 vous. Au moins 8 caract\u00e8res, et pas facile \u00e0 deviner (pas votre nom, pas 123456).'),
    ('frstep', 6, 'Tapez le m\u00eame nouveau mot de passe dans la deuxi\u00e8me bo\u00eete.'),
    ('frstep', 7, 'Touchez le bouton de confirmation.'),
    ('frsee', 'l\u2019\u00e9cran principal de la boutique (le bureau), avec les ic\u00f4nes des diff\u00e9rentes parties de la boutique.'),
    TROUBLE(['<b>\u201cThis is a problem with how the system was set up \u2014 not your password.\u201d</b> Your password was never even checked. The shop\u2019s own connection settings are wrong. Retyping your password will not help \u2014 tell the person who installed the shop.',
             'If your new password is refused: make it longer, and avoid common or repeating words.'],
            ['<b>\u00ab C\u2019est un probl\u00e8me de configuration du syst\u00e8me \u2014 pas votre mot de passe. \u00bb</b> Votre mot de passe n\u2019a m\u00eame pas \u00e9t\u00e9 v\u00e9rifi\u00e9. Les r\u00e9glages de connexion de la boutique sont erron\u00e9s. Retaper votre mot de passe ne changera rien \u2014 dites-le \u00e0 la personne qui a install\u00e9 la boutique.',
             'Si votre nouveau mot de passe est refus\u00e9 : allongez-le, et \u00e9vitez les mots courants ou r\u00e9p\u00e9titifs.']),
])

# COORDINATOR-VERIFY: the business-preset UI is landing in branch ds-presets
# in parallel. Task 2 below is written from the concept (Settings \u2192 a
# "Business type" choice, presets named General / Retail / Restaurant-Food /
# Services / Convenience-Fuel). Verify the exact labels, location and preset
# names against the merged UI, then update this walkthrough and the shot
# list (~/workspace/build3/manual-shot-list.md, Task 2) before final shots.
# Task 2 — business preset
section('Task 2 \u2014 Tell the shop what kind of business you run', 'T\u00e2che 2 \u2014 Dites \u00e0 la boutique quel genre de commerce vous avez', [
    ('p', 'Every shop is a little different. A restaurant needs tables and tips; a repair shop needs appointments. '
          'Instead of changing screens one by one, you pick one <b>business type</b> and the shop sets itself up for you. '
          'You can change it later \u2014 nothing is lost.'),
    ('p', 'Chaque commerce est un peu diff\u00e9rent. Un restaurant a besoin de tables et de pourboires; un atelier de r\u00e9paration, de rendez-vous. '
          'Au lieu de changer les \u00e9crans un par un, vous choisissez un <b>type de commerce</b> et la boutique se r\u00e8gle pour vous. '
          'Vous pouvez le changer plus tard \u2014 rien n\u2019est perdu.'),
    ('step', 1, 'Sign in with the master account (the one from Task 1 \u2014 username <b>admin</b>, with the password you chose in Task 1).'),
    ('step', 2, 'Open <b>Settings</b>.'),
    ('step', 3, 'Find <b>Business type</b> and tap it.'),
    ['shot:task2-businesstype.png', 'Settings with \u201cBusiness type\u201d', 'R\u00e9glages avec \u00ab Type de commerce \u00bb'],
    ('see', 'a short list of business types: General, Retail, Restaurant / Food, Services / Appointments, Convenience / Fuel.'),
    ('step', 4, 'Tap the one that matches your shop. Not sure? Pick <b>General</b> \u2014 you can change it later.'),
    ('step', 5, 'If the shop asks \u201cApply?\u201d, tap <b>Apply</b>.'),
    ['shot:task2-presetlist.png', 'The business type list', 'La liste des types de commerce'],
    ('see', 'the shop set up for your kind of business (for example, a restaurant sees tables; a repair shop sees appointments up front).'),
    ('frstep', 1, 'Connectez-vous avec le compte ma\u00eetre (celui de la t\u00e2che 1 \u2014 nom d\u2019utilisateur <b>admin</b>, avec le mot de passe que vous avez choisi \u00e0 la t\u00e2che 1).'),
    ('frstep', 2, 'Ouvrez <b>R\u00e9glages</b>.'),
    ('frstep', 3, 'Trouvez <b>Type de commerce</b> et touchez-le.'),
    ('frsee', 'une courte liste de types de commerce : G\u00e9n\u00e9ral, D\u00e9tail, Restaurant / Nourriture, Services / Rendez-vous, D\u00e9panneur / Essence.'),
    ('frstep', 4, 'Touchez celui qui correspond \u00e0 votre commerce. Pas s\u00fbr? Choisissez <b>G\u00e9n\u00e9ral</b> \u2014 vous pourrez changer plus tard.'),
    ('frstep', 5, 'Si la boutique demande \u00ab Appliquer? \u00bb, touchez <b>Appliquer</b>.'),
    ('frsee', 'la boutique r\u00e9gl\u00e9e pour votre genre de commerce (par exemple, un restaurant voit les tables; un atelier voit les rendez-vous bien en vue).'),
    TROUBLE(['If you do not see \u201cBusiness type\u201d: you may not be signed in with the master account. Sign out, then sign in as <b>admin</b> with the password you chose in Task 1.',
             'Picked the wrong type? Do Task 2 again and pick another. Products, sales and customers are never deleted by changing types.'],
            ['Si vous ne voyez pas \u00ab Type de commerce \u00bb : vous n\u2019\u00eates peut-\u00eatre pas connect\u00e9 avec le compte ma\u00eetre. D\u00e9connectez-vous, puis reconnectez-vous comme <b>admin</b> avec le mot de passe choisi \u00e0 la t\u00e2che 1.',
             'Mauvais type choisi? Refaites la t\u00e2che 2 et choisissez-en un autre. Les produits, ventes et clients ne sont jamais effac\u00e9s quand on change de type.']),
])

# Task 3 — add a product
section('Task 3 \u2014 Add a product you sell', 'T\u00e2che 3 \u2014 Ajouter un produit que vous vendez', [
    ('p', 'The shop can only sell what it knows. Add each product once; after that, selling it takes two taps.'),
    ('p', 'La boutique ne peut vendre que ce qu\u2019elle conna\u00eet. Ajoutez chaque produit une fois; ensuite, le vendre prend deux touchers.'),
    ('step', 1, 'From the main screen, open <b>Point of Sale</b>.'),
    ('step', 2, 'Tap <b>Add product</b>.'),
    ['shot:task3-addproduct.png', 'The \u201cAdd product\u201d button in Point of Sale', 'Le bouton \u00ab Ajouter un produit \u00bb dans le Point de vente'],
    ('see', 'a form with empty boxes for the product\u2019s name and price.'),
    ('step', 3, 'Type the product\u2019s name (for example: Coffee).'),
    ('step', 4, 'Type its price (for example: 2.50). Use a dot, not a comma, for cents.'),
    ('step', 5, 'If you keep stock (how many you have), type the number you have now. If not, leave it empty.'),
    ('step', 6, 'Tap <b>Save</b>.'),
    ['shot:task3-productform.png', 'The product form, filled in', 'Le formulaire de produit, rempli'],
    ('see', 'your product, with its price, in the grid of products.'),
    ('frstep', 1, '\u00c0 partir de l\u2019\u00e9cran principal, ouvrez <b>Point de vente</b>.'),
    ('frstep', 2, 'Touchez <b>Ajouter un produit</b>.'),
    ('frsee', 'un formulaire avec des bo\u00eetes vides pour le nom et le prix du produit.'),
    ('frstep', 3, 'Tapez le nom du produit (par exemple : Caf\u00e9).'),
    ('frstep', 4, 'Tapez son prix (par exemple : 2,50). Utilisez un point, pas une virgule, pour les cents.'),
    ('frstep', 5, 'Si vous suivez l\u2019inventaire (combien vous en avez), tapez le nombre que vous avez maintenant. Sinon, laissez vide.'),
    ('frstep', 6, 'Touchez <b>Enregistrer</b>.'),
    ('frsee', 'votre produit, avec son prix, dans la grille des produits.'),
    TROUBLE(['If the product does not appear: check that you tapped Save, and that you are looking at the Point of Sale (not the Catalogue \u2014 they are two different lists).',
             'Price looks wrong (250 instead of 2.50)? You typed the price in cents. Edit the product and type 2.50.'],
            ['Si le produit n\u2019appara\u00eet pas : v\u00e9rifiez que vous avez touch\u00e9 Enregistrer, et que vous regardez bien le Point de vente (pas le Catalogue \u2014 ce sont deux listes diff\u00e9rentes).',
             'Le prix semble faux (250 au lieu de 2,50)? Vous avez tap\u00e9 le prix en cents. Modifiez le produit et tapez 2.50.']),
])

# Task 4 — make a cash sale
section('Task 4 \u2014 Make a cash sale', 'T\u00e2che 4 \u2014 Faire une vente comptant', [
    ('p', '\u201cCash sale\u201d means the customer pays you with money (not a card). The shop records the sale either way.'),
    ('p', '\u00ab Vente comptant \u00bb veut dire que le client vous paie en argent (pas par carte). La boutique enregistre la vente de toute fa\u00e7on.'),
    ('step', 1, 'Open <b>Point of Sale</b>.'),
    ('step', 2, 'Tap the product the customer is buying (for example: Coffee).'),
    ('see', 'the product appears in the list on the side (the \u201ccart\u201d \u2014 what the customer is buying), and the total goes up.'),
    ('step', 3, 'Buying more than one? Tap the product again, or tap the + next to it in the cart.'),
    ('step', 4, 'When everything is in the cart, tap the big <b>Pay / Charge</b> button.'),
    ['shot:task4-posgrid.png', 'Point of Sale with one product in the cart', 'Le Point de vente avec un produit dans le panier'],
    ('see', 'the payment screen, asking how the customer pays.'),
    ('step', 5, 'Tap <b>Cash</b>.'),
    ('step', 6, 'Type how much money the customer hands you (or tap the exact amount).'),
    ('step', 7, 'Tap <b>Complete sale</b>.'),
    ['shot:task4-pay.png', 'The payment screen with Cash chosen', 'L\u2019\u00e9cran de paiement avec Comptant choisi'],
    ('see', 'a receipt, and the change to give back (if any). The sale is saved right away.'),
    ('step', 8, 'Hand the customer their change, and the receipt if they want it. Done!'),
    ('frstep', 1, 'Ouvrez <b>Point de vente</b>.'),
    ('frstep', 2, 'Touchez le produit que le client ach\u00e8te (par exemple : Caf\u00e9).'),
    ('frsee', 'le produit appara\u00eet dans la liste sur le c\u00f4t\u00e9 (le \u00ab panier \u00bb \u2014 ce que le client ach\u00e8te), et le total monte.'),
    ('frstep', 3, 'Plus d\u2019un? Touchez le produit encore, ou touchez le + \u00e0 c\u00f4t\u00e9 de lui dans le panier.'),
    ('frstep', 4, 'Quand tout est dans le panier, touchez le gros bouton <b>Payer</b>.'),
    ('frsee', 'l\u2019\u00e9cran de paiement, qui demande comment le client paie.'),
    ('frstep', 5, 'Touchez <b>Comptant</b>.'),
    ('frstep', 6, 'Tapez combien d\u2019argent le client vous donne (ou touchez le montant exact).'),
    ('frstep', 7, 'Touchez <b>Terminer la vente</b>.'),
    ('frsee', 'un re\u00e7u, et la monnaie \u00e0 remettre (s\u2019il y en a). La vente est enregistr\u00e9e tout de suite.'),
    ('frstep', 8, 'Remettez la monnaie au client, et le re\u00e7u s\u2019il le veut. Termin\u00e9!'),
    TROUBLE(['Tapped the wrong product? In the cart, tap the \u2212 (minus) to remove one, or the trash icon to remove it completely, before you pay.',
             'If the sale stops with a \u201ccould not reach the shop\u201d message: the internet dropped. Your cart is still there \u2014 see Task 10. No money was taken.'],
            ['Mauvais produit touch\u00e9? Dans le panier, touchez le \u2212 (moins) pour en enlever un, ou l\u2019ic\u00f4ne de poubelle pour l\u2019enlever au complet, avant de payer.',
             'Si la vente s\u2019arr\u00eate avec un message \u00ab impossible de joindre la boutique \u00bb : Internet a coup\u00e9. Votre panier est toujours l\u00e0 \u2014 voir la t\u00e2che 10. Aucun argent n\u2019a \u00e9t\u00e9 pris.']),
])

# Task 5 — refund
section('Task 5 \u2014 Give a refund', 'T\u00e2che 5 \u2014 Faire un remboursement', [
    ('p', 'A refund gives the customer their money back for something they bought. You find the sale first, then refund it.'),
    ('p', 'Un remboursement redonne au client son argent pour quelque chose qu\u2019il a achet\u00e9. On trouve d\u2019abord la vente, puis on la rembourse.'),
    ('step', 1, 'Open <b>Point of Sale</b>.'),
    ('step', 2, 'Tap <b>History</b>.'),
    ['shot:task5-history.png', 'The History list of past sales', 'La liste Historique des ventes pass\u00e9es'],
    ('see', 'the list of past sales, newest first.'),
    ('step', 3, 'Tap the sale you want to refund.'),
    ('see', 'the details of that sale.'),
    ('step', 4, 'Tap <b>Refund</b>.'),
    ('step', 5, 'Check the amount. If only part is being returned, change the quantity to what came back.'),
    ('step', 6, 'You may type a reason (why it came back). You can also leave it empty.'),
    ('step', 7, 'Tap <b>Confirm refund</b>.'),
    ['shot:task5-refund.png', 'The refund box for a sale', 'La bo\u00eete de remboursement d\u2019une vente'],
    ('see', 'the sale in History now shows it was refunded. Refunded sales cannot be voided (deleted) afterwards \u2014 this is on purpose, so the record stays honest.'),
    ('frstep', 1, 'Ouvrez <b>Point de vente</b>.'),
    ('frstep', 2, 'Touchez <b>Historique</b>.'),
    ('frsee', 'la liste des ventes pass\u00e9es, les plus r\u00e9centes en premier.'),
    ('frstep', 3, 'Touchez la vente \u00e0 rembourser.'),
    ('frsee', 'les d\u00e9tails de cette vente.'),
    ('frstep', 4, 'Touchez <b>Rembourser</b>.'),
    ('frstep', 5, 'V\u00e9rifiez le montant. Si seulement une partie revient, changez la quantit\u00e9 pour ce qui est revenu.'),
    ('frstep', 6, 'Vous pouvez taper une raison (pourquoi c\u2019est revenu). Vous pouvez aussi laisser vide.'),
    ('frstep', 7, 'Touchez <b>Confirmer le remboursement</b>.'),
    ('frsee', 'la vente dans l\u2019Historique montre maintenant qu\u2019elle a \u00e9t\u00e9 rembours\u00e9e. Une vente rembours\u00e9e ne peut plus \u00eatre annul\u00e9e (effac\u00e9e) \u2014 c\u2019est fait expr\u00e8s, pour que le registre reste honn\u00eate.'),
    TROUBLE(['Can\u2019t find the sale? Check you are signed in to the right shop, and scroll \u2014 History is newest first.',
             'Refund button missing? Only owners and managers can refund. Ask the person with the master account.'],
            ['Vente introuvable? V\u00e9rifiez que vous \u00eates connect\u00e9 \u00e0 la bonne boutique, et faites d\u00e9filer \u2014 l\u2019Historique met les plus r\u00e9centes en premier.',
             'Bouton Rembourser absent? Seuls les propri\u00e9taires et g\u00e9rants peuvent rembourser. Demandez \u00e0 la personne qui a le compte ma\u00eetre.']),
])

# Task 6 — public storefront
section('Task 6 \u2014 Put your shop on the web (the public page)', 'T\u00e2che 6 \u2014 Mettre votre boutique sur le Web (la page publique)', [
    ('p', 'Your shop can have a simple page on the web that anyone can look at: your shop name, what you sell, '
          'your hours and how to reach you. Products you add in the Point of Sale appear on the page by themselves \u2014 '
          'you do not type them twice. This page is a shop window, not a full website: visitors cannot buy online there.'),
    ('p', 'Votre boutique peut avoir une page simple sur le Web que tout le monde peut regarder : le nom de votre boutique, '
          'ce que vous vendez, vos heures et comment vous joindre. Les produits ajout\u00e9s dans le Point de vente apparaissent '
          'sur la page tout seuls \u2014 vous ne les tapez pas deux fois. Cette page est une vitrine, pas un site Web complet : '
          'les visiteurs ne peuvent pas acheter en ligne.'),
    ('step', 1, 'Sign in with the master account, or as the shop\u2019s owner/manager.'),
    ('step', 2, 'Open the <b>Admin</b> panel.'),
    ('step', 3, 'Tap the <b>Storefront</b> tab.'),
    ['shot:task6-storefronttab.png', 'The Admin panel, Storefront tab', 'Le panneau Admin, onglet Vitrine'],
    ('see', 'boxes for your public shop name, a short line about your shop (\u201cAbout\u201d), opening hours, email, phone, and a colour.'),
    ('step', 4, 'Fill in the boxes. Write them for strangers: what you sell, where you are, when you are open.'),
    ('step', 5, 'In the web address box, choose your shop\u2019s address: small letters, numbers and dashes only (for example <font face="Courier">my-shop</font>). Your full public link ends with <font face="Courier">#/store/my-shop</font>.'),
    ('step', 6, 'Turn on <b>Page is published</b>.'),
    ('step', 7, 'Tap <b>Save</b>.'),
    ['shot:task6-publish.png', '\u201cPage is published\u201d turned on, with the Save button', '\u00ab La page est publi\u00e9e \u00bb activ\u00e9, avec le bouton Enregistrer'],
    ('see', 'your public link, ready to copy.'),
    ('step', 8, 'Tap the link (or copy it) to look at your page the way customers see it.'),
    ['shot:task6-publicpage.png', 'The public page customers see', 'La page publique que les clients voient'],
    ('see', 'your shop page, with your products. (To keep one product off the page: in its product settings, set it to Hidden. To hide all prices: turn off \u201cShow prices\u201d in the Storefront tab.)'),
    ('frstep', 1, 'Connectez-vous avec le compte ma\u00eetre, ou comme propri\u00e9taire/g\u00e9rant de la boutique.'),
    ('frstep', 2, 'Ouvrez le panneau <b>Admin</b>.'),
    ('frstep', 3, 'Touchez l\u2019onglet <b>Vitrine</b>.'),
    ('frsee', 'des bo\u00eetes pour le nom public de votre boutique, une courte description (\u00ab \u00c0 propos \u00bb), les heures d\u2019ouverture, le courriel, le t\u00e9l\u00e9phone, et une couleur.'),
    ('frstep', 4, 'Remplissez les bo\u00eetes. \u00c9crivez pour des inconnus : ce que vous vendez, o\u00f9 vous \u00eates, quand vous \u00eates ouvert.'),
    ('frstep', 5, 'Dans la bo\u00eete d\u2019adresse Web, choisissez l\u2019adresse de votre boutique : lettres minuscules, chiffres et tirets seulement (par exemple <font face="Courier">ma-boutique</font>). Votre lien public complet se termine par <font face="Courier">#/store/ma-boutique</font>.'),
    ('frstep', 6, 'Activez <b>La page est publi\u00e9e</b>.'),
    ('frstep', 7, 'Touchez <b>Enregistrer</b>.'),
    ('frsee', 'votre lien public, pr\u00eat \u00e0 copier.'),
    ('frstep', 8, 'Touchez le lien (ou copiez-le) pour voir votre page comme les clients la voient.'),
    ('frsee', 'votre page de boutique, avec vos produits. (Pour retirer un produit de la page : dans ses r\u00e9glages de produit, mettez-le \u00e0 Masqu\u00e9. Pour cacher tous les prix : d\u00e9sactivez \u00ab Afficher les prix \u00bb dans l\u2019onglet Vitrine.)'),
    TROUBLE(['The link says \u201cnot available yet\u201d: \u201cPage is published\u201d is off, or you did not tap Save after turning it on. Go back to the Storefront tab and check both.',
             'A product is missing from the page: it is set to Hidden in its product settings, or it is only in the Catalogue (the public page shows Point of Sale products).'],
            ['Le lien dit \u00ab pas encore disponible \u00bb : \u00ab La page est publi\u00e9e \u00bb est d\u00e9sactiv\u00e9, ou vous n\u2019avez pas touch\u00e9 Enregistrer apr\u00e8s l\u2019avoir activ\u00e9. Retournez \u00e0 l\u2019onglet Vitrine et v\u00e9rifiez les deux.',
             'Un produit manque sur la page : il est \u00e0 Masqu\u00e9 dans ses r\u00e9glages de produit, ou il est seulement dans le Catalogue (la page publique montre les produits du Point de vente).']),
])

# Task 7 — touch screen optimization
section('Task 7 \u2014 Make the till easy to touch (tablets and phones)', 'T\u00e2che 7 \u2014 Rendre la caisse facile \u00e0 toucher (tablettes et t\u00e9l\u00e9phones)', [
    ('p', 'If your till is a tablet or a phone, small buttons are hard to tap. This setting makes buttons bigger '
          'and the home screen simpler, like a phone\u2019s. Turn it on for each device that needs it \u2014 it only changes that device.'),
    ('p', 'Si votre caisse est une tablette ou un t\u00e9l\u00e9phone, les petits boutons sont difficiles \u00e0 toucher. Ce r\u00e9glage '
          'grossit les boutons et simplifie l\u2019\u00e9cran d\u2019accueil, comme un t\u00e9l\u00e9phone. Activez-le sur chaque appareil qui en a besoin \u2014 '
          '\u00e7a ne change que cet appareil-l\u00e0.'),
    ('step', 1, 'Open <b>Settings</b>.'),
    ('step', 2, 'Tap <b>Appearance</b>.'),
    ('step', 3, 'Turn on <b>Touch screen optimization</b>.'),
    ['shot:task7-touchtoggle.png', '\u201cTouch screen optimization\u201d in Settings \u00b7 Appearance', '\u00ab Optimisation tactile \u00bb dans R\u00e9glages \u00b7 Apparence'],
    ('see', 'the home screen changes: big icons, apps open full-screen, and buttons everywhere are bigger.'),
    ('step', 4, 'Try it: open the Point of Sale and tap a product. Buttons should be easy to hit with a finger.'),
    ('step', 5, 'Want it back the old way? Repeat steps 1\u20133 and turn it off.'),
    ['shot:task7-touchhome.png', 'The touch home screen, with big icons', 'L\u2019\u00e9cran d\u2019accueil tactile, avec de grosses ic\u00f4nes'],
    ('frstep', 1, 'Ouvrez <b>R\u00e9glages</b>.'),
    ('frstep', 2, 'Touchez <b>Apparence</b>.'),
    ('frstep', 3, 'Activez <b>Optimisation tactile</b>.'),
    ('frsee', 'l\u2019\u00e9cran d\u2019accueil change : grosses ic\u00f4nes, applis en plein \u00e9cran, et des boutons plus gros partout.'),
    ('frstep', 4, 'Essayez : ouvrez le Point de vente et touchez un produit. Les boutons devraient \u00eatre faciles \u00e0 toucher du doigt.'),
    ('frstep', 5, 'Pour revenir comme avant : refaites les \u00e9tapes 1 \u00e0 3 et d\u00e9sactivez.'),
    TROUBLE(['Nothing changed? The setting applies to this device only, and the home screen changes first. If the till still shows the desktop-style home screen, close and reopen the shop (see \u201cStart here\u201d).'],
            ['Rien n\u2019a chang\u00e9? Le r\u00e9glage s\u2019applique \u00e0 cet appareil seulement, et c\u2019est l\u2019\u00e9cran d\u2019accueil qui change d\u2019abord. Si la caisse montre encore l\u2019accueil style bureau, fermez et rouvrez la boutique (voir \u00ab Commencez ici \u00bb).']),
])

# Task 8 — backup
section('Task 8 \u2014 Save a backup (do this regularly)', 'T\u00e2che 8 \u2014 Faire une sauvegarde (faites-le r\u00e9guli\u00e8rement)', [
    ('p', 'A backup is one file that holds everything in your account: products, sales, customers, settings. '
          'Save one regularly \u2014 for example every Friday \u2014 and keep the file somewhere safe, like a USB key or your email. '
          'If anything ever goes badly wrong, this file is how you get your shop back.'),
    ('p', 'Une sauvegarde est un seul fichier qui contient tout votre compte : produits, ventes, clients, r\u00e9glages. '
          'Faites-en une r\u00e9guli\u00e8rement \u2014 par exemple chaque vendredi \u2014 et gardez le fichier en lieu s\u00fbr, comme une cl\u00e9 USB '
          'ou votre courriel. Si quelque chose tourne vraiment mal un jour, c\u2019est ce fichier qui ram\u00e8ne votre boutique.'),
    ('step', 1, 'Open <b>Settings</b>.'),
    ('step', 2, 'Tap <b>Data</b>.'),
    ('step', 3, 'Tap <b>Download backup</b> (account backup).'),
    ['shot:task8-backup.png', 'The backup button in Settings \u00b7 Data', 'Le bouton de sauvegarde dans R\u00e9glages \u00b7 Donn\u00e9es'],
    ('see', 'a file named like <font face="Courier">drift-backup-2026-10-01.json</font> downloading to your device.'),
    ('step', 4, 'Find the downloaded file (usually in your Downloads folder) and copy it somewhere safe. That is it \u2014 done.'),
    ('frstep', 1, 'Ouvrez <b>R\u00e9glages</b>.'),
    ('frstep', 2, 'Touchez <b>Donn\u00e9es</b>.'),
    ('frstep', 3, 'Touchez <b>T\u00e9l\u00e9charger la sauvegarde</b> (sauvegarde du compte).'),
    ('frsee', 'un fichier nomm\u00e9 comme <font face="Courier">drift-backup-2026-10-01.json</font> qui se t\u00e9l\u00e9charge sur votre appareil.'),
    ('frstep', 4, 'Trouvez le fichier t\u00e9l\u00e9charg\u00e9 (habituellement dans votre dossier T\u00e9l\u00e9chargements) et copiez-le en lieu s\u00fbr. C\u2019est tout \u2014 termin\u00e9.'),
    TROUBLE(['No file appeared? Some browsers block downloads. Look for a small blocked-download icon near the address bar, allow the download, and try again.',
             'The backup file contains private things (like staff PIN numbers). Keep it like you would keep keys: do not share it publicly.'],
            ['Aucun fichier n\u2019est apparu? Certains navigateurs bloquent les t\u00e9l\u00e9chargements. Cherchez une petite ic\u00f4ne de t\u00e9l\u00e9chargement bloqu\u00e9 pr\u00e8s de la barre d\u2019adresse, autorisez le t\u00e9l\u00e9chargement, et r\u00e9essayez.',
             'Le fichier de sauvegarde contient des choses priv\u00e9es (comme les NIP du personnel). Gardez-le comme des cl\u00e9s : ne le partagez pas publiquement.']),
])

# Task 9 — factory reset
section('Task 9 \u2014 Start completely over (factory reset)', 'T\u00e2che 9 \u2014 Tout recommencer \u00e0 z\u00e9ro (r\u00e9initialisation d\u2019usine)', [
    ('p', '<b>Warning first.</b> A factory reset <b>deletes everything and everyone</b>: all accounts, products, sales, '
          'customers, appointments, files \u2014 gone, as if the shop was brand new. <b>There is no undo.</b> '
          'Only do this if you truly want to start over, or hand the shop to someone else completely empty. '
          'Only the master account (username <b>admin</b>, with the password you chose in Task 1) can do it.'),
    ('p', '<b>Attention d\u2019abord.</b> Une r\u00e9initialisation d\u2019usine <b>efface tout et tout le monde</b> : tous les comptes, produits, '
          'ventes, clients, rendez-vous, fichiers \u2014 disparus, comme si la boutique \u00e9tait neuve. <b>Aucun retour en arri\u00e8re.</b> '
          'Faites-le seulement si vous voulez vraiment recommencer, ou remettre la boutique \u00e0 quelqu\u2019un d\u2019autre compl\u00e8tement vide. '
          'Seul le compte ma\u00eetre (nom d\u2019utilisateur <b>admin</b>, avec le mot de passe choisi \u00e0 la t\u00e2che 1) peut le faire.'),
    ('step', 1, 'First, do Task 8 (download a backup) and keep the file safe. After a reset, that file is the only way back.'),
    ('step', 2, 'Sign in as <b>admin</b> (master account).'),
    ('step', 3, 'Open the <b>Admin</b> panel.'),
    ('step', 4, 'Scroll to the <b>Danger zone</b> at the bottom.'),
    ('step', 5, 'Tap <b>Factory reset</b>.'),
    ['shot:task9-dangerzone.png', 'The Danger zone with the Factory reset button', 'La Zone danger avec le bouton R\u00e9initialisation d\u2019usine'],
    ('see', 'a warning box. Before anything is deleted, the shop saves one last backup by itself and downloads it. If that backup fails, the reset stops and nothing is deleted.'),
    ('step', 6, 'Read the warning. Then type the word <b>RESET</b> (in capital letters) in the box.'),
    ('see', 'the reset button lights up. It stays off until the word is typed exactly right \u2014 this is on purpose, so nobody can tap it by accident.'),
    ('step', 7, 'Tap the reset button, and confirm.'),
    ['shot:task9-typereset.png', 'Typing RESET to arm the reset button', 'Taper RESET pour armer le bouton de r\u00e9initialisation'],
    ('see', 'you are signed out. The shop is empty and new. Sign in again with <b>admin</b> / <b>admin123</b> and pick a new password (same as Task 1).'),
    ('frstep', 1, 'D\u2019abord, faites la t\u00e2che 8 (t\u00e9l\u00e9charger une sauvegarde) et gardez le fichier en s\u00e9curit\u00e9. Apr\u00e8s une r\u00e9initialisation, ce fichier est le seul retour possible.'),
    ('frstep', 2, 'Connectez-vous comme <b>admin</b> (compte ma\u00eetre).'),
    ('frstep', 3, 'Ouvrez le panneau <b>Admin</b>.'),
    ('frstep', 4, 'Faites d\u00e9filer jusqu\u2019\u00e0 la <b>Zone danger</b> en bas.'),
    ('frstep', 5, 'Touchez <b>R\u00e9initialisation d\u2019usine</b>.'),
    ('frsee', 'une bo\u00eete d\u2019avertissement. Avant que quoi que ce soit soit effac\u00e9, la boutique fait une derni\u00e8re sauvegarde toute seule et la t\u00e9l\u00e9charge. Si cette sauvegarde \u00e9choue, la r\u00e9initialisation s\u2019arr\u00eate et rien n\u2019est effac\u00e9.'),
    ('frstep', 6, 'Lisez l\u2019avertissement. Puis tapez le mot <b>RESET</b> (en lettres majuscules) dans la bo\u00eete.'),
    ('frsee', 'le bouton de r\u00e9initialisation s\u2019allume. Il reste \u00e9teint tant que le mot n\u2019est pas tap\u00e9 exactement \u2014 c\u2019est fait expr\u00e8s, pour que personne ne le touche par accident.'),
    ('frstep', 7, 'Touchez le bouton de r\u00e9initialisation, et confirmez.'),
    ('frsee', 'vous \u00eates d\u00e9connect\u00e9. La boutique est vide et neuve. Reconnectez-vous avec <b>admin</b> / <b>admin123</b> et choisissez un nouveau mot de passe (comme \u00e0 la t\u00e2che 1).'),
    TROUBLE(['The reset button stays off: the word must be exactly RESET, all capitals, no spaces. Check Caps Lock.',
             '\u201cPRE-RESET BACKUP FAILED\u201d: the safety backup could not be saved, so the reset did not happen and nothing was deleted. Do Task 8 by hand, then try again.'],
            ['Le bouton reste \u00e9teint : le mot doit \u00eatre exactement RESET, tout en majuscules, sans espaces. V\u00e9rifiez le verrouillage des majuscules.',
             '\u00ab PRE-RESET BACKUP FAILED \u00bb : la sauvegarde de s\u00e9curit\u00e9 n\u2019a pas pu \u00eatre enregistr\u00e9e, donc la r\u00e9initialisation n\u2019a pas eu lieu et rien n\u2019a \u00e9t\u00e9 effac\u00e9. Faites la t\u00e2che 8 \u00e0 la main, puis r\u00e9essayez.']),
])

# Task 10 — sale fails with no connection
section('Task 10 \u2014 When a sale fails because the internet dropped', 'T\u00e2che 10 \u2014 Quand une vente \u00e9choue parce qu\u2019Internet a coup\u00e9', [
    ('p', 'Your shop lives on the internet. Every sale is recorded on the internet the moment it happens. '
          'If the internet drops in the middle of a sale, the sale cannot finish. Here is exactly what happens, and what to do. '
          'Good news first: <b>nobody is charged</b>, and <b>your cart (what the customer is buying) stays on the screen</b>. Nothing is lost.'),
    ('p', 'Votre boutique vit sur Internet. Chaque vente est enregistr\u00e9e sur Internet au moment o\u00f9 elle se fait. '
          'Si Internet coupe au milieu d\u2019une vente, la vente ne peut pas finir. Voici exactement ce qui se passe, et quoi faire. '
          'La bonne nouvelle d\u2019abord : <b>personne n\u2019est factur\u00e9</b>, et <b>votre panier (ce que le client ach\u00e8te) reste \u00e0 l\u2019\u00e9cran</b>. Rien n\u2019est perdu.'),
    ('step', 1, 'Read the message on the screen. It will say the shop could not be reached, and the sale did not go through.'),
    ['shot:task10-saleerror.png', 'The \u201ccould not reach the shop\u201d message at checkout', 'Le message \u00ab impossible de joindre la boutique \u00bb \u00e0 l\u2019encaissement'],
    ('see', 'your cart is still there, with every item, exactly as it was.'),
    ('step', 2, 'Check the Wi-Fi: look for the fan-shaped icon on the device. If it is missing or has an \u201c!\u201d, the device lost the internet.'),
    ('step', 3, 'Wait for the internet to come back (the icon returns). This can take a minute after an outage.'),
    ('step', 4, 'Tap <b>Retry</b> (or complete the sale again, the same way as Task 4).'),
    ('see', 'the receipt, like a normal sale. The sale is recorded once \u2014 retrying does not charge twice.'),
    ('frstep', 1, 'Lisez le message \u00e0 l\u2019\u00e9cran. Il dira que la boutique n\u2019a pas pu \u00eatre jointe, et que la vente n\u2019est pas pass\u00e9e.'),
    ('frsee', 'votre panier est toujours l\u00e0, avec chaque article, exactement comme il \u00e9tait.'),
    ('frstep', 2, 'V\u00e9rifiez le Wi-Fi : cherchez l\u2019ic\u00f4ne en \u00e9ventail sur l\u2019appareil. S\u2019il manque ou a un \u00ab ! \u00bb, l\u2019appareil a perdu Internet.'),
    ('frstep', 3, 'Attendez qu\u2019Internet revienne (l\u2019ic\u00f4ne revient). \u00c7a peut prendre une minute apr\u00e8s une panne.'),
    ('frstep', 4, 'Touchez <b>R\u00e9essayer</b> (ou terminez la vente \u00e0 nouveau, comme \u00e0 la t\u00e2che 4).'),
    ('frsee', 'le re\u00e7u, comme une vente normale. La vente est enregistr\u00e9e une seule fois \u2014 r\u00e9essayer ne facture pas deux fois.'),
    TROUBLE(['If the customer cannot wait: there is no \u201coffline\u201d selling \u2014 a sale that never reached the internet simply never happened. Write down what they bought on paper if you like, and ring it in when the internet returns.',
             'If sales keep failing for a long time, the problem is the internet connection or the shop\u2019s server \u2014 not the till. Tell the person who installed the shop.'],
            ['Si le client ne peut pas attendre : il n\u2019y a pas de vente \u00ab hors ligne \u00bb \u2014 une vente qui n\u2019a jamais atteint Internet n\u2019a tout simplement jamais eu lieu. Notez ce qu\u2019il a achet\u00e9 sur papier si vous voulez, et enregistrez-le quand Internet revient.',
             'Si les ventes \u00e9chouent longtemps, le probl\u00e8me est la connexion Internet ou le serveur de la boutique \u2014 pas la caisse. Dites-le \u00e0 la personne qui a install\u00e9 la boutique.']),
])

# ------------------------------- chapter 3: more parts of the shop
section('More parts of the shop (in plain words)', 'Les autres parties de la boutique (en mots simples)', [
    ('h2', 'The Catalogue / Le Catalogue'),
    ('p', 'The <b>Catalogue</b> is your stock list: what you have, how many, and where it sits on the shelf. '
          'It is a different list from the Point of Sale products (Task 3). Something in the Catalogue marked \u201cin store\u201d '
          'can be scanned straight into a sale. You can also add many items at once from a spreadsheet file (this is called a CSV file), '
          'and look items up by their barcode/ISBN number. Donations, fair days and special orders (a customer asking you to order something in) '
          'each have their own simple flow.'),
    ('p', 'Le <b>Catalogue</b> est votre liste d\u2019inventaire : ce que vous avez, combien, et o\u00f9 c\u2019est sur l\u2019\u00e9tag\u00e8re. '
          'C\u2019est une liste diff\u00e9rente des produits du Point de vente (t\u00e2che 3). Un article du Catalogue marqu\u00e9 \u00ab en magasin \u00bb '
          'peut \u00eatre scann\u00e9 directement dans une vente. Vous pouvez aussi ajouter beaucoup d\u2019articles d\u2019un coup \u00e0 partir d\u2019un fichier '
          'de tableur (on appelle \u00e7a un fichier CSV), et chercher des articles par leur code-barres/num\u00e9ro ISBN. Les dons, les journ\u00e9es de foire '
          'et les commandes sp\u00e9ciales (un client qui vous demande de commander quelque chose) ont chacun leur fa\u00e7on simple de fonctionner.'),
    ('h2', 'Appointments / Rendez-vous'),
    ('p', '<b>Appointments</b> is a booking book: customers book a time, and two bookings cannot take the same time by accident.'),
    ('p', '<b>Rendez-vous</b> est un cahier de r\u00e9servations : les clients r\u00e9servent une heure, et deux r\u00e9servations ne peuvent pas prendre la m\u00eame heure par accident.'),
    ('h2', 'Files / Fichiers'),
    ('p', '<b>Files</b> keeps your documents and pictures in the shop, and you can search the words inside them.'),
    ('p', '<b>Fichiers</b> garde vos documents et photos dans la boutique, et vous pouvez chercher les mots dedans.'),
    ('h2', 'Certificates \u2014 the staff time clock / Attestations \u2014 la pointeuse du personnel'),
    ('p', 'Staff clock in and out with their own secret number (a PIN \u2014 a short number, like a bank card\u2019s). '
          'Managers can fix a punch, make the schedule (two shifts for the same person cannot overlap), and print attestations \u2014 '
          'signed papers that prove someone\u2019s hours. Volunteer/community hours are kept separate from paid hours. '
          'Team members are invited with a code and have a role: Owner (can do everything), Manager (almost everything), Cashier (sells).'),
    ('p', 'Le personnel pointe son arriv\u00e9e et son d\u00e9part avec son propre num\u00e9ro secret (un NIP \u2014 un petit num\u00e9ro, comme celui d\u2019une carte bancaire). '
          'Les g\u00e9rants peuvent corriger un pointage, faire l\u2019horaire (deux quarts pour la m\u00eame personne ne peuvent pas se chevaucher) et imprimer des attestations \u2014 '
          'des papiers sign\u00e9s qui prouvent les heures de quelqu\u2019un. Les heures de b\u00e9n\u00e9volat sont gard\u00e9es s\u00e9par\u00e9ment des heures pay\u00e9es. '
          'Les membres de l\u2019\u00e9quipe sont invit\u00e9s avec un code et ont un r\u00f4le : propri\u00e9taire (peut tout faire), g\u00e9rant (presque tout), caissier (vend).'),
    ('h2', 'Taxes \u2014 read this before your first real sale / Taxes \u2014 \u00e0 lire avant votre premi\u00e8re vraie vente'),
    ('p', '<b>A new shop charges no tax at all</b> until you set it up. That is on purpose, so nobody is charged the wrong tax. '
          'Before selling for real, ask your accountant (the person who does your taxes) two things: what tax percentages apply where you are, '
          'and whether each tax is calculated on the price alone, or on price-plus-the-other-tax. Then, in the Point of Sale settings, type those numbers in, '
          'and press <b>Save</b>. The shop never changes tax numbers by itself. Some organizations pay no tax: they can be marked tax-exempt so their receipts show no tax.'),
    ('p', '<b>Une boutique neuve ne per\u00e7oit aucune taxe</b> tant que vous ne l\u2019avez pas r\u00e9gl\u00e9e. C\u2019est fait expr\u00e8s, pour que personne ne paie la mauvaise taxe. '
          'Avant de vendre pour vrai, demandez \u00e0 votre comptable (la personne qui fait vos imp\u00f4ts) deux choses : quels pourcentages de taxe s\u2019appliquent chez vous, '
          'et si chaque taxe se calcule sur le prix seulement, ou sur le prix plus l\u2019autre taxe. Ensuite, dans les r\u00e9glages du Point de vente, tapez ces nombres, '
          'et appuyez sur <b>Enregistrer</b>. La boutique ne change jamais les nombres de taxe toute seule. Certains organismes ne paient pas de taxe : on peut les marquer '
          'exon\u00e9r\u00e9s pour que leurs re\u00e7us ne montrent aucune taxe.'),
    ('h2', 'Other settings / Autres r\u00e9glages'),
    ('b', 'Colours and light/dark: Settings \u00b7 Appearance.'),
    ('b', 'If someone else changes a setting on another till, your screen picks it up within about a minute. If you are in the middle of typing in a form, your typing is never erased by that.'),
    ('b', 'When a newer version of the shop is ready, a small message invites you to refresh the page. Nothing is forced on you mid-sale.'),
    ('b', 'Couleurs et clair/sombre : R\u00e9glages \u00b7 Apparence.'),
    ('b', 'Si quelqu\u2019un change un r\u00e9glage sur une autre caisse, votre \u00e9cran le re\u00e7oit en environ une minute. Si vous \u00eates en train de taper dans un formulaire, ce que vous tapez n\u2019est jamais effac\u00e9 par \u00e7a.'),
    ('b', 'Quand une nouvelle version de la boutique est pr\u00eate, un petit message vous invite \u00e0 actualiser la page. Rien ne vous est impos\u00e9 au milieu d\u2019une vente.'),
    ('h2', 'Online payments \u2014 Lemon Squeezy and Stripe / Paiements en ligne \u2014 Lemon Squeezy et Stripe'),
    ('p', '<b>Online payments</b> let customers pay on the internet instead of only at pickup. '
          'Vendra does not touch the money itself \u2014 you connect your own Lemon Squeezy or Stripe account, '
          'and they handle the payment. Vendra adds no fee on top; Lemon Squeezy and Stripe charge their own processing fees.'),
    ('p', 'Les <b>paiements en ligne</b> permettent aux clients de payer sur internet au lieu de seulement \u00e0 la cueillette. '
          'Vendra ne touche pas l\u2019argent lui-m\u00eame \u2014 vous connectez votre propre compte Lemon Squeezy ou Stripe, '
          'et ce sont eux qui traitent le paiement. Vendra n\u2019ajoute aucun frais ; Lemon Squeezy et Stripe facturent leurs propres frais de traitement.'),
    ('p', '<b>To set up Lemon Squeezy:</b> (1) Create your store at lemonsqueezy.com. '
          '(2) In Lemon Squeezy, go to Settings \u00b7 Webhooks, create a webhook pointing to the address shown in Vendra, '
          'and copy the <b>signing secret</b>. '
          '(3) In Vendra, go to Admin \u00b7 Storefront, turn on \u201cAccept online payments via Lemon Squeezy\u201d, '
          'paste your checkout link and the signing secret, then Save. '
          'Customers will see a \u201cPay online\u201d button after placing an order. When they pay, Vendra marks the order as paid automatically.'),
    ('p', '<b>Pour configurer Lemon Squeezy :</b> (1) Cr\u00e9ez votre boutique sur lemonsqueezy.com. '
          '(2) Dans Lemon Squeezy, allez \u00e0 Settings \u00b7 Webhooks, cr\u00e9ez un webhook vers l\u2019adresse indiqu\u00e9e dans Vendra, '
          'et copiez le <b>secret de signature</b>. '
          '(3) Dans Vendra, allez \u00e0 Admin \u00b7 Vitrine, activez \u00ab Accepter les paiements en ligne via Lemon Squeezy \u00bb, '
          'collez votre lien de paiement et le secret de signature, puis Enregistrez. '
          'Les clients verront un bouton \u00ab Payer en ligne \u00bb apr\u00e8s avoir pass\u00e9 commande. Quand ils paient, Vendra marque la commande comme pay\u00e9e automatiquement.'),
    ('p', '<b>To set up Stripe:</b> (1) Create your account at stripe.com and create a payment link. '
          '(2) In Stripe, go to Developers \u00b7 Webhooks, create an endpoint pointing to the address shown in Vendra, '
          'and copy the <b>signing secret</b>. '
          '(3) In Vendra, go to Admin \u00b7 Storefront, turn on \u201cAccept online payments via Stripe\u201d, '
          'paste your payment link and the signing secret, then Save.'),
    ('p', '<b>Pour configurer Stripe :</b> (1) Cr\u00e9ez votre compte sur stripe.com et cr\u00e9ez un lien de paiement. '
          '(2) Dans Stripe, allez \u00e0 Developers \u00b7 Webhooks, cr\u00e9ez un point de terminaison vers l\u2019adresse indiqu\u00e9e dans Vendra, '
          'et copiez le <b>secret de signature</b>. '
          '(3) Dans Vendra, allez \u00e0 Admin \u00b7 Vitrine, activez \u00ab Accepter les paiements en ligne via Stripe \u00bb, '
          'collez votre lien de paiement et le secret de signature, puis Enregistrez.'),
    ('p', 'The signing secret is what keeps payments safe: Vendra checks every webhook signature before marking an order as paid. '
          'Without the correct secret, fake payment notifications are rejected. Never share your webhook secret.'),
    ('p', 'Le secret de signature est ce qui garde les paiements s\u00fbrs : Vendra v\u00e9rifie chaque signature de webhook avant de marquer une commande comme pay\u00e9e. '
          'Sans le bon secret, les fausses notifications de paiement sont rejet\u00e9es. Ne partagez jamais votre secret de webhook.'),
])

# ------------------------------- chapter 4: when something goes wrong
section('When something goes wrong', 'Quand quelque chose ne va pas', [
    ('p', 'This shop is built to fail politely: it explains, it never shows a blank page, and it never silently loses a sale. '
          'Here are the bad moments we know about, in plain words.'),
    ('p', 'Cette boutique est faite pour \u00e9chouer poliment : elle explique, elle ne montre jamais une page vide, et elle ne perd jamais une vente en silence. '
          'Voici les mauvais moments que nous connaissons, en mots simples.'),
    ('h2', 'The shop cannot be reached at opening / La boutique est injoignable \u00e0 l\u2019ouverture'),
    ('b', 'Before opening, the shop checks itself. If its own connection settings look wrong (for example a cut-off key), the screen says the setup looks wrong and that no password will work until whoever installed the shop fixes it. If the settings are fine but the server does not answer, the screen says that instead. Either way there is a <b>Retry</b> button \u2014 tap it once the internet is back.'),
    ('b', 'Avant de s\u2019ouvrir, la boutique se v\u00e9rifie. Si ses propres r\u00e9glages de connexion semblent erron\u00e9s (par exemple une cl\u00e9 coup\u00e9e), l\u2019\u00e9cran dit que la configuration semble incorrecte et qu\u2019aucun mot de passe ne fonctionnera tant que la personne qui a install\u00e9 la boutique ne l\u2019a pas corrig\u00e9e. Si les r\u00e9glages sont bons mais que le serveur ne r\u00e9pond pas, l\u2019\u00e9cran le dit plut\u00f4t. Dans les deux cas, il y a un bouton <b>R\u00e9essayer</b> \u2014 touchez-le quand Internet revient.'),
    ('h2', 'One part of the shop stops working / Une partie de la boutique arr\u00eate de fonctionner'),
    ('b', 'Each part of the shop is walled off from the others. If one part breaks, only that part shows a message, with a <b>Retry</b> button and a short code (like <font face="Courier">RS-9K2Q1-4F2A</font>). Write the code down and tell whoever looks after the shop \u2014 it points straight at the problem. The rest of the shop keeps working. If the shop breaks three times in a row while opening, it starts in a safe mode with repair options instead of breaking again and again.'),
    ('b', 'Chaque partie de la boutique est s\u00e9par\u00e9e des autres. Si une partie brise, elle seule montre un message, avec un bouton <b>R\u00e9essayer</b> et un petit code (comme <font face="Courier">RS-9K2Q1-4F2A</font>). Notez le code et dites-le \u00e0 la personne qui s\u2019occupe de la boutique \u2014 il pointe directement au probl\u00e8me. Le reste de la boutique continue de fonctionner. Si la boutique brise trois fois de suite en s\u2019ouvrant, elle d\u00e9marre en mode sans \u00e9chec avec des options de r\u00e9paration au lieu de briser encore et encore.'),
    ('h2', 'Dangerous buttons protect you / Les boutons dangereux vous prot\u00e8gent'),
    ('b', 'Before anything destructive (deleting, voiding a gift card, removing a time punch), the shop quietly saves a small safety copy on the device \u2014 the last 3 are kept. That is a safety net, not a backup: still do Task 8 regularly.'),
    ('b', 'Avant toute action destructive (effacer, annuler une carte-cadeau, enlever un pointage), la boutique enregistre discr\u00e8tement une petite copie de s\u00e9curit\u00e9 sur l\u2019appareil \u2014 les 3 derni\u00e8res sont gard\u00e9es. C\u2019est un filet de s\u00e9curit\u00e9, pas une sauvegarde : faites quand m\u00eame la t\u00e2che 8 r\u00e9guli\u00e8rement.'),
    ('h2', 'Getting help / Obtenir de l\u2019aide'),
    ('b', 'Open <b>Help &amp; Guide</b> from the Start menu (the Start menu is the main menu button of the shop) \u2014 this guide lives there too. From the sign-in screen, you can also send a support message.'),
    ('b', 'Ouvrez <b>Aide &amp; Guide</b> \u00e0 partir du menu D\u00e9marrer (le menu principal de la boutique) \u2014 ce guide s\u2019y trouve aussi. Depuis l\u2019\u00e9cran de connexion, vous pouvez aussi envoyer un message d\u2019assistance.'),
])

# ------------------------------- chapter 5: honest limits
section('Honest limits \u2014 what this shop cannot do', 'Limites honn\u00eates \u2014 ce que cette boutique ne peut pas faire', [
    ('p', 'We would rather tell you the limits than let you discover them. Here they are, plainly.'),
    ('p', 'Nous pr\u00e9f\u00e9rons vous dire les limites plut\u00f4t que vous les laissiez d\u00e9couvrir. Les voici, simplement.'),
    ('b', '<b>No internet, no selling.</b> There is no offline mode on purpose: a sale is only real once it is recorded on the internet. (Task 10 shows what happens.)'),
    ('b', '<b>The public page is a shop window, not a website.</b> Its look is fixed, and customers cannot buy or pay on it. For a full custom website, you need a website tool as well.'),
    ('b', '<b>Loyalty points are \u201cbest effort\u201d.</b> If the power or internet dies at the exact split second between recording a sale and adding points, the sale is safe but the points might not be added.'),
    ('b', '<b>Brand-new gift card glitch (rare).</b> If a gift card is sold and the internet drops at that exact moment, the recorded sale can end up pointing at a card that was cancelled during cleanup. If a customer says a brand-new card does not work, look in History first \u2014 a manager can void that sale.'),
    ('b', '<b>Your sign-in lives in the browser.</b> Whoever can open your unlocked browser on your device is, in practice, signed in as you. Sign out on shared devices. There is no list of \u201cwhich devices are signed in\u201d: signing out works on that device, and if the master account resets your password, you are signed out everywhere at once.'),
    ('b', '<b>Safety copies live on the same device.</b> If the device is lost or wiped, they are gone. Your downloaded backup file (Task 8) is the copy that lives elsewhere \u2014 keep it.'),
    ('b', '<b>Taxes start at zero.</b> Until you set them (see \u201cTaxes\u201d above), no tax is charged at all. Ask your accountant before real selling.'),
    ('b', '<b>Pas d\u2019Internet, pas de vente.</b> Il n\u2019y a pas de mode hors ligne, fait expr\u00e8s : une vente n\u2019est r\u00e9elle qu\u2019une fois enregistr\u00e9e sur Internet. (La t\u00e2che 10 montre ce qui se passe.)'),
    ('b', '<b>La page publique est une vitrine, pas un site Web.</b> Son apparence est fixe, et les clients ne peuvent ni acheter ni payer dessus. Pour un site Web complet sur mesure, il faut aussi un outil de site Web.'),
    ('b', '<b>Les points de fid\u00e9lit\u00e9 sont \u00ab au mieux \u00bb.</b> Si le courant ou Internet coupe \u00e0 la fraction de seconde exacte entre l\u2019enregistrement d\u2019une vente et l\u2019ajout des points, la vente est en s\u00e9curit\u00e9 mais les points pourraient ne pas \u00eatre ajout\u00e9s.'),
    ('b', '<b>P\u00e9pin de carte-cadeau toute neuve (rare).</b> Si une carte-cadeau est vendue et qu\u2019Internet coupe \u00e0 ce moment exact, la vente enregistr\u00e9e peut finir par pointer vers une carte annul\u00e9e pendant le nettoyage. Si un client dit qu\u2019une carte toute neuve ne fonctionne pas, regardez d\u2019abord dans l\u2019Historique \u2014 un g\u00e9rant peut annuler cette vente.'),
    ('b', '<b>Votre connexion vit dans le navigateur.</b> Quiconque peut ouvrir votre navigateur d\u00e9verrouill\u00e9 sur votre appareil est, en pratique, connect\u00e9 sous votre nom. D\u00e9connectez-vous sur les appareils partag\u00e9s. Il n\u2019y a pas de liste \u00ab quels appareils sont connect\u00e9s \u00bb : se d\u00e9connecter fonctionne sur cet appareil, et si le compte ma\u00eetre r\u00e9initialise votre mot de passe, vous \u00eates d\u00e9connect\u00e9 partout d\u2019un coup.'),
    ('b', '<b>Les copies de s\u00e9curit\u00e9 vivent sur le m\u00eame appareil.</b> Si l\u2019appareil est perdu ou effac\u00e9, elles disparaissent. Votre fichier de sauvegarde t\u00e9l\u00e9charg\u00e9 (t\u00e2che 8) est la copie qui vit ailleurs \u2014 gardez-le.'),
    ('b', '<b>Les taxes commencent \u00e0 z\u00e9ro.</b> Tant que vous ne les avez pas r\u00e9gl\u00e9es (voir \u00ab Taxes \u00bb plus haut), aucune taxe n\u2019est per\u00e7ue. Demandez \u00e0 votre comptable avant de vendre pour vrai.'),
])

# ------------------------------- appendix: technical install
section('Appendix \u2014 Installing on your own backend (technical)', 'Annexe \u2014 Installation sur votre propre serveur (technique)', [
    ('p', 'This appendix is for the person installing the shop the very first time. It is the only technical part of this guide. '
          'If someone installed the shop for you, you can skip it.'),
    ('p', 'Cette annexe est pour la personne qui installe la boutique la toute premi\u00e8re fois. C\u2019est la seule partie technique de ce guide. '
          'Si quelqu\u2019un a install\u00e9 la boutique pour vous, vous pouvez la sauter.'),
    ('step', 1, 'Create a free project at supabase.com (Dashboard \u2014 New project). This is the shop\u2019s \u201ccloud\u201d: where everything is saved.'),
    ('step', 2, 'Open the SQL editor and run every file in supabase/migrations/ in order, from 001 to the latest. One of them (056) creates the built-in master account (admin / admin123, see Task 1); another (057) adds the factory reset; 063 adds the public storefront page tables.'),
    ('step', 3, 'Copy the project URL and the anon key (Project Settings \u2014 API) into a .env file as VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example).'),
    ('step', 4, 'Run: npm install, then npm run build. Put the dist/ folder on any static host.'),
    ('step', 5, 'Open the shop and do Task 1 immediately \u2014 change the master password before anything else.'),
    ('frstep', 1, 'Cr\u00e9ez un projet gratuit sur supabase.com (Dashboard \u2014 New project). C\u2019est le \u00ab nuage \u00bb de la boutique : l\u00e0 o\u00f9 tout est enregistr\u00e9.'),
    ('frstep', 2, 'Ouvrez l\u2019\u00e9diteur SQL et ex\u00e9cutez chaque fichier de supabase/migrations/ dans l\u2019ordre, de 001 au plus r\u00e9cent. L\u2019un d\u2019eux (056) cr\u00e9e le compte ma\u00eetre int\u00e9gr\u00e9 (admin / admin123, voir la t\u00e2che 1); un autre (057) ajoute la r\u00e9initialisation d\u2019usine; 063 ajoute les tables de la page publique.'),
    ('frstep', 3, 'Copiez l\u2019URL du projet et la cl\u00e9 anon (Project Settings \u2014 API) dans un fichier .env : VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY (voir .env.example).'),
    ('frstep', 4, 'Ex\u00e9cutez : npm install, puis npm run build. Placez le dossier dist/ sur n\u2019importe quel h\u00e9bergeur statique.'),
    ('frstep', 5, 'Ouvrez la boutique et faites la t\u00e2che 1 imm\u00e9diatement \u2014 changez le mot de passe ma\u00eetre avant tout le reste.'),
    ('b', 'Rebranding note: the master account\u2019s email must match BRAND.accountsDomain in src/lib/brand.js. If you change the domain, update the email in migration 056 before running it (plain usernames are turned into <font face="Courier">&lt;username&gt;@&lt;domain&gt;</font> at sign-in).'),
    ('b', 'Note de personnalisation : le courriel du compte ma\u00eetre doit correspondre \u00e0 BRAND.accountsDomain dans src/lib/brand.js. Si vous changez de domaine, mettez \u00e0 jour le courriel dans la migration 056 avant de l\u2019ex\u00e9cuter (les noms d\u2019utilisateur simples sont transform\u00e9s en <font face="Courier">&lt;nom&gt;@&lt;domaine&gt;</font> \u00e0 la connexion).'),
])

# ============================================================ ES scaffold
# TODO(translation): ES + PT-BR scaffold sections. Every content string is
# 'TODO[ES] ' / 'TODO[PT] ' followed by the English source string. The final
# pass replaces the EN text after the marker with the human translation,
# keeping the structure (numbered steps, checkpoints, trouble lines, shot
# placeholders) identical to EN/FR. Do NOT machine-translate these.
section_es('Spanish version — translation draft (fill in)', [
    ('p', 'TODO[ES] This part of the guide is a scaffold for the Spanish translation. Every line below starts with TODO[ES] followed by the English source text. A human translator replaces each TODO[ES] line with the final Spanish text, keeping the same order, the same numbered steps, the same "You should now see" checkpoints and the same trouble lines. Do not delete lines and do not merge steps.'),
    ('p', 'TODO[ES] The screenshots are added when the final app is ready, from the final shipped screens, in Spanish.'),
])
section_es('Cover — Getting started', [
    ('p', 'TODO[ES] Vendra'),
    ('p', 'TODO[ES] Getting started'),
    ('p', 'TODO[ES] Point of sale, catalogue, team and files — in one calm app.'),
    ('p', 'TODO[ES] A step-by-step guide for complete beginners. No experience needed.'),
    ('p', 'TODO[ES] Guide — October 2026'),
])
section_es('Start here — read this first', [
    ('p', 'TODO[ES] Welcome! This guide shows you how to use <b>Vendra</b>, one small step at a time. '
          'You do not need to know anything about computers. Just follow the steps in order, '
          'and look at the pictures.'),
    ('h2', 'TODO[ES] What you need'),
    ('b', 'TODO[ES] A phone, a tablet, or a computer. Any of them works.'),
    ('b', 'TODO[ES] An internet connection. The shop lives on the internet, so your device must be connected.'),
    ('b', 'TODO[ES] The shop’s web address (the link you were given when the shop was set up). '
          'Keep it somewhere safe — you will type it or tap it every time you open the shop.'),
    ('h2', 'TODO[ES] Words we use in this guide'),
    ('p', 'TODO[ES] Every new word is explained here, in plain language. If a word further down is new to you, come back to this list.'),
    ('p', 'TODO[ES] <b>Internet</b> — the worldwide network that connects devices; it is how your shop talks to its saved information.'),
    ('p', 'TODO[ES] <b>Wi-Fi</b> — the wireless way your device connects to the internet at home or at work — it is the signal with the fan-shaped icon.'),
    ('p', 'TODO[ES] <b>Browser</b> — the app you use to visit pages on the internet (it is called Chrome, Safari, Edge or Firefox on most devices).'),
    ('p', 'TODO[ES] <b>Web address (a “link”)</b> — the shop’s address on the internet, like an address for a house. Typing it or tapping it takes you to the shop.'),
    ('p', 'TODO[ES] <b>Tap / click</b> — “tap” means touch once with a finger on a screen; “click” means press once with a mouse. They do the same thing.'),
    ('p', 'TODO[ES] <b>Sign in</b> — telling the shop who you are, so it shows your shop and keeps other people out.'),
    ('p', 'TODO[ES] <b>Password</b> — a secret word only you know. You type it when you sign in, like a key for a lock.'),
    ('p', 'TODO[ES] <b>Settings</b> — the place where you change how the shop behaves — like the dials on a machine.'),
    ('p', 'TODO[ES] <b>Download</b> — saving a copy of a file from the internet onto your device, so you keep it.'),
    ('p', 'TODO[ES] <b>Backup</b> — a safety copy of everything in your shop. If something goes wrong, the backup can put it back.'),
    ('p', 'TODO[ES] <b>The cloud</b> — a short way of saying “saved safely on the internet” instead of only on your device.'),
    ('h2', 'TODO[ES] Opening your shop for the first time'),
    ('esstep', 1, 'TODO[ES] Find the browser icon on your device and tap it. (Look for Chrome, Safari, Edge or Firefox.)'),
    ('esstep', 2, 'TODO[ES] Tap the address bar — the long box at the top of the browser where addresses go.'),
    ['shot:task-start-address.png', 'TODO[ES] The address bar at the top of the browser', 'TODO[ES] The address bar at the top of the browser'],
    ('esstep', 3, 'TODO[ES] Type the shop’s web address exactly as it was given to you, then press Enter (or tap Go).'),
    ('essee', 'TODO[ES] a page that says it is checking the connection, then the sign-in screen.'),
    ('p', 'TODO[ES] [If something goes wrong] If the page says it cannot reach the shop: check that Wi-Fi is on (look for the fan-shaped icon), then tap Retry. If it still fails, wait a minute and try again — the internet itself may be down.'),
    ('h2', 'TODO[ES] Keeping the shop one tap away'),
    ('p', 'TODO[ES] So you do not have to type the address every time, save it once:'),
    ('esstep', 1, 'TODO[ES] Open the shop in your browser (see above).'),
    ('esstep', 2, 'TODO[ES] On a computer: press Ctrl+D (Windows) or Cmd+D (Mac) to bookmark it. On a phone or tablet: open the browser menu (three dots or a share icon) and tap “Add to Home screen” (or “Add bookmark”).'),
    ('esstep', 3, 'TODO[ES] From now on, tap that bookmark or the new home-screen icon to open the shop.'),
    ['shot:task-start-bookmark.png', 'TODO[ES] The browser menu with “Add to Home screen”', 'TODO[ES] The browser menu with “Add to Home screen”'],
])
section_es('Your first day, step by step', [
    ('p', 'TODO[ES] Do these tasks in order the first time. Later, jump straight to the one you need.'),
])
section_es('Task 1 — Sign in for the first time', [
    ('p', 'TODO[ES] When the shop is new, it has one built-in account: the master account. '
          'Its username is <b>admin</b> and its first password is <b>admin123</b>. '
          'You will only use that password once — the shop makes you choose your own right away.'),
    ('esstep', 1, 'TODO[ES] Open the shop (see “Start here”).'),
    ('esstep', 2, 'TODO[ES] In the username box, type <b>admin</b>.'),
    ('esstep', 3, 'TODO[ES] In the password box, type <b>admin123</b>.'),
    ('esstep', 4, 'TODO[ES] Tap <b>Sign in</b>.'),
    ['shot:task1-signin.png', 'TODO[ES] The sign-in screen with admin typed in', 'TODO[ES] The sign-in screen with admin typed in'],
    ('essee', 'TODO[ES] a box asking you to choose a new password. The shop will not open until you do — this is on purpose, so nobody can keep using the first password.'),
    ('esstep', 5, 'TODO[ES] Type a new password of your own. Make it at least 8 characters, and not something easy to guess (not your name, not 123456).'),
    ('esstep', 6, 'TODO[ES] Type the same new password again in the second box.'),
    ('esstep', 7, 'TODO[ES] Tap the confirm button.'),
    ['shot:task1-newpassword.png', 'TODO[ES] The “choose a new password” box', 'TODO[ES] The “choose a new password” box'],
    ('essee', 'TODO[ES] the shop’s main screen (the desktop), with icons for the different parts of the shop.'),
    ('p', 'TODO[ES] [If something goes wrong] <b>“This is a problem with how the system was set up — not your password.”</b> Your password was never even checked. The shop’s own connection settings are wrong. Retyping your password will not help — tell the person who installed the shop.'),
    ('p', 'TODO[ES] [If something goes wrong] If your new password is refused: make it longer, and avoid common or repeating words.'),
])
section_es('Task 2 — Tell the shop what kind of business you run', [
    ('p', 'TODO[ES] Every shop is a little different. A restaurant needs tables and tips; a repair shop needs appointments. '
          'Instead of changing screens one by one, you pick one <b>business type</b> and the shop sets itself up for you. '
          'You can change it later — nothing is lost.'),
    ('esstep', 1, 'TODO[ES] Sign in with the master account (the one from Task 1 — username <b>admin</b>, with the password you chose in Task 1).'),
    ('esstep', 2, 'TODO[ES] Open <b>Settings</b>.'),
    ('esstep', 3, 'TODO[ES] Find <b>Business type</b> and tap it.'),
    ['shot:task2-businesstype.png', 'TODO[ES] Settings with “Business type”', 'TODO[ES] Settings with “Business type”'],
    ('essee', 'TODO[ES] a short list of business types: General, Retail, Restaurant / Food, Services / Appointments, Convenience / Fuel.'),
    ('esstep', 4, 'TODO[ES] Tap the one that matches your shop. Not sure? Pick <b>General</b> — you can change it later.'),
    ('esstep', 5, 'TODO[ES] If the shop asks “Apply?”, tap <b>Apply</b>.'),
    ['shot:task2-presetlist.png', 'TODO[ES] The business type list', 'TODO[ES] The business type list'],
    ('essee', 'TODO[ES] the shop set up for your kind of business (for example, a restaurant sees tables; a repair shop sees appointments up front).'),
    ('p', 'TODO[ES] [If something goes wrong] If you do not see “Business type”: you may not be signed in with the master account. Sign out, then sign in as <b>admin</b> with the password you chose in Task 1.'),
    ('p', 'TODO[ES] [If something goes wrong] Picked the wrong type? Do Task 2 again and pick another. Products, sales and customers are never deleted by changing types.'),
])
section_es('Task 3 — Add a product you sell', [
    ('p', 'TODO[ES] The shop can only sell what it knows. Add each product once; after that, selling it takes two taps.'),
    ('esstep', 1, 'TODO[ES] From the main screen, open <b>Point of Sale</b>.'),
    ('esstep', 2, 'TODO[ES] Tap <b>Add product</b>.'),
    ['shot:task3-addproduct.png', 'TODO[ES] The “Add product” button in Point of Sale', 'TODO[ES] The “Add product” button in Point of Sale'],
    ('essee', 'TODO[ES] a form with empty boxes for the product’s name and price.'),
    ('esstep', 3, 'TODO[ES] Type the product’s name (for example: Coffee).'),
    ('esstep', 4, 'TODO[ES] Type its price (for example: 2.50). Use a dot, not a comma, for cents.'),
    ('esstep', 5, 'TODO[ES] If you keep stock (how many you have), type the number you have now. If not, leave it empty.'),
    ('esstep', 6, 'TODO[ES] Tap <b>Save</b>.'),
    ['shot:task3-productform.png', 'TODO[ES] The product form, filled in', 'TODO[ES] The product form, filled in'],
    ('essee', 'TODO[ES] your product, with its price, in the grid of products.'),
    ('p', 'TODO[ES] [If something goes wrong] If the product does not appear: check that you tapped Save, and that you are looking at the Point of Sale (not the Catalogue — they are two different lists).'),
    ('p', 'TODO[ES] [If something goes wrong] Price looks wrong (250 instead of 2.50)? You typed the price in cents. Edit the product and type 2.50.'),
])
section_es('Task 4 — Make a cash sale', [
    ('p', 'TODO[ES] “Cash sale” means the customer pays you with money (not a card). The shop records the sale either way.'),
    ('esstep', 1, 'TODO[ES] Open <b>Point of Sale</b>.'),
    ('esstep', 2, 'TODO[ES] Tap the product the customer is buying (for example: Coffee).'),
    ('essee', 'TODO[ES] the product appears in the list on the side (the “cart” — what the customer is buying), and the total goes up.'),
    ('esstep', 3, 'TODO[ES] Buying more than one? Tap the product again, or tap the + next to it in the cart.'),
    ('esstep', 4, 'TODO[ES] When everything is in the cart, tap the big <b>Pay / Charge</b> button.'),
    ['shot:task4-posgrid.png', 'TODO[ES] Point of Sale with one product in the cart', 'TODO[ES] Point of Sale with one product in the cart'],
    ('essee', 'TODO[ES] the payment screen, asking how the customer pays.'),
    ('esstep', 5, 'TODO[ES] Tap <b>Cash</b>.'),
    ('esstep', 6, 'TODO[ES] Type how much money the customer hands you (or tap the exact amount).'),
    ('esstep', 7, 'TODO[ES] Tap <b>Complete sale</b>.'),
    ['shot:task4-pay.png', 'TODO[ES] The payment screen with Cash chosen', 'TODO[ES] The payment screen with Cash chosen'],
    ('essee', 'TODO[ES] a receipt, and the change to give back (if any). The sale is saved right away.'),
    ('esstep', 8, 'TODO[ES] Hand the customer their change, and the receipt if they want it. Done!'),
    ('p', 'TODO[ES] [If something goes wrong] Tapped the wrong product? In the cart, tap the − (minus) to remove one, or the trash icon to remove it completely, before you pay.'),
    ('p', 'TODO[ES] [If something goes wrong] If the sale stops with a “could not reach the shop” message: the internet dropped. Your cart is still there — see Task 10. No money was taken.'),
])
section_es('Task 5 — Give a refund', [
    ('p', 'TODO[ES] A refund gives the customer their money back for something they bought. You find the sale first, then refund it.'),
    ('esstep', 1, 'TODO[ES] Open <b>Point of Sale</b>.'),
    ('esstep', 2, 'TODO[ES] Tap <b>History</b>.'),
    ['shot:task5-history.png', 'TODO[ES] The History list of past sales', 'TODO[ES] The History list of past sales'],
    ('essee', 'TODO[ES] the list of past sales, newest first.'),
    ('esstep', 3, 'TODO[ES] Tap the sale you want to refund.'),
    ('essee', 'TODO[ES] the details of that sale.'),
    ('esstep', 4, 'TODO[ES] Tap <b>Refund</b>.'),
    ('esstep', 5, 'TODO[ES] Check the amount. If only part is being returned, change the quantity to what came back.'),
    ('esstep', 6, 'TODO[ES] You may type a reason (why it came back). You can also leave it empty.'),
    ('esstep', 7, 'TODO[ES] Tap <b>Confirm refund</b>.'),
    ['shot:task5-refund.png', 'TODO[ES] The refund box for a sale', 'TODO[ES] The refund box for a sale'],
    ('essee', 'TODO[ES] the sale in History now shows it was refunded. Refunded sales cannot be voided (deleted) afterwards — this is on purpose, so the record stays honest.'),
    ('p', 'TODO[ES] [If something goes wrong] Can’t find the sale? Check you are signed in to the right shop, and scroll — History is newest first.'),
    ('p', 'TODO[ES] [If something goes wrong] Refund button missing? Only owners and managers can refund. Ask the person with the master account.'),
])
section_es('Task 6 — Put your shop on the web (the public page)', [
    ('p', 'TODO[ES] Your shop can have a simple page on the web that anyone can look at: your shop name, what you sell, '
          'your hours and how to reach you. Products you add in the Point of Sale appear on the page by themselves — '
          'you do not type them twice. This page is a shop window, not a full website: visitors cannot buy online there.'),
    ('esstep', 1, 'TODO[ES] Sign in with the master account, or as the shop’s owner/manager.'),
    ('esstep', 2, 'TODO[ES] Open the <b>Admin</b> panel.'),
    ('esstep', 3, 'TODO[ES] Tap the <b>Storefront</b> tab.'),
    ['shot:task6-storefronttab.png', 'TODO[ES] The Admin panel, Storefront tab', 'TODO[ES] The Admin panel, Storefront tab'],
    ('essee', 'TODO[ES] boxes for your public shop name, a short line about your shop (“About”), opening hours, email, phone, and a colour.'),
    ('esstep', 4, 'TODO[ES] Fill in the boxes. Write them for strangers: what you sell, where you are, when you are open.'),
    ('esstep', 5, 'TODO[ES] In the web address box, choose your shop’s address: small letters, numbers and dashes only (for example <font face="Courier">my-shop</font>). Your full public link ends with <font face="Courier">#/store/my-shop</font>.'),
    ('esstep', 6, 'TODO[ES] Turn on <b>Page is published</b>.'),
    ('esstep', 7, 'TODO[ES] Tap <b>Save</b>.'),
    ['shot:task6-publish.png', 'TODO[ES] “Page is published” turned on, with the Save button', 'TODO[ES] “Page is published” turned on, with the Save button'],
    ('essee', 'TODO[ES] your public link, ready to copy.'),
    ('esstep', 8, 'TODO[ES] Tap the link (or copy it) to look at your page the way customers see it.'),
    ['shot:task6-publicpage.png', 'TODO[ES] The public page customers see', 'TODO[ES] The public page customers see'],
    ('essee', 'TODO[ES] your shop page, with your products. (To keep one product off the page: in its product settings, set it to Hidden. To hide all prices: turn off “Show prices” in the Storefront tab.)'),
    ('p', 'TODO[ES] [If something goes wrong] The link says “not available yet”: “Page is published” is off, or you did not tap Save after turning it on. Go back to the Storefront tab and check both.'),
    ('p', 'TODO[ES] [If something goes wrong] A product is missing from the page: it is set to Hidden in its product settings, or it is only in the Catalogue (the public page shows Point of Sale products).'),
])
section_es('Task 7 — Make the till easy to touch (tablets and phones)', [
    ('p', 'TODO[ES] If your till is a tablet or a phone, small buttons are hard to tap. This setting makes buttons bigger '
          'and the home screen simpler, like a phone’s. Turn it on for each device that needs it — it only changes that device.'),
    ('esstep', 1, 'TODO[ES] Open <b>Settings</b>.'),
    ('esstep', 2, 'TODO[ES] Tap <b>Appearance</b>.'),
    ('esstep', 3, 'TODO[ES] Turn on <b>Touch screen optimization</b>.'),
    ['shot:task7-touchtoggle.png', 'TODO[ES] “Touch screen optimization” in Settings · Appearance', 'TODO[ES] “Touch screen optimization” in Settings · Appearance'],
    ('essee', 'TODO[ES] the home screen changes: big icons, apps open full-screen, and buttons everywhere are bigger.'),
    ('esstep', 4, 'TODO[ES] Try it: open the Point of Sale and tap a product. Buttons should be easy to hit with a finger.'),
    ('esstep', 5, 'TODO[ES] Want it back the old way? Repeat steps 1–3 and turn it off.'),
    ['shot:task7-touchhome.png', 'TODO[ES] The touch home screen, with big icons', 'TODO[ES] The touch home screen, with big icons'],
    ('p', 'TODO[ES] [If something goes wrong] Nothing changed? The setting applies to this device only, and the home screen changes first. If the till still shows the desktop-style home screen, close and reopen the shop (see “Start here”).'),
])
section_es('Task 8 — Save a backup (do this regularly)', [
    ('p', 'TODO[ES] A backup is one file that holds everything in your account: products, sales, customers, settings. '
          'Save one regularly — for example every Friday — and keep the file somewhere safe, like a USB key or your email. '
          'If anything ever goes badly wrong, this file is how you get your shop back.'),
    ('esstep', 1, 'TODO[ES] Open <b>Settings</b>.'),
    ('esstep', 2, 'TODO[ES] Tap <b>Data</b>.'),
    ('esstep', 3, 'TODO[ES] Tap <b>Download backup</b> (account backup).'),
    ['shot:task8-backup.png', 'TODO[ES] The backup button in Settings · Data', 'TODO[ES] The backup button in Settings · Data'],
    ('essee', 'TODO[ES] a file named like <font face="Courier">drift-backup-2026-10-01.json</font> downloading to your device.'),
    ('esstep', 4, 'TODO[ES] Find the downloaded file (usually in your Downloads folder) and copy it somewhere safe. That is it — done.'),
    ('p', 'TODO[ES] [If something goes wrong] No file appeared? Some browsers block downloads. Look for a small blocked-download icon near the address bar, allow the download, and try again.'),
    ('p', 'TODO[ES] [If something goes wrong] The backup file contains private things (like staff PIN numbers). Keep it like you would keep keys: do not share it publicly.'),
])
section_es('Task 9 — Start completely over (factory reset)', [
    ('p', 'TODO[ES] <b>Warning first.</b> A factory reset <b>deletes everything and everyone</b>: all accounts, products, sales, '
          'customers, appointments, files — gone, as if the shop was brand new. <b>There is no undo.</b> '
          'Only do this if you truly want to start over, or hand the shop to someone else completely empty. '
          'Only the master account (username <b>admin</b>, with the password you chose in Task 1) can do it.'),
    ('esstep', 1, 'TODO[ES] First, do Task 8 (download a backup) and keep the file safe. After a reset, that file is the only way back.'),
    ('esstep', 2, 'TODO[ES] Sign in as <b>admin</b> (master account).'),
    ('esstep', 3, 'TODO[ES] Open the <b>Admin</b> panel.'),
    ('esstep', 4, 'TODO[ES] Scroll to the <b>Danger zone</b> at the bottom.'),
    ('esstep', 5, 'TODO[ES] Tap <b>Factory reset</b>.'),
    ['shot:task9-dangerzone.png', 'TODO[ES] The Danger zone with the Factory reset button', 'TODO[ES] The Danger zone with the Factory reset button'],
    ('essee', 'TODO[ES] a warning box. Before anything is deleted, the shop saves one last backup by itself and downloads it. If that backup fails, the reset stops and nothing is deleted.'),
    ('esstep', 6, 'TODO[ES] Read the warning. Then type the word <b>RESET</b> (in capital letters) in the box.'),
    ('essee', 'TODO[ES] the reset button lights up. It stays off until the word is typed exactly right — this is on purpose, so nobody can tap it by accident.'),
    ('esstep', 7, 'TODO[ES] Tap the reset button, and confirm.'),
    ['shot:task9-typereset.png', 'TODO[ES] Typing RESET to arm the reset button', 'TODO[ES] Typing RESET to arm the reset button'],
    ('essee', 'TODO[ES] you are signed out. The shop is empty and new. Sign in again with <b>admin</b> / <b>admin123</b> and pick a new password (same as Task 1).'),
    ('p', 'TODO[ES] [If something goes wrong] The reset button stays off: the word must be exactly RESET, all capitals, no spaces. Check Caps Lock.'),
    ('p', 'TODO[ES] [If something goes wrong] “PRE-RESET BACKUP FAILED”: the safety backup could not be saved, so the reset did not happen and nothing was deleted. Do Task 8 by hand, then try again.'),
])
section_es('Task 10 — When a sale fails because the internet dropped', [
    ('p', 'TODO[ES] Your shop lives on the internet. Every sale is recorded on the internet the moment it happens. '
          'If the internet drops in the middle of a sale, the sale cannot finish. Here is exactly what happens, and what to do. '
          'Good news first: <b>nobody is charged</b>, and <b>your cart (what the customer is buying) stays on the screen</b>. Nothing is lost.'),
    ('esstep', 1, 'TODO[ES] Read the message on the screen. It will say the shop could not be reached, and the sale did not go through.'),
    ['shot:task10-saleerror.png', 'TODO[ES] The “could not reach the shop” message at checkout', 'TODO[ES] The “could not reach the shop” message at checkout'],
    ('essee', 'TODO[ES] your cart is still there, with every item, exactly as it was.'),
    ('esstep', 2, 'TODO[ES] Check the Wi-Fi: look for the fan-shaped icon on the device. If it is missing or has an “!”, the device lost the internet.'),
    ('esstep', 3, 'TODO[ES] Wait for the internet to come back (the icon returns). This can take a minute after an outage.'),
    ('esstep', 4, 'TODO[ES] Tap <b>Retry</b> (or complete the sale again, the same way as Task 4).'),
    ('essee', 'TODO[ES] the receipt, like a normal sale. The sale is recorded once — retrying does not charge twice.'),
    ('p', 'TODO[ES] [If something goes wrong] If the customer cannot wait: there is no “offline” selling — a sale that never reached the internet simply never happened. Write down what they bought on paper if you like, and ring it in when the internet returns.'),
    ('p', 'TODO[ES] [If something goes wrong] If sales keep failing for a long time, the problem is the internet connection or the shop’s server — not the till. Tell the person who installed the shop.'),
])
section_es('More parts of the shop (in plain words)', [
    ('h2', 'TODO[ES] The Catalogue'),
    ('p', 'TODO[ES] The <b>Catalogue</b> is your stock list: what you have, how many, and where it sits on the shelf. '
          'It is a different list from the Point of Sale products (Task 3). Something in the Catalogue marked “in store” '
          'can be scanned straight into a sale. You can also add many items at once from a spreadsheet file (this is called a CSV file), '
          'and look items up by their barcode/ISBN number. Donations, fair days and special orders (a customer asking you to order something in) '
          'each have their own simple flow.'),
    ('h2', 'TODO[ES] Appointments'),
    ('p', 'TODO[ES] <b>Appointments</b> is a booking book: customers book a time, and two bookings cannot take the same time by accident.'),
    ('h2', 'TODO[ES] Files'),
    ('p', 'TODO[ES] <b>Files</b> keeps your documents and pictures in the shop, and you can search the words inside them.'),
    ('h2', 'TODO[ES] Certificates — the staff time clock'),
    ('p', 'TODO[ES] Staff clock in and out with their own secret number (a PIN — a short number, like a bank card’s). '
          'Managers can fix a punch, make the schedule (two shifts for the same person cannot overlap), and print attestations — '
          'signed papers that prove someone’s hours. Volunteer/community hours are kept separate from paid hours. '
          'Team members are invited with a code and have a role: Owner (can do everything), Manager (almost everything), Cashier (sells).'),
    ('h2', 'TODO[ES] Taxes — read this before your first real sale'),
    ('p', 'TODO[ES] <b>A new shop charges no tax at all</b> until you set it up. That is on purpose, so nobody is charged the wrong tax. '
          'Before selling for real, ask your accountant (the person who does your taxes) two things: what tax percentages apply where you are, '
          'and whether each tax is calculated on the price alone, or on price-plus-the-other-tax. Then, in the Point of Sale settings, type those numbers in, '
          'and press <b>Save</b>. The shop never changes tax numbers by itself. Some organizations pay no tax: they can be marked tax-exempt so their receipts show no tax.'),
    ('h2', 'TODO[ES] Other settings'),
    ('b', 'TODO[ES] Colours and light/dark: Settings · Appearance.'),
    ('b', 'TODO[ES] If someone else changes a setting on another till, your screen picks it up within about a minute. If you are in the middle of typing in a form, your typing is never erased by that.'),
    ('b', 'TODO[ES] When a newer version of the shop is ready, a small message invites you to refresh the page. Nothing is forced on you mid-sale.'),
])
section_es('When something goes wrong', [
    ('p', 'TODO[ES] This shop is built to fail politely: it explains, it never shows a blank page, and it never silently loses a sale. '
          'Here are the bad moments we know about, in plain words.'),
    ('h2', 'TODO[ES] The shop cannot be reached at opening'),
    ('b', 'TODO[ES] Before opening, the shop checks itself. If its own connection settings look wrong (for example a cut-off key), the screen says the setup looks wrong and that no password will work until whoever installed the shop fixes it. If the settings are fine but the server does not answer, the screen says that instead. Either way there is a <b>Retry</b> button — tap it once the internet is back.'),
    ('h2', 'TODO[ES] One part of the shop stops working'),
    ('b', 'TODO[ES] Each part of the shop is walled off from the others. If one part breaks, only that part shows a message, with a <b>Retry</b> button and a short code (like <font face="Courier">RS-9K2Q1-4F2A</font>). Write the code down and tell whoever looks after the shop — it points straight at the problem. The rest of the shop keeps working. If the shop breaks three times in a row while opening, it starts in a safe mode with repair options instead of breaking again and again.'),
    ('h2', 'TODO[ES] Dangerous buttons protect you'),
    ('b', 'TODO[ES] Before anything destructive (deleting, voiding a gift card, removing a time punch), the shop quietly saves a small safety copy on the device — the last 3 are kept. That is a safety net, not a backup: still do Task 8 regularly.'),
    ('h2', 'TODO[ES] Getting help'),
    ('b', 'TODO[ES] Open <b>Help &amp; Guide</b> from the Start menu (the Start menu is the main menu button of the shop) — this guide lives there too. From the sign-in screen, you can also send a support message.'),
])
section_es('Honest limits — what this shop cannot do', [
    ('p', 'TODO[ES] We would rather tell you the limits than let you discover them. Here they are, plainly.'),
    ('b', 'TODO[ES] <b>No internet, no selling.</b> There is no offline mode on purpose: a sale is only real once it is recorded on the internet. (Task 10 shows what happens.)'),
    ('b', 'TODO[ES] <b>The public page is a shop window, not a website.</b> Its look is fixed, and customers cannot buy or pay on it. For a full custom website, you need a website tool as well.'),
    ('b', 'TODO[ES] <b>Loyalty points are “best effort”.</b> If the power or internet dies at the exact split second between recording a sale and adding points, the sale is safe but the points might not be added.'),
    ('b', 'TODO[ES] <b>Brand-new gift card glitch (rare).</b> If a gift card is sold and the internet drops at that exact moment, the recorded sale can end up pointing at a card that was cancelled during cleanup. If a customer says a brand-new card does not work, look in History first — a manager can void that sale.'),
    ('b', 'TODO[ES] <b>Your sign-in lives in the browser.</b> Whoever can open your unlocked browser on your device is, in practice, signed in as you. Sign out on shared devices. There is no list of “which devices are signed in”: signing out works on that device, and if the master account resets your password, you are signed out everywhere at once.'),
    ('b', 'TODO[ES] <b>Safety copies live on the same device.</b> If the device is lost or wiped, they are gone. Your downloaded backup file (Task 8) is the copy that lives elsewhere — keep it.'),
    ('b', 'TODO[ES] <b>Taxes start at zero.</b> Until you set them (see “Taxes” above), no tax is charged at all. Ask your accountant before real selling.'),
])
section_es('Appendix — Installing on your own backend (technical)', [
    ('p', 'TODO[ES] This appendix is for the person installing the shop the very first time. It is the only technical part of this guide. '
          'If someone installed the shop for you, you can skip it.'),
    ('esstep', 1, 'TODO[ES] Create a free project at supabase.com (Dashboard — New project). This is the shop’s “cloud”: where everything is saved.'),
    ('esstep', 2, 'TODO[ES] Open the SQL editor and run every file in supabase/migrations/ in order, from 001 to the latest. One of them (056) creates the built-in master account (admin / admin123, see Task 1); another (057) adds the factory reset; 063 adds the public storefront page tables.'),
    ('esstep', 3, 'TODO[ES] Copy the project URL and the anon key (Project Settings — API) into a .env file as VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example).'),
    ('esstep', 4, 'TODO[ES] Run: npm install, then npm run build. Put the dist/ folder on any static host.'),
    ('esstep', 5, 'TODO[ES] Open the shop and do Task 1 immediately — change the master password before anything else.'),
    ('b', 'TODO[ES] Rebranding note: the master account’s email must match BRAND.accountsDomain in src/lib/brand.js. If you change the domain, update the email in migration 056 before running it (plain usernames are turned into <font face="Courier">&lt;username&gt;@&lt;domain&gt;</font> at sign-in).'),
])
section_es('Closing line', [
    ('p', 'TODO[ES] Vendra — step-by-step guide. The words on the screen always win over this guide.'),
])

# ============================================================ PT-BR scaffold
# TODO(translation): same convention as the ES scaffold above — every
# content string is 'TODO[PT] ' + the English source text, filled in by hand
# at the final pass. Do NOT machine-translate these.
section_pt('Brazilian Portuguese version — translation draft (fill in)', [
    ('p', 'TODO[PT] This part of the guide is a scaffold for the Brazilian Portuguese translation. Every line below starts with TODO[PT] followed by the English source text. A human translator replaces each TODO[PT] line with the final Brazilian Portuguese text, keeping the same order, the same numbered steps, the same "You should now see" checkpoints and the same trouble lines. Do not delete lines and do not merge steps.'),
    ('p', 'TODO[PT] The screenshots are added when the final app is ready, from the final shipped screens, in Brazilian Portuguese.'),
])
section_pt('Cover — Getting started', [
    ('p', 'TODO[PT] Vendra'),
    ('p', 'TODO[PT] Getting started'),
    ('p', 'TODO[PT] Point of sale, catalogue, team and files — in one calm app.'),
    ('p', 'TODO[PT] A step-by-step guide for complete beginners. No experience needed.'),
    ('p', 'TODO[PT] Guide — October 2026'),
])
section_pt('Start here — read this first', [
    ('p', 'TODO[PT] Welcome! This guide shows you how to use <b>Vendra</b>, one small step at a time. '
          'You do not need to know anything about computers. Just follow the steps in order, '
          'and look at the pictures.'),
    ('h2', 'TODO[PT] What you need'),
    ('b', 'TODO[PT] A phone, a tablet, or a computer. Any of them works.'),
    ('b', 'TODO[PT] An internet connection. The shop lives on the internet, so your device must be connected.'),
    ('b', 'TODO[PT] The shop’s web address (the link you were given when the shop was set up). '
          'Keep it somewhere safe — you will type it or tap it every time you open the shop.'),
    ('h2', 'TODO[PT] Words we use in this guide'),
    ('p', 'TODO[PT] Every new word is explained here, in plain language. If a word further down is new to you, come back to this list.'),
    ('p', 'TODO[PT] <b>Internet</b> — the worldwide network that connects devices; it is how your shop talks to its saved information.'),
    ('p', 'TODO[PT] <b>Wi-Fi</b> — the wireless way your device connects to the internet at home or at work — it is the signal with the fan-shaped icon.'),
    ('p', 'TODO[PT] <b>Browser</b> — the app you use to visit pages on the internet (it is called Chrome, Safari, Edge or Firefox on most devices).'),
    ('p', 'TODO[PT] <b>Web address (a “link”)</b> — the shop’s address on the internet, like an address for a house. Typing it or tapping it takes you to the shop.'),
    ('p', 'TODO[PT] <b>Tap / click</b> — “tap” means touch once with a finger on a screen; “click” means press once with a mouse. They do the same thing.'),
    ('p', 'TODO[PT] <b>Sign in</b> — telling the shop who you are, so it shows your shop and keeps other people out.'),
    ('p', 'TODO[PT] <b>Password</b> — a secret word only you know. You type it when you sign in, like a key for a lock.'),
    ('p', 'TODO[PT] <b>Settings</b> — the place where you change how the shop behaves — like the dials on a machine.'),
    ('p', 'TODO[PT] <b>Download</b> — saving a copy of a file from the internet onto your device, so you keep it.'),
    ('p', 'TODO[PT] <b>Backup</b> — a safety copy of everything in your shop. If something goes wrong, the backup can put it back.'),
    ('p', 'TODO[PT] <b>The cloud</b> — a short way of saying “saved safely on the internet” instead of only on your device.'),
    ('h2', 'TODO[PT] Opening your shop for the first time'),
    ('ptstep', 1, 'TODO[PT] Find the browser icon on your device and tap it. (Look for Chrome, Safari, Edge or Firefox.)'),
    ('ptstep', 2, 'TODO[PT] Tap the address bar — the long box at the top of the browser where addresses go.'),
    ['shot:task-start-address.png', 'TODO[PT] The address bar at the top of the browser', 'TODO[PT] The address bar at the top of the browser'],
    ('ptstep', 3, 'TODO[PT] Type the shop’s web address exactly as it was given to you, then press Enter (or tap Go).'),
    ('ptsee', 'TODO[PT] a page that says it is checking the connection, then the sign-in screen.'),
    ('p', 'TODO[PT] [If something goes wrong] If the page says it cannot reach the shop: check that Wi-Fi is on (look for the fan-shaped icon), then tap Retry. If it still fails, wait a minute and try again — the internet itself may be down.'),
    ('h2', 'TODO[PT] Keeping the shop one tap away'),
    ('p', 'TODO[PT] So you do not have to type the address every time, save it once:'),
    ('ptstep', 1, 'TODO[PT] Open the shop in your browser (see above).'),
    ('ptstep', 2, 'TODO[PT] On a computer: press Ctrl+D (Windows) or Cmd+D (Mac) to bookmark it. On a phone or tablet: open the browser menu (three dots or a share icon) and tap “Add to Home screen” (or “Add bookmark”).'),
    ('ptstep', 3, 'TODO[PT] From now on, tap that bookmark or the new home-screen icon to open the shop.'),
    ['shot:task-start-bookmark.png', 'TODO[PT] The browser menu with “Add to Home screen”', 'TODO[PT] The browser menu with “Add to Home screen”'],
])
section_pt('Your first day, step by step', [
    ('p', 'TODO[PT] Do these tasks in order the first time. Later, jump straight to the one you need.'),
])
section_pt('Task 1 — Sign in for the first time', [
    ('p', 'TODO[PT] When the shop is new, it has one built-in account: the master account. '
          'Its username is <b>admin</b> and its first password is <b>admin123</b>. '
          'You will only use that password once — the shop makes you choose your own right away.'),
    ('ptstep', 1, 'TODO[PT] Open the shop (see “Start here”).'),
    ('ptstep', 2, 'TODO[PT] In the username box, type <b>admin</b>.'),
    ('ptstep', 3, 'TODO[PT] In the password box, type <b>admin123</b>.'),
    ('ptstep', 4, 'TODO[PT] Tap <b>Sign in</b>.'),
    ['shot:task1-signin.png', 'TODO[PT] The sign-in screen with admin typed in', 'TODO[PT] The sign-in screen with admin typed in'],
    ('ptsee', 'TODO[PT] a box asking you to choose a new password. The shop will not open until you do — this is on purpose, so nobody can keep using the first password.'),
    ('ptstep', 5, 'TODO[PT] Type a new password of your own. Make it at least 8 characters, and not something easy to guess (not your name, not 123456).'),
    ('ptstep', 6, 'TODO[PT] Type the same new password again in the second box.'),
    ('ptstep', 7, 'TODO[PT] Tap the confirm button.'),
    ['shot:task1-newpassword.png', 'TODO[PT] The “choose a new password” box', 'TODO[PT] The “choose a new password” box'],
    ('ptsee', 'TODO[PT] the shop’s main screen (the desktop), with icons for the different parts of the shop.'),
    ('p', 'TODO[PT] [If something goes wrong] <b>“This is a problem with how the system was set up — not your password.”</b> Your password was never even checked. The shop’s own connection settings are wrong. Retyping your password will not help — tell the person who installed the shop.'),
    ('p', 'TODO[PT] [If something goes wrong] If your new password is refused: make it longer, and avoid common or repeating words.'),
])
section_pt('Task 2 — Tell the shop what kind of business you run', [
    ('p', 'TODO[PT] Every shop is a little different. A restaurant needs tables and tips; a repair shop needs appointments. '
          'Instead of changing screens one by one, you pick one <b>business type</b> and the shop sets itself up for you. '
          'You can change it later — nothing is lost.'),
    ('ptstep', 1, 'TODO[PT] Sign in with the master account (the one from Task 1 — username <b>admin</b>, with the password you chose in Task 1).'),
    ('ptstep', 2, 'TODO[PT] Open <b>Settings</b>.'),
    ('ptstep', 3, 'TODO[PT] Find <b>Business type</b> and tap it.'),
    ['shot:task2-businesstype.png', 'TODO[PT] Settings with “Business type”', 'TODO[PT] Settings with “Business type”'],
    ('ptsee', 'TODO[PT] a short list of business types: General, Retail, Restaurant / Food, Services / Appointments, Convenience / Fuel.'),
    ('ptstep', 4, 'TODO[PT] Tap the one that matches your shop. Not sure? Pick <b>General</b> — you can change it later.'),
    ('ptstep', 5, 'TODO[PT] If the shop asks “Apply?”, tap <b>Apply</b>.'),
    ['shot:task2-presetlist.png', 'TODO[PT] The business type list', 'TODO[PT] The business type list'],
    ('ptsee', 'TODO[PT] the shop set up for your kind of business (for example, a restaurant sees tables; a repair shop sees appointments up front).'),
    ('p', 'TODO[PT] [If something goes wrong] If you do not see “Business type”: you may not be signed in with the master account. Sign out, then sign in as <b>admin</b> with the password you chose in Task 1.'),
    ('p', 'TODO[PT] [If something goes wrong] Picked the wrong type? Do Task 2 again and pick another. Products, sales and customers are never deleted by changing types.'),
])
section_pt('Task 3 — Add a product you sell', [
    ('p', 'TODO[PT] The shop can only sell what it knows. Add each product once; after that, selling it takes two taps.'),
    ('ptstep', 1, 'TODO[PT] From the main screen, open <b>Point of Sale</b>.'),
    ('ptstep', 2, 'TODO[PT] Tap <b>Add product</b>.'),
    ['shot:task3-addproduct.png', 'TODO[PT] The “Add product” button in Point of Sale', 'TODO[PT] The “Add product” button in Point of Sale'],
    ('ptsee', 'TODO[PT] a form with empty boxes for the product’s name and price.'),
    ('ptstep', 3, 'TODO[PT] Type the product’s name (for example: Coffee).'),
    ('ptstep', 4, 'TODO[PT] Type its price (for example: 2.50). Use a dot, not a comma, for cents.'),
    ('ptstep', 5, 'TODO[PT] If you keep stock (how many you have), type the number you have now. If not, leave it empty.'),
    ('ptstep', 6, 'TODO[PT] Tap <b>Save</b>.'),
    ['shot:task3-productform.png', 'TODO[PT] The product form, filled in', 'TODO[PT] The product form, filled in'],
    ('ptsee', 'TODO[PT] your product, with its price, in the grid of products.'),
    ('p', 'TODO[PT] [If something goes wrong] If the product does not appear: check that you tapped Save, and that you are looking at the Point of Sale (not the Catalogue — they are two different lists).'),
    ('p', 'TODO[PT] [If something goes wrong] Price looks wrong (250 instead of 2.50)? You typed the price in cents. Edit the product and type 2.50.'),
])
section_pt('Task 4 — Make a cash sale', [
    ('p', 'TODO[PT] “Cash sale” means the customer pays you with money (not a card). The shop records the sale either way.'),
    ('ptstep', 1, 'TODO[PT] Open <b>Point of Sale</b>.'),
    ('ptstep', 2, 'TODO[PT] Tap the product the customer is buying (for example: Coffee).'),
    ('ptsee', 'TODO[PT] the product appears in the list on the side (the “cart” — what the customer is buying), and the total goes up.'),
    ('ptstep', 3, 'TODO[PT] Buying more than one? Tap the product again, or tap the + next to it in the cart.'),
    ('ptstep', 4, 'TODO[PT] When everything is in the cart, tap the big <b>Pay / Charge</b> button.'),
    ['shot:task4-posgrid.png', 'TODO[PT] Point of Sale with one product in the cart', 'TODO[PT] Point of Sale with one product in the cart'],
    ('ptsee', 'TODO[PT] the payment screen, asking how the customer pays.'),
    ('ptstep', 5, 'TODO[PT] Tap <b>Cash</b>.'),
    ('ptstep', 6, 'TODO[PT] Type how much money the customer hands you (or tap the exact amount).'),
    ('ptstep', 7, 'TODO[PT] Tap <b>Complete sale</b>.'),
    ['shot:task4-pay.png', 'TODO[PT] The payment screen with Cash chosen', 'TODO[PT] The payment screen with Cash chosen'],
    ('ptsee', 'TODO[PT] a receipt, and the change to give back (if any). The sale is saved right away.'),
    ('ptstep', 8, 'TODO[PT] Hand the customer their change, and the receipt if they want it. Done!'),
    ('p', 'TODO[PT] [If something goes wrong] Tapped the wrong product? In the cart, tap the − (minus) to remove one, or the trash icon to remove it completely, before you pay.'),
    ('p', 'TODO[PT] [If something goes wrong] If the sale stops with a “could not reach the shop” message: the internet dropped. Your cart is still there — see Task 10. No money was taken.'),
])
section_pt('Task 5 — Give a refund', [
    ('p', 'TODO[PT] A refund gives the customer their money back for something they bought. You find the sale first, then refund it.'),
    ('ptstep', 1, 'TODO[PT] Open <b>Point of Sale</b>.'),
    ('ptstep', 2, 'TODO[PT] Tap <b>History</b>.'),
    ['shot:task5-history.png', 'TODO[PT] The History list of past sales', 'TODO[PT] The History list of past sales'],
    ('ptsee', 'TODO[PT] the list of past sales, newest first.'),
    ('ptstep', 3, 'TODO[PT] Tap the sale you want to refund.'),
    ('ptsee', 'TODO[PT] the details of that sale.'),
    ('ptstep', 4, 'TODO[PT] Tap <b>Refund</b>.'),
    ('ptstep', 5, 'TODO[PT] Check the amount. If only part is being returned, change the quantity to what came back.'),
    ('ptstep', 6, 'TODO[PT] You may type a reason (why it came back). You can also leave it empty.'),
    ('ptstep', 7, 'TODO[PT] Tap <b>Confirm refund</b>.'),
    ['shot:task5-refund.png', 'TODO[PT] The refund box for a sale', 'TODO[PT] The refund box for a sale'],
    ('ptsee', 'TODO[PT] the sale in History now shows it was refunded. Refunded sales cannot be voided (deleted) afterwards — this is on purpose, so the record stays honest.'),
    ('p', 'TODO[PT] [If something goes wrong] Can’t find the sale? Check you are signed in to the right shop, and scroll — History is newest first.'),
    ('p', 'TODO[PT] [If something goes wrong] Refund button missing? Only owners and managers can refund. Ask the person with the master account.'),
])
section_pt('Task 6 — Put your shop on the web (the public page)', [
    ('p', 'TODO[PT] Your shop can have a simple page on the web that anyone can look at: your shop name, what you sell, '
          'your hours and how to reach you. Products you add in the Point of Sale appear on the page by themselves — '
          'you do not type them twice. This page is a shop window, not a full website: visitors cannot buy online there.'),
    ('ptstep', 1, 'TODO[PT] Sign in with the master account, or as the shop’s owner/manager.'),
    ('ptstep', 2, 'TODO[PT] Open the <b>Admin</b> panel.'),
    ('ptstep', 3, 'TODO[PT] Tap the <b>Storefront</b> tab.'),
    ['shot:task6-storefronttab.png', 'TODO[PT] The Admin panel, Storefront tab', 'TODO[PT] The Admin panel, Storefront tab'],
    ('ptsee', 'TODO[PT] boxes for your public shop name, a short line about your shop (“About”), opening hours, email, phone, and a colour.'),
    ('ptstep', 4, 'TODO[PT] Fill in the boxes. Write them for strangers: what you sell, where you are, when you are open.'),
    ('ptstep', 5, 'TODO[PT] In the web address box, choose your shop’s address: small letters, numbers and dashes only (for example <font face="Courier">my-shop</font>). Your full public link ends with <font face="Courier">#/store/my-shop</font>.'),
    ('ptstep', 6, 'TODO[PT] Turn on <b>Page is published</b>.'),
    ('ptstep', 7, 'TODO[PT] Tap <b>Save</b>.'),
    ['shot:task6-publish.png', 'TODO[PT] “Page is published” turned on, with the Save button', 'TODO[PT] “Page is published” turned on, with the Save button'],
    ('ptsee', 'TODO[PT] your public link, ready to copy.'),
    ('ptstep', 8, 'TODO[PT] Tap the link (or copy it) to look at your page the way customers see it.'),
    ['shot:task6-publicpage.png', 'TODO[PT] The public page customers see', 'TODO[PT] The public page customers see'],
    ('ptsee', 'TODO[PT] your shop page, with your products. (To keep one product off the page: in its product settings, set it to Hidden. To hide all prices: turn off “Show prices” in the Storefront tab.)'),
    ('p', 'TODO[PT] [If something goes wrong] The link says “not available yet”: “Page is published” is off, or you did not tap Save after turning it on. Go back to the Storefront tab and check both.'),
    ('p', 'TODO[PT] [If something goes wrong] A product is missing from the page: it is set to Hidden in its product settings, or it is only in the Catalogue (the public page shows Point of Sale products).'),
])
section_pt('Task 7 — Make the till easy to touch (tablets and phones)', [
    ('p', 'TODO[PT] If your till is a tablet or a phone, small buttons are hard to tap. This setting makes buttons bigger '
          'and the home screen simpler, like a phone’s. Turn it on for each device that needs it — it only changes that device.'),
    ('ptstep', 1, 'TODO[PT] Open <b>Settings</b>.'),
    ('ptstep', 2, 'TODO[PT] Tap <b>Appearance</b>.'),
    ('ptstep', 3, 'TODO[PT] Turn on <b>Touch screen optimization</b>.'),
    ['shot:task7-touchtoggle.png', 'TODO[PT] “Touch screen optimization” in Settings · Appearance', 'TODO[PT] “Touch screen optimization” in Settings · Appearance'],
    ('ptsee', 'TODO[PT] the home screen changes: big icons, apps open full-screen, and buttons everywhere are bigger.'),
    ('ptstep', 4, 'TODO[PT] Try it: open the Point of Sale and tap a product. Buttons should be easy to hit with a finger.'),
    ('ptstep', 5, 'TODO[PT] Want it back the old way? Repeat steps 1–3 and turn it off.'),
    ['shot:task7-touchhome.png', 'TODO[PT] The touch home screen, with big icons', 'TODO[PT] The touch home screen, with big icons'],
    ('p', 'TODO[PT] [If something goes wrong] Nothing changed? The setting applies to this device only, and the home screen changes first. If the till still shows the desktop-style home screen, close and reopen the shop (see “Start here”).'),
])
section_pt('Task 8 — Save a backup (do this regularly)', [
    ('p', 'TODO[PT] A backup is one file that holds everything in your account: products, sales, customers, settings. '
          'Save one regularly — for example every Friday — and keep the file somewhere safe, like a USB key or your email. '
          'If anything ever goes badly wrong, this file is how you get your shop back.'),
    ('ptstep', 1, 'TODO[PT] Open <b>Settings</b>.'),
    ('ptstep', 2, 'TODO[PT] Tap <b>Data</b>.'),
    ('ptstep', 3, 'TODO[PT] Tap <b>Download backup</b> (account backup).'),
    ['shot:task8-backup.png', 'TODO[PT] The backup button in Settings · Data', 'TODO[PT] The backup button in Settings · Data'],
    ('ptsee', 'TODO[PT] a file named like <font face="Courier">drift-backup-2026-10-01.json</font> downloading to your device.'),
    ('ptstep', 4, 'TODO[PT] Find the downloaded file (usually in your Downloads folder) and copy it somewhere safe. That is it — done.'),
    ('p', 'TODO[PT] [If something goes wrong] No file appeared? Some browsers block downloads. Look for a small blocked-download icon near the address bar, allow the download, and try again.'),
    ('p', 'TODO[PT] [If something goes wrong] The backup file contains private things (like staff PIN numbers). Keep it like you would keep keys: do not share it publicly.'),
])
section_pt('Task 9 — Start completely over (factory reset)', [
    ('p', 'TODO[PT] <b>Warning first.</b> A factory reset <b>deletes everything and everyone</b>: all accounts, products, sales, '
          'customers, appointments, files — gone, as if the shop was brand new. <b>There is no undo.</b> '
          'Only do this if you truly want to start over, or hand the shop to someone else completely empty. '
          'Only the master account (username <b>admin</b>, with the password you chose in Task 1) can do it.'),
    ('ptstep', 1, 'TODO[PT] First, do Task 8 (download a backup) and keep the file safe. After a reset, that file is the only way back.'),
    ('ptstep', 2, 'TODO[PT] Sign in as <b>admin</b> (master account).'),
    ('ptstep', 3, 'TODO[PT] Open the <b>Admin</b> panel.'),
    ('ptstep', 4, 'TODO[PT] Scroll to the <b>Danger zone</b> at the bottom.'),
    ('ptstep', 5, 'TODO[PT] Tap <b>Factory reset</b>.'),
    ['shot:task9-dangerzone.png', 'TODO[PT] The Danger zone with the Factory reset button', 'TODO[PT] The Danger zone with the Factory reset button'],
    ('ptsee', 'TODO[PT] a warning box. Before anything is deleted, the shop saves one last backup by itself and downloads it. If that backup fails, the reset stops and nothing is deleted.'),
    ('ptstep', 6, 'TODO[PT] Read the warning. Then type the word <b>RESET</b> (in capital letters) in the box.'),
    ('ptsee', 'TODO[PT] the reset button lights up. It stays off until the word is typed exactly right — this is on purpose, so nobody can tap it by accident.'),
    ('ptstep', 7, 'TODO[PT] Tap the reset button, and confirm.'),
    ['shot:task9-typereset.png', 'TODO[PT] Typing RESET to arm the reset button', 'TODO[PT] Typing RESET to arm the reset button'],
    ('ptsee', 'TODO[PT] you are signed out. The shop is empty and new. Sign in again with <b>admin</b> / <b>admin123</b> and pick a new password (same as Task 1).'),
    ('p', 'TODO[PT] [If something goes wrong] The reset button stays off: the word must be exactly RESET, all capitals, no spaces. Check Caps Lock.'),
    ('p', 'TODO[PT] [If something goes wrong] “PRE-RESET BACKUP FAILED”: the safety backup could not be saved, so the reset did not happen and nothing was deleted. Do Task 8 by hand, then try again.'),
])
section_pt('Task 10 — When a sale fails because the internet dropped', [
    ('p', 'TODO[PT] Your shop lives on the internet. Every sale is recorded on the internet the moment it happens. '
          'If the internet drops in the middle of a sale, the sale cannot finish. Here is exactly what happens, and what to do. '
          'Good news first: <b>nobody is charged</b>, and <b>your cart (what the customer is buying) stays on the screen</b>. Nothing is lost.'),
    ('ptstep', 1, 'TODO[PT] Read the message on the screen. It will say the shop could not be reached, and the sale did not go through.'),
    ['shot:task10-saleerror.png', 'TODO[PT] The “could not reach the shop” message at checkout', 'TODO[PT] The “could not reach the shop” message at checkout'],
    ('ptsee', 'TODO[PT] your cart is still there, with every item, exactly as it was.'),
    ('ptstep', 2, 'TODO[PT] Check the Wi-Fi: look for the fan-shaped icon on the device. If it is missing or has an “!”, the device lost the internet.'),
    ('ptstep', 3, 'TODO[PT] Wait for the internet to come back (the icon returns). This can take a minute after an outage.'),
    ('ptstep', 4, 'TODO[PT] Tap <b>Retry</b> (or complete the sale again, the same way as Task 4).'),
    ('ptsee', 'TODO[PT] the receipt, like a normal sale. The sale is recorded once — retrying does not charge twice.'),
    ('p', 'TODO[PT] [If something goes wrong] If the customer cannot wait: there is no “offline” selling — a sale that never reached the internet simply never happened. Write down what they bought on paper if you like, and ring it in when the internet returns.'),
    ('p', 'TODO[PT] [If something goes wrong] If sales keep failing for a long time, the problem is the internet connection or the shop’s server — not the till. Tell the person who installed the shop.'),
])
section_pt('More parts of the shop (in plain words)', [
    ('h2', 'TODO[PT] The Catalogue'),
    ('p', 'TODO[PT] The <b>Catalogue</b> is your stock list: what you have, how many, and where it sits on the shelf. '
          'It is a different list from the Point of Sale products (Task 3). Something in the Catalogue marked “in store” '
          'can be scanned straight into a sale. You can also add many items at once from a spreadsheet file (this is called a CSV file), '
          'and look items up by their barcode/ISBN number. Donations, fair days and special orders (a customer asking you to order something in) '
          'each have their own simple flow.'),
    ('h2', 'TODO[PT] Appointments'),
    ('p', 'TODO[PT] <b>Appointments</b> is a booking book: customers book a time, and two bookings cannot take the same time by accident.'),
    ('h2', 'TODO[PT] Files'),
    ('p', 'TODO[PT] <b>Files</b> keeps your documents and pictures in the shop, and you can search the words inside them.'),
    ('h2', 'TODO[PT] Certificates — the staff time clock'),
    ('p', 'TODO[PT] Staff clock in and out with their own secret number (a PIN — a short number, like a bank card’s). '
          'Managers can fix a punch, make the schedule (two shifts for the same person cannot overlap), and print attestations — '
          'signed papers that prove someone’s hours. Volunteer/community hours are kept separate from paid hours. '
          'Team members are invited with a code and have a role: Owner (can do everything), Manager (almost everything), Cashier (sells).'),
    ('h2', 'TODO[PT] Taxes — read this before your first real sale'),
    ('p', 'TODO[PT] <b>A new shop charges no tax at all</b> until you set it up. That is on purpose, so nobody is charged the wrong tax. '
          'Before selling for real, ask your accountant (the person who does your taxes) two things: what tax percentages apply where you are, '
          'and whether each tax is calculated on the price alone, or on price-plus-the-other-tax. Then, in the Point of Sale settings, type those numbers in, '
          'and press <b>Save</b>. The shop never changes tax numbers by itself. Some organizations pay no tax: they can be marked tax-exempt so their receipts show no tax.'),
    ('h2', 'TODO[PT] Other settings'),
    ('b', 'TODO[PT] Colours and light/dark: Settings · Appearance.'),
    ('b', 'TODO[PT] If someone else changes a setting on another till, your screen picks it up within about a minute. If you are in the middle of typing in a form, your typing is never erased by that.'),
    ('b', 'TODO[PT] When a newer version of the shop is ready, a small message invites you to refresh the page. Nothing is forced on you mid-sale.'),
])
section_pt('When something goes wrong', [
    ('p', 'TODO[PT] This shop is built to fail politely: it explains, it never shows a blank page, and it never silently loses a sale. '
          'Here are the bad moments we know about, in plain words.'),
    ('h2', 'TODO[PT] The shop cannot be reached at opening'),
    ('b', 'TODO[PT] Before opening, the shop checks itself. If its own connection settings look wrong (for example a cut-off key), the screen says the setup looks wrong and that no password will work until whoever installed the shop fixes it. If the settings are fine but the server does not answer, the screen says that instead. Either way there is a <b>Retry</b> button — tap it once the internet is back.'),
    ('h2', 'TODO[PT] One part of the shop stops working'),
    ('b', 'TODO[PT] Each part of the shop is walled off from the others. If one part breaks, only that part shows a message, with a <b>Retry</b> button and a short code (like <font face="Courier">RS-9K2Q1-4F2A</font>). Write the code down and tell whoever looks after the shop — it points straight at the problem. The rest of the shop keeps working. If the shop breaks three times in a row while opening, it starts in a safe mode with repair options instead of breaking again and again.'),
    ('h2', 'TODO[PT] Dangerous buttons protect you'),
    ('b', 'TODO[PT] Before anything destructive (deleting, voiding a gift card, removing a time punch), the shop quietly saves a small safety copy on the device — the last 3 are kept. That is a safety net, not a backup: still do Task 8 regularly.'),
    ('h2', 'TODO[PT] Getting help'),
    ('b', 'TODO[PT] Open <b>Help &amp; Guide</b> from the Start menu (the Start menu is the main menu button of the shop) — this guide lives there too. From the sign-in screen, you can also send a support message.'),
])
section_pt('Honest limits — what this shop cannot do', [
    ('p', 'TODO[PT] We would rather tell you the limits than let you discover them. Here they are, plainly.'),
    ('b', 'TODO[PT] <b>No internet, no selling.</b> There is no offline mode on purpose: a sale is only real once it is recorded on the internet. (Task 10 shows what happens.)'),
    ('b', 'TODO[PT] <b>The public page is a shop window, not a website.</b> Its look is fixed, and customers cannot buy or pay on it. For a full custom website, you need a website tool as well.'),
    ('b', 'TODO[PT] <b>Loyalty points are “best effort”.</b> If the power or internet dies at the exact split second between recording a sale and adding points, the sale is safe but the points might not be added.'),
    ('b', 'TODO[PT] <b>Brand-new gift card glitch (rare).</b> If a gift card is sold and the internet drops at that exact moment, the recorded sale can end up pointing at a card that was cancelled during cleanup. If a customer says a brand-new card does not work, look in History first — a manager can void that sale.'),
    ('b', 'TODO[PT] <b>Your sign-in lives in the browser.</b> Whoever can open your unlocked browser on your device is, in practice, signed in as you. Sign out on shared devices. There is no list of “which devices are signed in”: signing out works on that device, and if the master account resets your password, you are signed out everywhere at once.'),
    ('b', 'TODO[PT] <b>Safety copies live on the same device.</b> If the device is lost or wiped, they are gone. Your downloaded backup file (Task 8) is the copy that lives elsewhere — keep it.'),
    ('b', 'TODO[PT] <b>Taxes start at zero.</b> Until you set them (see “Taxes” above), no tax is charged at all. Ask your accountant before real selling.'),
])
section_pt('Appendix — Installing on your own backend (technical)', [
    ('p', 'TODO[PT] This appendix is for the person installing the shop the very first time. It is the only technical part of this guide. '
          'If someone installed the shop for you, you can skip it.'),
    ('ptstep', 1, 'TODO[PT] Create a free project at supabase.com (Dashboard — New project). This is the shop’s “cloud”: where everything is saved.'),
    ('ptstep', 2, 'TODO[PT] Open the SQL editor and run every file in supabase/migrations/ in order, from 001 to the latest. One of them (056) creates the built-in master account (admin / admin123, see Task 1); another (057) adds the factory reset; 063 adds the public storefront page tables.'),
    ('ptstep', 3, 'TODO[PT] Copy the project URL and the anon key (Project Settings — API) into a .env file as VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example).'),
    ('ptstep', 4, 'TODO[PT] Run: npm install, then npm run build. Put the dist/ folder on any static host.'),
    ('ptstep', 5, 'TODO[PT] Open the shop and do Task 1 immediately — change the master password before anything else.'),
    ('b', 'TODO[PT] Rebranding note: the master account’s email must match BRAND.accountsDomain in src/lib/brand.js. If you change the domain, update the email in migration 056 before running it (plain usernames are turned into <font face="Courier">&lt;username&gt;@&lt;domain&gt;</font> at sign-in).'),
])
section_pt('Closing line', [
    ('p', 'TODO[PT] Vendra — step-by-step guide. The words on the screen always win over this guide.'),
])

story.append(Spacer(1, 0.4 * inch))
story.append(P(f'{PRODUCT} \u2014 step-by-step guide. The words on the screen always win over this guide.<br/>'
               f'{PRODUCT} \u2014 guide \u00e9tape par \u00e9tape. Les mots \u00e0 l\u2019\u00e9cran ont toujours le dernier mot sur ce guide.', foot))

doc = SimpleDocTemplate(OUT, pagesize=LETTER,
                        leftMargin=0.9 * inch, rightMargin=0.9 * inch,
                        topMargin=0.8 * inch, bottomMargin=0.8 * inch,
                        title=f'{PRODUCT} \u2014 Getting started',
                        author=PRODUCT)
doc.build(story)
print('wrote', OUT)
