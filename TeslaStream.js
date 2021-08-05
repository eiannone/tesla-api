import WebSocket from 'ws';

const IDLE = 0;
const CONNECTING = 1;
const CONNECTED = 2;
const CLOSING = 3;
const CLOSED = 4;

export default class TeslaStream {
    static DEFAULT_COLUMNS = ['elevation', 'est_heading', 'est_lat', 'est_lng', 'odometer', 'power', 'shift_state', 'speed', 'soc'];

    constructor(logger = null, cb_inactive = null, cb_disconnects = null) {
        this.log = logger || this.#internalLog;
        this.ws = null;
        this.state = IDLE;
        this.columns = TeslaStream.DEFAULT_COLUMNS;
        this.checkTimeout = null;
        this.timeouts = 0;
        this.disconnects = 0;
        this.cbInactive = cb_inactive;
        this.cbDisconnects = cb_disconnects;
        this.reconnect = true;
        this.tag = null;
        this.lastShiftState = null;
    }

    isConnected() {
        return this.state == CONNECTED;
    }

    #internalLog(msg, level = 'debug') {
        console.log("[%s] %s", level, msg);
    }

    #expBackOffMs(exp, minSeconds, maxSeconds, base = 2) {
        let ms = Math.max(Math.pow(base, exp), minSeconds);
        return Math.round(Math.min(ms, maxSeconds) * 1000);
    }

    disconnect(reconnect = false, unsubscribe = true) {
        if (this.state == CLOSING || this.state == CLOSED) return;
        this.reconnect = reconnect;
        if (this.checkTimeout != null) {
            clearTimeout(this.checkTimeout);
            this.checkTimeout = null;
        }
        if (this.ws == null || this.ws.readyState == WebSocket.CLOSED) {
            this.ws = null;
            this.state = CLOSED;
            return;
        }
        this.state = CLOSING;
        if (this.ws.readyState != WebSocket.CLOSING) {
            if (unsubscribe) {
                this.log("Unsubscribing...");
                this.ws.send(JSON.stringify({msg_type: "data:unsubscribe", tag: this.tag}));
            }
            this.log("Sending closing frame...");
            this.ws.close(); // After closing eventually it will reconnect (see 'on close' event)
        }
    }

    #reconnect() {
        this.log("Reconnecting...");
        this.disconnect(true, false);
    }

    #timeout() {
        this.timeouts += 1;
        let level = (this.timeouts < 8)? 'debug' : 'info';
        this.log("Stream connection timed out / " + this.timeouts, level);        
        if (this.timeouts % 10 == 3) { // Teslamate does it on the 5th attempt
            this.log("Stream inactive!");
            if (this.cbInactive != null) this.cbInactive();
        }
        this.#reconnect();
    }

    #subscribe(tag, token) {
        this.log("Subscribing to stream...");
        this.ws.send(JSON.stringify({
            msg_type: "data:subscribe_oauth",
            token: token,
            value: this.columns.join(','),
            tag: tag
        }));        
    }

    connect(tag, token, columns = null, cb_data = null, cb_error = null) {
        this.tag = tag.toString();
        if (columns != null) this.columns = columns;        
        let shiftStatePos = this.columns.indexOf('shift_state');

        if (this.ws != null && this.ws.readyState != WebSocket.CLOSED) return;
        this.state = CONNECTING;
        this.log("Connecting to websocket...");
        this.ws = new WebSocket("wss://streaming.vn.teslamotors.com/streaming/", {
            perMessageDeflate: false,
            handshakeTimeout: 6000
        });
        if (this.checkTimeout != null) clearTimeout(this.checkTimeout);
        this.checkTimeout = setTimeout(this.#timeout.bind(this), this.#expBackOffMs(this.timeouts, 10, 30));

        this.ws.on('open', () => {
            this.log("Websocket open.");
            this.#subscribe(this.tag, token);
        });
        this.ws.on('message', (data) => {
            if (this.checkTimeout != null) clearTimeout(this.checkTimeout);
            this.checkTimeout = setTimeout(this.#timeout.bind(this), 15000);

            let d = JSON.parse(data);
            if (d.msg_type == 'control:hello') {
                this.log("Hello response received.");
                this.state = CONNECTED;
            } else if (d.msg_type == 'data:update') {
                let values = d.value.split(",");
                if (cb_data != null) cb_data(values);
                this.timeouts = 0;
                this.disconnects = 0;
                if (shiftStatePos > -1) this.lastShiftState = values[shiftStatePos + 1];
            } else if (d.msg_type == 'data:error' && typeof d.error_type != "undefined") {
                switch(d.error_type) {
                    case "vehicle_disconnected":
                        this.disconnects++;
                        const level = (this.disconnects < 8)? 'debug' : 'info';
                        const nDisconnections = (this.disconnects == 1)? '' : ' / '+this.disconnects;
                        this.log("Vehicle disconnected" + nDisconnections, level);
                        clearTimeout(this.checkTimeout);                        
                        if (this.disconnects % 10 == 0) {
                            this.log("Too many disconnects!", "warn");
                            if (this.cbDisconnects != null) this.cbDisconnects();
                        }
                        else {
                            let ms = (this.lastShiftState != null && this.lastShiftState != "")?
                                this.#expBackOffMs(this.disconnects, 0, 8, 1.3) :
                                this.#expBackOffMs(this.disconnects, 30, 60); // Teslamate uses min 15, max 30
                            
                            clearTimeout(this.checkTimeout);
                            this.log("Waiting for " + Math.round(ms / 1000) + " sec...");                            
                            this.checkTimeout = setTimeout(_ => { this.#subscribe(tag, token); }, ms);
                        }
                        break;
                    case "vehicle_error":
                        this.log("Vehicle error: " + d.value, "error");
                        break;
                    case "client_error":
                        this.log("Client error: " + d.value, "error");
                        if (cb_error != null) cb_error(d.value);
                        break;
                    default:
                        this.log("Stream API error ["+d.error_type+"]: " + data, "error");
                        break;
                }                
            } else {
                this.log("Unknown message: " + data, "error");
                if (cb_error != null) cb_error(data);
            }
        });
        this.ws.on('error', (error) => {
            const errMsg = (error instanceof Error)? error.message : error;
            this.log("Websocket error: " + errMsg, "error");
        });
        this.ws.on('close', (code, reason) => {
            this.log("Websocket closed ("+code + (reason? ': '+reason : '')+").");
            if (code == 1006) this.reconnect = true; // Abnormal close
            if (this.checkTimeout != null) clearTimeout(this.checkTimeout);
            this.ws = null;
            this.state = CLOSED;
            if (this.reconnect) {
                this.checkTimeout = setTimeout(() => { 
                    this.log("Reconnecting...");
                    this.connect(tag, token, columns, cb_data, cb_error); 
                }, 1000);
            }
        });
    }
}