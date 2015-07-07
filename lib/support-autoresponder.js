import moment from 'moment';
import util from 'util';

const SUPPORT_STATUS_KEY = 'slack_support_status';
const LAST_MESSAGED_USER_KEY = 'slack_support_last_messaged_';

var messageQueue = [];


export default function(brain, sendMessage) {

  function getChannels() {
    let channels = brain.get(SUPPORT_STATUS_KEY);
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
          let user = brain.userForId(userId);

          let lastMessagedUserTime = brain.get(LAST_MESSAGED_USER_KEY + userId);
          // Only message users at most once every 12 hours
          if (!lastMessagedUserTime || lastMessagedUserTime < moment().subtract(12, 'minute').valueOf()) {
            console.log('Sending message.');
            sendMessage(channelId, user)
            .then(() => {
               brain.set(LAST_MESSAGED_USER_KEY + userId, moment().valueOf());
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
    brain.set(SUPPORT_STATUS_KEY, channels);
  }

  function start() {
    setInterval(runScheduledJob, 60000);
  }

  // Try to catch any unsaved messages and save them.
  process.on('SIGTERM', function() {
    console.log('saving channels before shutdown.');
    var channels = getChannels();
    brain.set(SUPPORT_STATUS_KEY, channels);
  });

  return {
    enqueuMessage: null,
    start: start,
  };
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
