/**
 * Platform-owner (master admin) panel strings, merged into the i18n
 * dictionaries by src/lib/i18n.jsx as the `platform` namespace — same
 * pattern as recovery.js / classifieds.js, kept out of en.js/fr.js so
 * parallel locale work never collides with this file.
 *
 * Key prefix: `platform.*`
 * Plain, beginner-proof wording. French uses the typographic apostrophe ’
 * (codebase convention).
 */
export const platform = {
  en: {
    // ---- free customer tier ----
    freeTierTitle: 'Free customer tier',
    freeTierIntro:
      'Anyone with a free account can post personal classified ads, Kijiji-style. These knobs change the limits live — no rebuild needed.',
    enabledLabel: 'Free listings enabled',
    enabledHint: 'Turn the whole free tier off to pause new personal ads. Existing ads stay visible.',
    maxActiveLabel: 'Max active ads per customer',
    maxActiveHint: 'How many published, non-expired ads one person can have at once.',
    maxPerDayLabel: 'Max new ads per customer per day',
    maxPerDayHint: 'Drafts count too, so nobody can dodge it by draft-spamming.',
    expiryDaysLabel: 'Ad expiry (days)',
    expiryDaysHint: 'Published personal ads expire after this long. People can renew them.',
    // ---- account recovery ----
    recoveryTitle: 'Account recovery',
    recoveryIntro:
      'Recovery works without email: one-time recovery codes, security questions, and shop-owner assisted resets.',
    recoveryEnabledLabel: 'Account recovery enabled',
    recoveryEnabledHint: 'Master kill-switch. When off, nobody can generate codes or set questions, and the forgot-password dialog hides those options.',
    codesCountLabel: 'Recovery codes per user',
    codesCountHint: 'How many one-time codes are generated. 4–16.',
    maxAttemptsLabel: 'Max failed attempts',
    maxAttemptsHint: 'Failed recovery attempts before a temporary lockout.',
    windowMinutesLabel: 'Lockout window (minutes)',
    windowMinutesHint: 'How long the lockout lasts after too many failed attempts.',
    recoveryStats: '{codes} people have recovery codes · {questions} people set security questions',
    resetRecoveryTitle: 'Reset someone’s recovery',
    resetRecoveryHint:
      'Wipes their recovery codes and security questions so they can set them up again. You cannot reset the master account this way.',
    resetRecoveryPh: 'Username',
    resetRecoveryBtn: 'Find & reset',
    resetRecoveryConfirm: 'Wipe recovery codes and security questions for “{name}”? They will need to set them up again.',
    resetRecoveryDone: 'Recovery reset for {name}.',
    resetRecoveryError: 'Could not reset recovery.',
    userNotFound: 'No account with that username.',
    // ---- classifieds moderation ----
    modTitle: 'Classifieds moderation',
    modIntro:
      'Every personal ad on the platform, newest first. Remove anything abusive or spammy — removals are permanent.',
    modSearchPh: 'Search ads or usernames…',
    modNoAds: 'No customer ads found.',
    modRemove: 'Remove',
    modRemoveConfirm: 'Permanently remove “{title}”?',
    modRemoved: 'Ad removed.',
    modRemoveError: 'Could not remove the ad.',
    modPostedBy: 'by {user}',
    modShowing: 'Showing {n} of {total}',
    modLoadMore: 'Load more',
    // ---- shared ----
    save: 'Save settings',
    saved: 'Settings saved — they take effect immediately.',
    saveError: 'Could not save settings.',
    loadError: 'Could not load platform settings.',
    needsUpdate:
      'Platform controls need a small database update first. Nothing is lost — ask your host to apply the latest migration and come back.',
    cancel: 'Cancel',
    confirm: 'Confirm',
  },
  fr: {
    // ---- niveau gratuit ----
    freeTierTitle: 'Niveau gratuit',
    freeTierIntro:
      'Toute personne avec un compte gratuit peut publier des petites annonces personnelles, style Kijiji. Ces réglages modifient les limites en direct — aucune reconstruction requise.',
    enabledLabel: 'Annonces gratuites activées',
    enabledHint: 'Désactivez tout le niveau gratuit pour suspendre les nouvelles annonces personnelles. Les annonces existantes restent visibles.',
    maxActiveLabel: 'Annonces actives max par personne',
    maxActiveHint: 'Combien d’annonces publiées et non expirées une personne peut avoir à la fois.',
    maxPerDayLabel: 'Nouvelles annonces max par personne et par jour',
    maxPerDayHint: 'Les brouillons comptent aussi, pour éviter le contournement par brouillons.',
    expiryDaysLabel: 'Expiration des annonces (jours)',
    expiryDaysHint: 'Les annonces personnelles publiées expirent après ce délai. On peut les renouveler.',
    // ---- récupération de compte ----
    recoveryTitle: 'Récupération de compte',
    recoveryIntro:
      'La récupération fonctionne sans courriel : codes de récupération à usage unique, questions de sécurité et réinitialisation assistée par le propriétaire de la boutique.',
    recoveryEnabledLabel: 'Récupération de compte activée',
    recoveryEnabledHint: 'Interrupteur maître. Quand c’est désactivé, personne ne peut générer de codes ni définir de questions, et la boîte « mot de passe oublié » masque ces options.',
    codesCountLabel: 'Codes de récupération par utilisateur',
    codesCountHint: 'Combien de codes à usage unique sont générés. 4 à 16.',
    maxAttemptsLabel: 'Tentatives échouées max',
    maxAttemptsHint: 'Tentatives de récupération échouées avant un verrouillage temporaire.',
    windowMinutesLabel: 'Durée du verrouillage (minutes)',
    windowMinutesHint: 'Combien de temps dure le verrouillage après trop de tentatives échouées.',
    recoveryStats: '{codes} personnes ont des codes de récupération · {questions} personnes ont défini des questions de sécurité',
    resetRecoveryTitle: 'Réinitialiser la récupération de quelqu’un',
    resetRecoveryHint:
      'Efface ses codes de récupération et ses questions de sécurité pour qu’il puisse les redéfinir. Impossible de réinitialiser le compte maître ainsi.',
    resetRecoveryPh: 'Nom d’utilisateur',
    resetRecoveryBtn: 'Chercher et réinitialiser',
    resetRecoveryConfirm: 'Effacer les codes de récupération et les questions de sécurité de « {name} » ? Il devra les redéfinir.',
    resetRecoveryDone: 'Récupération réinitialisée pour {name}.',
    resetRecoveryError: 'Impossible de réinitialiser la récupération.',
    userNotFound: 'Aucun compte avec ce nom d’utilisateur.',
    // ---- modération des annonces ----
    modTitle: 'Modération des annonces',
    modIntro:
      'Toutes les annonces personnelles de la plateforme, les plus récentes d’abord. Supprimez tout contenu abusif ou indésirable — les suppressions sont définitives.',
    modSearchPh: 'Rechercher annonces ou utilisateurs…',
    modNoAds: 'Aucune annonce personnelle trouvée.',
    modRemove: 'Supprimer',
    modRemoveConfirm: 'Supprimer définitivement « {title} » ?',
    modRemoved: 'Annonce supprimée.',
    modRemoveError: 'Impossible de supprimer l’annonce.',
    modPostedBy: 'par {user}',
    modShowing: '{n} sur {total} affichées',
    modLoadMore: 'Afficher plus',
    // ---- commun ----
    save: 'Enregistrer',
    saved: 'Réglages enregistrés — ils s’appliquent immédiatement.',
    saveError: 'Impossible d’enregistrer les réglages.',
    loadError: 'Impossible de charger les réglages de la plateforme.',
    needsUpdate:
      'Les contrôles de la plateforme nécessitent d’abord une petite mise à jour de la base de données. Rien n’est perdu — demandez à votre hébergeur d’appliquer la dernière migration et revenez.',
    cancel: 'Annuler',
    confirm: 'Confirmer',
  },
  es: {
    // ---- nivel gratuito ----
    freeTierTitle: 'Nivel gratuito',
    freeTierIntro:
      'Cualquiera con una cuenta gratuita puede publicar anuncios personales, estilo Kijiji. Estos controles cambian los límites en vivo — sin reconstruir nada.',
    enabledLabel: 'Anuncios gratuitos activados',
    enabledHint: 'Apaga todo el nivel gratuito para pausar nuevos anuncios personales. Los existentes siguen visibles.',
    maxActiveLabel: 'Anuncios activos máx. por persona',
    maxActiveHint: 'Cuántos anuncios publicados y no vencidos puede tener una persona a la vez.',
    maxPerDayLabel: 'Anuncios nuevos máx. por persona y por día',
    maxPerDayHint: 'Los borradores también cuentan, para evitar trampas con borradores.',
    expiryDaysLabel: 'Vencimiento de anuncios (días)',
    expiryDaysHint: 'Los anuncios personales publicados vencen tras este tiempo. Se pueden renovar.',
    // ---- recuperación de cuenta ----
    recoveryTitle: 'Recuperación de cuenta',
    recoveryIntro:
      'La recuperación funciona sin correo: códigos de un solo uso, preguntas de seguridad y restablecimiento asistido por el dueño de la tienda.',
    recoveryEnabledLabel: 'Recuperación de cuenta activada',
    recoveryEnabledHint: 'Interruptor maestro. Apagado, nadie puede generar códigos ni definir preguntas, y el diálogo de contraseña olvidada oculta esas opciones.',
    codesCountLabel: 'Códigos de recuperación por usuario',
    codesCountHint: 'Cuántos códigos de un solo uso se generan. 4–16.',
    maxAttemptsLabel: 'Intentos fallidos máx.',
    maxAttemptsHint: 'Intentos de recuperación fallidos antes de un bloqueo temporal.',
    windowMinutesLabel: 'Duración del bloqueo (minutos)',
    windowMinutesHint: 'Cuánto dura el bloqueo tras demasiados intentos fallidos.',
    recoveryStats: '{codes} personas tienen códigos de recuperación · {questions} personas definieron preguntas de seguridad',
    resetRecoveryTitle: 'Restablecer la recuperación de alguien',
    resetRecoveryHint:
      'Borra sus códigos y preguntas de seguridad para que pueda configurarlos de nuevo. No puedes restablecer la cuenta maestra así.',
    resetRecoveryPh: 'Nombre de usuario',
    resetRecoveryBtn: 'Buscar y restablecer',
    resetRecoveryConfirm: '¿Borrar los códigos de recuperación y las preguntas de seguridad de «{name}»? Tendrá que configurarlos de nuevo.',
    resetRecoveryDone: 'Recuperación restablecida para {name}.',
    resetRecoveryError: 'No se pudo restablecer la recuperación.',
    userNotFound: 'Ninguna cuenta con ese nombre de usuario.',
    // ---- moderación de anuncios ----
    modTitle: 'Moderación de anuncios',
    modIntro:
      'Todos los anuncios personales de la plataforma, los más recientes primero. Elimina lo abusivo o spam — las eliminaciones son permanentes.',
    modSearchPh: 'Buscar anuncios o usuarios…',
    modNoAds: 'No se encontraron anuncios personales.',
    modRemove: 'Eliminar',
    modRemoveConfirm: '¿Eliminar permanentemente «{title}»?',
    modRemoved: 'Anuncio eliminado.',
    modRemoveError: 'No se pudo eliminar el anuncio.',
    modPostedBy: 'por {user}',
    modShowing: 'Mostrando {n} de {total}',
    modLoadMore: 'Cargar más',
    // ---- común ----
    save: 'Guardar ajustes',
    saved: 'Ajustes guardados — tienen efecto inmediato.',
    saveError: 'No se pudieron guardar los ajustes.',
    loadError: 'No se pudieron cargar los ajustes de la plataforma.',
    needsUpdate:
      'Los controles de la plataforma necesitan primero una pequeña actualización de la base de datos. No se pierde nada — pide a tu anfitrión que aplique la última migración y vuelve.',
    cancel: 'Cancelar',
    confirm: 'Confirmar',
  },
  pt: {
    // ---- nível gratuito ----
    freeTierTitle: 'Nível gratuito',
    freeTierIntro:
      'Qualquer pessoa com conta gratuita pode publicar anúncios pessoais, estilo Kijiji. Estes controles mudam os limites ao vivo — sem reconstruir nada.',
    enabledLabel: 'Anúncios gratuitos ativados',
    enabledHint: 'Desligue todo o nível gratuito para pausar novos anúncios pessoais. Os existentes continuam visíveis.',
    maxActiveLabel: 'Anúncios ativos máx. por pessoa',
    maxActiveHint: 'Quantos anúncios publicados e não expirados uma pessoa pode ter por vez.',
    maxPerDayLabel: 'Novos anúncios máx. por pessoa e por dia',
    maxPerDayHint: 'Rascunhos também contam, para evitar trapaças com rascunhos.',
    expiryDaysLabel: 'Expiração de anúncios (dias)',
    expiryDaysHint: 'Anúncios pessoais publicados expiram após esse tempo. Podem ser renovados.',
    // ---- recuperação de conta ----
    recoveryTitle: 'Recuperação de conta',
    recoveryIntro:
      'A recuperação funciona sem e-mail: códigos de uso único, perguntas de segurança e redefinição assistida pelo dono da loja.',
    recoveryEnabledLabel: 'Recuperação de conta ativada',
    recoveryEnabledHint: 'Interruptor mestre. Desligado, ninguém pode gerar códigos nem definir perguntas, e a caixa de senha esquecida oculta essas opções.',
    codesCountLabel: 'Códigos de recuperação por usuário',
    codesCountHint: 'Quantos códigos de uso único são gerados. 4–16.',
    maxAttemptsLabel: 'Tentativas com falha máx.',
    maxAttemptsHint: 'Tentativas de recuperação com falha antes de um bloqueio temporário.',
    windowMinutesLabel: 'Duração do bloqueio (minutos)',
    windowMinutesHint: 'Quanto tempo dura o bloqueio após tentativas demais com falha.',
    recoveryStats: '{codes} pessoas têm códigos de recuperação · {questions} pessoas definiram perguntas de segurança',
    resetRecoveryTitle: 'Redefinir a recuperação de alguém',
    resetRecoveryHint:
      'Apaga os códigos e as perguntas de segurança para que a pessoa possa configurá-los de novo. Não é possível redefinir a conta mestra assim.',
    resetRecoveryPh: 'Nome de usuário',
    resetRecoveryBtn: 'Buscar e redefinir',
    resetRecoveryConfirm: 'Apagar os códigos de recuperação e as perguntas de segurança de «{name}»? A pessoa terá de configurá-los de novo.',
    resetRecoveryDone: 'Recuperação redefinida para {name}.',
    resetRecoveryError: 'Não foi possível redefinir a recuperação.',
    userNotFound: 'Nenhuma conta com esse nome de usuário.',
    // ---- moderação de anúncios ----
    modTitle: 'Moderação de anúncios',
    modIntro:
      'Todos os anúncios pessoais da plataforma, os mais recentes primeiro. Remova conteúdo abusivo ou spam — remoções são permanentes.',
    modSearchPh: 'Buscar anúncios ou usuários…',
    modNoAds: 'Nenhum anúncio pessoal encontrado.',
    modRemove: 'Remover',
    modRemoveConfirm: 'Remover permanentemente «{title}»?',
    modRemoved: 'Anúncio removido.',
    modRemoveError: 'Não foi possível remover o anúncio.',
    modPostedBy: 'por {user}',
    modShowing: 'Mostrando {n} de {total}',
    modLoadMore: 'Carregar mais',
    // ---- comum ----
    save: 'Salvar ajustes',
    saved: 'Ajustes salvos — têm efeito imediato.',
    saveError: 'Não foi possível salvar os ajustes.',
    loadError: 'Não foi possível carregar os ajustes da plataforma.',
    needsUpdate:
      'Os controles da plataforma precisam primeiro de uma pequena atualização do banco de dados. Nada se perde — peça ao seu anfitrião para aplicar a migração mais recente e volte.',
    cancel: 'Cancelar',
    confirm: 'Confirmar',
  },
};
