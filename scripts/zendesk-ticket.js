// Description:
//  Opens Zendesk support tickets

var request = require('request');
var moment = require('moment');
var util = require('util');

var zendeskRootUrl = util.format('https://%s.zendesk.com/api/v2', process.env.ZENDESK_TENANT);
var slackRootUrl = 'https://slack.com/api';
var ticketOpenedMessage = '<@%s> A support ticket (%s) has been opened for your request. We contact you through the email address associated with your Slack account as soon as possible.';
var ticketCreatedMessage = util.format('Ticket created: <https://%s.zendesk.com/agent/tickets/%s|%s>', process.env.ZENDESK_TENANT);
var userErrorMessage = util.format('An error has occurred. If you would like to open a support ticket please email %s', process.env.SUPPORT_EMAIL);
var noCommentsErrorMessage = 'No recent comments found for <@%s>. You must provide the issue text.';
var invalidSlackUserErrorMessage = 'Could not find slack user.';
var noUserProvidedErrorMessage = 'Cannot open ticket. User was not provided.';
var defaultTicketSubject = 'Slack chat with %s';
var slackbotUsername = 'support';

module.exports = (robot) => {

  function getSlackMessages(channelId, oldestTime) {
    return new Promise((resolve, reject) => {
      request({
        url: util.format('%s/channels.history?token=%s&channel=%s&oldest=%s', slackRootUrl, process.env.SLACK_API_TOKEN, channelId, oldestTime),
        method: 'GET'
      }, function(err, response, body) {
        if (err || response.statusCode !== 200) {
          console.log('slack/channels.history: ' + JSON.stringify(body));
          return reject(err || 'Status code: ' + response.statusCode);
        }
        var result = JSON.parse(body);
        return resolve(result);
      });
    });
  }

  function postSupportTicket(ticket) {
    return new Promise((resolve, reject) => {
      var token = new Buffer(process.env.ZENDESK_API_EMAIL + '/token:' + process.env.ZENDESK_API_TOKEN).toString('base64');
      request({
        url: util.format('%s/tickets.json', zendeskRootUrl),
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + token
        },
        json: { ticket: ticket }
      }, function(err, response, body) {
        if (err || response.statusCode !== 201) {
          console.log('zendesk/postticket: ' + JSON.stringify(body));
          return reject(err || 'Status code: ' + response.statusCode);
        }
        resolve(body);
      });
    });
  }

  function postSlackMessage(channelId, text, username, iconUrl) {
    return new Promise((resolve, reject) => {
      request({
        url: util.format('%s/chat.postMessage?token=%s&channel=%s&text=%s&username=%s&icon_url=%s', slackRootUrl, process.env.SLACK_API_TOKEN, channelId, text, username, iconUrl),
        method: 'POST',
      }, function(err, response, body) {
        if (err || response.statusCode !== 200) {
          console.log('slack/chat.postMessage: ' + JSON.stringify(body));
          return reject(err || 'Status code: ' + response.statusCode);
        }
        return resolve(body);
      });
    });
  }

  function buildTicketBody(messages, user) {

    var getMessageText = function(user, ts, text) {
      return '@' + user + ' (' + moment.unix(ts).format('LTS') + '): ' + text;
    };
    var p = [];
    var startsWith1 = '<' + user.name;
    var startsWith2 = '<@' + user.id;
    for (var i = messages.length - 1; i >= 0; i--) {
      var message = messages[i];
      if (!message.hasOwnProperty('subtype')) { // ignore all subtypes as they are system/bot messages
        if (message.user === user.id) {
          p.push(getMessageText(message.user, message.ts, message.text));
        } else if ((message.text.indexOf(startsWith1) === 0 || message.text.indexOf(startsWith2) === 0)) {
          p.push(Promise.resolve(message).then(message => {
            var messageUser = robot.brain.userForId(message.user);
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
    var commandText = options.command_text;
    var user = options.user;

    return new Promise((resolve, reject) => {
      var oldest = moment().subtract(12, 'hour').format('X');
      return getSlackMessages(options.channel_id, oldest)
      .then(function(messageResult) {
        return buildTicketBody(messageResult.messages, user);
      })
      .then(function(body) {

        var subject;
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
          return reject(util.format(noCommentsErrorMessage, user.name));
        }

        return resolve({
          requester: {
            name:       user.profile.real_name || user.name,
            email:      user.profile.email
          },
          subject:      subject,
          comment: {
            body:       body
          }
        });
      });
    })
    .then(postSupportTicket)
    .then(ticket => {
      var text = util.format(ticketOpenedMessage, user.name, ticket.ticket.id);
      return postSlackMessage(options.channel_id, text, slackbotUsername, process.env.SLACK_ICON_URL)
      .then(function() {
        return Promise.resolve(ticket);
      });
    })
    .then(result => {
      return util.format(ticketCreatedMessage, result.ticket.id, result.ticket.id);
    });
  }

  robot.hear(/open ticket for \@([^\s]+) (.*)$/i, function(res) {
    var rawText = res.message.rawText;
    var matches = rawText.match(/open ticket for <@([^\s]+)> (.*)$/i);
    var options = {
      command_text: matches[2],
      channel_id: res.message.rawMessage.channel,
      user: robot.brain.userForId(matches[1]),
    };
    return openTicket(options)
    .then(text => {
      res.reply(text);
    }).catch(function(err) {
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

    var matches = req.body.text.trim().match(/\@([^\s]+) (.*)$/i);

    var options = {
      command_text: matches[2],
      channel_id: req.body.channel_id,
      user: robot.brain.userForName(matches[1]),
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
};
