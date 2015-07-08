import nconf from 'nconf';

nconf.file({ file: './config.json' })
     .argv().env()
     .defaults({
       AUTORESPOND_ROOMS: 'general',
       AUTORESPOND_JOB_INTERVAL: 30,
       AUTORESPOND_TIMEOUT: 300,
       AUTORESPOND_AGENT_WAIT_TIMEOUT: 600,
       AUTORESPOND_CONVERSATION_TIMEOUT: 120,
       AUTORESPOND_USER_LIMIT_TIMEOUT: 36000,
       AUTORESPOND_MINIMUM_REPLY_TIMEOUT: 15,
       WELCOME_ROOMS: 'general'
     });

export default nconf;
