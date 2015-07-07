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
//  AUTORESPOND_JOB_INTERVAL - Seconds between job runs
//  AUTORESPOND_TIMEOUT - Seconds to wait until autoresponding to messages
//  AUTORESPOND_AGENT_WAIT_TIMEOUT - Seconds to wait before replying after agent activity
//  AUTORESPOND_CONVERSATION_TIMEOUT - Seconds to ignore a message after an agent message
//  AUTORESPOND_USER_LIMIT_TIMEOUT - Seconds between maximum number messages per user in time
//  AUTORESPOND_MINIMUM_REPLY_TIMEOUT - Minimum seconds to wait before a message and autoreply


import util from 'util';
import moment from 'moment';
import { postSupportTicket } from '../lib/zendesk-client';
import { getSlackMessages, postSlackMessage } from '../lib/slack-client';
import autoResponder from '../lib/support-autoresponder';

const ticketOpenedMessage = '<@%s> A support ticket (%s) has been opened for your request. We will contact you through the email address associated with your Slack account as soon as possible.';
const ticketCreatedMessage = util.format('Ticket created: <https://%s.zendesk.com/agent/tickets/%s|%s>', process.env.ZENDESK_TENANT);
const userErrorMessage = util.format('An error has occurred. If you would like to open a support ticket please email %s', process.env.SUPPORT_EMAIL);
const noCommentsErrorMessage = 'No recent comments found for <@%s>. You must provide the issue text.';
const invalidSlackUserErrorMessage = 'Could not find slack user.';
const noUserProvidedErrorMessage = 'Cannot open ticket. User was not provided.';
const defaultTicketSubject = 'Slack chat with @%s';
const nobodyAvailible = util.format('<@%s> It doesn\'t look like anyone is available right now to help out in chat. If you would like, you can open a support ticket by simply replying *open ticket* and we will follow up over email. You may also open a support ticket by emailing %s.', '%s', process.env.SUPPORT_EMAIL);
const slackbotUsername = 'support';

module.exports = (robot) => {

  var responder = autoResponder(robot.brain, (message) => {
    let user = robot.brain.userForId(message.user_id);
    let text = util.format(nobodyAvailible, user.name);
    return postSlackMessage(message.channel_id, text, slackbotUsername, process.env.SLACK_ICON_URL);
  });
  responder.start();

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
    responder.handleResponse(res);
  });
};
