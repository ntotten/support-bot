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


import util from 'util';
import moment from 'moment';
import Log from 'log';
import config from '../config';
import { postSupportTicket } from '../lib/zendesk-client';
import { getSlackMessages, postSlackMessage } from '../lib/slack-client';

const ticketOpenedMessage = '<@%s> A support ticket (%s) has been opened for your request. We will contact you through the email address associated with your Slack account as soon as possible.';
const ticketCreatedMessage = util.format('Ticket created: <https://%s.zendesk.com/agent/tickets/%s|%s>', config.get('ZENDESK_TENANT'));
const userErrorMessage = util.format('An error has occurred. If you would like to open a support ticket please email %s', config.get('SUPPORT_EMAIL'));
const noCommentsErrorMessage = 'No recent comments found for <@%s>. You must provide the issue text.';
const noUserProvidedErrorMessage = 'Cannot open ticket. User was not provided.';
const defaultTicketSubject = 'Slack chat with @%s';
const slackbotUsername = 'support';

var log = new Log('zendesk');

module.exports = (robot) => {

  function buildTicketBody(messages) {
    let body = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      let message = messages[i];
      if (!message.hasOwnProperty('subtype')) { // ignore all subtypes as they are system/bot messages
        let user = robot.brain.userForId(message.user);

        // Replace any username mentions in ID format with readable ones
        let re = /<(@U.*?)>/;
        let rawText = message.text;
        let m;
        do {
          m = re.exec(rawText);
          if (m) {
            var user_id = m[1].substring(1);
            let mentionedUser = robot.brain.userForId(user_id) || { name: user_id };
            rawText = rawText.replace(m[0], '@' + mentionedUser.name);
          }
        } while (m);

        let text =  util.format('@%s (%s): %s',
          user ? user.name : 'unknown',
          moment.unix(message.ts).format('LTS'),
          rawText);
        body.push(text);
      }
    }

    return body.join('\n');
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
      let text = util.format(ticketOpenedMessage, user.id, ticket.ticket.id);
      return postSlackMessage(options.channel_id, text, slackbotUsername, config.get('SLACK_ICON_URL'))
      .then(function() {
        return Promise.resolve(ticket);
      });
    })
    .then(result => {
      return util.format(ticketCreatedMessage, result.ticket.id, result.ticket.id);
    });
  }

  function handleOpenTicket(res, options) {
    log.info('Opening ticket for @%s', options.user.name);

    return openTicket(options)
    .catch(function(err) {
      var message = userErrorMessage;
      if (typeof err === 'string') {
        message = err;
      }
      log.error(err);
      res.reply(message);
    });
  }

  robot.hear(/open ticket$/i, function(res) {
    var options = {
      channel_id: res.message.rawMessage.channel,
      user: robot.brain.userForId(res.message.user.id)
    };

    return handleOpenTicket(res, options);
  });

  robot.hear(/open ticket for \@([^\s]+) (.*)$/i, function(res) {
    var rawText = res.message.rawText;
    var matches = rawText.match(/open ticket for <@([^\s]+)> (.*)$/i);
    var options = {
      command_text: matches[2],
      channel_id: res.message.rawMessage.channel,
      user: robot.brain.userForId(matches[1]),
    };
    return handleOpenTicket(res, options);
  });

  robot.router.post('/hubot/zendesk/ticket', function(req, res) {
    if (req.body.token !== config.get('SLACK_COMMAND_TOKEN')) {
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
      log.error(err);
      return res.status(500).send(message);
    });

  });
};
