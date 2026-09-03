const WebSocket = require('ws');
const crypto = require('crypto');

function md5(value) {
    return crypto
        .createHash('md5')
        .update(value)
        .digest('hex');
}

function parseDigestChallenge(header) {
    if (!header || !header.startsWith('Digest ')) {
        return null;
    }

    const params = {};
    const value = header.substring(7);

    const regex = /(\w+)=("([^"]*)"|([^,\s]+))/g;
    let match;

    while ((match = regex.exec(value)) !== null) {
        params[match[1]] = match[3] !== undefined
            ? match[3]
            : match[4];
    }

    return params;
}

function createDigestHeader(url, username, password, challenge) {
    const parsedUrl = new URL(url);

    const method = 'GET';
    const uri = parsedUrl.pathname + parsedUrl.search;

    const realm = challenge.realm;
    const nonce = challenge.nonce;
    const qop = challenge.qop || 'auth';
    const opaque = challenge.opaque;

    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');

    const ha1 = md5(
        `${username}:${realm}:${password}`
    );

    const ha2 = md5(
        `${method}:${uri}`
    );

    const response = md5(
        `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`
    );

    let header =
        `Digest username="${username}", ` +
        `realm="${realm}", ` +
        `nonce="${nonce}", ` +
        `uri="${uri}", ` +
        `algorithm=MD5, ` +
        `response="${response}", ` +
        `qop=${qop}, ` +
        `nc=${nc}, ` +
        `cnonce="${cnonce}"`;

    if (opaque) {
        header += `, opaque="${opaque}"`;
    }

    return header;
}

function WebSocketClient() {
    this.number = 0;
    this.autoReconnectInterval = 5 * 1000;

    this.digestChallenge = null;
    this.reconnectTimer = null;
}

WebSocketClient.prototype.open = function (url) {
    this.url = url;

    const username = process.env.WS_USERNAME;
    const password = process.env.WS_PASSWORD;

    const options = {};

    if (
        username &&
        password &&
        this.digestChallenge
    ) {
        options.headers = {
            Authorization: createDigestHeader(
                this.url,
                username,
                password,
                this.digestChallenge
            )
        };

        console.log(
            `Using Digest authentication for ${this.url}`
        );
    }

    this.instance = new WebSocket(
        this.url,
        options
    );

    /*
     * Important:
     * ws emits "unexpected-response" when the HTTP
     * WebSocket handshake returns e.g. 401.
     */
    this.instance.on(
        'unexpected-response',
        (request, response) => {

            if (response.statusCode === 401) {
                const authHeader =
                    response.headers['www-authenticate'];

                console.log(
                    `Authentication required for ${this.url}`
                );

                console.log(
                    `WWW-Authenticate: ${authHeader}`
                );

                const challenge =
                    parseDigestChallenge(authHeader);

                if (challenge) {
                    this.digestChallenge = challenge;

                    response.resume();

                    request.abort();

                    this.reconnectImmediately();

                    return;
                }
            }

            console.error(
                `Unexpected server response: ${response.statusCode}`
            );

            response.resume();
        }
    );

    this.instance.on('open', () => {
        console.log(
            `WebSocket connected: ${this.url}`
        );

        this.onopen();
    });

    this.instance.on(
        'message',
        (data, flags) => {

            this.number++;

            this.onmessage(
                data,
                flags,
                this.number
            );
        }
    );

    this.instance.on(
        'close',
        (code, reason) => {

            const e = {
                code: code,
                reason: reason
                    ? reason.toString()
                    : ''
            };

            if (code !== 1000) {
                this.reconnect(e);
            }

            this.onclose(e);
        }
    );

    this.instance.on(
        'error',
        (e) => {

            this.onerror(e);

            /*
             * Do not immediately reconnect on every error,
             * because "close" normally follows and handles it.
             */
        }
    );
};

WebSocketClient.prototype.send =
function (data, option) {
    try {
        this.instance.send(
            data,
            option
        );
    } catch (e) {
        this.instance.emit(
            'error',
            e
        );
    }
};

WebSocketClient.prototype.reconnectImmediately =
function () {

    if (this.reconnectTimer) {
        clearTimeout(
            this.reconnectTimer
        );
    }

    this.reconnectTimer =
        setTimeout(() => {

            console.log(
                `Retrying WebSocket with authentication: ${this.url}`
            );

            this.open(
                this.url
            );

        }, 100);
};

WebSocketClient.prototype.reconnect =
function (e) {

    if (this.reconnectTimer) {
        return;
    }

    console.log(
        `WebSocketClient: retry in ${this.autoReconnectInterval}ms`,
        e
    );

    this.reconnectTimer =
        setTimeout(() => {

            this.reconnectTimer = null;

            console.log(
                `WebSocketClient: reconnecting ${this.url}`
            );

            this.open(
                this.url
            );

        }, this.autoReconnectInterval);
};

WebSocketClient.prototype.onopen =
function () {};

WebSocketClient.prototype.onmessage =
function () {};

WebSocketClient.prototype.onerror =
function () {};

WebSocketClient.prototype.onclose =
function () {};

module.exports.WebSocketClient =
    WebSocketClient;
