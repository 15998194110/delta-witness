// Preload before imports: a missing test double must never reach a real service.
// Explicit mock transports may replace fetch; direct socket transports stay denied.
const deny = () => { throw new Error('DELTA_OFFLINE_NETWORK_BLOCKED'); };
globalThis.fetch = async () => deny();
for (const name of ['http', 'https']) {
  const module = require(`node:${name}`);
  module.request = deny;
  module.get = deny;
}
const net = require('node:net');
net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
require('node:tls').connect = deny;
require('node:module').syncBuiltinESMExports();

// No environment credentials are loaded here. The local runner removes ambient
// credentials; the CI job has no secrets. Mock-only child processes can inject
// synthetic credentials while retaining this inherited outbound deny policy.
