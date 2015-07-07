// Description:
//  Opens Zendesk support tickets
//
// Configuration:
//  HUBOT_SLACK_TOKEN
//  SLACK_COMMAND_TOKEN
//  SLACK_ICON_URL
//  SUPPORT_EMAIL
//  ZENDESK_API_EMAIL
//  ZENDESK_API_TOKEN
//  ZENDESK_TENANT
//  COMPANY_EMAIL_DOMAIN - @domain.com format of the company email domain
//  AUTORESPOND_ROOMS - Comma sperated list of rooms to run the autoresponder in
//  AUTORESPOND_TIMEOUT - Minutes to wait until autoresponding to messages

import util from 'util';
import moment from 'moment';
import { postSupportTicket } from '../lib/zendesk-client';
import { getSlackMessages, postSlackMessage } from '../lib/slack-client';

const ticketOpenedMessage = '<@%s> A support ticket (%s) has been opened for your request. We will contact you through the email address associated with your Slack account as soon as possible.';
const ticketCreatedMessage = util.format('Ticket created: <https://%s.zendesk.com/agent/tickets/%s|%s>', process.env.ZENDESK_TENANT);
const userErrorMessage = util.format('An error has occurred. If you would like to open a support ticket please email %s', process.env.SUPPORT_EMAIL);
const noCommentsErrorMessage = 'No recent comments found for <@%s>. You must provide the issue text.';
const invalidSlackUserErrorMessage = 'Could not find slack user.';
const noUserProvidedErrorMessage = 'Cannot open ticket. User was not provided.';
const defaultTicketSubject = 'Slack chat with @%s';
const nobodyAvailible = util.format('<@%s> It doesn\'t look like anyone is available right now to help out in chat. If you would like, you can open a support ticket by simply replying *open ticket* and we will follow up over email. You may also open a support ticket by emailing %s.', '%s', process.env.SUPPORT_EMAIL);
const slackbotUsername = 'support';
const SUPPORT_STATUS_KEY = 'slack_support_status';
const LAST_MESSAGED_USER_KEY = 'slack_support_last_messaged_';

var messageQueue = [];

