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

function createDigestHeader(
    url,
    username,
    password,
    challenge
) {
    const parsedUrl = new URL(url);

    const method = 'GET';
    const uri =
        parsedUrl.pathname +
        parsedUrl.search;

    const realm = challenge.realm;
    const nonce = challenge.nonce;
    const qop = challenge.qop || 'auth';
    const opaque = challenge.opaque;

    const nc = '00000001';

    const cnonce =
        crypto
            .randomBytes(8)
            .toString('hex');

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
        header +=
            `, opaque="${opaque}"`;
    }

    return header;
}

function WebSocketClient() {
    this.number = 0;

    this.autoReconnectInterval =
        5 * 1000;

    this.digestChallenge = null;

    this.reconnectTimer = null;

    this.instance = null;

    this.url = null;
}

WebSocketClient.prototype.open =
function (url) {

    this.url = url;

    const username =
        process.env.WS_USERNAME;

    const password =
        process.env.WS_PASSWORD;

    const options = {};

    if (
        username &&
        password &&
        this.digestChallenge
    ) {
        options.headers = {
            Authorization:
                createDigestHeader(
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

    console.log(
        `Opening WebSocket: ${this.url}`
    );

    this.instance =
        new WebSocket(
            this.url,
            options
        );

    /*
     * ws emits "unexpected-response"
     * when the HTTP WebSocket handshake
     * returns e.g. 401, 404, 500, ...
     */
    this.instance.on(
        'unexpected-response',
        (request, response) => {

            if (
                response.statusCode === 401
            ) {
                const authHeader =
                    response.headers[
                        'www-authenticate'
                    ];

                console.log(
                    `Authentication required for ${this.url}`
                );

                console.log(
                    `WWW-Authenticate: ${authHeader}`
                );

                const challenge =
                    parseDigestChallenge(
                        authHeader
                    );

                if (challenge) {
                    this.digestChallenge =
                        challenge;

                    response.resume();

                    request.abort();

                    this.reconnectImmediately();

                    return;
                }
            }

            console.error(
                `Unexpected server response for ${this.url}: ${response.statusCode}`
            );

            response.resume();

            request.abort();

            this.reconnect({
                type:
                    'unexpected-response',

                statusCode:
                    response.statusCode
            });
        }
    );

    this.instance.on(
        'open',
        () => {

            console.log(
                `WebSocket connected: ${this.url}`
            );

            /*
             * If there is still an old
             * reconnect timer, remove it.
             */
            if (this.reconnectTimer) {
                clearTimeout(
                    this.reconnectTimer
                );

                this.reconnectTimer =
                    null;
            }

            this.onopen();
        }
    );

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

    /*
     * Always reconnect after a close.
     *
     * Even code 1000 is retried because
     * this exporter expects the endpoint
     * to stay permanently connected.
     */
    this.instance.on(
        'close',
        (code, reason) => {

            const e = {
                type: 'close',

                code: code,

                reason:
                    reason
                        ? reason.toString()
                        : ''
            };

            console.log(
                `WebSocket closed: ${this.url}`,
                e
            );

            this.reconnect(e);

            this.onclose(e);
        }
    );

    /*
     * Also schedule a reconnect on error.
     *
     * Usually "close" follows an error,
     * but reconnect() is protected by
     * reconnectTimer, so duplicate retries
     * are prevented.
     */
    this.instance.on(
        'error',
        (e) => {

            console.error(
                `WebSocket error: ${this.url}: ${e.message}`
            );

            this.onerror(e);

            this.reconnect({
                type: 'error',
                error: e.message
            });
        }
    );
};

WebSocketClient.prototype.send =
function (data, option) {

    try {
        if (
            !this.instance ||
            this.instance.readyState !==
                WebSocket.OPEN
        ) {
            throw new Error(
                'WebSocket is not connected'
            );
        }

        this.instance.send(
            data,
            option
        );

    } catch (e) {

        if (this.instance) {
            this.instance.emit(
                'error',
                e
            );
        } else {
            this.onerror(e);

            this.reconnect({
                type: 'send-error',
                error: e.message
            });
        }
    }
};

WebSocketClient.prototype
    .reconnectImmediately =
function () {

    if (this.reconnectTimer) {
        clearTimeout(
            this.reconnectTimer
        );
    }

    this.reconnectTimer =
        setTimeout(
            () => {

                /*
                 * Important:
                 * timer must be released
                 * before open().
                 */
                this.reconnectTimer =
                    null;

                console.log(
                    `Retrying WebSocket with authentication: ${this.url}`
                );

                this.open(
                    this.url
                );

            },
            100
        );
};

WebSocketClient.prototype.reconnect =
function (e) {

    /*
     * A reconnect is already scheduled.
     */
    if (this.reconnectTimer) {
        return;
    }

    console.log(
        `WebSocketClient: retry in ${this.autoReconnectInterval}ms: ${this.url}`,
        e
    );

    this.reconnectTimer =
        setTimeout(
            () => {

                /*
                 * Important:
                 * release timer before
                 * attempting to reconnect.
                 */
                this.reconnectTimer =
                    null;

                console.log(
                    `WebSocketClient: reconnecting ${this.url}`
                );

                this.open(
                    this.url
                );

            },
            this.autoReconnectInterval
        );
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
