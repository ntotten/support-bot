import request from 'request';
import util from 'util';
import config from '../config';

const zendeskRootUrl = util.format('https://%s.zendesk.com/api/v2', config.get('ZENDESK_TENANT'));

export function postSupportTicket(ticket) {
  return new Promise((resolve, reject) => {
    let token = new Buffer(config.get('ZENDESK_API_EMAIL') + '/token:' + config.get('ZENDESK_API_TOKEN')).toString('base64');
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
