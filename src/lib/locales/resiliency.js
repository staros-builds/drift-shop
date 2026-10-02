/**
 * Resiliency UI strings — kept OUT of en.js/fr.js on purpose.
 *
 * These are merged into the i18n dictionaries programmatically by
 * src/lib/i18n.jsx (one import line), so the per-app error boundaries,
 * boot self-check screens and auto-backup UI stay
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
      missingConfigBody: '{BRAND} was made without the settings it needs to reach your shop\u2019s online account. Rebuild it with these two settings filled in, then reload:',
      retry: 'Retry',
      notConfiguredTitle: 'The cloud backend is not configured.',
      configTitle: 'Connection settings look wrong',
      configMessage: 'This build was made with a mistake in its built-in cloud connection settings (the server address or the access key). No password will work until this is fixed — the app needs to be rebuilt with the correct settings.',
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
      missingConfigBody: '{BRAND} a été construite sans les réglages nécessaires pour joindre le compte en ligne de votre boutique. Reconstruisez-la avec ces deux réglages remplis, puis rechargez :',
      retry: 'Réessayer',
      notConfiguredTitle: 'Le serveur infonuagique n\u2019est pas configuré.',
      configTitle: 'Les réglages de connexion semblent incorrects',
      configMessage: "Cette copie de l'appli contient une erreur dans ses réglages de connexion infonuagique intégrés (l'adresse du serveur ou la clé d'accès). Aucun mot de passe ne fonctionnera tant que ce ne sera pas corrigé — l'appli doit être reconstruite avec les bons réglages.",
    },
    backup: {
      snapshotNote: 'Sauvegarde automatique enregistrée avant une action destructive.',
    },
  },
  es: {
    appCrash: {
      title: 'Esta parte de la aplicación tuvo un problema',
      message: 'El área {label} se detuvo inesperadamente. El resto de la aplicación sigue funcionando — nada más fue afectado.',
      retry: 'Intentar de nuevo',
      reload: 'Recargar toda la aplicación',
      reference: 'Referencia de soporte',
      referenceHint: 'Si reportas este problema, incluye esta referencia para que soporte encuentre el registro de errores correspondiente.',
    },
    boot: {
      checking: 'Comprobando la conexión a la nube…',
      checkingHint: 'Asegurando que el servidor responda antes de que la aplicación inicie.',
      failedTitle: 'No se pudo contactar el servidor',
      failedSchemaTitle: 'Servidor disponible, pero la base de datos se ve mal',
      failedMessage: 'La aplicación no pudo contactar su servidor en la nube. Revisa tu conexión a internet e inténtalo de nuevo.',
      failedSchemaMessage: 'El servidor respondió, pero no se encontró una tabla de la base de datos necesaria. El servidor puede estar mal configurado o apuntando al proyecto equivocado.',
      missingConfigBody: '{BRAND} se creó sin los ajustes que necesita para conectarse a la cuenta en línea de tu tienda. Vuelve a crearla con estos dos ajustes completos y luego recarga:',
      retry: 'Reintentar',
      notConfiguredTitle: 'El servidor en la nube no está configurado.',
      configTitle: 'La configuración de conexión se ve mal',
      configMessage: 'Esta copia de la aplicación se creó con un error en su configuración de conexión a la nube integrada (la dirección del servidor o la clave de acceso). Ninguna contraseña funcionará hasta que se corrija — la aplicación debe reconstruirse con la configuración correcta.',
    },
    backup: {
      snapshotNote: 'Copia automática guardada antes de una acción destructiva.',
    },
  },
  pt: {
    appCrash: {
      title: 'Esta parte do aplicativo teve um problema',
      message: 'A área {label} parou inesperadamente. O resto do aplicativo continua funcionando — nada mais foi afetado.',
      retry: 'Tentar de novo',
      reload: 'Recarregar o aplicativo todo',
      reference: 'Referência de suporte',
      referenceHint: 'Se você reportar este problema, inclua esta referência para o suporte encontrar o registro de erro correspondente.',
    },
    boot: {
      checking: 'Verificando a conexão com a nuvem…',
      checkingHint: 'Conferindo se o servidor responde antes de o aplicativo abrir.',
      failedTitle: 'Não foi possível alcançar o servidor',
      failedSchemaTitle: 'Servidor alcançável, mas o banco de dados parece errado',
      failedMessage: 'O aplicativo não conseguiu alcançar o servidor na nuvem. Confira sua conexão com a internet e tente de novo.',
      failedSchemaMessage: 'O servidor respondeu, mas uma tabela necessária do banco de dados não foi encontrada. O servidor pode estar mal configurado ou apontando para o projeto errado.',
      missingConfigBody: '{BRAND} foi criada sem as configurações de que precisa para alcançar a conta on-line da sua loja. Recrie-a com essas duas configurações preenchidas e recarregue:',
      retry: 'Tentar de novo',
      notConfiguredTitle: 'O servidor na nuvem não está configurado.',
      configTitle: 'As configurações de conexão parecem erradas',
      configMessage: 'Esta cópia do aplicativo foi criada com um erro nas configurações de conexão com a nuvem embutidas (o endereço do servidor ou a chave de acesso). Nenhuma senha vai funcionar até corrigir — o aplicativo precisa ser reconstruído com as configurações certas.',
    },
    backup: {
      snapshotNote: 'Backup automático salvo antes de uma ação destrutiva.',
    },
  },
};
