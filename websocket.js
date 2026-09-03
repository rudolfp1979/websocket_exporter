const WebSocket = require('ws');

function WebSocketClient() {
    this.number = 0;
    this.autoReconnectInterval = 5 * 1000;
}

WebSocketClient.prototype.open = function (url) {
    this.url = url;

    const username = process.env.WS_USERNAME;
    const password = process.env.WS_PASSWORD;

    const options = {};

    if (username && password) {
        const auth = Buffer
            .from(`${username}:${password}`)
            .toString('base64');

        options.headers = {
            Authorization: `Basic ${auth}`
        };
    }

    this.instance = new WebSocket(this.url, options);

    this.instance.on('open', () => {
        this.onopen();
    });

    this.instance.on('message', (data, flags) => {
        this.number++;
        this.onmessage(data, flags, this.number);
    });

    this.instance.on('close', (code, reason) => {
        const e = {
            code: code,
            reason: reason ? reason.toString() : ''
        };

        switch (code) {
            case 1000:
                console.log("WebSocket: closed");
                break;

            default:
                this.reconnect(e);
                break;
        }

        this.onclose(e);
    });

    this.instance.on('error', (e) => {
        this.onerror(e);

        switch (e.code) {
            case 'ECONNREFUSED':
                this.reconnect(e);
                break;
        }
    });
};

WebSocketClient.prototype.send = function (data, option) {
    try {
        this.instance.send(data, option);
    } catch (e) {
        this.instance.emit('error', e);
    }
};

WebSocketClient.prototype.reconnect = function (e) {
    console.log(
        `WebSocketClient: retry in ${this.autoReconnectInterval}ms`,
        e
    );

    this.instance.removeAllListeners();

    const that = this;

    setTimeout(function () {
        console.log("WebSocketClient: reconnecting...");
        that.open(that.url);
    }, this.autoReconnectInterval);
};

WebSocketClient.prototype.onopen = function (e) {
    console.log("WebSocketClient: open", arguments);
};

WebSocketClient.prototype.onmessage = function (data, flags, number) {
    console.log("WebSocketClient: message", arguments);
};

WebSocketClient.prototype.onerror = function (e) {
    console.log("WebSocketClient: error", arguments);
};

WebSocketClient.prototype.onclose = function (e) {
    console.log("WebSocketClient: closed", arguments);
};

module.exports.WebSocketClient = WebSocketClient;WebSocketClient.prototype.send = function (data, option) {
    try {
        this.instance.send(data, option);
    } catch (e) {
        this.instance.emit('error', e);
    }
}
WebSocketClient.prototype.reconnect = function (e) {
    console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`, e);
    this.instance.removeAllListeners();
    var that = this;
    setTimeout(function () {
        console.log("WebSocketClient: reconnecting...");
        that.open(that.url);
    }, this.autoReconnectInterval);
}
WebSocketClient.prototype.onopen = function (e) { console.log("WebSocketClient: open", arguments); }
WebSocketClient.prototype.onmessage = function (data, flags, number) { console.log("WebSocketClient: message", arguments); }
WebSocketClient.prototype.onerror = function (e) { console.log("WebSocketClient: error", arguments); }
WebSocketClient.prototype.onclose = function (e) { console.log("WebSocketClient: closed", arguments); }

module.exports.WebSocketClient = WebSocketClient;
