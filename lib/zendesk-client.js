import request from 'request';
import util from 'util';

const zendeskRootUrl = util.format('https://%s.zendesk.com/api/v2', process.env.ZENDESK_TENANT);

export function postSupportTicket(ticket) {
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
