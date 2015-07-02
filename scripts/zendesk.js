// Description:
//  Opens Zendesk support tickets
//
// Configuration:
//  COMPANY_EMAIL_DOMAIN - @domain.com format of the company email domain
//  AUTORESPOND_ROOMS - Coma sperated list of rooms to run the autoresponder in

var request = require('request');
var moment = require('moment');
var util = require('util');
var CronJob = require('cron').CronJob;

const zendeskRootUrl = util.format('https://%s.zendesk.com/api/v2', process.env.ZENDESK_TENANT);
const slackRootUrl = 'https://slack.com/api';
const ticketOpenedMessage = '<@%s> A support ticket (%s) has been opened for your request. We contact you through the email address associated with your Slack account as soon as possible.';
const ticketCreatedMessage = util.format('Ticket created: <https://%s.zendesk.com/agent/tickets/%s|%s>', process.env.ZENDESK_TENANT);
const userErrorMessage = util.format('An error has occurred. If you would like to open a support ticket please email %s', process.env.SUPPORT_EMAIL);
const noCommentsErrorMessage = 'No recent comments found for <@%s>. You must provide the issue text.';
const invalidSlackUserErrorMessage = 'Could not find slack user.';
const noUserProvidedErrorMessage = 'Cannot open ticket. User was not provided.';
const defaultTicketSubject = 'Slack chat with %s';
const nobodyAvailible = util.format('<@%s> It doesn\'t look like anyone is availible right now to help out in chat. If you would like you can open a support ticket by simply replying `open ticket` and we will follow up over email. You may also open a support ticket by emailing %s', '%s', process.env.SUPPORT_EMAIL);
const slackbotUsername = 'support';
const SUPPORT_STATUS_KEY = 'slack_support_status';

var job;
var messageQueue = [];

module.exports = (robot) => {

  function getSlackMessages(channelId, oldestTime) {
    return new Promise((resolve, reject) => {
      request({
        url: util.format('%s/channels.history?token=%s&channel=%s&oldest=%s', slackRootUrl, process.env.HUBOT_SLACK_TOKEN, channelId, oldestTime),
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
      let token = new Buffer(process.env.ZENDESK_API_EMAIL + '/token:' + process.env.ZENDESK_API_TOKEN).toString('base64');
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
        url: util.format('%s/chat.postMessage?token=%s&channel=%s&text=%s&username=%s&icon_url=%s', slackRootUrl, process.env.HUBOT_SLACK_TOKEN, channelId, text, username, iconUrl),
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

    let oldest = moment().subtract(12, 'hour').format('X');
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
    if (message.user.email_address && message.user.email_address.indexOf(process.env.COMPANY_EMAIL_DOMAIN) > 0) {
      // Clear cache of unanswered message. somebody from company is in the room
      if (rooms) {
        if (rooms[message.rawMessage.channel]) {
          delete rooms[message.rawMessage.channel];
        }
      }
    } else {
      // If the message is a regular user messages, and not from company store it
      let users = rooms[message.rawMessage.channel] = rooms[message.rawMessage.channel] || {};
      users[message.user.id] = moment.unix(message.rawMessage.ts).valueOf();
      robot.brain.set(SUPPORT_STATUS_KEY, rooms);
    }
  }

  robot.hear(/open ticket$/i, function(res) {
    var options = {
      channel_id: res.message.rawMessage.channel,
      user: robot.brain.userForId(res.message.user.id)
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

  robot.catchAll(function(res) {
    // Catch all messages that we will do autoresponses for
    if (process.env.AUTORESPOND_ROOMS.indexOf(res.message.user.room) < 0) {
      return;
    }

    if (res.message.rawMessage.type === 'message' && !res.message.rawMessage.subtype) {
      messageQueue.push(res.message);
    }
  });

  function onJobRun() {
    console.log('support job running');
    let channels = robot.brain.get(SUPPORT_STATUS_KEY);
    let nextMessage = messageQueue.pop();
    while (nextMessage) {
      processMessage(channels, nextMessage);
      nextMessage = messageQueue.pop();
    }
    for (let channelId in channels) {
      let channel = channels[channelId];
      for (let userId in channel) {
        let time = channel[userId];
        // Check if the user hasn't been responded to in time period
        if (time < moment().subtract(2, 'minute').valueOf()) {
          delete channel[userId];
          let user = robot.brain.userForId(userId);
          let text = util.format(nobodyAvailible, user.name);
          postSlackMessage(channelId, text, slackbotUsername, process.env.SLACK_ICON_URL)
          .catch(console.log);
        }
      }
      if (Object.keys(channels[channelId]).length === 0) {
        delete channels[channelId];
      }
    }
    robot.brain.set(SUPPORT_STATUS_KEY, channels);
  }

  function onJobStopped() {
    console.log('Support job stopped');
  }

  job = new CronJob('00 * * * * *', onJobRun, onJobStopped, true);
};
