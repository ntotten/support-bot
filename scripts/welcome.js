
// Description:
//  Opens Zendesk support tickets
//
// Configuration:
//  HUBOT_SLACK_TOKEN
//  SLACK_COMMAND_TOKEN
//  SLACK_ICON_URL
//  SUPPORT_EMAIL
//  WELCOME_ROOMS - Rooms to welcome users
//  WELCOME_MESSAGE - The text of the welcome message

import Log from 'log';
import config from '../config';
import util from 'util';
import { postSlackMessage } from '../lib/slack-client';

const slackbotUsername = 'support';
const welcomeMessage = util.format(config.get('WELCOME_MESSAGE'), config.get('SUPPORT_EMAIL'));

var log = new Log('welcome');

module.exports = (robot) => {
  robot.enter(function(res) {
    if (!res.message.user) {
      return;
    }

    // Only monitor certain rooms
    if (config.get('WELCOME_ROOMS').indexOf(res.message.user.room) < 0) {
      return;
    }

    log.info('Welcoming user %s', res.message.user.id);
    return postSlackMessage(res.message.user.id, welcomeMessage, slackbotUsername, config.get('SLACK_ICON_URL'));
  });
};
