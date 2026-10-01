/**
 * Resiliency UI strings — kept OUT of en.js/fr.js on purpose.
 *
 * These are merged into the i18n dictionaries programmatically by
 * src/lib/i18n.jsx (one import line), so the per-app error boundaries,
 * boot self-check screens, offline-queue banner and auto-backup UI stay
 * bilingual without touching the main locale files.
 *
 * Key prefix: `resiliency.*`
 */
export const resiliency = {
  en: {
    appCrash: {
      title: 'This part of the app hit a problem',
      message: 'The {label} area stopped unexpectedly. The rest of the app is still running — nothing else was affected.',
      retry: 'Try again',
      reload: 'Reload the whole app',
      reference: 'Support reference',
      referenceHint: 'If you report this problem, include this reference so support can find the matching error log.',
    },
    boot: {
      checking: 'Checking the cloud connection…',
      checkingHint: 'Making sure the backend is reachable before the app starts.',
      failedTitle: 'Could not reach the backend',
      failedSchemaTitle: 'Backend reachable, but the database looks wrong',
      failedMessage: 'The app could not reach its cloud backend. Check your internet connection, then try again.',
      failedSchemaMessage: 'The server answered, but a required database table was not found. The backend may be misconfigured or pointing at the wrong project.',
      retry: 'Retry',
      continueOffline: 'Continue offline anyway',
      continueOfflineHint: 'Sales you make offline are saved on this device and sync when the connection returns.',
      notConfiguredTitle: 'The cloud backend is not configured.',
    },
    queue: {
      banner: '{n} sale(s) saved on this device — waiting to sync',
      bannerHint: 'They will sync automatically when the connection returns. Do not clear this device\u2019s data.',
      syncing: 'Syncing queued sales…',
      lastError: 'Last sync error: {msg}',
      discardFailed: 'Discard failed items',
      discardConfirm: 'Discard all {n} queued sale(s) that failed to sync? They will be permanently removed from this device. Only do this if the sales were re-entered another way.',
    },
    backup: {
      snapshotNote: 'Auto-backup saved before a destructive action.',
    },
  },
  fr: {
    appCrash: {
      title: 'Cette partie de l\u2019appli a rencontré un problème',
      message: 'La zone {label} s\u2019est arrêtée de façon inattendue. Le reste de l\u2019appli fonctionne toujours — rien d\u2019autre n\u2019a été touché.',
      retry: 'Réessayer',
      reload: 'Recharger toute l\u2019appli',
      reference: 'Référence d\u2019assistance',
      referenceHint: 'Si vous signalez ce problème, incluez cette référence pour aider l\u2019assistance à retrouver le journal d\u2019erreur.',
    },
    boot: {
      checking: 'Vérification de la connexion infonuagique…',
      checkingHint: 'On s\u2019assure que le serveur est joignable avant de démarrer l\u2019appli.',
      failedTitle: 'Connexion au serveur impossible',
      failedSchemaTitle: 'Serveur joignable, mais la base de données semble incorrecte',
      failedMessage: 'L\u2019appli n\u2019a pas pu joindre son serveur infonuagique. Vérifiez votre connexion Internet, puis réessayez.',
      failedSchemaMessage: 'Le serveur a répondu, mais une table requise de la base de données est introuvable. Le serveur est peut-être mal configuré ou pointe vers le mauvais projet.',
      retry: 'Réessayer',
      continueOffline: 'Continuer hors ligne quand même',
      continueOfflineHint: 'Les ventes hors ligne sont enregistrées sur cet appareil et se synchronisent au retour de la connexion.',
      notConfiguredTitle: 'Le serveur infonuagique n\u2019est pas configuré.',
    },
    queue: {
      banner: '{n} vente(s) enregistrée(s) sur cet appareil — en attente de synchronisation',
      bannerHint: 'Elles se synchroniseront automatiquement au retour de la connexion. N\u2019effacez pas les données de cet appareil.',
      syncing: 'Synchronisation des ventes en attente…',
      lastError: 'Dernière erreur de synchro : {msg}',
      discardFailed: 'Écarter les éléments en échec',
      discardConfirm: 'Écarter les {n} vente(s) en attente dont la synchronisation a échoué ? Elles seront définitivement supprimées de cet appareil. Faites-le seulement si les ventes ont été saisies autrement.',
    },
    backup: {
      snapshotNote: 'Sauvegarde automatique enregistrée avant une action destructive.',
    },
  },
};

export default resiliency;