module.exports = (robot) => {

  function buildTicketBody(messages, user) {

    let getMessageText = function(user, ts, text) {
      return '@' + user + ' (' + moment.unix(ts).format('LTS') + '): ' + text;
    };
    let p = [];
    let startsWith1 = '<' + user.name;
    let startsWith2 = '<@' + user.id;
    for (let i = messages.length - 1; i >= 0; i--) {
      let message = messages[i];
      if (!message.hasOwnProperty('subtype')) { // ignore all subtypes as they are system/bot messages
        if (message.user === user.id) {
          p.push(getMessageText(message.user, message.ts, message.text));
        } else if ((message.text.indexOf(startsWith1) === 0 || message.text.indexOf(startsWith2) === 0)) {
          p.push(Promise.resolve(message).then(message => {
            let messageUser = robot.brain.userForId(message.user);
            if (messageUser) {
              return getMessageText(messageUser.name, message.ts, message.text.substring(message.text.indexOf('>: ') + 2));
            } else {
              return Promise.reject(invalidSlackUserErrorMessage);
            }
          }));
        }
      }
    }

    return Promise.all(p)
    .then(values => {
      var body = values.join('\n');
      return body.replace(user.id, user.name).replace('<@' + user.name + '>', '@' + user.name);
    });
  }

  function openTicket(options) {
    let commandText = options.command_text || '';
    let user = options.user;

    if (!user) {
      return Promise.reject(noUserProvidedErrorMessage);
    }

    let oldest = moment().subtract(3, 'hour').format('X');
    return getSlackMessages(options.channel_id, oldest)
    .then(function(messageResult) {
      return buildTicketBody(messageResult.messages, user);
    })
    .then(function(body) {

      let subject;
      if (commandText.length > 0 && body) {
        // If the command text is provided and there is a body, the text is used as the subject.
        subject = commandText;
      } else if (commandText.length === 0 && body) {
        // If command text is not provide, but we have a body then generate a default subject.
        subject = util.format(defaultTicketSubject, user.name);
      } else if (commandText.length > 0 && !body) {
        // If command text is provided, but no body then use generic subject and text as body.
        subject = util.format(defaultTicketSubject, user.name);
        body = commandText;
      } else {
        // If no command text and no body, there is an error
        return Promise.reject(util.format(noCommentsErrorMessage, user.name));
      }

      return {
        requester: {
          name:       user.real_name || user.name,
          email:      user.email_address
        },
        subject:      subject,
        comment: {
          body:       body
        }
      };
    })
    .then(postSupportTicket)
    .then(ticket => {
      let text = util.format(ticketOpenedMessage, user.name, ticket.ticket.id);
      return postSlackMessage(options.channel_id, text, slackbotUsername, process.env.SLACK_ICON_URL)
      .then(function() {
        return Promise.resolve(ticket);
      });
    })
    .then(result => {
      return util.format(ticketCreatedMessage, result.ticket.id, result.ticket.id);
    });
  }

  function processMessage(rooms, message) {
    console.log('Processing message ' + message.id);

    // Only certain rooms get responders
    if (process.env.AUTORESPOND_ROOMS.indexOf(message.channel_name) < 0) {
      console.log('Skipping message. Not responding to channel: ' + message.channel_name);
      return;
    }
    // Only handle normal user messages
    if (message.type === 'message' && message.subtype) {
      console.log('Skipping message as it is not a user generated message');
      return;
    }

    if (message.is_agent) {
      console.log('Clear cache of unanswered message. somebody from company is in the room');
      if (rooms) {
        if (rooms[message.channel_id]) {
          delete rooms[message.channel_id];
        }
      }
    } else {
      console.log('The message is a regular user messages, and not from company store it');
      let users = rooms[message.channel_id] = rooms[message.channel_id] || {};
      users[message.user_id] = message.timestamp;
    }
  }

  robot.hear(/open ticket$/i, function(res) {
    var options = {
      channel_id: res.message.rawMessage.channel,
      user: robot.brain.userForId(res.message.user.id)
    };
    return openTicket(options)
    .catch(function(err) {
      var message = userErrorMessage;
      if (typeof err === 'string') {
        message = err;
      }
      console.log(err);
      res.reply(message);
    });
  });

  robot.hear(/open ticket for \@([^\s]+) (.*)$/i, function(res) {
    var rawText = res.message.rawText;
    var matches = rawText.match(/open ticket for <@([^\s]+)> (.*)$/i);
    var options = {
      command_text: matches[2],
      channel_id: res.message.rawMessage.channel,
      user: robot.brain.userForId(matches[1]),
    };
    return openTicket(options)
    .catch(function(err) {
      var message = userErrorMessage;
      if (typeof err === 'string') {
        message = err;
      }
      console.log(err);
      res.reply(message);
    });
  });

  robot.router.post('/hubot/zendesk/ticket', function(req, res) {
    if (req.body.token !== process.env.SLACK_COMMAND_TOKEN) {
      return res.status(500).send('Invalid token');
    }

    var rawText = req.body.text.trim();
    var commandText;
    var username;
    if (rawText.indexOf(' ') > -1) {
      var matches = rawText.match(/\@([^\s]+) (.*)$/i);
      commandText = matches[2];
      username = matches[1];
    } else {
      username = rawText.replace('@', '');
    }

    var options = {
      command_text: commandText,
      channel_id: req.body.channel_id,
      user: robot.brain.userForName(username),
    };

    return openTicket(options)
    .then(text => {
      return res.status(200).send(text);
    }).catch(err => {
      var message = userErrorMessage;
      if (typeof err === 'string') {
        message = err;
      }
      console.log(err);
      return res.status(500).send(message);
    });

  });

  // Catch all messages for autoresponder
  robot.catchAll(function(res) {
    var message = {
      id: res.message.id,
      user_id: res.message.user.id,
      email_address: res.message.user.email_address,
      timestamp: moment.unix(res.message.rawMessage.ts).valueOf(),
      channel_id: res.message.rawMessage.channel,
      channel_name: res.message.user.room,
      type: res.message.rawMessage.type,
      subtype: res.message.rawMessage.subtype,
      //text: res.message.rawText,
      is_agent: !!(res.message.user.email_address && res.message.user.email_address.indexOf(process.env.COMPANY_EMAIL_DOMAIN) > 0)
    };
    messageQueue.push(message);
  });

  function getChannels() {
    let channels = robot.brain.get(SUPPORT_STATUS_KEY);
    let nextMessage = messageQueue.pop();
    while (nextMessage) {
      processMessage(channels, nextMessage);
      nextMessage = messageQueue.pop();
    }
    return channels;
  }

  function runScheduledJob() {
    console.log('support job running');
    let channels = getChannels();
    for (let channelId in channels) {
      let channel = channels[channelId];
      for (let userId in channel) {
        let time = channel[userId];
        // Check if the user hasn't been responded to in time period
        if (time < moment().subtract(process.env.AUTORESPOND_TIMEOUT, 'minute').valueOf()) {
          delete channel[userId];
          let user = robot.brain.userForId(userId);
          let text = util.format(nobodyAvailible, user.name);
          var lastMessagedUserTime = robot.brain.get(LAST_MESSAGED_USER_KEY + userId);
          // Only message users at most once every 12 hours
          if (!lastMessagedUserTime || lastMessagedUserTime < moment().subtract(12, 'minute').valueOf()) {
            console.log('Sending message.');
            postSlackMessage(channelId, text, slackbotUsername, process.env.SLACK_ICON_URL)
            .then(() => {
               robot.brain.set(LAST_MESSAGED_USER_KEY + userId, moment().valueOf());
            })
            .catch(console.log);
          } else {
            console.log('Not sending message, too many messages to user in allowed time.');
          }
        }
      }
      if (Object.keys(channels[channelId]).length === 0) {
        delete channels[channelId];
      }
    }
    robot.brain.set(SUPPORT_STATUS_KEY, channels);
  }

  setInterval(runScheduledJob, 60000);

  // Try to catch any unsaved messages and save them.
  process.on('SIGTERM', function() {
    console.log('saving channels before shutdown.');
    var channels = getChannels();
    robot.brain.set(SUPPORT_STATUS_KEY, channels);
  });
};
