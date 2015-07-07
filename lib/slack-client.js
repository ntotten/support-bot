import request from 'request';
import util from 'util';

const slackRootUrl = 'https://slack.com/api';

export function getSlackMessages(channelId, oldestTime) {
  return new Promise((resolve, reject) => {
    request({
      url: util.format('%s/channels.history?token=%s&channel=%s&oldest=%s&count=%s', slackRootUrl, process.env.HUBOT_SLACK_TOKEN, channelId, oldestTime, 1000),
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

export function postSlackMessage(channelId, text, username, iconUrl) {
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
