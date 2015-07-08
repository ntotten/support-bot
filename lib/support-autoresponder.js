import moment from 'moment';
import _ from 'lodash';
import Log from 'log';
import config from '../config';

const CHANNELS_KEY = 'support_channels';
const USER_MESSAGE_KEY = 'user_message_';
const MESSAGE_MENTION_REGEX = /^<@.*>/i;

/*
Structure of the channel data:
{
  channels: [
    {
      id: '123',
      last_agent_message: 12345,
      messages: [
        { ... message ... }
      ]
    }
  ]
}

*/

var log = new Log('autoresponder');

export default function(brain, sendMessage) {

  /**
   * Checks if a message should be added to the pending messages queue
   *
   * @param {Object} channel The channel the message is in
   * @param {Object} message The message to check
   * @return {Boolean} True if should be added otherwise false.
   */
  function shouldEnqueuMessage(channel, message) {

    // Only certain rooms get responders
    if (config.get('AUTORESPOND_ROOMS').indexOf(message.channel_name) < 0) {
      log.info('Skipping message: Not responding to \'%s\' channel.', message.channel_name);
      return false;
    }

    // Only handle normal user messages
    if (message.type !== 'message' || message.subtype) {
      log.info('Skipping message: Message is not a user generated message');
      return false;
    }

    // Don't reply durring office hours
    var hours = config.get('AUTORESPOND_OFFICE_HOURS')[moment().day()];
    var startTime = moment().set('hour', hours.start.split(':')[0]).set('minute', hours.start.split(':')[1]);
    var endTime = moment().set('hour', hours.end.split(':')[0]).set('minute', hours.end.split(':')[1]);
    if (moment() > startTime && moment() < endTime) {
      log.info('Skipping message: We are inside office hours, agents will respond.');
      return false;
    }

    // Don't reply to messages that start with @user as they are replying to somebody
    if (MESSAGE_MENTION_REGEX.test(message.text)) {
      log.info('Skipping message: Message is a reply to somebody');
      return false;
    }

    // We don't reply to agents, plus agent messages reset the queue
    if (message.is_agent) {
      log.info('Skipping message: Message is from an agent.');
      if (channel.last_agent_message < message.timestamp) {
        channel.last_agent_message = message.timestamp;
      }
      // Since we have agent activity we also need to clear all
      // currently queued messages
      log.info('We have an agent active, clearing message queue.');
      channel.messages.length = 0;
      return false;
    }

    // If this message was only a short time after the last agent message it is probably a reply
    if (moment(message.timestamp).subtract(config.get('AUTORESPOND_CONVERSATION_TIMEOUT'), 'second').valueOf() < channel.last_agent_message) {
      log.info('Skipping message: This message seems like it might be a reply to an agent');
      return false;
    }

    return true;
  }


  /**
   * Checks if a reply should be sent to the user
   *
   * @param {Object} channel The channel the message is in
   * @param {Object} message The message to check
   * @return {Boolean} True if the message should be sent,
   *                   false if the message will never be sent,
   *                   or undefined if the message might be sent later.
   */
  function shouldSendReply(channel, message) {

    // Check if the message is old enough to reply
    if (message.timetamp < moment().subtract(config.get('AUTORESPOND_TIMEOUT'), 'second').valueOf()) {
      log.info('Check later: Message is not old enough to respond.');
      return;
    }

    // Check to make sure the message isnt just a second or so old.
    // It is weird to have the bot reply instantly.
    if (message.timetamp < moment().subtract(config.get('AUTORESPOND_MINIMUM_REPLY_TIMEOUT'), 'second').valueOf()) {
      log.info('Check later: Too soon to reply to message, skipping for now.');
      return;
    }

    // When agents have been active recently, we give them some time to respond
    if (moment().subtract(config.get('AUTORESPOND_AGENT_WAIT_TIMEOUT'), 'second').valueOf() < channel.last_agent_message) {
      log.info('Check later: Agents have been in the room recently, dont respond just yet');
      return;
    }

    // Only message users at most once every 12 hours
    let lastMessagedUserTime = brain.get(USER_MESSAGE_KEY + message.user_id);
    if (lastMessagedUserTime && lastMessagedUserTime > moment().subtract(config.get('AUTORESPOND_USER_LIMIT_TIMEOUT'), 'second').valueOf()) {
      log.info('Skipping message: We already sent this user a message in the allowed time.');
      return false;
    }

    return true;
  }

  function runScheduledJob() {
    log.info('Running scheduled job...');
    try {
      let channels = getChannels();
      for (let i = 0; i < channels.length; i++) {
        let channel = channels[i];
        log.info('Channel %s currently has %s message(s) in the queue.', channel.id, channel.messages.length);
        for (let m = 0; m < channel.messages.length; m++) {
          let message = channel.messages[m];
          let shouldReply = shouldSendReply(channel, message);
          if (shouldReply === true) {
            log.info('Replying to message %s', message.id);
            sendMessage(message);
            brain.set(USER_MESSAGE_KEY + message.user_id, moment().valueOf());
            delete channel.messages[m];
          } else if (shouldReply === false) {
            log.info('Deleting message %s', message.id);
            delete channel.messages[m];
          } else {
            log.info('Keeping message %s', message.id);
          }
        }

        // Clean out any deleted messages from the queue
        channel.messages = _.compact(channel.messages);
      }
    } catch (err) {
      log.error(err);
    }
  }
  brain.set(CHANNELS_KEY, undefined);

  function getChannels() {
    return brain.get(CHANNELS_KEY) || [];
  }

  function setChannels(channels) {
    brain.set(CHANNELS_KEY, channels);
  }

  function start() {
    setInterval(runScheduledJob, config.get('AUTORESPOND_JOB_INTERVAL') * 1000);
  }

  function enqueMessage(message) {
    log.info('Recieved message');
    let channels = getChannels();
    var channel = _.find(channels, { id: message.channel_id });
    if (!channel) {
      channel = {
        id: message.channel_id,
        last_agent_message: 0,
        messages: []
      };
      channels.push(channel);
    }
    if (shouldEnqueuMessage(channel, message)) {
      channel.messages.push(message);
      log.info('Message queued');
    }
    setChannels(channels);
  }

  function handleResponse(res) {
    if (!res.message.rawMessage) {
      // Some types of messages dont include rawMessage
      // these are system messages and we don't care about them
      return;
    }

    var message = {
      id: res.message.id,
      user_id: res.message.user.id,
      email_address: res.message.user.email_address,
      channel_name: res.message.user.room,
      timestamp: moment.unix(res.message.rawMessage.ts).valueOf(),
      channel_id: res.message.rawMessage.channel,
      type: res.message.rawMessage.type,
      subtype: res.message.rawMessage.subtype,
      text: res.message.rawText,
      is_agent: !!(res.message.user.email_address && res.message.user.email_address.indexOf(config.get('COMPANY_EMAIL_DOMAIN')) > 0)
    };
    enqueMessage(message);
  }

  return {
    handleResponse: handleResponse,
    enqueMessage: enqueMessage,
    start: start,
  };
}
